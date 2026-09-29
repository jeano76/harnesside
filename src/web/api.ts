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
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  token: string | null;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  constructor(private opts: ClientOptions) {}

  async get<T>(path: string): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(path, { headers: authHeaders(this.opts.token) });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {
        // 본문이 JSON 이 아니면 상태 코드만으로 말한다
      }
      if (res.status === 401) {
        throw new ApiError(401, `인증 실패 — 토큰이 없거나 세션이 만료됐습니다. (${detail})`);
      }
      throw new ApiError(res.status, detail);
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
