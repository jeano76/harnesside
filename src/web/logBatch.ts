/**
 * 로그 스트림을 프레임 단위로 묶어 화면에 반영한다 (P1-4).
 *
 * 왜: `log.append` 는 한 줄당 WS 메시지 하나다. 메시지마다 `setLogs` 를 부르면
 * 최대 2000줄 배열을 줄마다 복사하고 줄마다 렌더한다 — 빌드·`cat` 처럼 한 번에
 * 수백 줄이 쏟아지면 O(줄 × 2000) 복사와 렌더가 쌓여 UI 가 얼어붙는다.
 * 모아 두었다가 한 프레임에 한 번만 합치면 복사·렌더가 프레임 수로 줄어든다.
 */
import type { LogEntry } from "../server/logRing.js";

export const LOG_CAP = 2000;

/** 기존 목록 뒤에 배치를 붙인다. 이미 본 seq(재접속 재전송)는 버리고, 상한을 넘으면 앞을 자른다. */
export function mergeLogs(prev: LogEntry[], batch: LogEntry[], cap = LOG_CAP): LogEntry[] {
  let lastSeq = prev.length > 0 ? prev[prev.length - 1].seq : -Infinity;
  const fresh: LogEntry[] = [];
  for (const e of batch) {
    if (e.seq <= lastSeq) continue;
    fresh.push(e);
    lastSeq = e.seq;
  }
  if (fresh.length === 0) return prev;
  const next = prev.concat(fresh);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * 항목을 모았다가 `schedule` 이 부르는 시점에 한 번에 `flush` 한다.
 * 기본 스케줄은 `requestAnimationFrame` — 숨은 탭에서는 브라우저가 멈추므로
 * 보이지 않는 동안의 렌더도 저절로 생략되고, 돌아오면 쌓인 것을 한 번에 그린다.
 */
export function createBatcher<T>(
  flush: (items: T[]) => void,
  schedule: (cb: () => void) => void = (cb) => requestAnimationFrame(() => cb())
): { push(item: T): void; drain(): void } {
  let buf: T[] = [];
  let pending = false;
  const drain = () => {
    pending = false;
    if (buf.length === 0) return;
    const items = buf;
    buf = [];
    flush(items);
  };
  return {
    push(item: T) {
      buf.push(item);
      if (!pending) {
        pending = true;
        schedule(drain);
      }
    },
    drain,
  };
}
