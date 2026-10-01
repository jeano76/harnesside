/**
 * GPU 판정이 **남의 창을 읽지 않는지** — 진짜 소켓으로 (2026-10-01).
 *
 * 왜 **진짜 소켓**인가. 앞선 재현에서 두 번을 속았다:
 *  1. `fetchImpl` 만 주입하면 **WS 경로를 못 탄다** — `systemInfo` 가 별도로 소켓을
 *     열기 때문에 "판정을 시도했는가" 를 주입으로 확인할 수 없다.
 *  2. 가짜 CDP 서버를 띄우려 **포트를 겹쳐 써** 죽었다. 그 사실을 모르고
 *     "자기 창인데도 거부된다" 고 결론냈는데, 그건 서버가 안 떠서 그런 것이었다.
 *
 * 그래서 여기서는 **HTTP·WS 를 실제로 세운다.** 그리고 **포트 충돌을 먼저 확인**해
 * 자기 자신이 거짓말하지 않게 한다 — 앞선 2번이 그랬다.
 */

import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { BrowserLauncher } from "./browserLauncher.js";

/** 가짜 CDP 가 창을 가리키는 값. 남의 창일 수도, 우리 창일 수도 있다. */
let profileToReport = "";
let httpServer: Server | null = null;
let wss: WebSocketServer | null = null;
let port = 0;

before(async () => {
  httpServer = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: "Chrome/153.0.8010.52",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(profileToReport)}`,
        }),
      );
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
        // **켜져 있는** GPU 값. off 세트를 넘겨도 이 값이 나오면 판정은 실패해야 한다.
        ws.send(
          JSON.stringify({
            id: 1,
            result: {
              gpu: {
                auxAttributes: { glRenderer: "ANGLE (NVIDIA, RTX 2070 SUPER, OpenGL 4.6)", glVendor: "NVIDIA" },
                featureStatus: { webgl: "enabled", opengl: "enabled" },
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

/**
 * **자기 상태를 먼저 확인한다.** 소켓이 안 떴으면 아래 검사가 **검증 없이** 지나간다.
 * 앞선 재현이 정확히 그랬다 — 서버가 죽었는데 "재거부" 로 읽었다.
 */
function assertCdpAlive(): void {
  assert.ok(port > 0, "가짜 CDP 가 뜨지 않았다 — 아래 검사는 아무것도 검증하지 않는다");
}

/** 창이 `profileToReport` 인 상태에서, `ourProfile` 로 판정한 결과. */
async function check(ourProfile: string, mode: "off" | "budgeted" | "full" = "budgeted") {
  const warns: string[] = [];
  const l = new BrowserLauncher(
    { mode, appUrl: "http://127.0.0.1:7317/", userDataDir: ourProfile },
    { logger: (lvl, msg) => { if (lvl === "warn") warns.push(msg); } },
  );
  const v = await l.verifyGpu(port, { attempts: 1, intervalMs: 1 });
  return { v, warns };
}

test("[살아있는지] 가짜 CDP 가 **실제로 응답**한다 — 없으면 아래가 조용히 통과한다", async () => {
  assertCdpAlive();
  profileToReport = "/tmp/probe";
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { webSocketDebuggerUrl: string };
  assert.match(body.webSocketDebuggerUrl, /devtools\/browser\//, "wsUrl 이 형식을 벗어났다");
});

test("**자기 창**이면 GPU 를 실제로 읽는다 — 막아 버리면 판정이 늘 실패한다", async () => {
  assertCdpAlive();
  profileToReport = "/tmp/ours";
  const { v, warns } = await check("/tmp/ours");
  assert.equal(warns.length, 0, `자기 창인데 거부했다: ${warns[0]}`);
  assert.match(String(v.glRenderer), /ANGLE/, `GPU 를 읽지 못했다: ${v.detail}`);
  assert.equal(v.webgl, "enabled");
  assert.equal(v.ok, true, "자기 창의 켜진 GPU 를 실패로 봤다");
});

test("**남의 창**이면 **거부한다** — 남의 off 창을 우리로 읽으면 거짓 통과가 된다", async () => {
  assertCdpAlive();
  profileToReport = "/tmp/other-profile";
  const { v, warns } = await check("/tmp/ours");
  assert.equal(v.ok, false, "남의 창으로 **통과**했다 — 거짓 통과");
  assert.equal(v.glRenderer, undefined, `남의 창의 GPU 값을 그대로 받았다: ${v.glRenderer}`);
  assert.match(warns[0] ?? "", /우리 것이 아닙니다/, "왜 건너뛰었는지 경고가 없다");
  assert.match(warns[0] ?? "", /other-profile/, "어느 창인지 말하지 않는다");
});

test("**off 모드에서도** 남의 창이면 거부한다 — 여기가 제일 위험하다 (거짓 통과)", async () => {
  assertCdpAlive();
  profileToReport = "/tmp/other-profile";
  const { v, warns } = await check("/tmp/ours", "off");
  // 가짜 서버는 **켜진** GPU 를 보고한다. 그런데 모드는 off — 즉 기대는 "Disabled".
  // 남의 창을 읽었다면 값이 없어서 "확인 실패" 가 될 뿐 **거짓 통과는 안 된다**;
  // 진짜 위험은 반대다 — 남의 **off** 창을 읽으면 "GPU 비활성 확인" 이 된다.
  assert.equal(v.ok, false, "남의 창으로 off 판정을 통과했다");
  assert.match(warns[0] ?? "", /우리 것이 아닙니다/);
  assert.doesNotMatch(v.detail, /비활성 확인됨/, "거짓으로 GPU 비활성을 확인했다고 했다");
});

test("**판정 불가**(wsUrl 형식 없음)는 '아니오' 와 **다르다** — 같은 문장이면 원인 사라진다", async () => {
  assertCdpAlive();
  profileToReport = "";
  const { v, warns } = await check("/tmp/ours");
  assert.equal(v.ok, false);
  // **"남의 창" 이라고 하면 안 된다** — 형식이 다른 것이지 프로필이 다른 게 아니다.
  assert.doesNotMatch(warns[0] ?? "", /우리 것이 아닙니다/, "모르는 것을 '남의 것' 이라 단정했다");
  assert.match(warns[0] ?? "", /확인할 수 없습니다/, "왜 모르는지 말하지 않는다");
});

test("**경로 끝 슬래시**는 같은 창 — 거절하면 자기 창을 잃는다", async () => {
  assertCdpAlive();
  profileToReport = "/tmp/ours/";
  const { v, warns } = await check("/tmp/ours");
  assert.equal(warns.length, 0, `끝 슬래시 하나를 다른 창으로 봤다: ${warns[0]}`);
  assert.equal(v.ok, true, v.detail);
});

test("**한글 프로필 경로**도 자기 창 — 인코딩만 풀면 된다", async () => {
  assertCdpAlive();
  const dir = "/tmp/내 프로필/프로필 dir";
  profileToReport = dir;
  const { v, warns } = await check(dir);
  assert.equal(warns.length, 0, `한글 경로를 못 읽었다: ${warns[0]}`);
  assert.equal(v.ok, true, v.detail);
});

test("**접두만 같으면** 남의 창 — `/tmp/p` 와 `/tmp/p2` 를 같다고 보면 안 된다", async () => {
  assertCdpAlive();
  profileToReport = "/tmp/p2";
  const { v } = await check("/tmp/p");
  assert.equal(v.ok, false, "접두 일치로 자기 창이라 했다");
});
