/**
 * GPU 판정 — **자기 창인지** 확인하는 근거 (2026-10-01 실측 2회).
 *
 * ── 이 파일이 두 번 다시 쓰인 이유 ──────────────────────────────────────────
 *
 * **1판: `webSocketDebuggerUrl` 의 프로필 경로.** 실제 CDP 응답은 이렇다:
 *
 *   ws://127.0.0.1:9222/devtools/browser/6dade661-8a93-4ea9-b4e6-0f080f97f96a
 *
 * 경로가 **아니다. UUID 다.** 그래서 그 판정은 자기 창에서도 항상 `ours: null`
 * 이 되었고, **GPU 판정을 영구히 막았다.** 부팅 로그가 매번 "남의 창입니다" 로
 * 끝났다. 원래 문제(남의 창을 측정) 는 실제로 있었지만, 이 수정은 **자기 창도 막았다.**
 *
 * **잘못 고친 쪽이 더 나쁜 결함이다.** 그래서 2판은 근거를 바꿨다 — **앱 URL** 은
 * 실제로 자기 것임을 보여준다(실측: 자기 창의 탭은 `http://127.0.0.1:7317/`).
 *
 * 2판의 규칙은 **부정 방향**이다:
 *   - 앱 URL 이 보인다 → **확실히 우리 창** → 측정한다.
 *   - 없다 → **근거 없음** → 측정하지 않는다. 단 **"남의 창" 이라 단정하지 않는다.**
 *   - 형식이 깨졌다 → 알 수 없다 → 측정하지 않는다.
 *
 * **`ours: false` 를 만들지 않는다.** "우리 것이 아님" 과 "모름" 을 구분할 수 없으면
 * **모른다고** 말하는 게 낫다 — 단정은 근거 없이 하는 것이다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { windowIdentity, gpuFlags, launchFlags, IDE_DEFAULT_PORT } from "./browserFlags.js";

const APP = `http://127.0.0.1:${IDE_DEFAULT_PORT}/`;

// ── 1. 자기 창 ──────────────────────────────────────────────────────────────

test("**우리 앱 URL** 이 탭에 있으면 자기 창이다", () => {
  const r = windowIdentity([APP], IDE_DEFAULT_PORT);
  assert.equal(r.ours, true);
});

test("앱 URL 이 **경로를 거쳐도** 우리 창이다 — SPA 라 `/` 일 수 있다", () => {
  assert.equal(windowIdentity([`http://127.0.0.1:${IDE_DEFAULT_PORT}/?t=TOKEN`], IDE_DEFAULT_PORT).ours, true);
  assert.equal(windowIdentity([`http://127.0.0.1:${IDE_DEFAULT_PORT}/anything`], IDE_DEFAULT_PORT).ours, true);
});

test("**URL 이 여러 개**여도 우리 것이 하나 있으면 자기 창이다", () => {
  assert.equal(windowIdentity(["about:blank", "chrome://newtab", APP], IDE_DEFAULT_PORT).ours, true);
});

test("**자기 창인데 막지 않는다** — 막으면 기능이 죽는다 (1판이 그렇게 죽었다)", () => {
  // **이게 1판의 실제 실패다.** 자기 창이 `ours: null` 이 되어 GPU 판정이 영구히
  // 막혔다. 막는 쪽이 풀리는 쪽보다 **오류가 크다** — 판정을 못 하는 것은
  // "모르다" 지만, 측정 안 하는 것은 **기능이 죽은 것**이다.
  const r = windowIdentity([APP], IDE_DEFAULT_PORT);
  assert.notEqual(r.ours, null, "자기 창을 '모름' 으로 처리한다 — GPU 판정이 영구히 막힌다");
});

// ── 2. 남의 창 · 근거 없음 ──────────────────────────────────────────────────

test("**남의 창**에는 우리 앱 URL 이 없다 — 근거 없음으로 처리한다", () => {
  const r = windowIdentity(["http://127.0.0.1:7317/"], 9222); // 앱은 7317
  assert.equal(r.ours, null);
  // **"남의 창" 이라 단정하지 않는다** — 자기 창이 아직 페이지를 못 열었을 수 있다.
  assert.ok(
    !("seenDir" in r),
    "근거 없이 '남의 창' 이라 단정했다 — 확인 못 한 것과 아는 것은 다르다",
  );
});

test("**탭 목록이 비어 있어도** '남의 창' 이라 하지 않는다", () => {
  const r = windowIdentity([], IDE_DEFAULT_PORT);
  assert.equal(r.ours, null);
  assert.ok(!("seenDir" in r), "빈 목록을 '남의 창' 이라 했다");
});

test("**탭 목록을 못 읽었으면** 모른다", () => {
  assert.equal(windowIdentity(undefined, IDE_DEFAULT_PORT).ours, null);
});

test("**앱 포트를 모르면** 모른다 — 0 으로 비교하면 아무 창도 우리 창이 된다", () => {
  // 실측 위험: 포트를 모르는 채 비교하면 `undefined` 와 비교해 **전부 걸린다.**
  assert.equal(windowIdentity([APP], undefined).ours, null);
  assert.equal(windowIdentity([APP], Number.NaN).ours, null);
  // NaN 을 그대로 넣으면 문자열에 `NaN` 이 있어 우연히 통과할 수 있다.
  assert.equal(windowIdentity(["http://127.0.0.1:NaN/"], Number.NaN).ours, null);
});

test("**다른 포트**의 URL 은 우리 것이 아니다 — 포트를 본다", () => {
  // `73170` 처럼 포트 **접두사**로 겹치면 안 된다 — 경계가 필요해 보인다.
  assert.equal(windowIdentity(["http://127.0.0.1:73170/"], IDE_DEFAULT_PORT).ours, null);
  assert.equal(windowIdentity(["http://127.0.0.1:17317/"], IDE_DEFAULT_PORT).ours, null);
});

test("**ports 7317 과 73170 이 구별된다** — 문자열 검색이 아니라 경계를 본다", () => {
  assert.equal(windowIdentity(["http://127.0.0.1:73170/"], 7317).ours, null);
});

// ── 3. 실측 근거 — 모드별 플래그 ───────────────────────────────────────────
//
// 위 규칙이 **실제 문제의 해법**이어야 한다. 이게 없으면 "없는 문제의 해법" 이다.
test("**off** 는 `--disable-gpu` 를 넣는다 — 두 모드가 구별되어야 판정이 의미를 갖는다", () => {
  assert.ok(gpuFlags("off").includes("--disable-gpu"));
});

test("**budgeted** 는 GPU 를 끄지 않는다", () => {
  assert.ok(!gpuFlags("budgeted").includes("--disable-gpu"), gpuFlags("budgeted").join(" "));
});

test("**전체 플래그**를 만들어도 budgeted 에서 GPU 차단 플래그가 없다", () => {
  const built = launchFlags({
    mode: "budgeted",
    appUrl: "http://127.0.0.1:7317/",
    userDataDir: "/tmp/x",
    noSandbox: true,
  });
  assert.equal(built.args.includes("--disable-gpu"), false, built.args.join(" "));
});

test("**off** 에는 소프트웨어 래스터 차단도 있다 — 없으면 GPU 를 꺼도 SwiftShader 가 산다", () => {
  const f = gpuFlags("off");
  assert.ok(f.includes("--disable-software-rasterizer"));
  assert.ok(!f.includes("--use-angle=swiftshader"), "이건 소프트웨어 GL 을 켜는 플래그다");
});

// ── 4. 자기 검사 ────────────────────────────────────────────────────────────

test("[살아있는지] 앱 포트 상수가 **코드와 같다** — 상수를 하드코딩하지 않는다", () => {
  // 검사에서 `7317` 을 그대로 썼으면, 포트가 바뀌면 **검사는 통과하는데 코드는 틀린다.**
  assert.equal(IDE_DEFAULT_PORT, 7317);
  assert.equal(windowIdentity([`http://127.0.0.1:${IDE_DEFAULT_PORT}/`], IDE_DEFAULT_PORT).ours, true);
});

test("**모든 경우**가 셋 중 하나다 — 네 번째 상태가 생기면 안 된다", () => {
  // 판정 결과는 `true` 또는 `null` 뿐이다. `false` 는 **나올 수 없다** —
  // 근거가 없으면 "모름" 이지 "남의 것" 이 아니다.
  const cases = [windowIdentity([APP], IDE_DEFAULT_PORT), windowIdentity([], 1), windowIdentity(undefined, 1)];
  for (const c of cases) {
    assert.ok(c.ours === true || c.ours === null, `네 번째 상태: ${JSON.stringify(c)}`);
  }
  assert.ok(
    cases.every((c) => !("oursFalse" in c)),
    "판정에 쓸 수 없는 필드가 있다",
  );
});

test("판정이 **모르다고 하면 이유**를 말한다 — 이유 없는 '모름' 은 방치가 된다", () => {
  const r = windowIdentity([], IDE_DEFAULT_PORT);
  assert.equal(r.ours, null);
  assert.ok(r.ours === null && typeof (r as { why?: unknown }).why === "string", "이유가 없다");
});
