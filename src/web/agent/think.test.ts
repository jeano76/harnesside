/**
 * Think 상태 머신 테스트 (§5.3 · §10.2).
 *
 * 이 테스트가 지키는 것: **"생각만 하다가 아무것도 안 하는" 버그가 되돌아오지 않는다.**
 * 원본에서 실제로 일어난 일(420토큰 예산을 사고가 다 써서 tool_call 이 0개)이라,
 * 계측 없이 통과하는 테스트는 무의미하다. 전이를 **직접** 검증한다.
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
  thinkNotice,
  adoptServerThink,
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

// ── 예산 초과 안내 문구 (2026-10-05) ────────────────────────────────────────
//
// 사용자가 지목한 그대로: **thinking 은 상시 동작하는데 왜 "꺼짐" 이라 하나.**
// 화면 문구가 실제로 하는 일을 말하는지, 그리고 **추정치임을 말하는지** 를 고정한다.

test("**추론이 켜져 있고 안전하면 아무 말도 하지 않는다**", () => {
  const s = initialThink();
  assert.equal(thinkNotice(s, true), null, "정상인 데 경고를 띄웠다 — 상시 경고는 경고가 아니다");
});

test("**턴이 끝나면 아무 말도 하지 않는다** — 지난 경고가 다음 턴까지 남으면 안 된다", () => {
  const s = { ...initialThink(), enabled: false, needsWarning: true };
  assert.equal(thinkNotice(s, false), null);
});

test("**꺼졌다고 말하지 않는다** — 설정이 꺼진 것도 사고가 멈춘 것도 아니다", () => {
  const s = { ...initialThink(), enabled: false, needsWarning: true, usedTokens: 5000 };
  const n = thinkNotice(s, true);
  assert.ok(n, "전환되었는데 말하지 않는다");
  assert.ok(!n.text.includes("꺼짐"), `라벨이 여전히 꺼졌다고 말한다: ${n.text}`);
  assert.ok(!n.title.includes("꺼졌"), `툴팁이 아직 꺼졌다고 말한다: ${n.title}`);
});

test("**무엇이 일어났는지와 다음 무엇을 말하는지**가 둘 다 있다", () => {
  const s = { ...initialThink(), enabled: false, needsWarning: true, usedTokens: 5000 };
  const n = thinkNotice(s, true)!;
  assert.match(n.text, /추론 예산 초과/, `무엇이 일어났는지 없는다: ${n.text}`);
  assert.match(n.text, /도구 호출/, `무엇을 하게 되었는지 없다: ${n.text}`);
  assert.match(n.title, /원래대로 돌아갑니다|이 턴이 끝나면/, "이 전환이 영구적인지 말하지 않는다");
});

test("**숫자가 추정치라고 말한다** — 서버 로그도 스스로 추정치라고 적어 놓고 있다", () => {
  const s = { ...initialThink(), enabled: false, needsWarning: true, usedTokens: 5000 };
  const n = thinkNotice(s, true)!;
  assert.equal(n.estimated, true);
  assert.match(n.text, /추정/, `추정치라는 표시가 없다: ${n.text}`);
  assert.match(n.title, /추정한 값/, "툴팁에 추정이 없다");
});

test("**아직 초과하지 않았으면 초과라고 말하지 않는다** — 곧 임을 알린다", () => {
  const s = { ...initialThink(), enabled: true, needsWarning: true, usedTokens: 3900 };
  const n = thinkNotice(s, true)!;
  assert.match(n.text, /곧 초과/, `이미 초과한 것처럼 말한다: ${n.text}`);
  assert.ok(!n.text.includes("초과 →"), "아직 초과하지 않았는데 전환된 것처럼 말한다");
});

test("**상한과 추정치를 눈에 보이는 숫자로 함께 보여 준다** — 비교의 근거가 있어야 한다", () => {
  const s = { ...initialThink(), enabled: false, needsWarning: true, usedTokens: 4321, maxReasoningTokens: 4096 };
  const n = thinkNotice(s, true)!;
  assert.match(n.text, /4,321/, `쓴 양이 없다: ${n.text}`);
  assert.match(n.text, /4,096/, `상한이 없다: ${n.text}`);
});

// ── 서버 정본을 따른다 (2026-10-05) ────────────────────────────────────────
//
// 웹이 자기 기본값(4,096)으로 예산을 세고 있으면, 서버가 설정을 따라 64 로 좁혔어도
// **서버는 조용히 도구 호출을 강제하는데 화면은 아무 설명도 하지 않는다**(실측).

test("**서버가 알려 준 상한을 따른다** — 이것이 없으면 화면이 거짓말이 된다", () => {
  const s = initialThink();
  const next = adoptServerThink(s, { maxReasoningTokens: 64 });
  assert.equal(next.maxReasoningTokens, 64, "서버 값 대신 자기 기본값을 썼다");
});

test("**설정을 안 했으면** 기존 값을 유지한다 — 없는 것을 지어내지 않는다", () => {
  const s = { ...initialThink(), maxReasoningTokens: 2048 };
  const next = adoptServerThink(s, {});
  assert.equal(next.maxReasoningTokens, 2048);
});

test("**잘못된 서버 값은** 정본이 좁힌다 — 웹이 또 다른 규칙을 두지 않는다", () => {
  assert.equal(adoptServerThink(initialThink(), { maxReasoningTokens: 999999 }).maxReasoningTokens, 8192);
  // **보내는 값이 있는데** 쓸 수 없는 값이면 정본이 기본값으로 돌린다.
  assert.equal(adoptServerThink(initialThink(), { maxReasoningTokens: "전부" }).maxReasoningTokens, 4096);
});

test("**서버가 껐다고 하면** 그 상태도 따른다 — 켜짐 을 계속 보이는 것은 거짓말이다", () => {
  const next = adoptServerThink(initialThink(), { enabled: false, maxReasoningTokens: 64 });
  assert.equal(next.enabled, false);
  assert.equal(next.forcedToolChoice, true, "강제 전환을 모르는 채로 켜짐 을 유지한다");
});

test("**켜짐/끄짐 정보가 없으면** 기존 상태를 그대로 둔다", () => {
  const s = { ...initialThink(), enabled: false, forcedToolChoice: true };
  const next = adoptServerThink(s, { maxReasoningTokens: 512 });
  assert.equal(next.enabled, false, "값이 없는데 바꿨다");
  assert.equal(next.maxReasoningTokens, 512);
});

test("**상한을 맞춘 뒤에는** 임계 비교가 서버 값으로 이뤄진다 — 델타를 받으면 바로 넘는다", () => {
  let s = adoptServerThink(initialThink(), { maxReasoningTokens: 64 });
  assert.equal(s.enabled, true);
  s = ingest(s, { reasoning: "가".repeat(200) }); // 한글 200자 ≈ 300 토큰 추정
  assert.equal(s.enabled, false, "64 상한인데 임계에 안 미쳤다 — 여전히 4096 으로 계산하고 있다");
  assert.equal(s.forcedToolChoice, true);
});

// ── 턴 경계를 넘는 계량기 (실측 버그) ────────────────────────────────────────
// 서버는 매 턴 reasoningTokens 를 0부터 세는데, 웹은 finish/adopt 어디에서도
// usedTokens·needsWarning 을 비우지 않았다. 그래서 한 번 초과했거나 여러 턴에
// 걸쳐 사고가 쌓이면, 다음 턴에서 쓰지도 않은 예산으로 경고가 떴다.

test("상한의 80%에 들면 **끄지 않고** 곧 초과를 알린다 — 예보가 예보답게", () => {
  let s = initialThink({ enabled: true, maxReasoningTokens: 100 });
  s = ingest(s, { reasoning: "a".repeat(320) }); // ≈80 토큰 추정
  assert.equal(s.enabled, true, "80%인데 벌써 껐다");
  assert.equal(s.needsWarning, true, "임박했는데 조용하다");
  assert.equal(s.forcedToolChoice, false, "임박했는데 강제 전환했다");
  const n = thinkNotice(s, true)!;
  assert.match(n.text, /곧 초과/, `예보가 아니다: ${n.text}`);
});

test("80% 미만이면 조용하다 — 상시 경고는 경고가 아니다", () => {
  let s = initialThink({ enabled: true, maxReasoningTokens: 10000 });
  s = ingest(s, { reasoning: "짧게" });
  assert.equal(s.needsWarning, false);
  assert.equal(thinkNotice(s, true), null);
});

test("finish 는 **이번 턴의 계량기**를 비운다 — 정책은 그대로", () => {
  let s = initialThink({ enabled: true, maxReasoningTokens: 10 });
  s = ingest(s, { reasoning: "가나다라마바사아자차카타파하".repeat(10) });
  assert.equal(s.needsWarning, true);
  const done = finish(s);
  assert.equal(done.usedTokens, 0, "다음 턴이 전날 턴의 사용량을 물려받는다");
  assert.equal(done.needsWarning, false, "다음 턴이 전날 턴의 경고를 물려받는다");
  assert.equal(done.forcedToolChoice, false);
  assert.equal(done.reason, null);
  assert.equal(done.maxReasoningTokens, 10, "상한(정책)까지 초기화했다");
  assert.equal(thinkNotice(done, true), null, "끝난 턴의 경고가 다음 턴에 보인다");
});

test("adoptServerThink 는 턴 시작이므로 계량기를 비운다 — 상한 동기화와 별개", () => {
  let s = { ...initialThink(), usedTokens: 5000, needsWarning: true, forcedToolChoice: true, enabled: false };
  const next = adoptServerThink(s, { enabled: true, maxReasoningTokens: 4096 });
  assert.equal(next.usedTokens, 0);
  assert.equal(next.needsWarning, false);
  assert.equal(next.enabled, true);
});

test("그냥 꺼져 있는 것은 경고가 아니다 — 초과 관측이 있어야 말한다", () => {
  const off = { ...initialThink(), enabled: false };
  assert.equal(thinkNotice(off, true), null, "설정 OFF인데 매 턴 초과가 뜬다");
});

test("초과 → 턴 종료 → 다음 턴: 경고가 따라오지 않는다 (실측 시나리오)", () => {
  let s = initialThink({ enabled: true, maxReasoningTokens: 50 });
  for (let i = 0; i < 50; i++) s = ingest(s, { reasoning: "가나다라마바사아자차카타파하" });
  assert.ok(thinkNotice(s, true) !== null, "초과했는데 조용하다");
  s = finish(s); // 턴 끝
  s = adoptServerThink(s, { enabled: true, maxReasoningTokens: 50 }); // 다음 턴 시작
  assert.equal(thinkNotice(s, true), null, "지난 턴의 초과가 다음 턴에 보인다");
});

test("안내에 한 줄 꼬리표가 있다 — 표시줄과 숫자를 반복하지 않기 위해서", () => {
  const soon = thinkNotice({ ...initialThink(), enabled: true, needsWarning: true, usedTokens: 3900 }, true)!;
  assert.equal(soon.short, "곧 초과");
  assert.ok(!soon.short.includes("3,900"), `꼬리표에 숫자가 또 들어간다: ${soon.short}`);
  const over = thinkNotice({ ...initialThink(), enabled: false, needsWarning: true, usedTokens: 5000 }, true)!;
  assert.match(over.short, /초과/);
});
