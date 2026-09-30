/**
 * WS 이벤트 구독 (단일 소켓 공유).
 *
 * 앱은 WS 를 **하나만** 연다(재연결·백오프·epoch 규칙이 거기에 있으므로). 패널이
 * 자기 소켓을 하나씩 더 열면:
 *  - 소켓 수만큼 재연결 타이머가 생기고(서버가 끊기면 그만큼 늘어난다)
 *  - **PTY 출력을 놓친다** — 다른 패널이 탭을 닫으면 남은 소켓의 출처를 알 수 없다
 *
 * 그래서 앱의 `WsClient` 하나가 여기서 **모든 패널에** 전달한다. 구독은 해제 가능해야
 * 한다 — 남은 구독자가 패널을 붙들면 메모리가 새고, 다음 실행에서 버퍼가 읽힌다.
 */

export type WsEvent = Record<string, unknown>;
export type WsSubscriber = (ev: WsEvent) => void;

const subs = new Set<WsSubscriber>();

/** 앱의 유일한 WS 수신자가 이것을 부른다. */
export function dispatchWs(ev: WsEvent): void {
  for (const fn of subs) {
    try {
      fn(ev);
    } catch {
      // 한 패널의 오류가 **다른 패널의 스트림을 죽이면 안 된다.**
      // 터미널 화면이 터져도 로그 패널은 계속 굴러야 한다.
    }
  }
}

export function subscribeWs(fn: WsSubscriber): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function wsSubscriberCount(): number {
  return subs.size;
}
