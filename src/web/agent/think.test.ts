/**
 * Think 상태 머신 테스트 (§5.3 · §10.2).
 *
 * 이 테스트가 지키는 것: **"생각만 하다가 아무것도 안 하는" 버그가 되돌아오지 않는다.**
 * 원본에서 실제로 일어난 일(420토큰 예산을 사고가 다 써서 tool_call 이 0개)이라,
 * 계측 없이 통과하는 테스트는 worthless 다. 전이를 **직접** 검증한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  initialThink,
  ingest,
  toolChoiceFor,
  elapsedSec,
  speed,
  finish,
  animationFor,
  shouldAnimate,
  initialRetry,
  retryAfterNoTool,
  exhaustedMessage,
  DEFAULT_MAX_REASONING,
} from "./think.js";

test("기본값은 thinking **ON** — 사고가 안 보이면 '기능이 없다' 고 읽힌다 (2026-10-01)", () => {
  const s = initialThink();
  assert.equal(s.enabled, true, "기본이 꺼져 있다 — 화면에 사고가 안 보인다");
  // **경고는 켜짐과 무관**이다. 켜져 있는 것과 위험한 것은 다르다.
  assert.equal(s.needsWarning, false, "시작하자마자 경고를 띄운다 — 상시 보이는 경고는 경고가 아니다");
  assert.equal(toolChoiceFor(s), "auto");
});

test("기본을 켜도 **안전장치는 그대로다** — 상한과 강제 전환 (§5.3 함정)", () => {
  // 원본에서 겪은 사고: 420토큰 예산에서 thinking 을 켜면 tool_call 이 하나도 안 나왔다.
  // 그래서 상한과 초과 시 `tool_choice: "required"` 전환을 **유지**해야 한다.
  // 기본을 켠 것이 이 두 가지를 없애는 근거가 아니다.
  const s = initialThink();
  assert.equal(s.maxReasoningTokens, DEFAULT_MAX_REASONING, "상한이 없다 — 사고가 예산을 다 쓸 수 있다");
  let over = ingest(s, { reasoning: "가".repeat(20000) });
  assert.equal(over.forcedToolChoice, true, "초과해도 강제 전환하지 않는다 — tool_call 이 사라진다");
  assert.equal(over.enabled, false, "초과했는데 사고가 계속된다");
  assert.equal(toolChoiceFor(over), "required");
  assert.equal(over.needsWarning, true, "위험해진 순간에 경고를 띄우지 않는다");
});

test("명시적으로 끌 수 있다 — 기본값이 강제가 아니다", () => {
  assert.equal(initialThink({ enabled: false }).enabled, false);
});

test("사고 델타가 누적된다", () => {
  let s = initialThink({ enabled: true });
  s = ingest(s, { reasoning: "abc" });
  s = ingest(s, { reasoning: "def" });
  assert.ok(s.usedTokens > 0, "사고 토큰이 세지지 않았다");
  const before = s.usedTokens;
  s = ingest(s, { text: "답변" });
  assert.equal(s.usedTokens, before, "답변 텍스트가 사고 토큰에 섞였다");
});

test("예산을 초과하면 **thinking 을 끄고 tool_choice=required 로 전환**된다", () => {
  let s = initialThink({ enabled: true, maxReasoningTokens: 50 });
  // 원본 함정 재현: 예산이 찬 사고가 계속 나온다.
  for (let i = 0; i < 50; i++) s = ingest(s, { reasoning: "가나다라마바사아자차카타파하가나다라마바사아자차카타파하" });
  assert.equal(s.forcedToolChoice, true, "강제 전환이 일어나지 않았다 — 도구 호출이 계속 누락된다");
  assert.equal(s.enabled, false, "thinking 이 꺼지지 않았다");
  assert.equal(toolChoiceFor(s), "required", "tool_choice 가 required 가 아니다");
  assert.ok(s.reason, "전환 사유가 없다 — 사용자는 왜 바뀌었는지 모른다");
  assert.match(s.reason!, /상한/);
});

test("**한 번만** 전환한다 — 매 델타마다 사유가 바뀌지 않는다", () => {
  let s = initialThink({ enabled: true, maxReasoningTokens: 10 });
  for (let i = 0; i < 100; i++) s = ingest(s, { reasoning: "가나다라마바사아자차카타파하" });
  const reason = s.reason;
  s = ingest(s, { reasoning: "또 사고가 계속 이어지는 아주 긴 델타" });
  assert.equal(s.reason, reason, "사유가 계속 갱신된다 — 화면이 깜빡인다");
  assert.equal(s.forcedToolChoice, true);
});

test("예산 안이면 강제 전환하지 않는다 — 정상 경로가 막히면 안 된다", () => {
  let s = initialThink({ enabled: true, maxReasoningTokens: 10000 });
  for (let i = 0; i < 10; i++) s = ingest(s, { reasoning: "짧게" });
  assert.equal(s.forcedToolChoice, false);
  assert.equal(toolChoiceFor(s), "auto", "정상인데 도구 호출을 강제했다");
});

test("thinking OFF 인데 델타가 와도 예산 전환은 없다", () => {
  let s = initialThink({ enabled: false, maxReasoningTokens: 5 });
  for (let i = 0; i < 20; i++) s = ingest(s, { reasoning: "가나다라마바사아자차카타파하" });
  assert.equal(s.forcedToolChoice, false, "꺼진 thinking 이 켜졌다");
});

test("경과 시간: 시작 전은 null — 0 초가 아니다", () => {
  const s = initialThink({ enabled: true });
  assert.equal(elapsedSec(s), null, "시작 전인데 0 초가 나왔다");
  let t = ingest(s, { reasoning: "x" });
  const start = t.startedAt!;
  assert.equal(elapsedSec(t, start), 0);
  assert.equal(elapsedSec(t, start + 2500), 2.5);
  t = finish(t);
  assert.equal(t.startedAt, null, "종료 후에도 시간이 흐른다");
});

test("속도: 시간이 0 이거나 미측정이면 null — **0 tok/s 는 거짓말**", () => {
  const s = ingest(initialThink({ enabled: true }), { reasoning: "가나다라마" });
  assert.equal(speed(s, s.startedAt!), null, "0초에 속도를 냈다");
  const fast = speed(s, s.startedAt! + 1000);
  assert.ok(fast !== null && fast > 0, `속도가 잘못됐다: ${fast}`);
  // 토큰 0 이면 속도도 없다(0/0 = 0 으로 쓰면 "정지" 처럼 보인다)
  assert.equal(speed({ ...s, usedTokens: 0 }, s.startedAt! + 1000), null);
});

test("애니메이션: 기본은 3개 파동 도트 1.2s (§5.3)", () => {
  const a = animationFor("dots");
  assert.equal(a.dots, 3);
  assert.equal(a.durationMs, 1200);
});

test("대안 4종이 모두 설정된다 — 하나라도 빠지면 사용자가 고를 수 없다", () => {
  for (const s of ["pulse", "orbit", "shimmer", "bar"] as const) {
    const a = animationFor(s);
    assert.ok(a.durationMs >= 0, `${s} 에 duration 이 없다`);
  }
  assert.equal(animationFor("shimmer").dots, 0, "shimmer 에 도트가 있다");
  assert.equal(animationFor("bar").dots, 0);
});

test("prefers-reduced-motion 이면 애니메이션을 멈춘다 — 텍스트만", () => {
  assert.equal(shouldAnimate("dots", true), false);
  assert.equal(shouldAnimate("dots", false), true);
  // style 과 무관하게 reduced 가 우선이어야 한다
  assert.equal(shouldAnimate("orbit", true), false);
});

test("도구를 안 고르면 **2회 재시도 후 명확한 오류** — 무한 재시도 금지", () => {
  let r = initialRetry(2);
  assert.equal(r.exhausted, false);
  const a1 = retryAfterNoTool(r, "tool_call 없음");
  assert.equal(a1.shouldRetry, true, "첫 실패에서 포기했다");
  const a2 = retryAfterNoTool(a1, "tool_call 없음");
  assert.equal(a2.attempts, 2);
  assert.equal(a2.exhausted, true, "2회째인데 아직 시도한다");
  assert.equal(a2.shouldRetry, false, "무한 재시도가 됐다");
  // 세 번째는 애초에 시도하지 않는다
  const a3 = retryAfterNoTool(a2, "tool_call 없음");
  assert.equal(a3.shouldRetry, false);
  assert.equal(a3.attempts, 3);
});

test("소진 오류 문구에 원인과 조치가 **둘 다** 있다", () => {
  let r = initialRetry(2);
  r = retryAfterNoTool(r, "응답에 tool_call 이 없음");
  r = retryAfterNoTool(r, "응답에 tool_call 이 없음");
  const msg = exhaustedMessage(r);
  assert.match(msg, /응답에 tool_call 이 없음/, "마지막 오류를 숨겼다");
  assert.match(msg, /reasoning|max_tokens/, "조치 방법이 없다");
  assert.match(msg, /2회/, "몇 번 시도했는지 않는다");
});

test("maxAttempts 가 1 이면 한 번 만에 포기한다", () => {
  let r = initialRetry(1);
  const a = retryAfterNoTool(r, "e");
  assert.equal(a.exhausted, true);
  assert.equal(a.shouldRetry, false);
});
