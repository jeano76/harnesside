/**
 * 닫힌 파이프(EPIPE)에 쓰다가 서버가 **스스로를 무한히 기록하며 죽는** 사고를 막는다.
 *
 * 사고(2026-10-04, 크래시 로그 2.7억 자): 부모가 stdout 을 닫으면(`nohup … > /dev/null` 이 아니라 닫힌 파이프·
 * 끊긴 터미널) `process.stdout.write` 가 `write EPIPE` 를 **비동기 `error` 이벤트**로 낸다 → 처리기가 없으니
 * `uncaughtException` → 그 처리기가 `emit()`(= 같은 stdout 에 쓰기)을 부른다 → 또 EPIPE → 또 `uncaughtException`
 * … 한 줄이 수천만 번 크래시 로그에 쌓였다. 고치는 곳은 셋이다: 스트림 `error` 를 삼킨다 · 쓰기를 방어한다 ·
 * 예외 처리기가 EPIPE 를 "치명적" 으로 보지 않는다.
 */

/** 이 오류가 "상대가 이미 닫았다" 인가 — 서버가 죽을 이유가 아니다. */
export function isBrokenPipe(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET";
}

type Writable = {
  write: (s: string) => unknown;
  on: (ev: "error", fn: (e: unknown) => void) => unknown;
  destroyed?: boolean;
  writable?: boolean;
};

/** stdout/stderr 의 `error` 를 삼킨다(처리기가 없으면 uncaughtException 이 된다). */
export function installPipeGuard(streams: Writable[]): void {
  for (const s of streams) s.on("error", () => { /* EPIPE 등 — 출력이 끊겨도 서버는 계속 일한다 */ });
}

/** 쓰기가 던지거나 닫힌 스트림이면 **조용히 버린다** — 로그를 못 쓴다고 서버가 죽으면 안 된다. */
export function safeWrite(s: Writable, text: string): boolean {
  if (s.destroyed === true || s.writable === false) return false;
  try {
    s.write(text);
    return true;
  } catch {
    return false;
  }
}
