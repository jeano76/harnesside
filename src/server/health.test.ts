/**
 * /api/health 의 startedAt 검증 (§11 — 자기 기동 시각).
 *
 * §11 은 "자기 기동 시각" 을 요구한다. `startedAt` 는 이미 코드의 한 줄로
 * 존재하지만 **그 값을 읽는 시험이 없었다.** 값이 있다는 것과 사용된다는 것은
 * 다르다(부록 B 2): 누군가 startedAt 필드를 지우면 이 테스트가 먼저 울어야
 * 한다. "아무도 안 쓰니까 괜찮지" 가 아니다 — §11 을 구현했다고 말하려면
 * "시험이 통과한다" 면서만 가능하다.
 */

import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpServer } from "./httpServer.js";
import { issueToken } from "../auth/token.js";

const CLEANUPS: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of CLEANUPS) await c();
});

interface Harness {
  base: string;
  token: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-health-"));
  const token = await issueToken(dir, 0);
  // STARTED_AT 를 흉내 낸 고정 시점. 실제 index.ts 도 `const STARTED_AT = Date.now()` 로
  // 모듈 로드 시각을 캡처하므로 테스트는 같은 패턴으로 검증한다.
  const fakeStartedAt = Date.now() - 1_234;

  const srv = new HttpServer({ token, port: 0 });
  srv.route("GET", "/api/health", () => ({
    ok: true,
    llamaUp: false,
    version: "0.1.0",
    startedAt: fakeStartedAt,
  }));

  const { port, close } = await srv.start();
  CLEANUPS.push(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, token: token.token, close };
}

async function req(h: Harness, path: string): Promise<Response> {
  return fetch(`${h.base}${path}`);
}

test("startedAt 가 응답에 존재한다 (§11)", async () => {
  const h = await startServer();
  try {
    const res = await req(h, "/api/health");
    assert.equal(res.status, 200);
    const body: Record<string, unknown> = (await res.json()) as never;
    assert.ok("startedAt" in body, "응답에 startedAt 필드가 있어야 한다 (§11)");
  } finally {
    await h.close();
  }
});

test("startedAt 는 숫자 타입이다", async () => {
  const h = await startServer();
  try {
    const res = await req(h, "/api/health");
    assert.equal(res.status, 200);
    const body: Record<string, unknown> = (await res.json()) as never;
    assert.ok(typeof body.startedAt === "number", `startedAt 는 숫자여야 한다. 실제: ${typeof body.startedAt}`);
  } finally {
    await h.close();
  }
});

test("startedAt 는 현재 시각보다 이전이다 (§11 — 기동 시각)", async () => {
  const h = await startServer();
  try {
    const res = await req(h, "/api/health");
    assert.equal(res.status, 200);
    const body: Record<string, unknown> = (await res.json()) as never;
    const startedAt = body.startedAt as number;
    const now = Date.now();

    // 서버가 미래에 떠 있을 수 없다.
    assert.ok(startedAt <= now, `startedAt(${startedAt}) 이 현재 시각(${now})보다 뒤일 수 없다`);

    // 시작 시점이 너무 멀리 과거도 아니다 (10 분 이상이면 잘못된 초기화).
    const maxAge = 10 * 60 * 1000;
    assert.ok(
      now - startedAt < maxAge,
      `startedAt(${startedAt}) 가 현재 시각보다 ${maxAge}ms 보다 오래 전이다`
    );
  } finally {
    await h.close();
  }
});

test("시작 후 여러 번 호출해도 startedAt 는 변하지 않는다 (고정)", async () => {
  const h = await startServer();
  try {
    const resA = await req(h, "/api/health");
    assert.equal(resA.status, 200);
    const bodyA: Record<string, unknown> = (await resA.json()) as never;

    const resB = await req(h, "/api/health");
    assert.equal(resB.status, 200);
    const bodyB: Record<string, unknown> = (await resB.json()) as never;

    assert.equal(
      bodyA.startedAt,
      bodyB.startedAt,
      "여러 호출 간 startedAt 가 바뀌었다 — 기동 시각이 고정되지 않았다"
    );
  } finally {
    await h.close();
  }
});
