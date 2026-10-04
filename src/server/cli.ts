#!/usr/bin/env node
/**
 * harnesside CLI (§3.7.4) — 데몬 제어 표면.
 *
 * 부팅 로직은 `index.ts` 가, **명령 해석과 상태 보고는 여기가** 담당한다.
 * 나누는 이유: `harnesside status` 는 서버가 죽었어도 동작해야 한다(읽기 전용).
 * 부팅 코드까지 끌어들이면 "서버가 없으니 상태를 알 수 없다" 는 비참한 상황이 된다.
 */

import { readVersion } from "./version.js";
import {
  defaultPaths,
  collectStatus,
  formatStatus,
  statusJson,
  ensureSingleInstance,
  clearInstance,
  parseLogArgs,
  readLogFile,
  emit,
  C,
  type Paths,
} from "./daemon.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseNdjson } from "./logRing.js";

export const USAGE = `${C.bold("harnesside")} — 로컬 llama.cpp 코딩 에이전트 (웹 IDE)

사용법:
  harnesside [up]            서버 + 창 기동 (기본)
  harnesside up -d           데몬 모드 — 창 없이 계속 실행
  harnesside open            실행 중 서버에 창만 추가
  harnesside status          상태 (JSON 은 --json)
  harnesside logs [-f]       로그 보기 (데몬이어도 가능)
  harnesside down            우아한 종료 (체크포인트 기록 후)
  harnesside doctor          환경 진단 (읽기 전용 · 아래 판정을 그대로 보여준다)
  harnesside version         버전 (= --version, package.json 의 version)
  harnesside doctor --install  없으면 설치 · 모델이 없으면 받는다 [포트]

doctor 가 보는 것 (모르는 것은 "미확인" 으로 적는다 — 0 이나 false 로 채우지 않는다):
  Node 버전(major.minor · engines 대조) · 단말 capability 5종과 단말 이름
  포트 3상태(비어 있음 / 우리가 씀 / 다른 프로그램) — 웹 7317 · llama 8080 · CDP 9222
  dist 가 src 보다 오래됐는가 · 설정(스키마 버전 · 비밀은 이름만) · 모델 파일
doctor 는 **아무것도 고치지 않는다.** 손대려면 doctor --install 뿐이다.

옵션:
  --install      doctor 와 함께 판정에 이어 설치·수령한다 (이것만 손댄다)
  --no-browser    창을 띄우지 않고 서버만 (디버깅용)
  --daemon        = up -d
  --version       버전만 출력
  --dry           12단계만 출력, 부수효과 없음
  --json          status 를 JSON 1줄로
  --level=LEVEL   logs 필터 (debug|info|warn|error)
  --since=ISO     logs 는 해당 시각 이후만
  --limit=N       logs 마지막 N줄
  -f, --follow    logs 실시간 추적

환경변수:
  HARNESSIDE_MODELS_DIR       모델 디렉터리 (프로젝트에 두지 않는다)
  HARNESSIDE_LLAMA_SERVER      llama-server 바이너리 경로
  HARNESSIDE_CDP_PORT          Chrome CDP 포트 (기본 9222)
  HARNESSIDE_CHROME_NO_SANDBOX=1  샌드박스 해제 (보안 경계 약화 — 위험)
  HARNESSIDE_GPU_MODE            브라우저 GPU 모드 강제 (off|budgeted|full)
`;

export interface ParsedArgs {
  command: string;
  rest: string[];
  flags: Set<string>;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const known = ["up", "open", "status", "logs", "down", "doctor", "version", "help", "--help", "-h"];
  const first = argv[0];
  const command = first && known.includes(first) ? first : "up";
  const rest = command === "up" && first && !known.includes(first) ? argv : argv.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  return { command, rest, flags, json: flags.has("--json") };
}

export async function cmdStatus(paths: Paths, json: boolean): Promise<number> {
  const s = await collectStatus(paths);
  if (json) {
    emit(await statusJson(paths));
    return 0;
  }
  emit(formatStatus(s));
  // 종료 코드로도 알린다 — 스크립트가 쓸 수 있게(0=실행 중, 3=정지).
  return s.running ? 0 : 3;
}

export async function cmdLogs(paths: Paths, rest: string[]): Promise<number> {
  const o = parseLogArgs(rest);
  const lines = await readLogFile(paths, o.limit ?? 200);
  if (lines.length === 0) {
    // 아무것도 안 찍으면 "로그가 멈췄다" 와 구분되지 않는다.
    emit(C.dim(`로그가 아직 없습니다: ${paths.logFile}`));
    return 0;
  }
  const entries = lines
    .map((l) => parseNdjson(l))
    .filter((e): e is NonNullable<typeof e> => e !== null);
  const min = o.level;
  const shown = min
    ? entries.filter((e) => rankOf(e.level) >= rankOf(min))
    : entries;
  for (const e of shown) {
    const t = new Date(e.ts).toISOString().slice(11, 23);
    const tag = e.source === "server" ? "" : `[${e.source}]`;
    emit(`${t} ${e.level.toUpperCase().padEnd(5)} ${tag}${e.message}`);
  }
  if (o.follow) {
    // tail -F: 새 줄만 계속 찍는다. 파일 부재를 "끝"으로 보지 않는다(로그는 나중에 생긴다).
    let pos = (await readLogFile(paths, 0)).length;
    const { watch } = await import("node:fs");
    const w = watch(paths.logFile, { persistent: true }, (_ev, _name) => {
      void (async () => {
        const all = (await readLogFile(paths, 0)).slice(pos);
        pos += all.length;
        for (const l of all) {
          const e = parseNdjson(l);
          if (!e) continue;
          if (min && rankOf(e.level) < rankOf(min)) continue;
          const t = new Date(e.ts).toISOString().slice(11, 23);
          const tag = e.source === "server" ? "" : `[${e.source}]`;
          emit(`${t} ${e.level.toUpperCase().padEnd(5)} ${tag}${e.message}`);
        }
      })();
    });
    emit(C.dim("(추적 중 — Ctrl+C 로 종료)"));
    await new Promise<void>((resolve) => {
      const stop = () => {
        w.close();
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  }
  return 0;
}

function rankOf(level: string): number {
  return { debug: 10, info: 20, warn: 30, error: 40 }[level] ?? 20;
}

export async function cmdDown(paths: Paths): Promise<number> {
  const { readInstance, isAlive } = await import("./daemon.js");
  const rec = await readInstance(paths);
  if (!rec || !isAlive(rec.pid)) {
    await clearInstance(paths);
    emit(C.dim("실행 중인 서버가 없습니다"));
    return 3;
  }
  // 우아한 종료: SIGTERM 을 주고 잠깐 기다린다. 그래도 있으면 승격한다(§4.4).
  emit(`종료 신호를 보냅니다 (pid ${rec.pid})…`);
  try {
    process.kill(rec.pid, "SIGTERM");
  } catch (e) {
    emit(C.yellow(`신호를 보내지 못했습니다: ${String(e)}`));
    return 1;
  }
  for (let i = 0; i < 50; i++) {
    if (!isAlive(rec.pid)) {
      await clearInstance(paths);
      emit(C.green("종료되었습니다"));
      return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  emit(C.yellow("10초 안에 종료되지 않아 SIGKILL 합니다"));
  try {
    process.kill(rec.pid, "SIGKILL");
  } catch {
    // 이미 죽음
  }
  await clearInstance(paths);
  return 0;
}

/**
 * 진단. `--install` 을 주면 판정에 이어 **그 판단대로** 설치·수령한다.
 *
 * 판정과 실행이 같은 함수(`planFirstRun`) 를 쓴다는 게 요점이다. 두 경로를 따로 만들면
 * "확인하러 왔더니 20GB 를 받았다" 가 된다 — 실제로 그랬다(§setup/bootstrap.ts).
 */
export async function cmdDoctor(
  paths: Paths,
  opts: { install?: boolean; llamaPort?: number } = {},
): Promise<number> {
  const s = await collectStatus(paths);
  emit(C.bold("harnesside doctor"));
  emit(`  서버: ${s.running ? C.green("실행 중") : C.dim("정지")}`);
  emit(`  로그 상한: ${s.logLimits.maxChars.toLocaleString()}자 / ${s.logLimits.maxLines.toLocaleString()}줄`);
  emit(`  로그 파일: ${s.logFile}`);

  // 판정 규칙은 `doctorChecks.ts` 에 있다(2026-10-04 · Q-13). 여기 있는 건 출력뿐이다.
  // **판정을 이 함수 안에 박아두면** 브라우저·포트·설정을 실제로 만지지 않고
  // 결과를 조작해 검사할 방법이 사라진다(그래서 순수 판정 + 주입 가능한 I/O 로 나눴다).
  const { collectDoctorChecks, formatCheck, nextActions, countUnknown } = await import("./doctorChecks.js");
  const checks = await collectDoctorChecks({
    projectRoot: paths.projectRoot,
    home: homedir(),
    configPath: paths.configPath,
    // 포트 판정의 최우선 근거: **인스턴스 파일에 적힌 우리 pid**. 명령줄 매칭은
    // 설치 경로에 따라 틀릴 수 있지만 이건 우리가 직접 쓴 값이다.
    serverPid: s.running ? s.pid : undefined,
  });
  emit(C.bold("판정"));
  for (const c of checks) emit(formatCheck(c));

  // llama-server 상태는 **판정 정본**(`firstRun.inspectLlama`) 을 쓴다. 여기서
  // `findLlamaServer` 만 부르면 **세 경우 중 하나가 사라진다** — "떠 있는 서버" 를
  // doctor 가 "찾을 수 없음" 으로 말한다. 실제로 그랬다.
  const { inspectLlama } = await import("../setup/firstRun.js");
  const llamaState = await inspectLlama({ home: homedir() }).catch(() => null);
  if (llamaState?.situation === "running") {
    emit(`  llama-server: ${C.green(`실행 중 — ${llamaState.running!.baseUrl} (${llamaState.running!.model})`)}`);
  } else if (llamaState?.situation === "installed") {
    emit(`  llama-server: ${C.green(llamaState.llama!.binPath)} ${C.dim("(설치됨 · 미구동)")}`);
  } else {
    emit(`  llama-server: ${C.red("찾을 수 없음")} ${C.dim("— 'harnesside doctor --install' 로 설치할 수 있습니다")}`);
  }

  // 설치가 명시적으로 요청됐을 때만 손댄다. 기본 `doctor` 는 **읽기 전용**이다.
  if (opts.install) {
    emit("");
    emit(C.bold("설치"));
    const { planFirstRun } = await import("../setup/firstRun.js");
    const plan = await planFirstRun({
      llamaPort: opts.llamaPort,
      modelsDir: process.env.HARNESSIDE_MODELS_DIR ?? join(homedir(), ".harnesside", "models"),
      home: homedir(),
      allowInstall: true,
      log: (line) => emit(`  ${C.dim(line)}`),
    });
    for (const r of plan.reasons) emit(`  ${r}`);
    for (const e of plan.errors) emit(`  ${C.red(e)}`);
    emit(
      plan.ok
        ? `  ${C.green("준비됨")} — llama 포트 ${plan.llamaPort}` +
            (plan.llama ? ` · ${plan.llama.binPath}` : "") +
            (plan.downloaded ? ` · 모델 ${plan.downloaded.file}` : "")
        : `  ${C.red("준비되지 않음")} — 위 사유를 확인하십시오`,
    );
    for (const line of plan.errors) return 1;
  }

  const { execFile } = await import("node:child_process");
  const probe = (cmd: string, args: string[]) =>
    new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile(cmd, args, { timeout: 8000 }, (err, stdout) =>
        resolve({ ok: !err, out: String(stdout).trim() })
      );
    });

  for (const [label, cmd, args] of [["chrome", "google-chrome", ["--version"]]] as const) {
    const r = await probe(cmd, [...args]);
    emit(`  ${label}: ${r.ok ? C.green(r.out.split("\n")[0]) : C.red("찾을 수 없음")}`);
  }
  const gpu = await probe("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"]);
  // GPU 조회가 실패하면 "없음" 이 아니라 **미확인**이라고 말한다. 구 명령은
  // 실패를 "GPU 없음" 으로 바꿔 적었다 — 그건 다른 사실이다(조회 실패 ≠ GPU 없음).
  emit(
    `  VRAM 여유: ${gpu.ok ? `${gpu.out} MiB` : C.dim("미확인 — GPU 없음인지 조회 실패인지 이 출력만으로는 구분되지 않음")}`,
  );

  // 요구(Q-13): 출력에 **사용자가 다음에 할 수 있는 행동**이 1개 이상 있어야 한다.
  // "모든 것이 정상" 이어도 아무것도 안 말하는 게 아니라, 남은 행동만 말한다.
  const actions = nextActions(checks);
  emit("");
  emit(C.bold("다음에 할 수 있는 것"));
  if (actions.length === 0) {
    emit(`  ${C.green("없음 — 이 항목에서 고칠 것이 없습니다")}`);
  } else {
    for (const a of actions) emit(`  ${a}`);
  }
  const unknown = countUnknown(checks);
  if (unknown > 0) {
    emit(`  ${C.dim(`미확인 ${unknown}건 — 위 목록에서 "미확인" 으로 적힌 항목은 측정하지 못했다는 뜻입니다 (0 이나 false 가 아닙니다)`)}`);
  }
  return 0;
}

/** `status`/`logs`/`down`/`doctor` 는 부팅 없이 동작한다(읽기 전용 경로). */
export async function runStandalone(argv: string[]): Promise<number | null> {
  const paths = defaultPaths();
  const { command, rest, flags, json } = parseArgs(argv);
  if (flags.has("--help") || flags.has("-h") || command === "help") {
    emit(USAGE);
    return 0;
  }
  // `--version` · `version` — 정본은 package.json(Q-7). 부팅하지 않는다(예전엔 `--version` 이 서버를 띄우려 했다).
  if (command === "version" || flags.has("--version")) {
    emit(readVersion());
    return 0;
  }
  if (command === "status") return cmdStatus(paths, json);
  if (command === "logs") return cmdLogs(paths, rest);
  if (command === "down") return cmdDown(paths);
  if (command === "doctor") {
    // `--install` 은 **판정만 하는 경로와 같은 코드** 를 쓴다. 확인만 하려는데
    // cmake 가 돌아가거나 20GB 가 다운로드되면 그건 "진단" 이 아니다.
    // 포트는 **숫자로만** 받는다. 문자열을 그대로 넘기면 나중에 `-DGGML_CUDA` 같은
    // 인자가 포트로 들어가 조용히 이상한 설정이 된다.
    const portArg = rest.find((r) => /^\d+$/.test(r));
    return cmdDoctor(paths, { install: flags.has("--install"), llamaPort: portArg ? Number(portArg) : undefined });
  }
  if (command === "open") {
    // 이미 떠 있으면 창만 추가한다(§3.2 [1]).
    const { readInstance, isAlive } = await import("./daemon.js");
    const rec = await readInstance(paths);
    if (rec && isAlive(rec.pid)) {
      emit(C.green(`이미 실행 중입니다 (pid ${rec.pid}) — 창을 추가하려면 서버에 open 이벤트를 보냅니다.`));
      return 0;
    }
    emit(C.yellow("실행 중인 서버가 없습니다. 먼저 `harnesside up -d` 로 시작하세요."));
    return 3;
  }
  return null; // up 은 index.ts 가 처리
}

export async function guardSingleInstance(paths: Paths): Promise<number | null> {
  const r = await ensureSingleInstance(paths);
  if (r.ok) return null;
  emit(C.yellow(`이미 실행 중입니다 (pid ${r.running.pid}, ${r.running.mode} 모드)`));
  emit(C.dim("  새 인스턴스를 띄우지 않습니다 — 포트와 VRAM 을 두 개가 나눠 쓰게 됩니다."));
  emit(C.dim("  창만 추가: harnesside open    종료: harnesside down"));
  return 1;
}
