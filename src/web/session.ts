/**
 * 페이지 부팅 시 토큰 처리 (§3.6).
 *
 * 규칙 하나: **토큰은 URL 에 처음 한 번만 있고, 첫 렌더가 끝나면 사라져야 한다.**
 * 주소창에 남으면 스크린샷·복사·셸 히스토리·충/crash 리포트에 새어 나간다.
 * 그런데 WebSocket 업그레이드는 브라우저 API 상 커스텀 헤더를 못 넣으므로
 * (?t= 쿼리는 사라진다) 세션 동안은 **세션스토리지**를 쓴다.
 * 세션스토리지가 맞는 이유: 탭을 닫으면 사라지고, 같은 탭에서의 재접속에는 충분하다.
 */

const QUERY_KEY = "t";
const STORAGE_KEY = "harnesside.token";

/**
 * URL 쿼리에서 토큰을 뽑고 URL 에서 제거한다(지금 당장).
 *
 * 반환값은 **항상 같은 출처의 경로 형태**(path + search + hash)다. 토큰이 없을 때
 * 절대 URL 을 그대로 돌려주면 호출부가 `location.href !== cleanHref` 비교에 의존하게 되고,
 * 그 비교가 놓치면 토큰이 주소창에 남는다. 호출부는 replaceState 에 그냥 넣으면 된다.
 */
export function consumeTokenFromUrl(href: string, storage?: Pick<Storage, "setItem">): { token: string | null; cleanHref: string } {
  let url: URL;
  try {
    url = new URL(href, "http://127.0.0.1");
  } catch {
    return { token: null, cleanHref: href };
  }
  const token = url.searchParams.get(QUERY_KEY);
  if (!token) {
    return { token: null, cleanHref: url.pathname + (url.search ? url.search : "") + url.hash };
  }
  url.searchParams.delete(QUERY_KEY);
  // 흔적까지 지운다: `?t=...` 만 지우면 스크린샷에 빈 쿼리 문자열이 남는다.
  const cleaned = url.pathname + (url.search ? url.search : "") + url.hash;
  storage?.setItem(STORAGE_KEY, token);
  return { token, cleanHref: cleaned };
}

export function readStoredToken(storage?: Pick<Storage, "getItem">): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * 지금 쓸 수 있는 토큰을 결정한다.
 * 순서: 저장소(재접속) → URL 쿼리(최초 부팅). 둘 다 없으면 null.
 */
export function resolveToken(
  href: string,
  storage?: Pick<Storage, "getItem" | "setItem">
): { token: string | null; cleanHref: string } {
  const stored = readStoredToken(storage);
  if (stored) {
    // URL 에 토큰이 남아 있으면 그것도 함께 치운다(이전 버전이 남긴 흔적).
    const { cleanHref } = consumeTokenFromUrl(href, storage);
    return { token: stored, cleanHref };
  }
  return consumeTokenFromUrl(href, storage);
}

/** 인증 헤더를 붙인다. 쿼리는 WS 업그레이드에서만 쓰고, HTTP 는 헤더를 쓴다. */
export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** WebSocket URL. 브라우저 WS API 는 헤더를 못 넣으므로 쿼리로만 전달한다. */
export function wsUrl(token: string | null, port: number): string {
  const base = `ws://127.0.0.1:${port}/ws`;
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}
