/**
 * 실행 중인 llama-server 의 **실제** 컨텍스트 창(토큰)을 서버에게 직접 묻는다.
 *
 * 클라이언트가 창 크기를 추측(설정값·VRAM 표·기본값)하면 서버와 어긋나는 순간이 온다. 실측: 서버는
 * `-c 20480` 인데 에이전트는 86016 으로 알고 있어 압축이 한참 늦었고, 프롬프트가 20479 토큰까지 차
 * 서버가 `exceeds the available context size` 로 거절하거나 생성이 잘렸다(사고가 문장 중간에서 끊기고
 * 답이 빔). 서버가 진실이다.
 *
 * `/props` 의 `default_generation_settings.n_ctx` 를 먼저, 없으면 `/slots[0].n_ctx` 를 본다. 둘 다
 * **슬롯 하나가 쓸 수 있는 창**이다(`-np` 가 여럿이면 전체를 나눈 값) — 요청 하나가 실제로 받는 크기.
 * 못 읽으면 null 이다(추측으로 채우지 않는다). 던지지 않는다.
 */
export async function probeServerContext(
  baseUrl: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<number | null> {
  const f = opts.fetch ?? fetch;
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const get = async (path: string): Promise<unknown> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 3000);
    try {
      const res = await f(`${root}${path}`, { signal: ctl.signal });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const valid = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null);

  const props = (await get("/props")) as { default_generation_settings?: { n_ctx?: unknown } } | null;
  const fromProps = valid(props?.default_generation_settings?.n_ctx);
  if (fromProps) return fromProps;
  const slots = (await get("/slots")) as Array<{ n_ctx?: unknown }> | null;
  return Array.isArray(slots) ? valid(slots[0]?.n_ctx) : null;
}
