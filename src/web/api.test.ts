/**
 * API 클라이언트 테스트 (§3.3 · §3.6 · §3.4).
 *
 * 이 파일이 **커버리지 표에 아예 없었다** — 테스트가 하나도 없어서 표에조차 안 떴다.
 * 그리고 여기에는 실제로 버그가 있었다: 409 의 `conflict`(서버본문)를 `ApiError` 가
 * 버려서 충돌 UI 에 비교 대상이 없던 것(§3.4). 눈으로 발견해서 고친 뒤에도 **검사가
 * 없어서** 같은 버그가 다시 생길 수 있었다.
 *
 * 규칙:
 *  1. **토큰이 없으면 아무 API 도 200 이 아니다** — 조용히 삼키지 않는다.
 *  2. **오류에도 데이터를 실어 보낸다.** 본문을 버리면 409 라는 숫자만 남는다.
 *  3. **401 은 따로 말한다** — 설정 문제인지 토큰 문제인지 구분해야 한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApiClient, ApiError, type BootStep, type GpuInfo } from "./api.js";

/** fetch 를 주입한다 — 진짜 네트워크는 쓰지 않는다("오늘의 서버" 를 검증하지 않기 위해). */
function client(fetchImpl: typeof fetch, token: string | null = "t") {
  return new ApiClient({ token, fetchImpl });
}

const jsonRes = (status: number, body: unknown, ok = status < 400) =>
  ({ ok, status, statusText: "", json: async () => body }) as unknown as Response;

test("토큰을 **헤더로** 보낸다 — WS 말고 HTTP 는 헤더를 쓴다(§3.6)", async () => {
  let seen: Record<string, string> = {};
  const c = client((async (path: string, init: RequestInit) => {
    seen = (init.headers ?? {}) as Record<string, string>;
    assert.equal(path, "/api/workspace");
    return jsonRes(200, { current: { root: "/x" } });
  }) as unknown as typeof fetch, "secret-token");
  await c.get("/api/workspace");
  assert.equal(seen.Authorization, "Bearer secret-token");
});

test("**401 은 '인증 실패'** 라고 말한다 — 원인을 모르면 사용자가 추측한다", async () => {
  const c = client((async () => jsonRes(401, { error: "토큰 불일치" })) as unknown as typeof fetch);
  await assert.rejects(
    () => c.get("/api/workspace"),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 401);
      assert.match(e.message, /인증 실패/);
      // 원인이 함께 있어야 추측이 줄어든다.
      assert.match(e.message, /토큰 불일치/);
      return true;
    }
  );
});

test("**409 의 서버본문을 버리지 않는다** — 버리면 충돌 화면에 비교 대상이 없다", async () => {
  const server = { path: "a.ts", content: "서버본문\n", version: 200 };
  const c = client((async () => jsonRes(409, { error: "디스크에서 변경되었습니다", conflict: server })) as unknown as typeof fetch);
  await assert.rejects(
    () => c.put("/api/fs/file", { path: "a.ts", content: "내것", baseVersion: 100 }),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 409);
      assert.match(e.message, /디스크에서 변경되었습니다/);
      // **이게 핵심** 다. 이 값이 없으면 편집기는 "저장 실패" 만 보인다.
      // `conflict` 는 content/version **둘만** 꺼낸다 — 화면이 비교에 쓰는 것이 그 둘이고,
      // 나머지(경로 등)는 이미 알고 있는 사실이라 섞지 않는다.
      assert.deepEqual(e.conflict, { content: "서버본문\n", version: 200 });
      assert.equal((e.body as { conflict: Record<string, unknown> }).conflict.path, "a.ts", "원본 body 는 그대로 남아 있어야 한다");
      return true;
    }
  );
});

test("`conflict` 가 없으면 **null** — 빈 문자열이 아니라", async () => {
  const c = client((async () => jsonRes(409, { error: "충돌" })) as unknown as typeof fetch);
  await assert.rejects(
    () => c.put("/api/fs/file", {}),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      // **빈 문자열로 채우면** "서버본문이 빈 파일" 과 "서버본문을 못 받았다" 를
      // 구분하지 못한다(§5.10).
      assert.equal(e.conflict, null);
      return true;
    }
  );
});

test("`conflict.content` 가 문자열이 아니면 **null** — 모양이 다른 응답에 물리지 않는다", async () => {
  const c = client((async () => jsonRes(409, { error: "충돌", conflict: { content: 123 } })) as unknown as typeof fetch);
  await assert.rejects(
    () => c.put("/api/fs/file", {}),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.conflict, null);
      return true;
    }
  );
});

test("본문이 JSON 이 아니어도 **죽지 않는다** — 상태 코드만으로 말한다", async () => {
  const c = client((async () =>
    ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new Error("HTML 응답");
      },
    }) as unknown as Response) as unknown as typeof fetch);
  await assert.rejects(
    () => c.get("/api/workspace"),
    (e: unknown) => e instanceof ApiError && e.status === 502 && /HTTP 502/.test(e.message)
  );
});

test("본문은 **버리지 않는다** — 오류에도 데이터가 있다", async () => {
  const c = client((async () => jsonRes(400, { error: "path 가 필요합니다", field: "path" })) as unknown as typeof fetch);
  await assert.rejects(
    () => c.post("/api/git/commit", {}),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.deepEqual(e.body, { error: "path 가 필요합니다", field: "path" });
      return true;
    }
  );
});

test("GET 은 **본문을 보내지 않는다** — 쿼리는 URL 로", async () => {
  let init: RequestInit = {};
  const c = client((async (_p: string, i: RequestInit) => {
    init = i;
    return jsonRes(200, {});
  }) as unknown as typeof fetch);
  await c.get("/api/logs");
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
});

test("POST/PUT 은 **Content-Type 과 JSON** 을 보낸다 — 라우트가 요구한다", async () => {
  const seen: RequestInit[] = [];
  const c = client((async (_p: string, i: RequestInit) => {
    seen.push(i);
    return jsonRes(200, { ok: true });
  }) as unknown as typeof fetch);
  await c.post("/api/git/clone", { url: "x" });
  await c.put("/api/fs/file", { path: "a" });
  assert.equal(seen.length, 2);
  for (const i of seen) {
    assert.equal((i.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.ok(typeof i.body === "string", "본문이 직렬화되지 않았다");
  }
  assert.equal(JSON.parse(seen[0].body as string).url, "x");
});

test("ws() 는 **포트를 경로에 넣지 않는다** — 포트는 URL 에 온다", () => {
  assert.equal(client((async () => jsonRes(200, {})) as unknown as typeof fetch, "tk").ws(7317), "ws://127.0.0.1:7317/ws?t=tk");
  // 토큰이 없으면 쿼리를 **붙이지 않는다** — "t=" 만 붙이면 인증 실패의 원인이 숨겨진다.
  assert.equal(client((async () => jsonRes(200, {})) as unknown as typeof fetch, null).ws(7317), "ws://127.0.0.1:7317/ws");
});

test("클라이언트는 **값을 지어내지 않는다** — 없는 필드는 그대로 undefined", async () => {
  // 이 저장소의 제일 오래된 교훈: **모름과 0 을 구분한다.** HTTP 계층에서 없는 필드를
  // 0 이나 빈 문자열로 채우면 "서버가 안 줬다" 가 "값이 0 이다" 로 바뀌고, 화면은 그
  // 차이를 알 수 없다. 그래서 클라이언트는 **그대로 통과**시킨다.
  const c = client((async () => jsonRes(200, { steps: [{ n: 1, name: "단계" }] })) as unknown as typeof fetch);
  const got = await c.get<{ steps: Array<{ n: number; name: string; detail?: string }> }>("/api/bootstrap");
  assert.equal(got.steps[0].name, "단계");
  assert.equal(got.steps[0].detail, undefined, "없는 필드를 채워 넣었다");
  // `tookSeconds` 처럼 0 이 **의미 있는** 값인 필드도 서버가 안 줬으면 undefined 다.
  assert.equal((got.steps[0] as { tookSeconds?: number }).tookSeconds, undefined);
});

test("타입 파라미터는 **그대로** 반환한다 — 캐스팅이 아니라 통과", async () => {
  const body: BootStep[] = [{ n: 1, name: "단계", ok: true, detail: "d", tookSeconds: 0.1 }];
  const c = client((async () => jsonRes(200, body)) as unknown as typeof fetch);
  assert.deepEqual(await c.get<BootStep[]>("/api/bootstrap"), body);
  const gpu: GpuInfo = { mode: "off", reserveMiB: 0, rationale: ["이유"], measured: { vramTotalMiB: 0, vramFreeMiB: 0, modelMiB: 0, headroomMiB: 0 } };
  const c2 = client((async () => jsonRes(200, gpu)) as unknown as typeof fetch);
  assert.deepEqual(await c2.get<GpuInfo>("/api/gpu"), gpu);
});
