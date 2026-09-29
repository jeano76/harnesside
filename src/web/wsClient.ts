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
      if (typeof msg.seq === "number" && msg.seq > this.lastSeq) this.lastSeq = msg.seq;
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
