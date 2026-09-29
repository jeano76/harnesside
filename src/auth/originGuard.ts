/**
 * Origin / Host 검증 (§3.6) — DNS rebinding 방어.
 *
 * 위협: 사용자가 다른 탭에서 아무 페이지나 열고 있는 상태가 이 프로그램의 **정상 상태**다.
 * 그 페이지가 `fetch("http://127.0.0.1:7317/api/...")` 를 쏘면 브라우저는
 * 같은 사용자의 요청으로 처리한다. CORS 로 "응답을 못 읽는다" 를 막아도
 *  - 순수 GET(no-cors)은 **응답을 못 읽어도 요청이 간다**(요청이 곧 파일 읽기)
 *  - WebSocket 은 **CORS 규칙이 아예 없다**
 *  이므로 "바인드를 127.0.0.1 로 제한" 하는 것으로는 막히지 않는다.
 *
 * 방어선 2개:
 *  1) Host 헤더가 실제 우리 주소여야 한다. `evil.com` 이 127.0.0.1 로 해석되도록
 *     DNS 를 조작하면(`DNS rebinding`) 브라우저는 `Host: evil.com` 으로 요청한다.
 *     → Host 불일치 = 거절.
 *  2) Origin 이 우리 페이지여야 한다. WebSocket 에는 이게 유일한 방어선이다.
 */

export interface AllowedOrigins {
  host: string; // "127.0.0.1"
  port: number;
}

export function expectedOrigin(a: AllowedOrigins): string {
  return `http://${a.host}:${a.port}`;
}

/** 허용되는 Host 값들: `host:port` 와, IPv6 를 감싼 `host:port`. */
export function expectedHosts(a: AllowedOrigins): string[] {
  const host = a.host.includes(":") ? `[${a.host}]` : a.host;
  return [`${host}:${a.port}`];
}

export type GuardResult = { ok: true } | { ok: false; reason: string; status: number };

/**
 * Host 헤더 검증. `undefined`(HTTP/1.0) 도 거부한다 — 우리 서버는 HTTP/1.1 이다.
 * 포트 생략(`Host: 127.0.0.1`)은 **거부한다**: 우리 포트와 다르다는 뜻이며,
 * 어차피 이 서버에는 그 포트로 안 들어온다.
 */
export function checkHost(hostHeader: string | undefined, a: AllowedOrigins): GuardResult {
  if (!hostHeader) {
    return { ok: false, reason: "Host 헤더가 없습니다 (DNS rebinding 방어를 위해 거부)", status: 403 };
  }
  const allowed = expectedHosts(a);
  if (!allowed.includes(hostHeader.toLowerCase())) {
    return {
      ok: false,
      reason: `Host 헤더 불일치: ${hostHeader} (허용: ${allowed.join(", ")}) — DNS rebinding 시도일 수 있습니다`,
      status: 403,
    };
  }
  return { ok: true };
}

/**
 * Origin 헤더 검증.
 *  - `Origin` 이 없으면: 같은 출처의 GET/HEAD 일 수 있다. **허용**하되 호출부가
 *    상태 변경 메서드에는 토큰을 요구하도록 만든다(무단 POST 는 토큰이 막는다).
 *  - `Origin: null`(파일://, 일부 사설 탐색 모드)은 거부 — 우리 페이지에서 나올 수 없다.
 *  - 불일치면 거절.
 */
export function checkOrigin(originHeader: string | undefined, a: AllowedOrigins): GuardResult {
  if (!originHeader) return { ok: true };
  const want = expectedOrigin(a);
  if (originHeader === "null") {
    return { ok: false, reason: "Origin: null 은 허용하지 않습니다", status: 403 };
  }
  if (originHeader !== want) {
    return { ok: false, reason: `Origin 불일치: ${originHeader} (허용: ${want})`, status: 403 };
  }
  return { ok: true };
}

/** HTTP 헤더를 소문자 키 맵으로 정규화한다(Node 는 대소문자가 섞여 온다). */
export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
