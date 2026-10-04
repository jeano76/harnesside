/**
 * 원격 `baseUrl` 은 **지원하지 않는다** — 그리고 그 사실을 조용히 넘기지 않고 말한다 (Q-10, 2026-10-04).
 *
 * 실측 사실: 웹 서버의 에이전트는 항상 `http://127.0.0.1:<부팅이 정한 llama 포트>` 로 요청한다(`index.ts` AgentService 의 baseUrl).
 * 설정 파일에 원격 주소(프록시·클라우드)를 적어도 **아무 데서도 읽히지 않고 무시**됐다 — 사용자는 원격 모델을 쓰는 줄 알고
 * 로컬 모델의 답을 받는다. 원격 경로는 스트리밍·오류 형태·토큰 계수·인증을 한 번도 실측하지 않았으므로 "지원" 이라 말할 근거가 없다.
 * 그래서 루프백이 아닌 `baseUrl` 이 보이면 **"지원하지 않습니다"** 를 부팅 로그·로그 패널에 남긴다.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 설정 객체에서 baseUrl 후보(최상위 · llama.baseUrl). */
export function configuredBaseUrl(config: unknown): string | null {
  const c = (config ?? {}) as { baseUrl?: unknown; llama?: { baseUrl?: unknown } };
  const v = typeof c.llama?.baseUrl === "string" ? c.llama.baseUrl : typeof c.baseUrl === "string" ? c.baseUrl : null;
  return v && v.trim() ? v.trim() : null;
}

/** 원격이면 사람이 읽는 경고 한 문장, 로컬이거나 없으면 null. 주소를 읽을 수 없으면 그 사실을 말한다. */
export function remoteBaseUrlNotice(config: unknown): string | null {
  const url = configuredBaseUrl(config);
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return `설정의 baseUrl(${url}) 을 주소로 읽을 수 없습니다 — 무시하고 로컬 llama-server 를 씁니다.`;
  }
  if (LOOPBACK.has(host)) return null;
  return `설정의 baseUrl(${url}) 은 원격 주소입니다 — 원격 OpenAI 호환 서버는 지원하지 않습니다(스트리밍·오류·토큰 계수·인증 미측정). 로컬 llama-server 만 씁니다.`;
}
