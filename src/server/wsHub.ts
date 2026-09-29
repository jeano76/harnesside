/**
 * WebSocket 허브 (§2.3) — 서버 → 클라이언트 단방향 이벤트.
 *
 * 왜 지금 만드는가: 로그 패널을 2초 폴링으로 붙여두면 "상시 출력" 요구는 성립하지만
 * **흐름이 끊긴다**(요청 간격만큼). 그리고 이벤트 종류가 늘어날 때마다 폴링을
 * 곱해야 한다. 허브를 지금 만드는 것이 구조적으로 가장 싸다(§12 순서 경고 3).
 *
 * 세 가지 계약을 여기서 한 번만 정한다:
 *  1) **이벤트는 `type` 필드를 가진 JSON**이다(§2.3). 새 이벤트를 추가해도
 *     클라이언트 코드는 분기를 하나 늘리는 것으로 끝난다.
 *  2) **`epoch` + `seq`** 로 재접속을 이어받는다. 연결이 끊겨도 흐름이 끊기지 않아야 한다.
 *  3) **느린 클라이언트 때문에 서버가 막히지 않는다.** 큐가 차면 오래된 것부터
 *     버린다 — 새 정보가 더 중요하다.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";

export type EventType =
  | "hello"
  | "agent.state"
  | "agent.reasoning.delta"
  | "agent.text.delta"
  | "agent.tool.call"
  | "agent.tool.result"
  | "agent.turn.end"
  | "log.append"
  | "log.status"
  | "notice.push"
  | "update.state"
  | "fs.changed"
  | "sys.metrics"
  | "sys.logs"
  | "pong";

export interface ServerEvent {
  type: EventType;
  [k: string]: unknown;
}

export interface WsHubOptions {
  server: Server;
  path?: string;
  /** 부팅 시각(epoch). 재접속 시 이전 인스턴스와 구분한다. */
  epoch?: string;
  /** 연결당 최대 대기 이벤트 수. 넘으면 오래된 것부터 버린다. */
  maxQueue?: number;
  onConnect?: (ws: WebSocket) => void;
  /**
   * 마지막 클라이언트가 떠났을 때 한 번만 부른다.
   *
   * S3(하트비트 만료)의 기준점을 밖에서 알 수 있게 해 주는 경로다. "창이 연결되었다" 만
   * 말하고 "떠났다" 를 말하지 않으면, 그 뒤의 모든 판정이 **시작을 알 수 없다** —
   * S3 도 유휴 정책도 기준점이 없으면 못 센다.
   */
  onDisconnect?: () => void;
  onMessage?: (msg: Record<string, unknown>, ws: WebSocket) => void;
}

interface Client {
  ws: WebSocket;
  /** 아직 못 보낸 이벤트(느린 클라이언트 보호). */
  queue: string[];
  alive: boolean;
}

export class WsHub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private seq = 0;
  private epoch: string;
  private maxQueue: number;
  /** 최근 이벤트(재접속 재생용). */
  private ring: { seq: number; payload: string }[] = [];
  private ringMax = 2000;
  /** 한 번이라도 클라이언트가 붙었는가. **S3 판정의 전제** 다. */
  private sawClient = false;
  /** 마지막 클라이언트가 사라진 시각. 살아 있는 동안에는 null. */
  private lastClientGoneAt: number | null = null;

  constructor(private opts: WsHubOptions) {
    this.epoch = opts.epoch ?? new Date().toISOString();
    this.maxQueue = opts.maxQueue ?? 1000;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  /** http.Server 의 upgrade 를 가로챈다(인증은 httpServer 가 먼저 검사한 뒤 위임한다). */
  handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): boolean {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== (this.opts.path ?? "/ws")) return false;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    return true;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = { ws, queue: [], alive: true };
    this.clients.add(client);
    this.sawClient = true;
    this.lastClientGoneAt = null;
    this.opts.onConnect?.(ws);

    // hello 에 이어 붙여 **재생을 요청받는다**: 클라이언트가 sinceSeq 를 보내면
    // 그 뒤부터 흘려보낸다(연결이 끊겨도 흐름이 이어진다 — §5.12.1).
    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        // 역직렬화 실패가 한 연결 전체를 죽이면 안 된다(격리).
        return;
      }
      if (msg.type === "sinceSeq") {
        const since = Number(msg.since ?? 0);
        for (const r of this.ring) if (r.seq > since) this.enqueue(client, r.payload);
        return;
      }
      this.opts.onMessage?.(msg, ws);
    });

    const heartbeat = setInterval(() => {
      if (client.alive) {
        client.alive = false;
        try {
          ws.ping();
        } catch {
          // 이미 닫힘
        }
      } else {
        // 한 번 응답이 없으면 끊는다. 창이 멈춘 채로 소켓만 남아 있는 상태를 막는다.
        this.remove(client);
      }
    }, 10_000);
    // unref: 이 타이머가 **프로세스 종료를 붙잡으면 안 된다.** 데몬은 창이 모두 닫히면
    // 그대로 끝나야 하고, 테스트도 이 타이머 때문에 매달린다(실제로 그랬다).
    heartbeat.unref?.();

    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      this.remove(client);
    });
    ws.on("error", () => {
      clearInterval(heartbeat);
      this.remove(client);
    });

    // hello 를 먼저 보낸다. seq 는 **지금 값** — 클라이언트가 이걸 기준으로 이후
    // 이벤트만 받는다(빈 구간을 재전송하지 않기 위해 publish 경로가 아니라 직접 보낸다).
    try {
      ws.send(JSON.stringify({ type: "hello", epoch: this.epoch, seq: this.seq }));
    } catch {
      this.remove(client);
    }
  }

  private remove(c: Client): void {
    c.alive = false;
    this.clients.delete(c);
    // **마지막 클라이언트가 사라진 시각**을 기록한다(S3 하트비트 만료의 기준점).
    // 살아 있는 클라이언트가 남아 있으면 기준점을 지운다 — "한 명도 없다" 의 시작은
    // 마지막 사람이 나간 그때부터다.
    if (this.clients.size === 0) {
      this.lastClientGoneAt = Date.now();
      this.opts.onDisconnect?.();
    }
    try {
      c.ws.close();
    } catch {
      // 이미 닫힘
    }
  }

  /**
   * S3(웹 클라이언트 하트비트 만료) 판정값.
   *
   * **한 번도 붙은 적이 없으면 `null` 이다.** 부팅 직후에는 창이 아직 페이지를 못 열
   * 수 있는데, 그 상태를 "클라이언트 없음" 으로 읽으면 **아직 뜨지 않은 창을 죽인다** —
   * 실제로 그랬다(창 기동 실패 → 0개 → 곧바로 종료). `null` 과 `0ms` 는 전혀 다른
   * 사실이므로 구분한다.
   */
  msSinceLastClientGone(now = Date.now()): number | null {
    if (!this.sawClient) return null;
    if (this.clients.size > 0) return null;
    if (this.lastClientGoneAt === null) return null;
    return now - this.lastClientGoneAt;
  }

  /** 서버 → 전 클라이언트. 순번을 붙여 재접속 이어받기가 가능하게 한다. */
  publish(ev: ServerEvent): void {
    const payload = JSON.stringify({ ...ev, seq: ++this.seq, epoch: this.epoch });
    this.ring.push({ seq: this.seq, payload });
    if (this.ring.length > this.ringMax) this.ring.shift();
    for (const c of this.clients) this.enqueue(c, payload);
  }

  private enqueue(c: Client, payload: string): void {
    if (c.ws.readyState !== 1) {
      this.remove(c);
      return;
    }
    if (c.ws.bufferedAmount > 4 * 1024 * 1024) {
      // 소켓 백로그가 4 MiB 를 넘으면 **늦은** 버린 다(죽은 클라이언트가 서버를 붙잡는다).
      c.queue.length = 0;
    }
    if (c.queue.length >= this.maxQueue) c.queue.shift(); // 오래된 것부터
    c.queue.push(payload);
    this.flush(c);
  }

  private flush(c: Client): void {
    if (c.ws.readyState !== 1) return;
    while (c.queue.length > 0) {
      const next = c.queue[0];
      if (c.ws.bufferedAmount > 1024 * 1024) return; // 밀린 동안 보류
      try {
        c.ws.send(next);
        c.queue.shift();
      } catch {
        this.remove(c);
        return;
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get lastSeq(): number {
    return this.seq;
  }

  async close(): Promise<void> {
    for (const c of [...this.clients]) {
      try {
        c.ws.close(1001, "server shutting down");
      } catch {
        // 무시
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
