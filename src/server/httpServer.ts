/**
 * HTTP + WebSocket 서버 (§3.3 · §3.6 · §2.3)
 *
 * 설계 원칙 하나: **인증은 라우터보다 앞에서** 일어난다. 라우트마다 "이건 공개,
 * 이건 인증" 을 적으면 나중에 새 API 를 만들면서 인증을 빠뜨리고, 그 길은
 * "누가 만들었는지 찾기 어려운" 상태가 된다(§12 순서 경고). 그래서 미들웨어 하나가
 * 모든 요청을 먼저 통과시키고, 라우터는 **인증된 요청만** 본다.
 *
 * CORS 는 아예 안 보낸다 — "빈 화이트리스트" 를 명시적으로 선언하는 편이
 * 나중에 누가 "일단 열어두자" 하고 추가하는 것보다 안전하다.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep, join, extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { extractToken, tokenMatches, type TokenRecord } from "../auth/token.js";
import { checkHost, checkOrigin, normalizeHeaders, type AllowedOrigins } from "../auth/originGuard.js";

/** 확장자별 Content-Type. 미등록 확장자는 이진으로 둔다(브라우저가 해석하지 않게). */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** JSON 본문을 읽는다. 상한이 없으면 요청 하나가 메모리를 다 먹을 수 있다. */
export async function readBody(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.byteLength;
    if (size > maxBytes) throw Object.assign(new Error("요청 본문이 너무 큽니다"), { status: 413 });
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/**
 * 쿼리 문자열의 정수를 **범위 안에서만** 받는다.
 *
 * 왜 여기서 막나: 상한을 라우트마다 다르게 적으면 어느 하나가 빠진다. 그리고
 * `Number("abc")` 는 `NaN` 이라 그대로 상한 비교를 통과해 **무한 반복**이 되거나
 *(`maxHits = NaN` → 비교가 항상 false) **상한이 사라진다**(§9.3 표: 오염으로 무한 요청).
 *
 * **조용히 고치지 않는다** — 잘못된 값은 주어진 기본값으로 떨어지고, 그 사실은
 * 호출부가 로그로 남긴다. 여기서 400 을 던지면 화면이 "검색어가 잘못됐다" 는
 * **올바른 문장**을 보게 되지만, 그건 검색어가 아니라 상한 값의 문제라서 혼란스럽다.
 */
export function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  // `Number.isFinite` 로 먼저 거른다 — `NaN` 과 `Infinity` 둘 다 걸린다.
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function contentTypeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

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
  /**
   * 인증을 통과한 WS 업그레이드를 넘겨받는 훅. `true` 를 반환하면 이 서버가
   * 소유권을 가져갔다는 뜻이다(기본 구현으로 넘어가지 않는다).
   * §2.3 의 허브를 여기에 꽂는다 — 인증은 여전히 이 서버가 담당한다.
   */
  onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
}

const PUBLIC_ROUTES = new Set(["GET /api/health"]);

export class HttpServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  /** 인증을 통과한 업그레이드 훅(§2.3 허브). */
  private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => boolean) | null = null;
  private routes: Route[] = [];
  private boundPort = 0;

  constructor(private opts: ServerDeps) {
    this.routes = opts.routes ?? [];
  }

  get deps(): ServerDeps {
    return this.opts;
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
      // 주입된 허브가 있으면 그것이 연결을 소유한다(§2.3). 없으면 최소 구현으로 폴백.
      if (this.opts.onUpgrade && this.opts.onUpgrade(req, socket, head)) return;
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
    // **토큰은 API/WS 에만 요구한다.** 정적 자산(HTML·JS·CSS)까지 걸면 첫 요청에만
    // `?t=` 를 실은 페이지가 뜬 뒤 그 JS 요청이 401 이 되어 **빈 화면** 이 된다
    // (실제로 그렇게 났다 — 창은 뜨는데 아무것도 그려지지 않는다).
    // 자산에는 시크릿이 없으므로 공개해도 위험이 없고, 보호 대상은 데이터(`/api/*`)다.
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const isPublic = !isApi || PUBLIC_ROUTES.has(key) || match?.public === true;

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
      // API 가 아니면 **웹 자산**을 준다. "창이 떴는데 빈 화면" 은 결함이다(§0.3).
      const served = await this.serveStatic(url.pathname, res);
      if (served) return;
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
      // 핸들러가 **의도한** 상태 코드(404/403/409)는 그대로 전달한다 — 경로 안전이
      // "403" 인데 "500" 이 되면 사용자는 서버 오류로 오해하고 원인을 못 찾는다.
      // 그 외 내부 오류는 경로·스택이 새지 않도록 가린다.
      const status = (e as { status?: number })?.status;
      if (typeof status === "number" && status >= 400 && status < 600) {
        const conflict = (e as { conflict?: unknown }).conflict;
        this.json(res, status, { error: (e as Error).message, status, ...(conflict ? { conflict } : {}) });
        return;
      }
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

  /**
   * 정적 자산 서빙 (§5 의 웹 IDE).
   *
   * 두 가지가 중요하다:
   * 1) **경로 탈출 차단** — `dist/web` 밖으로 나가면 403. 웹 서버가 임의 파일을
   *    읽는다면 그건 §3.4 가 아니라 §3.6 의 구멍이다.
   * 2) **SPA 폴백** — 없는 경로는 `index.html` 이다. 라우팅은 클라이언트가 하므로
   *    404 를 주면 "빈 화면" 이 되고, 사용자는 서버가 죽었다고 생각한다(§0.3).
   */
  private async serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const root = this.deps.staticDir;
    if (!root) return false;
    // API 는 여기서 받지 않는다 — 인증을 거친 라우터의 영역이다.
    if (pathname.startsWith("/api/") || pathname.startsWith("/ws")) return false;

    const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
    const resolvedRoot = resolve(root);
    const candidate = resolve(resolvedRoot, rel === "" ? "index.html" : rel);
    const inside = (p: string) => p === resolvedRoot || p.startsWith(resolvedRoot + sep);

    // 1) 경로 정규화 결과가 루트 밖이면 **파일이 있든 없든** 거부한다.
    //    (없다고 404 를 주면 "어떤 파일이 있다/없다" 를 새어 준다)
    if (!inside(candidate)) {
      this.deny(res, 403, "경로 밖으로 나갈 수 없습니다");
      return true;
    }

    // 2) 심볼릭 링크로 빠져나가는 경우도 같은 이유로 막는다.
    const real = await realpath(candidate).catch(() => null);
    if (real && !inside(real)) {
      this.deny(res, 403, "경로 밖으로 나갈 수 없습니다");
      return true;
    }

    // 3) 확장자가 없는 경로(= 라우팅)는 SPA 폴백. 확장자가 있는 경로는
    //    "정적 파일" 이라 없는 것은 404 다 — index.html 로 덮으면 스크립트 404 가
    //    화면에는 "앱이 조용히 깨진 상태" 로 보인다(§11.3 의 "멈춘 것처럼 보인다").
    if (!real) {
      const idx = join(resolvedRoot, "index.html");
      const idxReal = await realpath(idx).catch(() => null);
      if (extname(pathname) || !idxReal) {
        if (!extname(pathname) && !idxReal) {
          this.deny(res, 404, "dist/web 가 없습니다 — 'npm run build' 후 재시작 하세요");
          return true;
        }
        return false; // 진짜 없는 정적 파일 → 라우터가 404
      }
      return this.sendFile(res, idxReal);
    }

    return this.sendFile(res, real);
  }

  private async sendFile(res: ServerResponse, file: string): Promise<boolean> {
    const data = await readFile(file).catch(() => null);
    if (!data) return false;
    res.writeHead(200, {
      "content-type": contentTypeFor(file),
      "content-length": data.byteLength,
      "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
    return true;
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
