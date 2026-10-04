import { appendFileSync, mkdirSync, writeSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reported directly: "harnesside 를 윈도우즈 쉘에서 프롬프트를 입력했는데 왜
 * 바로 쉘 프롬프트로 떨어지지?" — with no top-level uncaughtException /
 * unhandledRejection handler anywhere in this codebase, ANY error thrown
 * outside the one try/catch around loop.send() in index.tsx (a React
 * render error, an unawaited rejected promise from a fire-and-forget
 * callback, a Windows-specific spawn/path failure, etc.) hits Node's
 * default handler: print to stderr, then exit. On Windows specifically,
 * an async stdout/stderr write issued right before process exit can be
 * silently dropped (a long-documented Node-on-Windows I/O quirk) — so the
 * crash message itself may never actually reach the screen, and all the
 * user sees is the process vanishing back to the shell prompt with no
 * explanation at all.
 *
 * Fixes for that: write the crash to disk with a SYNCHRONOUS append (never
 * lost to an exit race) before anything else, and print to stderr via a
 * synchronous fd write (fs.writeSync) rather than process.stderr.write,
 * which is also async and subject to the same drop-on-exit risk.
 */

export function formatCrashReport(kind: "uncaughtException" | "unhandledRejection", err: unknown): string {
  const timestamp = new Date().toISOString();
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return `\n[${timestamp}] harnesside fatal error (${kind}):\n${detail}\n`;
}

const CRASH_LOG_RELATIVE_PATH = join(".harnesside", "crash.log");

/** 크래시 로그 경로. 서버·웹이 같은 곳을 본다(두 곳에 두면 어긋난다). */
export function crashLogPath(projectRoot: string): string {
  return join(projectRoot, CRASH_LOG_RELATIVE_PATH);
}

/**
 * 마지막 크래시 꼬리 읽기 (웹 M10 배너용).
 * 없으면 `{ present: false }` — "없음" 을 말한다. 읽기 실패는 `error` 로
 * 말하고 present:false 로 덮지 않는다 (모름을 없음으로 말하지 않는다).
 */
export function readCrashTail(
  projectRoot: string,
  maxChars = 4000
): { present: boolean; tail: string | null; error: string | null } {
  let exists = true;
  try {
    statSync(crashLogPath(projectRoot));
  } catch {
    exists = false;
  }
  if (!exists) return { present: false, tail: null, error: null };
  try {
    const full = readFileSync(crashLogPath(projectRoot), "utf8");
    const tail = full.length > maxChars ? `…(앞 ${full.length - maxChars}자 생략)\n${full.slice(-maxChars)}` : full;
    return { present: true, tail, error: null };
  } catch (e) {
    return { present: false, tail: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Best-effort: a failure to write the crash log must never prevent the
 *  crash message itself from still reaching stderr, and never throw
 *  recursively out of a handler that is itself already handling a crash. */
/** 크래시 로그 상한(바이트). */
export const MAX_CRASH_LOG_BYTES = 2 * 1024 * 1024;

export function writeCrashLogSync(projectRoot: string, report: string): void {
  try {
    mkdirSync(join(projectRoot, ".harnesside"), { recursive: true });
    const path = join(projectRoot, CRASH_LOG_RELATIVE_PATH);
    // **크기 상한** — 같은 오류가 되풀이되면 로그가 끝없이 커진다(2026-10-04: EPIPE 41만 건·263MB).
    // 상한을 넘으면 더 쓰지 않는다: 처음 기록이 원인을 말해 주고, 디스크를 채우지 않는다.
    try {
      if (statSync(path).size > MAX_CRASH_LOG_BYTES) return;
    } catch {
      /* 아직 없다 — 새로 쓴다 */
    }
    appendFileSync(path, report);
  } catch {
    // Nothing more we can do — the stderr write (the handler's other
    // half) is what actually matters if disk access itself is the problem.
  }
}

/** Registers the two process-level crash handlers. `onBeforeExit` restores
 *  the terminal (exitAltScreen) before the report is printed, so the
 *  message lands on the normal screen buffer instead of being swallowed by
 *  (or scribbled over) whatever the alt-screen was still showing. Exits
 *  with code 1 itself — Node's own docs are explicit that resuming normal
 *  operation after uncaughtException is not safe, so this never tries to. */
export function installCrashHandlers(projectRoot: string, onBeforeExit: () => void): void {
  const handle = (kind: "uncaughtException" | "unhandledRejection") => (err: unknown) => {
    try {
      onBeforeExit();
    } catch {
      // Cleanup itself failing must not prevent the report below.
    }
    const report = formatCrashReport(kind, err);
    writeCrashLogSync(projectRoot, report);
    try {
      // fd 2 = stderr. Synchronous, unlike process.stderr.write — the
      // Windows write-dropped-on-exit issue this whole handler exists for.
      writeSync(2, report + `(crash details also saved to ${join(projectRoot, CRASH_LOG_RELATIVE_PATH)})\n`);
    } catch {
      // If even this fails, the crash log (already written above) is the
      // only remaining record — nothing else to fall back to.
    }
    process.exit(1);
  };
  process.on("uncaughtException", handle("uncaughtException"));
  process.on("unhandledRejection", handle("unhandledRejection"));
}
