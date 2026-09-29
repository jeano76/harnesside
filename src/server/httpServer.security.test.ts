/**
 * 보안 경계 통합 테스트 (§10.3.1 시나리오를 **실제 HTTP 요청**으로 검증).
 *
 * 유닛 테스트(tokenMatches 등)는 함수가 올바른지 만 본다. 이 파일은
 * "다른 탭의 페이지를 흉내 낸 요청이 실제로 막히는지" 를 본다. 실제 서버를
 * 띄우고 실제로 fetch 한다 — 가짜 라우터로 통과시켜도 통과한 것이 아니다.
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
  port: number;
  token: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-http-"));
  const token = await issueToken(dir, 0);
  // 포트 0 → OS 가 빈 포트를 고른다. 7317 을 하드코딩하면 다른 실행과 충돌한다.
  const srv = new HttpServer({ token, port: 0 });
  srv.route("GET", "/api/health", () => ({ ok: true, llamaUp: false }));
  srv.route("GET", "/api/fs/file", (c) => ({ path: c.query.get("path"), content: "SECRET" }));
  srv.route("POST", "/api/fs/file", () => ({ saved: true }));
  srv.route("GET", "/api/models/download/:jobId", (c) => ({ jobId: c.params.jobId }));
  const { port, close } = await srv.start();
  CLEANUPS.push(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, port, token: token.token, close };
}

async function req(
  h: Harness,
  path: string,
  init: RequestInit & { rawHeaders?: Record<string, string> } = {}
): Promise<Response> {
  const { rawHeaders, ...rest } = init;
  return fetch(`${h.base}${path}`, {
    ...rest,
    headers: { ...(rawHeaders ?? {}), ...((rest.headers as Record<string, string>) ?? {}) },
  });
}

test("토큰 없이 어떤 /api/* 도 200 을 주지 않는다", async () => {
  const h = await startServer();
  for (const [method, path] of [
    ["GET", "/api/fs/file?path=~/.ssh/id_rsa"],
    ["POST", "/api/fs/file"],
    ["GET", "/api/models/download/abc"],
  ] as const) {
    const res = await req(h, path, { method });
    assert.notEqual(res.status, 200, `${method} ${path} 가 인증 없이 200 을 주었다`);
    assert.equal(res.status, 401, `${method} ${path} 의 상태코드`);
    // 내용이 새어나오지 않아야 한다
    const body = await res.text();
    assert.equal(body.includes("SECRET"), false, "파일 내용이 노출됐다");
  }
});

test("헬스체크만 공개다 — 아무것도 노출하지 않으므로", async () => {
  const h = await startServer();
  const res = await req(h, "/api/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("올바른 토큰이면 통과한다 — 인증이 모든 요청을 막아서는 안 된다", async () => {
  const h = await startServer();
  const res = await req(h, "/api/fs/file?path=src/a.ts", {
    rawHeaders: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { content: string };
  assert.equal(body.content, "SECRET");
});

test("X-Harnesside-Token 헤더도 통과한다 (WebSocket 용)", async () => {
  const h = await startServer();
  const res = await req(h, "/api/health", {
    rawHeaders: { "x-harnesside-token": h.token },
  });
  assert.equal(res.status, 200);
});

test("쿼리 ?t= 로도 통과한다 (부팅 직후 첫 페이지만)", async () => {
  const h = await startServer();
  const res = await req(h, `/api/health?t=${encodeURIComponent(h.token)}`);
  assert.equal(res.status, 200);
});

test("잘못된 토큰은 401", async () => {
  const h = await startServer();
  const res = await req(h, "/api/fs/file", { rawHeaders: { authorization: "Bearer wrong" } });
  assert.equal(res.status, 401);
});

test("Host 헤더 위조(DNS rebinding)는 403 — 공개 API 조차", async () => {
  const h = await startServer();
  // fetch 는 Host 를 직접 지정 못 하므로 raw socket 으로 간다(§10.3.1 와 동일 목적).
  const net = await import("node:net");
  const { status } = await new Promise<{ status: number }>((resolve) => {
    const sock = net.connect(h.port, "127.0.0.1", () => {
      sock.write(
        "GET /api/health HTTP/1.1\r\n" +
          `Host: evil.com\r\n` +
          `Authorization: Bearer ${h.token}\r\n` +
          "Connection: close\r\n\r\n"
      );
    });
    let buf = "";
    sock.on("data", (d) => (buf += String(d)));
    sock.on("close", () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 0 });
    });
    sock.on("error", () => resolve({ status: 0 }));
  });
  assert.equal(status, 403, "Host 위조가 통과했다");
});

test("Origin 이 다른 출처면 403", async () => {
  const h = await startServer();
  const res = await req(h, "/api/health", { rawHeaders: { origin: "http://evil.com" } });
  assert.equal(res.status, 403);
});

test("Origin: null 은 403 (파일:// 등)", async () => {
  const h = await startServer();
  const res = await req(h, "/api/health", { rawHeaders: { origin: "null" } });
  assert.equal(res.status, 403);
});

test("CORS 헤더를 아예 보내지 않는다", async () => {
  const h = await startServer();
  const res = await req(h, "/api/health");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

test("404 는 인증 **이후** 에 온다 — 경로 존재 여부를 노출하지 않는다", async () => {
  const h = await startServer();
  const anon = await req(h, "/api/does-not-exist");
  const authed = await req(h, "/api/does-not-exist", { rawHeaders: { authorization: `Bearer ${h.token}` } });
  assert.equal(anon.status, 401, "토큰 없는데 404 가 떠 존재 여부가 드러난다");
  assert.equal(authed.status, 404);
});

test("경로 파라미터가 디코딩되어 전달된다", async () => {
  const h = await startServer();
  const res = await req(h, "/api/models/download/job%2F42", {
    rawHeaders: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { jobId: string };
  assert.equal(body.jobId, "job/42");
});

test("핸들러가 던진 오류는 스택을 노출하지 않는다", async () => {
  const h = await startServer();
  h.close();
  // 이미 닫은 서버에는 닿을 수 없으므로, 새 핸들러로 직접 등록해 확인한다.
  const dir = await mkdtemp(join(tmpdir(), "harnesside-http-err-"));
  const token = await issueToken(dir, 0);
  const srv = new HttpServer({ token, port: 0 });
  srv.route("GET", "/api/boom", () => {
    throw new Error("secret internal path /home/jeano/.ssh/id_rsa");
  });
  const { port, close } = await srv.start();
  CLEANUPS.push(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/boom`, {
    headers: { authorization: `Bearer ${token.token}` },
  });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(text.includes("id_rsa"), false, "내부 경로가 노출됐다");
  assert.equal(text.includes("secret internal"), false);
});
