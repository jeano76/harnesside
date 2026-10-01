/**
 * GPU 판정이 **남의 창을 읽지 않는지** (2026-10-01).
 *
 * 실측으로 출발했다. 부팅 로그에 이 줄이 있었다:
 *
 *   [gpu] GPU budgeted 모드 (Disabled)
 *
 * `budgeted` 인데 `Disabled` 라니 모순이다. 그래서 플래그 생성기를 직접 돌려 확인했다 —
 * **`budgeted` 플래그에는 `--disable-gpu` 가 없다.** 실제 `--disable-gpu` 로 떠 있던
 * 프로세스를 찾아보니 **이전 실행에서 남은 창**이었다(pid 763640, CDP 9222 점유).
 *
 * 즉 이 검사는 **우리가 띄우지 않은 창**을 읽어 GPU 가 꺼졌다고 보고했다. 더 나쁜 건
 * 이게 **양방향으로** 거짓말한다는 것이다:
 *  - 남의 `off` 창 → "GPU 비활성 확인" 이라는 **거짓 통과**
 *  - 남의 `full` 창 → "비활성 미확인" 이라는 **거짓 실패**
 *
 * 여기서는 판정 함수 자체와, 판정 불가가 **거짓말로 바뀌지 않는지** 를 고정한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { windowIdentity, gpuFlags, launchFlags, profileDir } from "./browserFlags.js";

// ── 1. 자기 창 판정 ──────────────────────────────────────────────────────────

test("**우리 프로필**이면 우리 창이다", () => {
  const dir = "/tmp/opencode/ub";
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent(dir)}`;
  assert.deepEqual(windowIdentity(ws, dir), { ours: true });
});

test("**다른 프로필**이면 남의 창이다 — 측정을 막아야 한다", () => {
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent("/tmp/opencode/c3")}`;
  const who = windowIdentity(ws, "/tmp/opencode/ub");
  assert.equal(who.ours, false, "남의 창을 우리 창으로 봤다");
  assert.equal((who as { seenDir: string }).seenDir, "/tmp/opencode/c3", "어느 창인지 말하지 않는다");
});

test("**경로 끝 슬래시**는 같은 창이다 — `/tmp/p` 와 `/tmp/p/` 가 다른 창으로 보이면 안 된다", () => {
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent("/tmp/p/")}`;
  assert.equal(windowIdentity(ws, "/tmp/p").ours, true, "끝 슬래시 하나 때문에 다른 창으로 봤다");
});

test("**경로에 한글이나 공백**이 있어도 경로로 읽는다 — 인코딩만 풀면 된다", () => {
  const dir = "/tmp/내 프로필/프로필 dir";
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent(dir)}`;
  assert.equal(windowIdentity(ws, dir).ours, true, "인코딩된 경로를 못 읽어 다른 창으로 봤다");
});

test("**앞부분만 같으면 남의 창이다** — `/tmp/p` 와 `/tmp/p2` 를 같다고 보면 안 된다", () => {
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent("/tmp/p2")}`;
  assert.equal(windowIdentity(ws, "/tmp/p").ours, false, "접두 일치로 우리 창이라 했다");
});

test("**깨진 퍼센트 인코딩**은 추측하지 않는다 — `ours: null` 이 정답", () => {
  // `%` 가 단독으로 나오면 decodeURIComponent 가 예외를 던진다. 그때 **"아니다" 도
  // "맞다" 도 아니고** 모른다고 말해야 한다 — 새는 창에서 false 를 내면 우리 창을
  // 버리고, true 를 내면 남의 창을 믿는다.
  const ws = "ws://127.0.0.1:9222/devtools/browser/%E0%A4%A";
  assert.deepEqual(windowIdentity(ws, "/tmp/x"), { ours: null });
});

test("**wsUrl 이 없으면** 모른다 — 빈 문자열을 경로로 보지 않는다", () => {
  assert.deepEqual(windowIdentity(undefined, "/tmp/x"), { ours: null });
  assert.deepEqual(windowIdentity("", "/tmp/x"), { ours: null });
});

test("**경로 형식이 아니면** 모른다 — devtools/browser 가 없으면 경로가 없다", () => {
  assert.deepEqual(windowIdentity("ws://127.0.0.1:9222/something/else", "/tmp/x"), { ours: null });
});

test("**우리 프로필을 모르면** 모른다 — 없는데 맞는 척하면 남의 창을 믿는다", () => {
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent("/tmp/other")}`;
  assert.deepEqual(windowIdentity(ws, undefined), { ours: null }, "모르는 것을 아는 척했다");
});

test("**`ours: null` 과 `ours: false` 는 다르다** — 둘을 합치면 결함이 숨는다", () => {
  // false = **확인함·남의 창**. null = **모름**. 둘을 같은 값으로 두면
  // "왜 GPU 확인이 안 되었나" 를 로그에서 못 찾는다.
  const other = windowIdentity(
    `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent("/tmp/other")}`,
    "/tmp/mine",
  );
  const unknown = windowIdentity("ws://127.0.0.1:9222/x", "/tmp/mine");
  assert.equal(other.ours, false);
  assert.equal(unknown.ours, null);
  assert.notEqual(other.ours, unknown.ours);
});

// ── 2. 실측 근거: budgeted 는 GPU 를 끄지 않는다 ────────────────────────────
//
// 이게 없으면 1번 검사가 "실제로 문제가 있었나" 를 증명하지 않는다. 즉 1번은
// **실제 문제의 해법**이고, 여기 없으면 **없는 문제의 해법**이다.
test("**budgeted** 는 `--disable-gpu` 를 넣지 않는다 — 실측된 모순의 근거", () => {
  const flags = gpuFlags("budgeted");
  assert.ok(
    !flags.includes("--disable-gpu"),
    `budgeted 에 --disable-gpu 가 있다: ${flags.join(" ")}`,
  );
  assert.ok(
    !flags.includes("--use-gl=disabled"),
    "GL 구현체를 없애면 GPU 를 끄는 것과 같다 — 예산 모드에서 과하다",
  );
});

test("**off** 는 `--disable-gpu` 를 넣는다 — 두 모드가 **구별되어야** 판정이 의미를 갖는다", () => {
  assert.ok(gpuFlags("off").includes("--disable-gpu"));
});

test("**off** 에는 소프트웨어 래스터 차단도 있다 — 없으면 GPU 를 꺼도 SwiftShader 가 산다", () => {
  const f = gpuFlags("off");
  assert.ok(f.includes("--disable-software-rasterizer"), "이게 빠지면 GPU off 를 측정할 수 없다");
  assert.ok(
    !f.includes("--use-angle=swiftshader"),
    "이건 소프트웨어 GL 을 켜는 플래그다 — 정반대다",
  );
});

test("**전체 플래그**를 만들어도 budgeted 에서 GPU 차단 플래그가 없다", () => {
  const built = launchFlags({
    mode: "budgeted",
    appUrl: "http://127.0.0.1:7317/",
    userDataDir: "/tmp/x",
    noSandbox: true,
  });
  assert.equal(
    built.args.includes("--disable-gpu"),
    false,
    `전체 조립 뒤에 GPU 차단 플래그가 생겼다: ${built.args.join(" ")}`,
  );
  assert.equal(built.mode, "budgeted");
});

// ── 3. 이 검사가 **자기 자신을** 속이지 않는지 ───────────────────────────────
//
// 1번이 "남의 창을 막는다" 고 말하려면, **우리가 띄운 창을 막지 않아야** 한다.
// 이게 깨지면 실제 앱이 GPU 검사를 못 한다 — 막지도 않고 되지도 않는 상태다.
test("**우리 창은 통과한다** — 막아 버리면 GPU 검사가 항상 실패한다", () => {
  const dir = "/home/jeano/.harnesside/chrome-profile";
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent(dir)}`;
  assert.equal(windowIdentity(ws, dir).ours, true);
});

test("**경로를 정확히 넣으면 통과한다** — 우리가 띄울 때 넘기는 값을 그대로 쓴다", () => {
  // 실제 호출은 `this.opts.userDataDir` 이며, 없으면 `profileDir(home)` 이다.
  // 두 값이 다르면 자기 창을 막는다 — 그래서 **동일해야** 한다.
  const dir = profileDir("/home/jeano");
  const ws = `ws://127.0.0.1:9222/devtools/browser/${encodeURIComponent(dir)}`;
  assert.equal(windowIdentity(ws, dir).ours, true);
});
