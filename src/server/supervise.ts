#!/usr/bin/env node
/**
 * 상위 감시기 진입점 — 서버를 자식으로 띄우고 죽으면 정책대로 다시 띄운다 (P13·M10·M12).
 *
 * 쓰는 법: `node dist/server/supervise.js [서버 인자...]`
 * 서버 인자는 그대로 자식에게 넘어간다(`--daemon`·`--no-browser` 등).
 * 감시기 자체 옵션은 `--sv-*` 로만 받는다 — 자식과 섞이면 자식이 오해한다.
 *
 *   --sv-grace <초>        기동 신호 대기. 기본 90.
 *   --sv-max <횟수>        윈도우 내 재시작 상한. 기본 5.
 *   --sv-window <초>       상한을 세는 윈도우. 기본 300.
 *   --sv-base <초>         첫 백오프. 기본 2.
 *   --sv-max-backoff <초>  백오프 상한. 기본 60.
 *   --sv-poll <ms>         프로브 간격. 기본 500.
 *   --help                 이 도움말.
 *
 * 약속:
 *  - 자식은 **빌드 산출물**(`dist/server/index.js`, 이 파일 옆)만 된다.
 *    소스(src 아래 `.ts`)는 node 가 실행하지 못한다 — `npm run build` 부터 하라 말한다.
 *  - 자식에게는 `HARNESSIDE_SUPERVISED=1` 과 포트 파일 경로를 환경으로 넘긴다.
 *    자식은 그 파일에 자기 IDE 포트만 적는다(관측 실패가 부팅을 막지 않는다).
 *  - 기동 신호는 포트 파일+`/api/health startedAt` 둘 다 맞을 때만 인정한다 —
 *    남의 서버를 우리 자식으로 믿지 않는다(`probe.ts`).
 *  - 종료 코드: 0 = 정상 종료·외부 정지, 1 = crash-loop 등으로 멈춤, 2 = 사용법 오류.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supervise, type SupervisorChild } from "./supervisor/runner.js";
import { supervisedHello } from "./supervisor/probe.js";
import { checkUpdateConfirmed, rollbackUpdate } from "./supervisor/upgrade.js";
import { DEFAULT_SUPERVISOR_POLICY } from "./supervisor/policy.js";

export interface SupervisorArgs {
  /** 자식에게 그대로 넘길 인자. */
  childArgs: string[];
  bootGraceSec: number;
  maxRestarts: number;
  windowSec: number;
  backoffBaseSec: number;
  backoffMaxSec: number;
  pollMs: number;
}

/** 인자 파싱 — 순수 함수라 테스트가 된다. `--sv-*` 만 먹고 나머지는 자식 몫이다. */
export function parseSupervisorArgs(argv: string[]): SupervisorArgs {
  const out: SupervisorArgs = {
    childArgs: [],
    bootGraceSec: 90,
    maxRestarts: DEFAULT_SUPERVISOR_POLICY.maxRestarts,
    windowSec: DEFAULT_SUPERVISOR_POLICY.windowSec,
    backoffBaseSec: DEFAULT_SUPERVISOR_POLICY.backoffBaseSec,
    backoffMaxSec: DEFAULT_SUPERVISOR_POLICY.backoffMaxSec,
    pollMs: 500,
  };
  const num = (name: string, raw: string | undefined, set: (v: number) => void): void => {
    if (raw === undefined) throw new Error(`${name} 뒤에 숫자가 없습니다`);
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} 값이 숫자가 아닙니다: ${raw}`);
    set(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--sv-grace") num(a, argv[++i], (v) => (out.bootGraceSec = v));
    else if (a === "--sv-max") num(a, argv[++i], (v) => (out.maxRestarts = v));
    else if (a === "--sv-window") num(a, argv[++i], (v) => (out.windowSec = v));
    else if (a === "--sv-base") num(a, argv[++i], (v) => (out.backoffBaseSec = v));
    else if (a === "--sv-max-backoff") num(a, argv[++i], (v) => (out.backoffMaxSec = v));
    else if (a === "--sv-poll") num(a, argv[++i], (v) => (out.pollMs = v));
    else out.childArgs.push(a);
  }
  return out;
}

function say(line: string): void {
  process.stdout.write(`[supervisor] ${line}\n`);
}

async function fetchHealth(port: number): Promise<{ ok?: unknown; startedAt?: unknown } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    if (!res.ok) return null;
    return (await res.json()) as { ok?: unknown; startedAt?: unknown };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (raw.includes("--help") || raw.includes("-h")) {
    process.stdout.write(
      [
        "harnesside supervisor — 서버를 자식으로 띄우고 죽으면 다시 띄웁니다.",
        "",
        "  node dist/server/supervise.js [서버 인자...] [--sv-grace 90 ...]",
        "",
        "서버 인자는 그대로 자식에게 넘어갑니다. 빌드 산출물(dist)이 있어야 합니다.",
      ].join("\n") + "\n"
    );
    return 0;
  }
  let args: SupervisorArgs;
  try {
    args = parseSupervisorArgs(raw);
  } catch (e) {
    process.stderr.write(`[supervisor] ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // 자식은 옆의 빌드 산출물이다. 소스(.ts)를 node 가 실행하지 못하므로,
  // tsx 로 돌 때는 거부하고 빌드를 요구한다 — 조용히 죽는 자식보다 낫다.
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".ts")) {
    process.stderr.write("[supervisor] 소스로 직접 실행할 수 없습니다 — `npm run build` 후 dist/server/supervise.js 로 실행하십시오.\n");
    return 2;
  }
  const childEntry = join(dirname(here), "index.js");

  const portFile = join(tmpdir(), `harnesside-sv-${process.pid}.port`);
  // 업데이트 위임 경로 — 서버의 stateDir·슬롯·설치 루트와 같은 곳을 본다.
  // 감시기는 자식과 같은 cwd 에서 돈다는 전제다(다르면 포트를 못 찾는다 — 위 probe 와 같은 이유).
  const projectRoot = process.cwd();
  const stateDir = join(projectRoot, ".harnesside", "state");
  const slotsDir = join(stateDir, "update-slots");
  const installRoot = resolve(dirname(childEntry), "..", "..");
  const token = { stop: false };
  let child: ChildProcess | null = null;
  let attemptStart = 0;
  const onSignal = (sig: string): void => {
    if (!token.stop) {
      token.stop = true;
      say(`정지 요청(${sig}) — 자식을 종료하고 끝냅니다.`);
    } else {
      say(`두 번째 정지 요청(${sig}) — 강제 종료합니다.`);
      try {
        child?.kill("SIGKILL");
      } catch {
        /* 이미 없음 */
      }
      process.exit(130);
    }
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const out = await supervise({
    spawn: (attempt) => {
      attemptStart = Date.now();
      // 이전 시도의 포트 파일을 지운다 — 낡은 포트를 읽으면 남의 서버를 본다.
      void rm(portFile, { force: true }).catch(() => undefined);
      const proc: ChildProcess = spawn(process.execPath, [childEntry, ...args.childArgs], {
        stdio: "inherit",
        env: { ...process.env, HARNESSIDE_SUPERVISED: "1", HARNESSIDE_SV_PORT_FILE: portFile },
      });
      child = proc;
      const wrapped: SupervisorChild = {
        pid: proc.pid,
        waitExit: () =>
          new Promise((res) => {
            proc.on("exit", (code, signal) => res({ code, signal }));
            proc.on("error", () => res({ code: null, signal: null }));
          }),
        kill: () => {
          try {
            proc.kill("SIGTERM");
          } catch {
            /* 이미 없음 */
          }
        },
      };
      return wrapped;
    },
    probeHello: () =>
      supervisedHello({
        readPortFile: async () => {
          const rawPort = await readFile(portFile, "utf8").catch(() => null);
          if (rawPort === null) return null;
          const port = Number.parseInt(rawPort.trim(), 10);
          return Number.isInteger(port) ? port : null;
        },
        fetchHealth,
        spawnStartedAt: attemptStart,
      }),
    bootGraceSec: args.bootGraceSec,
    pollMs: args.pollMs,
    policy: {
      maxRestarts: args.maxRestarts,
      windowSec: args.windowSec,
      backoffBaseSec: args.backoffBaseSec,
      backoffMaxSec: args.backoffMaxSec,
    },
    emit: (e) => {
      if (e.type === "started") say(`자식 기동 시도 ${e.attempt}${e.pid ? ` (pid ${e.pid})` : ""}`);
      else if (e.type === "boot-healthy") say(`시도 ${e.attempt} 기동 확인됨`);
      else if (e.type === "boot-failed") say(`시도 ${e.attempt} 기동 실패 — ${e.reason}`);
      else if (e.type === "exited") say(`시도 ${e.attempt} 종료(${e.exit}) — ${e.delaySec}초 뒤 재시작`);
      else if (e.type === "upgrade-restart") say(`시도 ${e.attempt} 업데이트 적용됨 — 새 버전으로 재기동합니다`);
      else if (e.type === "upgrade-confirmed") say(`시도 ${e.attempt} 업데이트 확인됨 — ${e.reason}`);
      else if (e.type === "upgrade-rolled-back") say(`시도 ${e.attempt} 업데이트 실패, 되돌렸습니다 — ${e.detail}`);
      else say(`정지 — ${e.reason}`);
    },
    upgrade: {
      checkConfirmed: () => checkUpdateConfirmed(stateDir),
      rollback: () => rollbackUpdate(stateDir, slotsDir, installRoot),
    },
    stopToken: token,
  });

  await rm(portFile, { force: true }).catch(() => undefined);
  const crashed = !/정상 종료|외부 정지/.test(out.reason);
  say(`종료 — ${out.reason} (시도 ${out.attempts}회)`);
  return crashed ? 1 : 0;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`[supervisor] 치명적 오류: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exit(1);
    }
  );
}
