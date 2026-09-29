/**
 * "창을 띄워야 하는가" 규칙 테스트.
 *
 * 회귀 배경: `--no-browser` / `--daemon` 인데도 Chrome 이 떴다. 규칙을 한 줄짜리
 * 플래그 변수로만 남겨뒀다가 **그 변수를 안 쓰는 곳**이 생겼고(단계 11), 아무도 지키지
 * 않았다. 창 없는 데몬이 GPU 를 먹고, X 서버 없는 러너에서 죽었다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserIntent, windowLifecycleApplies, NO_BROWSER_FLAGS } from "./browserIntent.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("기본은 창을 띄운다 — 그것이 주 모드다 (D3)", () => {
  const i = resolveBrowserIntent(["node", "index.ts"]);
  assert.equal(i.launch, true, "플래그가 없으면 창 모드여야 한다");
  assert.ok(i.reason.length > 0, "이유가 없으면 사람이 읽을 수 없다");
});

for (const flag of NO_BROWSER_FLAGS) {
  test(`${flag} — 창을 띄우지 않는다`, () => {
    assert.equal(resolveBrowserIntent(["node", "index.ts", flag]).launch, false);
  });
}

test("--dry 도 창을 띄우지 않는다 — 부수효과 0 (§3.2)", () => {
  // `--dry` 는 "12단계 이름/순서만, 부수효과 0" 이다. 창을 띄우면 그 정의가 거짓이다.
  // 실제로 부팅 스모크가 X 서버 없는 러너에서 여기서 죽었다.
  const i = resolveBrowserIntent(["node", "index.ts", "--dry"]);
  assert.equal(i.launch, false);
  assert.match(i.reason, /부수효과 0|dry/, "dry 는 이유가 다르게 표시되어야 한다");
});

test("플래그 조합 — 하나라도 있으면 안 뜬다 (창 없는 쪽이 우선)", () => {
  // `--dry --no-browser` 처럼 같이 오면 창 없는 쪽이 맞다.
  assert.equal(resolveBrowserIntent(["node", "index.ts", "--no-browser", "--dry"]).launch, false);
  assert.equal(resolveBrowserIntent(["node", "index.ts", "--daemon", "--dry"]).launch, false);
});

test("비슷한 이름을 플래그로 받아들이지 않는다 — 정확히 일치해야 한다", () => {
  // `--no-browser-please` 나 `--nobrowser` 는 다른 플래그다. 부분 일치로 여기면
  // 사용자가 오타 낸 순간 조용히 창이 떠 버린다.
  assert.equal(resolveBrowserIntent(["node", "index.ts", "--no-browser-please"]).launch, true);
  assert.equal(resolveBrowserIntent(["node", "index.ts", "--nobrowser"]).launch, true);
});

test("--no-browser 의 이유를 로그에 실을 수 있다 — '조용히 안 함'", () => {
  const i = resolveBrowserIntent(["node", "index.ts", "--no-browser"]);
  assert.match(i.reason, /창 없음|llama 만/);
});

test("수명 규칙은 창이 있을 때만 성립한다 — 부재와 종료는 다른 신호", () => {
  // 워치독이 "창이 닫혔다" 를 들어야 하는 조건.
  assert.equal(windowLifecycleApplies(["node", "index.ts"]), true);
  assert.equal(windowLifecycleApplies(["node", "index.ts", "--no-browser"]), false);
  assert.equal(windowLifecycleApplies(["node", "index.ts", "--daemon"]), false);
});

// ── 구조 검사: 규칙이 만들어져도 **안 쓰면** 아무 소용이 없다 ──────────────────
// 실제로 그랬다. `NO_BROWSER` 변수는 있었고 단계 11 은 그걸 안 봤다.
test("단계 11 은 창 띄우기 **전에** NO_BROWSER 를 확인한다", async () => {
  const body = await readFile(join(ROOT, "src/server/index.ts"), "utf8");
  const stepStart = body.indexOf("11: async ({ result: r })");
  assert.ok(stepStart > 0, "단계 11 을 찾지 못했다");
  // 단계 11 이 어디서 끝나는지 — 다음 단계 번호 또는 lateSteps 끝.
  const stepEnd = body.indexOf("12: async", stepStart);
  const seg = body.slice(stepStart, stepEnd > 0 ? stepEnd : body.length);
  const guard = seg.indexOf("NO_BROWSER");
  const launch = seg.indexOf("new BrowserLauncher");
  assert.ok(guard > 0, "단계 11 이 NO_BROWSER 를 확인하지 않는다 — 창 없는 모드에서도 Chrome 이 뜬다");
  assert.ok(launch > 0, "단계 11 에서 BrowserLauncher 를 찾지 못했다");
  assert.ok(
    guard < launch,
    "단계 11 이 Chrome 을 **먼저** 띄우고 나중에 NO_BROWSER 를 본다 — 순서가 틀렸으면 창이 이미 떴다",
  );
});

test("워치독은 expectChrome 를 명시적으로 넘긴다 — 기본값에 기대지 않는다", async () => {
  // 기본값이 true 라서 생략해도 동작은 같다. 하지만 생략하면 버그가 **조용히** 돌아온다.
  // 그래서 규칙이 적용되는 자리에 의도를 드러낸다.
  const body = await readFile(join(ROOT, "src/server/index.ts"), "utf8");
  assert.match(body, /expectChrome:/, "index.ts 가 expectChrome 를 넘기지 않는다");
});
