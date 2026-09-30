/**
 * 서버 API 클라이언트 (§3.3).
 *
 * 명심할 것: **토큰이 없으면 아무 API 도 200 이 아니다**(§3.6). 그래서 이 모듈은
 * 401 을 조용히 삼키지 않고 화면에 "인증 실패" 로 올린다. 조용히 실패하면 사용자는
 * "빈 화면" 으로만 이해하고 설정 문제인지 토큰 문제인지 알 수 없다.
 */

import { authHeaders, wsUrl } from "./session.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * 응답 본문 전체.
     *
     * **409 충돌의 `conflict`(서버본문·버전)를 여기에 실어야** 편집기가 "내 편집 vs
     * 서버본문" 을 나란히 보여줄 수 있다. 본문을 버리면 사용자는 "저장 실패" 라는
     * 글자만 보고 자기 편집을 잃는다(§3.4) — 가장 나쁜 실패.
     */
    readonly body: unknown = null
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 충돌 응답에서 서버본문을 꺼낸다. 없으면 null — **빈 문자열이 아니다.** */
  get conflict(): { content: string; version: number } | null {
    const c = (this.body as { conflict?: { content?: unknown; version?: unknown } } | null)?.conflict;
    if (!c || typeof c.content !== "string") return null;
    return { content: c.content, version: typeof c.version === "number" ? c.version : 0 };
  }
}

export interface ClientOptions {
  token: string | null;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  constructor(private opts: ClientOptions) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /**
   * JSON 본문으로 쓴다. GET 만 있는 클라이언트면 "전환" 같은 동작을 화면에서 못 한다 —
   * 로직이 있어도 호출할 길이 없으면 없는 기능과 같다(§④ 의 ◐ 의 뜻).
   */
  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const init: RequestInit = { method, headers: authHeaders(this.opts.token) };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await f(path, init);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      let parsed: unknown = null;
      try {
        parsed = (await res.json()) as { error?: string };
        if ((parsed as { error?: string } | null)?.error) detail = (parsed as { error: string }).error;
      } catch {
        // 본문이 JSON 이 아니면 상태 코드만으로 말한다
      }
      if (res.status === 401) {
        throw new ApiError(401, `인증 실패 — 토큰이 없거나 세션이 만료됐습니다. (${detail})`, parsed);
      }
      // **본문을 그대로 실어 보낸다** — 409 의 서버본문을 안 쓰면 충돌 UI 가 없다.
      throw new ApiError(res.status, detail, parsed);
    }
    return (await res.json()) as T;
  }

  ws(port: number): string {
    return wsUrl(this.opts.token, port);
  }
}

export interface BootStep {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
  pending?: boolean;
  tookSeconds: number;
}

export interface GpuInfo {
  mode: string;
  reserveMiB: number;
  rationale: string[];
  measured: { vramTotalMiB: number; vramFreeMiB: number; modelMiB: number; headroomMiB: number };
  llama?: number;
  ide?: number;
}
