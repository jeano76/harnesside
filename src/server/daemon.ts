#!/usr/bin/env node
/**
 * harnesside 데몬 명령계 (§3.7.4).
 *
 * 설계 원칙: **TTY 유무와 무관하게 같은 결과**. 사람이 보든 CI 가 보든 같은 출력이 나와야
 * "이건 되네"를 근거로 판단할 수 있다. 색상만 TTY 에서 붙인다.
 *
 * TTY 가 없다는 건 두 가지다:
 *  1) 화면 출력(커서 이동·프로그레스 바)을 하면 `nohup.out` 과 journal 이 지저분해진다
 *  2) 키 입력에 의존하면 데몬으로 돌 수 없다
 *  따라서 전부 NDJSON 한 줄로 쓴다(§3.7.1).
 */

import { readVersion } from "./version.js";
import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogRing, DEFAULTS } from "./logRing.js";

export type DaemonMode = "window" | "daemon";

export interface Paths {
  projectRoot: string;
  stateDir: string;
  instanceLock: string;
  portsFile: string;
  configPath: string;
  credentialsPath: string;
  logFile: string;
  home: string;
}

export function defaultPaths(projectRoot: string = process.cwd(), home = homedir()): Paths {
  const stateDir = join(projectRoot, ".harnesside", "state");
  return {
    projectRoot,
    stateDir,
    instanceLock: join(stateDir, "instance.lock"),
    portsFile: join(stateDir, "ports.json"),
    configPath: join(projectRoot, ".harnesside", "config.yaml"),
    credentialsPath: join(homedir(), ".harnesside", "credentials.json"),
    logFile: join(stateDir, "server.ndjson"),
    home,
  };
}

export interface InstanceRecord {
  pid: number;
  mode: DaemonMode;
  startedAt: string;
  llamaPort?: number;
  idePort?: number;
  llm?: { model?: string; ready?: boolean };
  gpuMode?: string;
}

/** 실행 중인지 판정한다. 락 파일 내용 + PID 생존을 함께 본다. */
export async function readInstance(paths: Paths): Promise<InstanceRecord | null> {
  try {
    const raw = await readFile(paths.instanceLock, "utf8");
    const lines = raw.trim().split("\n");
    const pid = Number.parseInt(lines[0] ?? "", 10);
    const rest = lines.slice(2).join("\n");
    if (!Number.isFinite(pid)) return null;
    return { pid, mode: "window", startedAt: lines[1] ?? "", ...(rest ? JSON.parse(rest) : {}) } as InstanceRecord;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writeInstance(paths: Paths, rec: InstanceRecord): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(
    paths.instanceLock,
    `${rec.pid}\n${rec.startedAt}\n${JSON.stringify({ mode: rec.mode, llamaPort: rec.llamaPort, idePort: rec.idePort, gpuMode: rec.gpuMode })}\n`,
    { mode: 0o600 }
  );
}

export async function clearInstance(paths: Paths): Promise<void> {
  await unlink(paths.instanceLock).catch(() => {});
}

/** §3.7.2: 이미 있으면 새 인스턴스를 띄우지 않는다. */
export async function ensureSingleInstance(paths: Paths): Promise<{ ok: true } | { ok: false; running: InstanceRecord }> {
  const rec = await readInstance(paths);
  if (rec && isAlive(rec.pid)) return { ok: false, running: rec };
  if (rec) {
    // 고아 락 — 서버가 죽었는데 락만 남은 경우. 정리하고 진행한다(사유는 로그에 남는다).
    await clearInstance(paths);
  }
  return { ok: true };
}

// ---- 출력 (§3.7.1) -------------------------------------------------------

const useColor = (): boolean => !!process.stdout.isTTY && process.env.NO_COLOR === undefined;

export function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function emitPlain(msg: string): void {
  // 데몬 상태 보고는 **사람이 읽는 문장**이어야 한다(§11.3: `TypeError: fetch failed`
  // 원문을 띄지 않는다).
  emit(msg);
}

export function colorize(s: string, code: string): string {
  return useColor() ? `[${code}m${s}[0m` : s;
}

export const C = {
  green: (s: string) => colorize(s, "32"),
  red: (s: string) => colorize(s, "31"),
  yellow: (s: string) => colorize(s, "33"),
  dim: (s: string) => colorize(s, "2"),
  bold: (s: string) => colorize(s, "1"),
};

// ---- status (§3.7.4) ------------------------------------------------------

export interface StatusInfo {
  running: boolean;
  pid?: number;
  mode?: DaemonMode;
  uptimeSec?: number;
  llamaPort?: number;
  idePort?: number;
  model?: string;
  gpuMode?: string;
  logFile: string;
  logBytes?: number;
  /** 로그 상한 — 사용자가 "얼마나 더 쌓이냐" 를 물으면 이것이 답이다. */
  logLimits: { maxChars: number; maxLines: number };
}

export async function collectStatus(paths: Paths): Promise<StatusInfo> {
  const rec = await readInstance(paths);
  const running = !!rec && isAlive(rec.pid);
  let logBytes: number | undefined;
  try {
    logBytes = (await stat(paths.logFile)).size;
  } catch {
    // 로그 파일이 아직 없으면 undefined — 0 으로 말하면 "빈 파일" 과 구분되지 않는다
  }
  return {
    running,
    pid: rec?.pid,
    mode: rec?.mode,
    uptimeSec: rec?.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(rec.startedAt)) / 1000)) : undefined,
    llamaPort: rec?.llamaPort,
    idePort: rec?.idePort,
    model: rec?.llm?.model,
    gpuMode: rec?.gpuMode,
    logFile: paths.logFile,
    logBytes,
    logLimits: { maxChars: DEFAULTS.maxChars, maxLines: DEFAULTS.maxLines },
  };
}

export function formatStatus(s: StatusInfo): string {
  const lines: string[] = [];
  lines.push(C.bold("harnesside 상태"));
  if (!s.running) {
    lines.push(`  상태: ${C.dim("실행 중이 아님")}`);
    lines.push(`  로그: ${s.logFile}`);
    lines.push(`  로그 상한: ${s.logLimits.maxChars.toLocaleString()}자 / ${s.logLimits.maxLines.toLocaleString()}줄`);
    return lines.join("\n");
  }
  lines.push(`  상태: ${C.green("실행 중")} (pid ${s.pid}, ${s.mode} 모드, ${s.uptimeSec ?? 0}초)`);
  lines.push(`  llama: ${s.llamaPort ? `http://127.0.0.1:${s.llamaPort}` : C.dim("미정")}`);
  lines.push(`  IDE:   ${s.idePort ? `http://127.0.0.1:${s.idePort}` : C.dim("미정")}`);
  if (s.gpuMode) lines.push(`  브라우저 GPU: ${s.gpuMode}`);
  if (s.model) lines.push(`  모델: ${s.model}`);
  lines.push(`  로그: ${s.logFile}${s.logBytes !== undefined ? ` (${formatBytes(s.logBytes)})` : C.dim(" (없음)")}`);
  lines.push(`  로그 상한: ${s.logLimits.maxChars.toLocaleString()}자 / ${s.logLimits.maxLines.toLocaleString()}줄 ${C.dim("(화면 표시 기준 · §5.12.2)")}`);
  return lines.join("\n");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / 1024 / 1024).toFixed(1)}MiB`;
}

/** `status` 의 기계 판독용 출력(§3.7.4: JSON 1줄). */
export async function statusJson(paths: Paths): Promise<string> {
  // 버전도 함께 — `harnesside --version` 과 같은 정본(Q-7).
  return JSON.stringify({ version: readVersion(), ...(await collectStatus(paths)) });
}

// ---- logs (§3.7.4) -------------------------------------------------------

export interface LogOptions {
  follow?: boolean;
  level?: "debug" | "info" | "warn" | "error";
  since?: string;
  limit?: number;
}

export function parseLogArgs(args: string[]): LogOptions {
  const o: LogOptions = {};
  for (const a of args) {
    if (a === "-f" || a === "--follow") o.follow = true;
    else if (a.startsWith("--level=")) o.level = a.slice(8) as LogOptions["level"];
    else if (a.startsWith("--since=")) o.since = a.slice(8);
    else if (a.startsWith("--limit=")) o.limit = Number(a.slice(8));
  }
  return o;
}

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/**
 * 로그 파일/링에서 지난 항목을 읽는다. 데몬이어도 **관찰은 가능**해야 한다(§3.7.4).
 * 파일이 없으면 빈 출력이 아니라 "아직 로그가 없습니다" 를 말한다 — 아무것도 안
 * 찍는 것과 "로그가 멈춘 것" 은 사용자가 구분할 수 없다.
 */
export function formatEntries(entries: { ts: number; level: string; source: string; scope: string; message: string }[], minLevel?: keyof typeof LEVEL_RANK): string {
  const min = minLevel ? LEVEL_RANK[minLevel] : 0;
  return entries
    .filter((e) => (LEVEL_RANK[e.level as keyof typeof LEVEL_RANK] ?? 20) >= min)
    .map((e) => {
      const t = new Date(e.ts).toISOString().slice(11, 23);
      const tag = e.source === "server" ? "" : `[${e.source}]`;
      return `${t} ${e.level.toUpperCase().padEnd(5)} ${tag}${e.message}`;
    })
    .join("\n");
}

/** 파일 로그를 읽는다. 회전본(`.1` …)은 제외한다 — 최신본만 보면 된다. */
export async function readLogFile(paths: Paths, limit = 200): Promise<string[]> {
  const raw = await readFile(paths.logFile, "utf8").catch(() => null);
  if (raw === null) return [];
  const lines = raw.trimEnd().split("\n");
  return limit > 0 ? lines.slice(-limit) : lines;
}

/**
 * 데몬 로깅 싱글턴을 파일 writer 와 함께 초기화한다.
 *
 * writer 는 append 전용 파일 핸들을 하나 들고 있는다 — 줄마다 open 하면 로그가
 * 많을 때 파일 디스크립터와 syscall 이 지배한다(§3.5.1).
 */
export function initDaemonLogging(paths: Paths, maxChars = DEFAULTS.maxChars, maxLines = DEFAULTS.maxLines) {
  let handle: number | null = null;
  const writer = (line: string) => {
    try {
      if (handle === null) handle = openSync(paths.logFile, "a");
      writeSync(handle, `${line}\n`);
    } catch {
      // 디스크 오류가 로그를 막으면 안 된다 — 데몬은 사람이 보지 않는다
    }
  };
  const ring = getLogRing({ maxChars, maxLines, writer });
  return {
    ring,
    close: () => {
      if (handle !== null) {
        try {
          closeSync(handle);
        } catch {
          // 이미 닫힘
        }
        handle = null;
      }
    },
  };
}

export function ensureStateDir(paths: Paths): Promise<string | undefined> {
  return mkdir(paths.stateDir, { recursive: true });
}
