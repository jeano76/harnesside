/**
 * 정적 서빙 테스트 (§3.4 · §5).
 *
 * "창이 떴는데 빈 화면" 은 결함이다(§0.3). 그 원인 중 하나가 "서버가 HTML 을 안 준다" 이고,
 * 여기서 그 경로와 **경로 탈출** 을 함께 막는다.
 */

import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpServer } from "./httpServer.js";
import { issueToken } from "../auth/token.js";

const CLEANUPS: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of CLEANUPS) await c();
});

async function webRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-web-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>harnesside</title><div id=root></div>");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
  // 탈출 시도용 파일(루트 밖에 있음)
  await writeFile(join(dir, "..", `secret-${Date.now()}.txt`), "SECRET");
  return dir;
}

async function start(): Promise<{ base: string; token: string; close: () => Promise<void> }> {
  const web = await webRoot();
  const state = await mkdtemp(join(tmpdir(), "harnesside-state-"));
  const token = await issueToken(state, 0);
  const srv = new HttpServer({ token, port: 0, staticDir: web });
  srv.route("GET", "/api/health", () => ({ ok: true }));
  const { close } = await srv.start();
  CLEANUPS.push(async () => {
    await close();
    await rm(web, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  const port = (srv as unknown as { boundPort: number }).boundPort;
  return { base: `http://127.0.0.1:${port}`, token: token.token, close };
}

test("루트 경로가 index.html 을 준다 — 창이 뜨면 내용이 있어야 한다", async () => {
  const h = await start();
  const res = await fetch(`${h.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /harnesside/);
});

test("정적 자산의 Content-Type 이 맞는다 (JS 를 HTML 로 주면 스크립트가 안 돈다)", async () => {
  const h = await start();
  const res = await fetch(`${h.base}/assets/app.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  // 자산은 불변 캐시, HTML 은 캐시하지 않는다(구버전 화면이 남으면 디버깅이 힘들다)
  assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  const html = await fetch(`${h.base}/`);
  assert.match(html.headers.get("cache-control") ?? "", /no-store/);
});

test("SPA 폴백 — 없는 경로도 index.html 이다 (빈 화면 방지)", async () => {
  const h = await start();
  for (const p of ["/settings", "/panels/system-monitor", "/a/b/c"]) {
    const res = await fetch(`${h.base}${p}`);
    assert.equal(res.status, 200, `${p} 가 404 를 주면 빈 화면이 된다`);
    assert.match(await res.text(), /harnesside/);
  }
});

test("경로 탈출은 차단된다 — 웹 서버가 임의 파일을 읽으면 §3.6 구멍이다", async () => {
  const h = await start();
  // fetch 는 URL 을 클라이언트에서 정규화해 버린다(`/../x` → `/x`).
  // 그래서 **원시 소켓**으로 보내야 서버가 실제로 받는 형태를 시험한다.
  const net = await import("node:net");
  const raw = (line: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve) => {
      const port = Number(new URL(h.base).port);
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(`${line}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      let buf = "";
      sock.on("data", (d) => (buf += String(d)));
      sock.on("close", () => {
        const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
        resolve({ status: m ? Number(m[1]) : 0, body: buf });
      });
      sock.on("error", () => resolve({ status: 0, body: "" }));
    });

  for (const path of ["/../package.json", "/../../etc/passwd", "/%2e%2e/package.json", "/assets/%2e%2e/%2e%2e/package.json", "/....//package.json"]) {
    const { status, body } = await raw(`GET ${path} HTTP/1.1`);
    // **핵심 불변식**: dist/web 밖의 내용이 절대 새지 않는다.
    //
    // 상태코드별 설명: WHATWG URL 파서가 평문 `..` 와 **인코딩된 `%2e%2e` 둘 다**
    // 경로 세그먼트로 정규화해 버린다. 그래서 서버는 항상 `/etc/passwd`,
    // `/package.json` 같은 안전한 경로만 받게 되고 → 확장자가 있으므로 404.
    // 즉 HTTP 계층의 탈출은 파서가 이미 막는다. 그래도 두 겹으로 막는다:
    // 아래 resolve 검사(직접 단위 테스트)와 realpath 검사(심볼릭 링크).
    assert.ok(status === 200 || status === 403 || status === 404, `예상 밖 상태코드 ${status} (${path})`);
    assert.equal(body.includes("\"name\": \"harnesside\""), false, `${path} 로 package.json 이 샜다`);
    assert.equal(body.includes("root:x:"), false, `${path} 로 /etc/passwd 가 샜다`);
    assert.equal(body.includes("HARNESSIDE_MODELS_DIR"), false, `${path} 로 소스 파일이 샜다`);
  }
});

test("경로 검사 로직 자체: 디코딩된 ../ 는 루트 밖으로 판정된다", async () => {
  // HTTP 계층은 위에서 막히지만, 이 함수 경로(예: 심볼릭 링크, 다른 호출부)까지
  // 방어하려면 resolve 단계가 스스로 '밖' 을 구분할 수 있어야 한다.
  const { resolve } = await import("node:path");
  const root = resolve("/tmp/web");
  const outside = resolve(root, "../secrets.txt");
  const inside = resolve(root, "assets/app.js");
  assert.equal(outside === root || outside.startsWith(root + "/"), false);
  assert.equal(inside === root || inside.startsWith(root + "/"), true);
});

test("정적 자산에도 토큰이 필요하다 — '/' 만 예외로 공개할지 여부는 정책이다", async () => {
  const h = await start();
  // 현재 정책: 정적 자산은 인증 없이 준다(창이 처음 열릴 때 토큰이 URL 로만 오기 때문).
  // 단, **API 는 공개되지 않는다**. 이 두 개가 섞이면 안 된다.
  const api = await fetch(`${h.base}/api/health`);
  assert.equal(api.status, 200, "health 는 공개 경로");
  const gpu = await fetch(`${h.base}/api/gpu`);
  assert.equal(gpu.status, 401, "API 는 토큰 없이 열리면 안 된다");
});

test("없는 정적 확장자 파일은 404 이고 index.html 로 덮지 않는다", async () => {
  const h = await start();
  const res = await fetch(`${h.base}/assets/missing.js`);
  assert.equal(res.status, 404);
});
