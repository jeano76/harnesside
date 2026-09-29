/**
 * 세션 토큰 (§3.6) — "토큰 없으면 API 를 아예 열지 않는다."
 *
 * 왜 이게 필수인가: CLI 라면 실행 주체가 곧 사용자라 문제가 없다. 웹 서버는
 * **같은 머신의 어떤 웹페이지도** `http://127.0.0.1:7317/api/fs/file?path=~/.ssh/id_rsa`
 * 를 `fetch` 하는 것만으로 시크릿을 읽을 수 있다. 127.0.0.1 에만 바인드해도는
 * 막히지 않는다 — CORS 우회, `<img>`/no-cors, 그리고 **WebSocket 은 CORS 가 없다.**
 * 이건 이론적 위험이 아니라 이 프로그램이 매일 하는 일(에이전트가 파일을 읽고)과 맞닿는다.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, chmod, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 32바이트 = 256비트. 추측 불가능성과 "외워 넣을 수 없음" 을 동시에 만족하는 최소. */
export const TOKEN_BYTES = 32;

export interface TokenRecord {
  token: string;
  createdAt: string;
  /** 포트에 토큰을 실어 보내면 `/json/version` 로 새므로, 검증에만 쓴다. */
  idePort: number;
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * 상수 시간 비교. `===` 로 토큰을 비교하면 타이밍으로 자를 수 있다.
 * 길이가 다르면 timingSafeEqual 이 예외를 던지므로 먼저 확인한다.
 */
export function tokenMatches(expected: string, presented: string | null | undefined): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function tokenFilePath(stateDir: string): string {
  return join(stateDir, "token.json");
}

/**
 * 토큰을 발급해 파일에 기록한다(0600). 이미 있으면 **그대로 쓴다** — 매 부팅마다
 * 바뀌면 열려 있던 창이 인증에 실패한다(§3.6 의 URL 에 붙은 토큰이 무효화된다).
 */
export async function issueToken(stateDir: string, idePort: number): Promise<TokenRecord> {
  const path = tokenFilePath(stateDir);
  const existing = await readToken(stateDir);
  if (existing) {
    // 포트만 현재 값으로 맞춘다(포트는 매번 달라질 수 있다).
    if (existing.idePort !== idePort) {
      const updated: TokenRecord = { ...existing, idePort };
      await persist(path, updated);
      return updated;
    }
    return existing;
  }
  const record: TokenRecord = {
    token: generateToken(),
    createdAt: new Date().toISOString(),
    idePort,
  };
  await persist(path, record);
  return record;
}

async function persist(path: string, record: TokenRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 원자적 쓰기: 임시 파일 → rename. 전원 차단으로 토큰 파일이 깨지면
  // 다음 부팅이 "인증 실패"로 영영 실패한다(§6.4 와 같은 이유).
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

export async function readToken(stateDir: string): Promise<TokenRecord | null> {
  try {
    const raw = await readFile(tokenFilePath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenRecord>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return {
      token: parsed.token,
      createdAt: parsed.createdAt ?? new Date(0).toISOString(),
      idePort: typeof parsed.idePort === "number" ? parsed.idePort : 0,
    };
  } catch {
    return null;
  }
}

export async function revokeToken(stateDir: string): Promise<void> {
  await unlink(tokenFilePath(stateDir)).catch(() => {});
}

/**
 * 요청에서 토큰을 꺼낸다. 세 곳을 모두 본다 — 하나만 보면 "왜 인증이 안 되지" 를
 * 사용자가 재현할 수 없다(§3.6).
 *  1) `Authorization: Bearer <token>`
 *  2) `X-Harnesside-Token` 헤더 (WebSocket 업그레이드용 — 브라우저 WS API 는 헤더를 못 넣는다)
 *  3) 쿼리 `?t=` (부팅 직후 첫 페이지만)
 */
export function extractToken(req: {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}): string | null {
  const h = req.headers;
  // Node 는 **반복된 헤더를 배열로 준다.** `typeof === "string"` 만 보면 그 요청은
  // "토큰 없음" 으로 처리돼 401 이 나는데 원인은 헤더가 배열이었던 것 — 재현이 안 된다.
  const first = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined;

  const auth = first(h["authorization"]);
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim() || null;
  }
  const xh = first(h["x-harnesside-token"]);
  if (xh) return xh;
  if (typeof req.url === "string") {
    const q = req.url.indexOf("?");
    if (q >= 0) {
      const params = new URLSearchParams(req.url.slice(q + 1));
      const t = params.get("t");
      if (t) return t;
    }
  }
  return null;
}
