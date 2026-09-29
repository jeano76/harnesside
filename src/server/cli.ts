#!/usr/bin/env node
/**
 * harnesside CLI (§3.7.4) — 데몬 제어 표면.
 *
 * 부팅 로직은 `index.ts` 가, **명령 해석과 상태 보고는 여기가** 담당한다.
 * 나누는 이유: `harnesside status` 는 서버가 죽었어도 동작해야 한다(읽기 전용).
 * 부팅 코드까지 끌어들이면 "서버가 없으니 상태를 알 수 없다" 는 비참한 상황이 된다.
 */

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
import { parseNdjson } from "./logRing.js";

export const USAGE = `${C.bold("harnesside")} — 로컬 llama.cpp 코딩 에이전트 (웹 IDE)

사용법:
  harnesside [up]            서버 + 창 기동 (기본)
  harnesside up -d           데몬 모드 — 창 없이 계속 실행
  harnesside open            실행 중 서버에 창만 추가
  harnesside status          상태 (JSON 은 --json)
  harnesside logs [-f]       로그 보기 (데몬이어도 가능)
  harnesside down            우아한 종료 (체크포인트 기록 후)
  harnesside doctor          환경 진단

옵션:
  --no-browser    창을 띄우지 않고 서버만 (디버깅용)
  --keep-alive    창을 닫아도 종료하지 않음
  --daemon        = up -d
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
`;

export interface ParsedArgs {
  command: string;
  rest: string[];
  flags: Set<string>;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const known = ["up", "open", "status", "logs", "down", "doctor", "help", "--help", "-h"];
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

export async function cmdDoctor(paths: Paths): Promise<number> {
  const s = await collectStatus(paths);
  emit(C.bold("harnesside doctor"));
  emit(`  서버: ${s.running ? C.green("실행 중") : C.dim("정지")}`);
  emit(`  로그 상한: ${s.logLimits.maxChars.toLocaleString()}자 / ${s.logLimits.maxLines.toLocaleString()}줄`);
  emit(`  로그 파일: ${s.logFile}`);
  const { execFile } = await import("node:child_process");
  const probe = (cmd: string, args: string[]) =>
    new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile(cmd, args, { timeout: 8000 }, (err, stdout) =>
        resolve({ ok: !err, out: String(stdout).trim() })
      );
    });

  // llama-server 위치는 **이미 있는 탐색 규칙** 을 재사용한다. 여기서 경로를
  // 하드코딩하면(했다 — `/home/jeano/...`) 이 저장소를 클론한 다른 사람의
  // `doctor` 가 "찾을 수 없음" 을 말하고, 어디가 잘못됐는지 아무도 모른다.
  const { findLlamaServer } = await import("../setup/llamaCpp.js");
  const llama = await findLlamaServer();
  emit(llama ? `  llama-server: ${C.green(llama.binPath)}` : `  llama-server: ${C.red("찾을 수 없음")}`);

  for (const [label, cmd, args] of [["chrome", "google-chrome", ["--version"]]] as const) {
    const r = await probe(cmd, [...args]);
    emit(`  ${label}: ${r.ok ? C.green(r.out.split("\n")[0]) : C.red("찾을 수 없음")}`);
  }
  const gpu = await probe("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"]);
  emit(`  VRAM 여유: ${gpu.ok ? `${gpu.out} MiB` : C.dim("GPU 없음")}`);
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
  if (command === "status") return cmdStatus(paths, json);
  if (command === "logs") return cmdLogs(paths, rest);
  if (command === "down") return cmdDown(paths);
  if (command === "doctor") return cmdDoctor(paths);
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
