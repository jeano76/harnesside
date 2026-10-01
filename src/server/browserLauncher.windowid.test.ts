/**
 * GPU 판정 — **자기 창인지** 확인하고, **자기 창을 막지 않는다** (2026-10-01 실측 2회).
 *
 * ── 이 파일이 세 번 다시 쓰인 이유 ──────────────────────────────────────────
 *
 * **1판: `webSocketDebuggerUrl` 의 프로필 경로.** 실제 CDP 응답은:
 *
 *   ws://127.0.0.1:9222/devtools/browser/6dade661-8a93-4ea9-b4e6-0f080f97f96a
 *
 * **경로가 아니다. UUID 다.** 그래서 자기 창에서도 항상 `ours: null` 이 되었고 GPU
 * 판정을 **영구히 막았다** — 부팅 로그가 매번 "남의 창입니다" 로 끝났다.
 *
 * **잘못 고친 쪽이 더 나빴다.** 원래 문제(남의 창을 측정) 는 실제로 있었지만, 1판은
 * **자기 창도 막았다.** 검사 하나가 기능을 죽인 셈이다. 그래서 지금은
 * **근거가 없으면 막지 않는다** — 근거가 **확실히** 없을 때만 건너뛴다.
 *
 * **2판: 탭 목록의 앱 URL.** 실제로 작동한다 — 자기 창의 탭은 `http://127.0.0.1:7317/`
 * 다. 실측 결과: 부팅 로그가 `GPU 비활성 확인됨` 으로 끝났다.
 *
 * 규칙은 **부정 방향**이다. `ours: false` 를 만들지 않는다:
 *   - 앱 URL 이 보인다 → **확실히 우리 창** → 측정한다.
 *   - 없다 → **근거 없음** → 측정하지 않는다. **"남의 창" 이라 단정하지 않는다.**
 *   - 형식이 깨졌다 → 알 수 없다 → 측정하지 않는다.
 *
 * **왜 `false` 가 없는가:** 자기 창이 아직 페이지를 못 열었을 수 있다. 그때
 * "남의 창" 이라 단정하면 **틀린 이유**로 막는다. 확인 못 한 것과 아는 것이 다르다.
 */

import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { BrowserLauncher } from "./browserLauncher.js";
import { IDE_DEFAULT_PORT } from "./browserFlags.js";

const APP = `http://127.0.0.1:${IDE_DEFAULT_PORT}/`;

// ── 가짜 CDP: **자기 창인 경우 / 아닌 경우**를 실제로 만든다 ─────────────────
//
// 주입 `fetchImpl` 은 `systemInfo` 의 **WS 경로를 못 탄다.** 그래서 소켓을 세운다.
let tabUrls: string[] = [];
let httpServer: Server | null = null;
let wss: WebSocketServer | null = null;
let port = 0;

before(async () => {
  httpServer = createServer((req, res) => {
    if (req.url === "/json/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(tabUrls.map((url) => ({ type: "page", url }))));
      return;
    }
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/153", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/uuid-1234` }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => httpServer!.listen(0, "127.0.0.1", r));
  port = (httpServer!.address() as AddressInfo).port;

  wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { id?: number };
      if (m.id === 1) {
        ws.send(
          JSON.stringify({
            id: 1,
            result: {
              gpu: {
                auxAttributes: { glRenderer: "Disabled", glVendor: "disabled" },
                featureStatus: { opengl: "disabled_off", webgl: "disabled_off" },
              },
            },
          }),
        );
      }
    });
  });
});

after(async () => {
  wss?.clients.forEach((c) => c.terminate());
  wss?.close();
  await new Promise<void>((r) => httpServer?.close(() => r()));
});

/** [살아있는지] — 소켓이 안 떴으면 아래가 **검증 없이** 지나간다. */
function assertCdpAlive(): void {
  assert.ok(port > 0, "가짜 CDP 가 뜨지 않았다 — 아래 검사는 아무것도 검증하지 않는다");
}

async function check(mode: "off" | "budgeted" = "off", idePort = IDE_DEFAULT_PORT) {
  const warns: string[] = [];
  const l = new BrowserLauncher(
    { mode, appUrl: "http://127.0.0.1:7317/", userDataDir: "/tmp/ours", idePort },
    { logger: (lvl, msg) => { if (lvl === "warn") warns.push(msg); } },
  );
  return { v: await l.verifyGpu(port, { attempts: 1, intervalMs: 1 }), warns };
}

test("[살아있는지] 가짜 CDP 가 **응답**한다 — 없으면 아래가 조용히 통과한다", async () => {
  assertCdpAlive();
  tabUrls = [APP];
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  assert.equal(res.status, 200);
});

test("**자기 창**이면 GPU 를 실제로 읽는다 — 막으면 기능이 죽는다 (1판이 그렇게 죽었다)", async () => {
  assertCdpAlive();
  tabUrls = [APP];
  const { v, warns } = await check("off");
  assert.deepEqual(warns, [], `자기 창인데 거부했다: ${warns[0]}`);
  assert.equal(v.glRenderer, "Disabled", `GPU 를 읽지 못했다: ${v.detail}`);
  assert.equal(v.ok, true, v.detail);
});

test("**off 모드**에서 `Disabled` 면 **비활성 확인**이다 — 이게 정상 경로다", async () => {
  assertCdpAlive();
  tabUrls = [APP];
  const { v } = await check("off");
  assert.equal(v.ok, true, `off 인데 확인하지 못했다: ${v.detail}`);
  assert.match(v.detail, /비활성 확인/);
});

test("**우리 앱 URL 이 없는** 창은 측정하지 않는다 — 남의 창의 값을 믿으면 안 된다", async () => {
  assertCdpAlive();
  tabUrls = ["http://127.0.0.1:9999/", "about:blank"];
  const { v, warns } = await check("off");
  assert.equal(v.ok, false, "근거 없이 통과했다 — 거짓 통과");
  assert.equal(v.glRenderer, undefined, `남은 창의 값을 받았다: ${v.glRenderer}`);
  assert.match(warns[0] ?? "", /확인 못 했다/, "왜 건너뛰었는지 말하지 않는다");
});

test("'남의 창' 이라 **단정하지 않는다** — 근거가 없는 단정은 틀린 이유로 막는다", async () => {
  assertCdpAlive();
  tabUrls = [];
  const { warns } = await check("off");
  assert.doesNotMatch(warns[0] ?? "", /우리 것이 아닙니다/, "근거 없이 단정했다 — 자기 창이 못 열었을 수도 있다");
});

test("**다른 앱 포트**로 띄운 경우 그 포트를 본다 — 상수를 하드코딩하지 않는다", async () => {
  assertCdpAlive();
  // 앱이 8080 에 있고 탭은 7317 — 근거 없음.
  tabUrls = [APP];
  const { v } = await check("off", 8080);
  assert.equal(v.ok, false, "하드코딩된 7317 로 통과했다 — 앱 포트를 안 따라간다");
  // 앱이 8080 이고 탭도 8080 — 자기 창.
  tabUrls = ["http://127.0.0.1:8080/"];
  const ok = await check("off", 8080);
  assert.equal(ok.v.ok, true, `자기 창을 막았다: ${ok.v.detail}`);
});

test("**포트가 겹치면** 다른 앱으로 오해하지 않는다 — 7317 과 73170", async () => {
  assertCdpAlive();
  tabUrls = ["http://127.0.0.1:73170/"];
  const { v } = await check("off", 7317);
  assert.equal(v.ok, false, "73170 을 7317 로 읽었다 — 경계가 없다");
});

test("**예측할 수 없는 곳**을 지났다고 말하지 않는다 — 알면 말하고 모르면 모른다고 한다", async () => {
  assertCdpAlive();
  tabUrls = [APP];
  const good = await check("off");
  assert.equal(good.v.ok, true);
  tabUrls = ["http://127.0.0.1:9999/"];
  const bad = await check("off");
  assert.equal(bad.v.ok, false);
  // **둘 다 문장을 만든다** — 조용히 떨어지지 않는다.
  assert.ok(good.v.detail.length > 0 && bad.v.detail.length > 0);
});
