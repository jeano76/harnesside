/**
 * X-1 위임 실행기 — 외부 코딩 에이전트를 **비대화형 서브프로세스**로 돌리고 결론만 돌려준다.
 *
 * - 입력은 작업 명세 파일(`task.md`), 출력은 로그 파일 + ≤2KB 요약. 대화 이력은 로컬 컨텍스트로 오지 않는다(P2).
 * - "완료" 보고는 믿지 않는다: 하네스가 `verify` 를 직접 돌려 판정한다(P4).
 * - 타임아웃·루프 감지로 강제 종료하고 이유를 돌려준다. 조용히 끝나지 않는다.
 *
 * 실행기는 주입 가능하다(`AgentSpec`) — 테스트는 가짜 에이전트 스크립트로 정상·타임아웃·루프·모호한 task 를 검증한다.
 */
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { LoopDetector, redactSecrets, validateRequest, type DelegateRequest } from "./safety.js";
import { buildTaskMd, parseStatusBlock } from "./template.js";

const execFileP = promisify(execFile);

export const SUMMARY_MAX_BYTES = 2048;
export const VERIFY_TAIL_MAX_BYTES = 1024;

export interface AgentSpec {
  name: string;
  bin: string;
  /** 프롬프트(작업 명세 경로를 가리킨다)로 argv 를 만든다. 출력은 stream-json 한 줄씩이어야 한다. */
  buildArgs(o: { prompt: string; maxBudgetUsd: number | null; readOnly?: boolean }): string[];
}

/** Claude Code 비대화형. 편집은 자동 승인하되(작업 디렉터리 안), 셸은 검증·읽기 명령만, push·삭제·설치는 막는다(P6). */
export const CLAUDE_SPEC: AgentSpec = {
  name: "claude",
  bin: "claude",
  buildArgs: ({ prompt, maxBudgetUsd, readOnly }) => [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    readOnly ? "default" : "acceptEdits",
    "--allowedTools",
    readOnly
      ? "Read,Glob,Grep,Bash(git diff:*),Bash(git status:*),Bash(git log:*)"
      : "Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(git status:*),Bash(git log:*),Bash(npm run:*),Bash(npm test:*),Bash(npx tsc:*),Bash(node --test:*)",
    "--disallowedTools",
    `${readOnly ? "Edit,Write,NotebookEdit," : ""}Bash(git push:*),Bash(rm:*),Bash(npm install:*),Bash(npm i:*),Bash(curl:*),Bash(wget:*),WebFetch`,
    "--no-session-persistence",
    ...(maxBudgetUsd !== null ? ["--max-budget-usd", String(maxBudgetUsd)] : []),
  ],
};

export interface DelegateConfig {
  agent: string;
  /** 기본 30분(사용자 결정, 2026-10-17). */
  timeoutMs: number;
  /** 지정 전에는 상한 없음(null) — 비용 상한은 사용자 결정 대기. */
  maxBudgetUsd: number | null;
  verifyTimeoutMs: number;
}

export const DEFAULT_DELEGATE_CONFIG: DelegateConfig = {
  agent: "claude",
  timeoutMs: 30 * 60 * 1000,
  maxBudgetUsd: null,
  verifyTimeoutMs: 10 * 60 * 1000,
};

export type DelegateStatus =
  | "done"
  | "verify-failed"
  | "blocked"
  | "needs"
  | "killed"
  | "timeout"
  | "malformed"
  | "error"
  | "rejected";

export interface DelegateResult {
  status: DelegateStatus;
  /** 사람이 읽을 이유·요약(≤2KB). */
  summary: string;
  changedFiles: string[];
  /** 허용 범위(`files`) 밖에서 바뀐 파일 — 비어 있어야 정상. */
  outOfScope: string[];
  verify: { recipe: string; ok: boolean; tail: string } | null;
  logPath: string | null;
  durationMs: number;
}

export interface DelegateInput extends DelegateRequest {
  /** 도구 계층이 `load_skill(checklist)` 로 만들어 넘긴다. */
  skillChecklists?: { name: string; text: string }[];
  /** "review": 읽기 전용 리뷰(X-4 5단계). 구현한 모델과 다른 모델이 diff 를 읽고 지적만 한다. */
  mode?: "implement" | "review";
}

export interface DelegateDeps {
  agents?: Record<string, AgentSpec>;
  now?: () => number;
}

let running = false;

function clipBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  return `${buf.subarray(0, max - 3).toString("utf8")}…`;
}

function reject(reason: string, detail: string): DelegateResult {
  return { status: "rejected", summary: clipBytes(`${reason}: ${detail}`, SUMMARY_MAX_BYTES), changedFiles: [], outOfScope: [], verify: null, logPath: null, durationMs: 0 };
}

async function binaryExists(bin: string): Promise<boolean> {
  try {
    await execFileP("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

/** git 이 추적하는 변경·미추적 파일의 내용 해시 스냅샷. git 이 아니면 null("알 수 없음"). */
export async function snapshotChanges(root: string): Promise<Map<string, string> | null> {
  let out: string;
  try {
    out = (await execFileP("git", ["status", "--porcelain", "-uall", "-z"], { cwd: root, maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
  const snap = new Map<string, string>();
  const entries = out.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const code = e.slice(0, 2);
    const path = e.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // 원본 경로 항목은 건너뛴다
    try {
      snap.set(path, createHash("sha256").update(await readFile(join(root, path))).digest("hex"));
    } catch {
      snap.set(path, "deleted");
    }
  }
  return snap;
}

export function diffSnapshots(before: Map<string, string> | null, after: Map<string, string> | null): string[] | null {
  if (!before || !after) return null;
  const changed: string[] = [];
  for (const [p, h] of after) if (before.get(p) !== h) changed.push(p);
  // 작업 전에는 더러웠다가 지금은 깨끗해진 파일(되돌린 것)도 바뀐 것이다.
  for (const p of before.keys()) if (!after.has(p)) changed.push(p);
  return changed.sort();
}

/** verify 이름을 npm 스크립트로 해석한다. 없으면 null — 있는 척하지 않는다. */
async function resolveVerifyCommand(root: string, verify: string): Promise<{ cmd: string; args: string[] } | null> {
  if (!/^[\w:.-]+$/.test(verify)) return null;
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    if (!pkg.scripts || !(verify in pkg.scripts)) return null;
    return verify === "test" ? { cmd: "npm", args: ["test"] } : { cmd: "npm", args: ["run", verify] };
  } catch {
    return null;
  }
}

function runVerify(root: string, cmd: { cmd: string; args: string[] }, timeoutMs: number): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd.cmd, cmd.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > 64 * 1024) buf = buf.slice(-32 * 1024);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const tail = redactSecrets(buf).trimEnd().split("\n").slice(-30).join("\n");
      resolveP({ ok: code === 0, tail: clipBytes(signal ? `[${signal}]\n${tail}` : tail, VERIFY_TAIL_MAX_BYTES) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, tail: clipBytes(`검증 명령을 실행하지 못했다: ${e.message}`, VERIFY_TAIL_MAX_BYTES) });
    });
  });
}

async function runDelegationInner(
  req: DelegateInput,
  root: string,
  cfg: DelegateConfig = DEFAULT_DELEGATE_CONFIG,
  deps: DelegateDeps = {}
): Promise<DelegateResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const check = validateRequest(req, root);
  if (!check.ok) return reject(check.reason, check.detail);

  const agentName = req.agent ?? cfg.agent;
  const spec = (deps.agents ?? { claude: CLAUDE_SPEC })[agentName];
  if (!spec) return reject("unknown-agent", `지원하지 않는 에이전트: ${agentName}. 지금은 claude 만 연결돼 있다.`);
  if (!(await binaryExists(spec.bin))) return reject("agent-not-installed", `${spec.bin} 실행 파일을 찾지 못했다(which 실패).`);
  if (running) return reject("busy", "다른 위임이 실행 중이다. 끝난 뒤 다시 호출하라(동시 실행 금지).");
  running = true;
  try {
    const id = `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    const dir = join(root, ".harnesside", "state", "delegations", id);
    await mkdir(dir, { recursive: true });
    const taskPath = join(dir, "task.md");
    const logPath = join(dir, "log.txt");
    const review = req.mode === "review";
    const goal = review ? `${req.task.trim()}\n\n[읽기 전용 리뷰] 파일을 수정하지 마라. 문제점(버그·누락·범위 밖 변경)만 근거와 함께 보고하라.` : req.task.trim();
    await writeFile(
      taskPath,
      buildTaskMd({ goal, criteria: req.verify ? [`\`${req.verify}\` 가 성공(exit 0)`] : [], files: check.files, skillChecklists: req.skillChecklists ?? [] }),
      "utf8"
    );

    const before = await snapshotChanges(root);
    const prompt = `작업 명세는 ${taskPath} 에 있다. 먼저 그 파일을 읽고 지시를 정확히 따르라. 대화 없이 끝까지 수행하고, 마지막에 명세의 '최종 출력 형식'만 출력하라.`;
    const child = spawn(spec.bin, spec.buildArgs({ prompt, maxBudgetUsd: cfg.maxBudgetUsd, readOnly: review }), {
      cwd: root, // P6: 작업 디렉터리를 워크스페이스 루트로 고정
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const log = createWriteStream(logPath, { flags: "a" });
    const loop = new LoopDetector();
    let killedBy: "timeout" | "loop" | null = null;
    let finalText = "";
    let lastAssistantText = "";
    let resultSeen = false;
    let carry = "";

    const kill = (why: "timeout" | "loop") => {
      if (killedBy) return;
      killedBy = why;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* 이미 종료 */
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 이미 종료 */
        }
      }, 3000).unref();
    };
    const timer = setTimeout(() => kill("timeout"), cfg.timeoutMs);

    const handleLine = (line: string) => {
      log.write(`${redactSecrets(line)}\n`);
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // stream-json 이 아닌 줄은 로그에만 남는다
      }
      if (ev?.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c?.type === "tool_use" && loop.push(`${c.name}:${JSON.stringify(c.input)}`)) kill("loop");
          if (c?.type === "text" && typeof c.text === "string") lastAssistantText = c.text;
        }
      } else if (ev?.type === "result") {
        resultSeen = true;
        if (typeof ev.result === "string") finalText = ev.result;
      }
    };
    const onChunk = (d: Buffer) => {
      carry += d.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) handleLine(l);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", (d: Buffer) => log.write(`[stderr] ${redactSecrets(d.toString("utf8"))}`));

    const exit = await new Promise<{ code: number | null; spawnError: string | null }>((res) => {
      child.on("error", (e) => res({ code: null, spawnError: e.message }));
      child.on("close", (code) => res({ code, spawnError: null }));
    });
    clearTimeout(timer);
    if (carry.trim()) handleLine(carry);
    await new Promise<void>((r) => log.end(r));
    const logBytes = (await stat(logPath).catch(() => ({ size: 0 }))).size;

    const after = await snapshotChanges(root);
    // 하네스 자신의 산출물(.harnesside/ — 위임 로그·캐시)은 에이전트의 변경이 아니다.
    const changed = diffSnapshots(before, after)?.filter((p) => !p.startsWith(".harnesside/")) ?? null;
    const changedFiles = changed ?? [];
    const scope = new Set(check.files);
    const outOfScope = changed ? changed.filter((p) => !scope.has(p)) : [];
    const base = { changedFiles, outOfScope, logPath, durationMs: now() - started };
    const unknownNote = changed === null ? " (git 저장소가 아니라 변경 파일은 알 수 없다)" : "";
    void logBytes;

    if (killedBy === "timeout") {
      return { ...base, status: "timeout", verify: null, summary: clipBytes(`${Math.round(cfg.timeoutMs / 60000)}분 제한을 넘겨 강제 종료했다. 부분 변경이 남았을 수 있다 — changedFiles 확인.${unknownNote}`, SUMMARY_MAX_BYTES) };
    }
    if (killedBy === "loop") {
      return { ...base, status: "killed", verify: null, summary: clipBytes(`같은 도구 호출이 반복돼(루프) 강제 종료했다. 부분 변경이 남았을 수 있다 — changedFiles 확인.${unknownNote}`, SUMMARY_MAX_BYTES) };
    }
    if (exit.spawnError) {
      return { ...base, status: "error", verify: null, summary: clipBytes(`에이전트를 실행하지 못했다: ${exit.spawnError}`, SUMMARY_MAX_BYTES) };
    }
    const text = finalText || lastAssistantText;
    const block = parseStatusBlock(text);
    if (!resultSeen && exit.code !== 0) {
      return { ...base, status: "error", verify: null, summary: clipBytes(`에이전트가 결과 없이 종료했다(exit ${exit.code}). 로그: ${logPath}`, SUMMARY_MAX_BYTES) };
    }
    if (!block) {
      return { ...base, status: "malformed", verify: null, summary: clipBytes(`최종 STATUS 블록이 없다 — 성공으로 치지 않는다. 마지막 출력: ${text.slice(-600)}`, SUMMARY_MAX_BYTES) };
    }
    if (review && changedFiles.length > 0) {
      return { ...base, status: "error", verify: null, summary: clipBytes(`읽기 전용 리뷰인데 파일이 바뀌었다: ${changedFiles.join(", ")} — 결과를 믿지 말고 git diff 로 확인·복원하라.`, SUMMARY_MAX_BYTES) };
    }
    if (review && block.status === "done") {
      return { ...base, status: "done", verify: null, summary: clipBytes(`${block.body}\n[리뷰: 코드는 바뀌지 않았다]`, SUMMARY_MAX_BYTES) };
    }
    if (block.status !== "done") {
      return { ...base, status: block.status, verify: null, summary: clipBytes(block.body, SUMMARY_MAX_BYTES) };
    }
    // DONE 은 모델의 말이다 — 하네스가 직접 검증한다(P4).
    let verify: DelegateResult["verify"] = null;
    if (req.verify) {
      const cmd = await resolveVerifyCommand(root, req.verify);
      verify = cmd
        ? { recipe: req.verify, ...(await runVerify(root, cmd, cfg.verifyTimeoutMs)) }
        : { recipe: req.verify, ok: false, tail: `package.json 에 '${req.verify}' 스크립트가 없어 검증하지 못했다.` };
    }
    const failed = verify !== null && !verify.ok;
    const note = verify === null ? "\n[미검증: verify 가 지정되지 않았다]" : "";
    return { ...base, status: failed ? "verify-failed" : "done", verify, summary: clipBytes(`${block.body}${note}`, SUMMARY_MAX_BYTES) };
  } finally {
    running = false;
  }
}

export function formatDelegateResult(r: DelegateResult): string {
  return JSON.stringify(r, null, 2);
}

/** X-8: 위임마다 index.jsonl 한 줄. 기록 실패가 위임 결과를 바꾸지 않는다. */
export async function runDelegation(
  req: DelegateInput,
  root: string,
  cfg: DelegateConfig = DEFAULT_DELEGATE_CONFIG,
  deps: DelegateDeps = {}
): Promise<DelegateResult> {
  const r = await runDelegationInner(req, root, cfg, deps);
  try {
    const logBytes = r.logPath ? (await stat(r.logPath).catch(() => ({ size: 0 }))).size : 0;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      agent: req.agent ?? cfg.agent,
      task: req.task.trim().slice(0, 120),
      durationMs: r.durationMs,
      summaryBytes: Buffer.byteLength(r.summary, "utf8"),
      logBytes,
      verify: r.verify ? { recipe: r.verify.recipe, ok: r.verify.ok } : null,
      outOfScope: r.outOfScope.length,
      status: r.status,
    });
    const dir = join(root, ".harnesside", "state", "delegations");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "index.jsonl"), `${line}\n`, "utf8");
  } catch {
    /* 기록은 부가 기능 */
  }
  return r;
}
