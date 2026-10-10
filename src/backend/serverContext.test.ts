import { test } from "node:test";
import assert from "node:assert/strict";
import { probeServerContext } from "./serverContext.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fakeFetch = (routes: Record<string, () => Response>, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url);
    const path = new URL(url).pathname;
    const r = routes[path];
    if (!r) return new Response("nope", { status: 404 });
    return r();
  }) as unknown as typeof fetch;

test("/props 의 n_ctx 를 읽는다 — 서버가 실제로 받은 창", async () => {
  const n = await probeServerContext("http://127.0.0.1:8080", {
    fetch: fakeFetch({ "/props": () => json({ default_generation_settings: { n_ctx: 20480 } }) }),
  });
  assert.equal(n, 20480);
});

test("/props 가 없으면 /slots[0].n_ctx 로 물러난다", async () => {
  const n = await probeServerContext("http://127.0.0.1:8080", {
    fetch: fakeFetch({ "/slots": () => json([{ id: 0, n_ctx: 86016 }]) }),
  });
  assert.equal(n, 86016);
});

test("baseUrl 끝의 /v1 과 슬래시는 떼고 서버 루트에 묻는다", async () => {
  const seen: string[] = [];
  await probeServerContext("http://127.0.0.1:8080/v1/", {
    fetch: fakeFetch({ "/props": () => json({ default_generation_settings: { n_ctx: 4096 } }) }, seen),
  });
  assert.equal(seen[0], "http://127.0.0.1:8080/props");
});

test("못 읽으면 null — 추측으로 채우지 않는다 (오류·이상한 값·빈 응답)", async () => {
  const boom = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
  assert.equal(await probeServerContext("http://x", { fetch: boom }), null);
  for (const bad of [0, -1, "20480", null, Number.NaN]) {
    const n = await probeServerContext("http://x", {
      fetch: fakeFetch({ "/props": () => json({ default_generation_settings: { n_ctx: bad } }), "/slots": () => json([{ n_ctx: bad }]) }),
    });
    assert.equal(n, null, `이상한 값 ${String(bad)} 을 창 크기로 썼다`);
  }
});

test("응답이 늦으면 시간 제한으로 포기하고 null", async () => {
  const hang = ((_u: string, init?: RequestInit) =>
    new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  assert.equal(await probeServerContext("http://x", { fetch: hang, timeoutMs: 20 }), null);
});
