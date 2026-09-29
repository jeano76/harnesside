/**
 * HTTP + WebSocket 서버 (§3.3 · §3.6 · §2.3)
 *
 * 설계 원칙 하나: **인증은 라우터보다 앞에서** 일어난다. 라우트마다 "이건 공개,
 * 이건 인증" 을 적으면 나중에 새 API 를 만들면서 인증을 빠뜨리고, 그 길은
 * "누가 만들었는지 찾기 어려운" 상태가 된다(§12 순서 경고). 그래서 미들웨어 하나가
 * 모든 요청을 먼저 통과시키고, 라우터는 **인증된 요청만** 본다.
 *
 * CORS 는 아예 안 보낸다 — "빈 화이트리스트" 를 명시적으로 선언하는 편이
 * 나중에 누가 "일단放开하자" 하고 추가하는 것보다 안전하다.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { extractToken, tokenMatches, type TokenRecord } from "../auth/token.js";
import { checkHost, checkOrigin, normalizeHeaders, type AllowedOrigins } from "../auth/originGuard.js";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  /** `/api/models/download/:jobId` 형태. */
  pattern: string;
  handler: Handler;
  /** 인증을 건너뛸 수 있는 공개 경로(헬스체크처럼 아무것도 exposes 하지 않는 것만). */
  public?: boolean;
}

export interface ServerDeps {
  token: TokenRecord;
  host?: string;
  port: number;
  routes?: Route[];
  /** 데몬이 파일을 못 찾는 환경(CI)에서 디스크를 만지지 않게. */
  staticDir?: string;
  logger?: (level: "info" | "warn" | "error", o: unknown, m: string) => void;
}

const PUBLIC_ROUTES = new Set(["GET /api/health"]);

export class HttpServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private routes: Route[] = [];
  private boundPort = 0;

  constructor(private deps: ServerDeps) {
    this.routes = deps.routes ?? [];
  }

  route(method: string, pattern: string, handler: Handler, opts: { public?: boolean } = {}): this {
    this.routes.push({ method, pattern, handler, public: opts.public });
    return this;
  }

  get allowed(): AllowedOrigins {
    return { host: this.deps.host ?? "127.0.0.1", port: this.boundPort || this.deps.port };
  }

  async start(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // **127.0.0.1 에만 바인드한다.** 그래도 이것만으로는 충분하지 않다(§3.6) —
      // 토큰과 Host/Origin 검증이 함께 있어야 한다.
      server.listen(this.deps.port, "127.0.0.1", () => resolve());
    });

    // 포트 0 을 넘기면 OS 가 고른 **실제 포트** 를 돌려준다. 요청한 값을 그대로
    // 돌려주면 "서버가 안 뜬" 것처럼 보이고 테스트는 전부 fetch failed 로 죽는다
    // (실제로 겪음 — 0 은 "아무 포트나" 라는 뜻이지 "0 번 포트" 가 아니다).
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : this.deps.port;
    this.boundPort = actualPort;

    // WebSocket: 업그레이드 단계에서 Origin/Host 를 검증한다. WS 에는 CORS 규칙이 없다.
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const h = normalizeHeaders(req.headers as Record<string, string | undefined>);
      const hostCheck = checkHost(h.host, this.allowed);
      const originCheck = checkOrigin(h.origin, this.allowed);
      const tokenOk = tokenMatches(this.deps.token.token, extractToken({ headers: h, url: req.url }));
      if (!hostCheck.ok || !originCheck.ok || !tokenOk) {
        this.deps.logger?.("warn", { host: h.host, origin: h.origin }, "WebSocket 업그레이드 거절");
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });

    return { port: this.boundPort, close: () => this.close() };
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    this.deps.logger?.("info", { url: req.url }, "WebSocket 연결됨");
    ws.on("message", (data) => {
      // §2.3 역직렬화 실패가 한 연결 전체를 죽이지 않게 격리한다.
      try {
        const msg = JSON.parse(String(data)) as { type?: string; [k: string]: unknown };
        if (!msg || typeof msg.type !== "string") return;
        this.dispatchWs(ws, msg as { type: string; [k: string]: unknown });
      } catch (e) {
        this.deps.logger?.("warn", { err: String(e) }, "WS 메시지 파싱 실패(연결은 유지)");
      }
    });
  }

  private dispatchWs(ws: WebSocket, msg: { type: string; [k: string]: unknown }): void {
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const h = normalizeHeaders(req.headers as Record<string, string | undefined>);

    // 1) Host 검증 — DNS rebinding 방어. 모든 요청에 대해, 공개 API 조차.
    const hostCheck = checkHost(h.host, this.allowed);
    if (!hostCheck.ok) {
      this.deny(res, hostCheck.status, hostCheck.reason);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${h.host ?? "127.0.0.1"}`);
    const method = (req.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;

    const match = this.match(method, url.pathname);
    const isPublic = PUBLIC_ROUTES.has(key) || match?.public === true;

    // 2) Origin 검증 (브라우저가 보낸 경우)
    const originCheck = checkOrigin(h.origin, this.allowed);
    if (!originCheck.ok) {
      this.deny(res, originCheck.status, originCheck.reason);
      return;
    }

    // 3) 토큰 검증 — 공개 경로를 뺀 **모든** 요청.
    if (!isPublic) {
      const presented = extractToken({ headers: h, url: req.url });
      if (!tokenMatches(this.deps.token.token, presented)) {
        this.deps.logger?.("warn", { key }, "인증 실패(토큰 없음/불일치)");
        this.deny(res, 401, "인증이 필요합니다");
        return;
      }
    }

    if (!match) {
      this.deny(res, 404, `알 수 없는 경로: ${url.pathname}`);
      return;
    }

    try {
      const out = await match.handler({ req, res, url, params: match.params, query: url.searchParams });
      if (res.writableEnded) return; // 핸들러가 직접 응답한 경우
      if (out === undefined) {
        this.json(res, 204, null);
      } else {
        this.json(res, 200, out);
      }
    } catch (e) {
      // 내부 오류 메시지를 그대로 노출하지 않는다(경로·스택이 새어나간다).
      this.deps.logger?.("error", { err: String(e), key }, "핸들러 오류");
      this.deny(res, 500, "서버 오류");
    }
  }

  private match(method: string, pathname: string): { handler: Handler; params: Record<string, string>; public?: boolean } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const p = r.pattern.split("/").filter(Boolean);
      const q = pathname.split("/").filter(Boolean);
      if (p.length !== q.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < p.length; i++) {
        if (p[i].startsWith(":")) {
          params[p[i].slice(1)] = decodeURIComponent(q[i]);
        } else if (p[i] !== q[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: r.handler, params, public: r.public };
    }
    return null;
  }

  private deny(res: ServerResponse, status: number, reason: string): void {
    // CORS 헤더를 **아예 보내지 않는다**(허용 출처 화이트리스트가 없다).
    this.json(res, status, { error: reason, status });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body ?? null);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(payload);
  }

  async close(): Promise<void> {
    for (const c of this.wss?.clients ?? []) {
      try {
        c.close();
      } catch {
        // 이미 닫힘
      }
    }
    this.wss?.close();
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}
