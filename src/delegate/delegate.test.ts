import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDelegation, DEFAULT_DELEGATE_CONFIG, SUMMARY_MAX_BYTES, type AgentSpec } from "./delegate.js";
import { parseStatusBlock, buildTaskMd } from "./template.js";
import { validateRequest, redactSecrets, LoopDetector } from "./safety.js";

/** 가짜 에이전트: 시나리오별로 stream-json 을 흉내 내는 node 스크립트. 실제 외부 에이전트는 띄우지 않는다. */
const FAKE_SCRIPT = `
const mode = process.argv[2];
const fs = require("node:fs");
const out = (o) => console.log(JSON.stringify(o));
const tool = (name, input) => out({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const done = (text) => out({ type: "result", subtype: "success", result: text });
if (mode === "ok") {
  tool("Edit", { file_path: "a.ts" });
  fs.writeFileSync("a.ts", "export const a = 2;\\n");
  done("작업 끝\\nSTATUS: DONE\\nCHANGED: a.ts\\nVERIFIED: 미검증\\nRISKS: 없음");
} else if (mode === "scope") {
  fs.writeFileSync("a.ts", "export const a = 3;\\n");
  fs.writeFileSync("other.ts", "oops\\n");
  done("STATUS: DONE\\nCHANGED: a.ts, other.ts");
} else if (mode === "loop") {
  for (;;) { tool("Read", { file_path: "a.ts" }); }
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "blocked") {
  done("STATUS: BLOCKED: 해석이 둘이다");
} else if (mode === "nostatus") {
  done("다 했습니다!");
} else if (mode === "secret") {
  out({ type: "assistant", message: { content: [{ type: "text", text: "key sk-ant-abcdefghijklmnop1234 and password=hunter2hunter2" }] } });
  done("STATUS: DONE");
}
`;

function fake(mode: string, script: string): AgentSpec {
  return { name: "fake", bin: "node", buildArgs: () => [script, mode] };
}

async function withProject(fn: (dir: string, script: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-deleg-"));
  try {
    const script = join(dir, "..", `fake-agent-${process.pid}.cjs`);
    await writeFile(script, FAKE_SCRIPT, "utf8");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"", bad: "node -e \"console.log('boom');process.exit(1)\"" } }), "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
    await fn(dir, script);
    await rm(script, { force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TASK = "a.ts 의 상수 a 의 값을 1 에서 2 로 바꿔라. 다른 파일은 건드리지 마라.";

test("정상: DONE 보고 + 하네스가 직접 돌린 verify 통과 → done, 변경 파일·로그 경로가 돌아온다", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"], verify: "check" }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("ok", script) } });
    assert.equal(r.status, "done", r.summary);
    assert.deepEqual(r.changedFiles, ["a.ts"]);
    assert.deepEqual(r.outOfScope, []);
    assert.equal(r.verify?.ok, true);
    assert.ok(Buffer.byteLength(r.summary) <= SUMMARY_MAX_BYTES);
    assert.ok(r.logPath && (await readFile(r.logPath, "utf8")).includes("tool_use"), "전체 로그는 파일로만 간다");
    assert.ok(await readFile(join(r.logPath!, "..", "task.md"), "utf8"), "작업 명세 파일이 남지 않았다");
  }));

test("DONE 이라고 해도 verify 가 실패하면 verify-failed — 모델의 완료 보고를 믿지 않는다", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"], verify: "bad" }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("ok", script) } });
    assert.equal(r.status, "verify-failed");
    assert.equal(r.verify?.ok, false);
    assert.match(r.verify!.tail, /boom/);
  }));

test("없는 verify 스크립트는 '검증하지 못했다' — 통과로 치지 않는다", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"], verify: "nope" }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("ok", script) } });
    assert.equal(r.status, "verify-failed");
    assert.match(r.verify!.tail, /스크립트가 없어/);
  }));

test("verify 를 안 주면 '미검증' 이 요약에 남는다", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("ok", script) } });
    assert.equal(r.status, "done");
    assert.match(r.summary, /미검증/);
  }));

test("범위 밖 파일 변경은 outOfScope 로 드러난다", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("scope", script) } });
    assert.deepEqual(r.outOfScope, ["other.ts"]);
    assert.deepEqual(r.changedFiles, ["a.ts", "other.ts"]);
  }));

test("타임아웃: 응답 없는 에이전트는 강제 종료되고 status=timeout", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"] }, dir, { ...DEFAULT_DELEGATE_CONFIG, timeoutMs: 1500 }, { agents: { fake: fake("hang", script) } });
    assert.equal(r.status, "timeout");
    assert.match(r.summary, /강제 종료/);
  }));

test("루프: 같은 tool 호출이 반복되면 강제 종료되고 status=killed", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"] }, dir, { ...DEFAULT_DELEGATE_CONFIG, timeoutMs: 20_000 }, { agents: { fake: fake("loop", script) } });
    assert.equal(r.status, "killed");
    assert.match(r.summary, /루프/);
  }));

test("모호한 task 는 실행하지 않고 무엇을 구체화할지 돌려준다 (프로세스를 띄우지 않는다)", () =>
  withProject(async (dir, script) => {
    let spawned = false;
    const spec: AgentSpec = { name: "fake", bin: "node", buildArgs: () => { spawned = true; return [script, "ok"]; } };
    for (const [task, files, reason] of [
      ["그거 좀 고쳐줘", ["a.ts"], "vague-task"],
      [TASK, [], "no-files"],
      ["src 아래 안 쓰는 파일을 전부 정리해줘 제발 부탁", ["a.ts"], "destructive-task"],
      [TASK, ["../outside.ts"], "outside-root"],
    ] as const) {
      const r = await runDelegation({ agent: "fake", task, files: [...files] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: spec } });
      assert.equal(r.status, "rejected");
      assert.match(r.summary, new RegExp(reason));
    }
    assert.equal(spawned, false);
  }));

test("BLOCKED 는 이유를 그대로, STATUS 없는 출력은 malformed — 성공으로 치지 않는다", () =>
  withProject(async (dir, script) => {
    const b = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("blocked", script) } });
    assert.equal(b.status, "blocked");
    assert.match(b.summary, /해석이 둘/);
    const m = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("nostatus", script) } });
    assert.equal(m.status, "malformed");
  }));

test("로그의 키·비밀번호는 저장 전에 마스킹된다", () =>
  withProject(async (dir, script) => {
    const r = await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("secret", script) } });
    const log = await readFile(r.logPath!, "utf8");
    assert.ok(!log.includes("abcdefghijklmnop1234") && !log.includes("hunter2hunter2"), log);
    assert.match(log, /\[REDACTED\]/);
  }));

test("없는 에이전트·미설치 바이너리는 rejected", () =>
  withProject(async (dir) => {
    const a = await runDelegation({ agent: "codex", task: TASK, files: ["a.ts"] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: {} });
    assert.equal(a.status, "rejected");
    const spec: AgentSpec = { name: "ghost", bin: "definitely-not-installed-xyz", buildArgs: () => [] };
    const b = await runDelegation({ agent: "ghost", task: TASK, files: ["a.ts"] }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { ghost: spec } });
    assert.equal(b.status, "rejected");
    assert.match(b.summary, /agent-not-installed/);
  }));

test("template: 마지막 STATUS 블록만 파싱하고, 고정 규칙·스킬이 명세에 들어간다", () => {
  const out = "STATUS: DONE (예시 문구)\n그 뒤 대화...\nSTATUS: NEEDS: 새 의존성 필요\nRISKS: x";
  const b = parseStatusBlock(out)!;
  assert.equal(b.status, "needs");
  assert.match(b.body, /새 의존성/);
  assert.equal(parseStatusBlock("그냥 텍스트"), null);
  const md = buildTaskMd({ goal: "g", criteria: ["c1"], files: ["a.ts"], skillChecklists: [{ name: "s", text: "- t" }] });
  assert.match(md, /되물을 수 없다/);
  assert.match(md, /수정 가능: a\.ts/);
  assert.match(md, /### s\n- t/);
  assert.match(md, /STATUS: DONE \| BLOCKED \| NEEDS/);
});

test("safety: 마스킹·루프 감지·요청 검증 단위", () => {
  assert.ok(!redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz").includes("abcdefghijklmnop"));
  assert.ok(!redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123").includes("ghp_abc"));
  const d = new LoopDetector(6, 2);
  const seq = ["a", "b", "c", "d", "e", "f"].map((k) => d.push(k));
  assert.ok(!seq.includes(true), "다양한 호출을 루프로 오판했다");
  const d2 = new LoopDetector(6, 2);
  let hit = false;
  for (let i = 0; i < 6; i++) hit = d2.push(i % 2 ? "x" : "y");
  assert.ok(hit);
  assert.equal(validateRequest({ task: TASK, files: ["src/a.ts"] }, "/w").ok, true);
});

test("X-8: 위임마다 index.jsonl 에 한 줄(상태·소요·크기·검증 결과)이 남는다", () =>
  withProject(async (dir, script) => {
    await runDelegation({ agent: "fake", task: TASK, files: ["a.ts"], verify: "check" }, dir, DEFAULT_DELEGATE_CONFIG, { agents: { fake: fake("ok", script) } });
    const lines = (await readFile(join(dir, ".harnesside", "state", "delegations", "index.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.status, "done");
    assert.equal(row.verify.ok, true);
    assert.ok(row.durationMs >= 0 && row.logBytes > 0 && row.summaryBytes > 0);
  }));
