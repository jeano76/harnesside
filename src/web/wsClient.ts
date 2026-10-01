/**
 * WS 클라이언트 (§2.3).
 *
 * 재접속 규칙이 이 파일의 전부다: 창은 닫혔다 다시 열리고, 서버는 오래 산다.
 * 그래서 **연결이 흔들려도 화면이 흔들리면 안 된다**(§5.10: WS 재연결은 메모리
 * 상태를 유지하므로 세션을 재적재하지 않는다 — 화면이 통째로 바뀌면 안 된다).
 */

import { wsUrl } from "./session.js";

export interface WsClientOptions {
  port: number;
  token: string | null;
  onEvent: (ev: Record<string, unknown>) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
  WebSocketImpl?: typeof WebSocket;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private epoch: string | null = null;
  private lastSeq = 0;
  private backoff = 500;
  private closed = false;
  private timer: number | null = null;

  constructor(private opts: WsClientOptions) {}

  /**
   * **현재 소켓** — 테스트와 진단용 (2026-10-01).
   *
   * 왜 필요한가: `ws` 는 private 이라 소켓을 **떼어내서** 이벤트 중복을 재현할 수
   * 없었다. 그럼 검사는 "창이 다시 붙으면 어떻게 되나" 를 **관찰**만 하다가 통과한다 —
   * 실제 버그(같은 이벤트가 두 번 적용)를 **만들 수 없다** 는 뜻이다.
   *
   * **쓰지 않는다** — 프로덕션 경로가 아니라 관찰 창구다. 공개하되, 여기서
   * 상태를 바꾸지 않는다(바꾸면 중복 판정 규칙과 어긋난다).
   */
  get socket(): WebSocket | null {
    return this.ws;
  }

  connect(): void {
    if (this.closed) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    this.opts.onStatus?.("connecting");
    try {
      this.ws = new Impl(wsUrl(this.opts.token, this.opts.port));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoff = 500;
      this.opts.onStatus?.("open");
      // 이어받기를 요청한다. 서버가 끊긴 동안 쌓인 이벤트를 흘려보낸다.
      if (this.lastSeq > 0) this.send({ type: "sinceSeq", since: this.lastSeq });
    };
    this.ws.onmessage = (e: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "") as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof msg.epoch === "string") {
        // 다른 인스턴스의 seq 와 섞이면 안 된다.
        if (this.epoch && this.epoch !== msg.epoch) this.lastSeq = 0;
        this.epoch = msg.epoch;
      }
      // **중복은 여기서 버린다** (2026-10-01).
      //
      // 예전엔 `lastSeq` 를 **기록만** 하고 무조건 `onEvent` 를 불렀다. 그 결과
      // **같은 이벤트가 두 번 적용**됐다 — 사용자가 셸 명령 하나를 보냈는데
      // 같은 블록이 두 개 떴다(실측).
      //
      // 왜 서버의 `seq > since` 필터로 안 막히나: 그 필터는 `sinceSeq` 를 **보낸 뒤**의
      // 재생에만 걸린다. 재연결 중 **이미 도착한** 이벤트는 다시 흘러온다. 그리고
      // `appendToBlock` 의 `tool` 은 `streamable` 이 아니라 **항상 새 블록**을 만들기
      // 때문에, 두 번 적용되면 화면에는 **명령이 두 개**로 보인다.
      //
      // **되감긴 seq 도 버린다** — seq 는 순서표지니 뒤로 간 것은 이미 본 것이거나
      // 오래된 것이다. 반대로 **`seq` 가 없는 이벤트는 버리지 않는다** — 계측·제어
      // 메시지에 seq 가 없을 수 있고, 그것을 버리면 로그가 조용히 사라진다.
      if (typeof msg.seq === "number") {
        if (msg.seq <= this.lastSeq) return; // 이미 본 것 — 재생이지 새 이벤트가 아니다
        this.lastSeq = msg.seq;
      }
      this.opts.onEvent(msg);
    };
    this.ws.onclose = () => {
      this.opts.onStatus?.("closed");
      this.ws = null;
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      // onclose 가 이어서 오므로 재연결은 거기서만 한다(중복 예약 방지).
    };
  }

  /** 지수 백오프. 창을 닫았다 여는 게 아니라 **네트워크가 흔들린 것**이다. */
  private scheduleReconnect(): void {
    if (this.closed || this.timer !== null) return;
    const delay = Math.min(this.backoff, 15_000);
    this.backoff = Math.min(this.backoff * 2, 15_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay) as unknown as number;
  }

  send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  get connected(): boolean {
    return this.ws?.readyState === 1;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.ws?.close();
    } catch {
      // 이미 닫힘
    }
    this.ws = null;
  }
}
