/**
 * 끝 따라가기 판정 테스트 (§"작성 중인 코드는 실시간으로 보이고 스크롤이 생겨도 끝을 따라간다").
 *
 * React 렌더링은 여기서 검증하지 않는다. 핵심인 "끝 근처인가" 판정이 순수 함수
 * (shouldStickToBottom)에 분리되어 있는지, 그리고 스트리밍 보기(CodeBlock·
 * DiffPanel·LiveDraft)가 실제로 `autoScroll` 로 묶여 있는지를 고정한다 —
 * 판정이 컴포넌트 안에 가려 있으면 "위로 올린 사용자의 줄을 낚아채지 않는다" 는
 * 규칙이 깨져도 테스트가 모른다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldStickToBottom, STICK_THRESHOLD_PX, isOwnScroll, nextStick } from "./followTail.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

test("끝에 있으면 따라간다 (stick=true)", () => {
  // 1000 중 800 위치, 보이는 높이가 200 → 남은 거리 0.
  assert.equal(shouldStickToBottom(800, 1000, 200), true);
});

test("임계값 안쪽은 끝으로 본다", () => {
  assert.equal(shouldStickToBottom(800 - STICK_THRESHOLD_PX, 1000, 200), true, "정확히 경계도 끝이다");
  assert.equal(shouldStickToBottom(800 - STICK_THRESHOLD_PX - 1, 1000, 200), false, "1px 밖은 끝이 아니다");
});

test("위로 올린 상태에서는 손대지 않는다 (stick=false)", () => {
  assert.equal(shouldStickToBottom(100, 1000, 200), false, "700px 남은 데서 끝으로 끌면 읽는 줄을 낚아챈다");
});

test("스크롤이 생기기 전(넘치지 않음)은 따라간다", () => {
  assert.equal(shouldStickToBottom(0, 150, 200), true, "짧은 초안은 항상 보인다");
});

test("측정값이 비정상이면 따라가기로 둔다 (멈추는 쪽이 결함이다)", () => {
  assert.equal(shouldStickToBottom(NaN, 1000, 200), true);
  assert.equal(shouldStickToBottom(0, Infinity, 200), true);
});

test("CodeBlock 은 autoScroll prop 을 받아 pre 끝에 묶는다", () => {
  const src = read("CodeBlock.tsx");
  assert.ok(/autoScroll\?: boolean/.test(src), "CodeBlock 에 autoScroll prop 이 없다");
  assert.ok(/useFollowTail<HTMLPreElement>\(autoScroll/.test(src), "pre 가 follow 훅에 묶여 있지 않다");
});

test("DiffPanel 은 autoScroll prop 을 받아 양쪽 레이아웃 body 에 묶는다", () => {
  const src = read("../editor/DiffPanel.tsx");
  assert.ok(/autoScroll\?: boolean/.test(src), "DiffPanel 에 autoScroll prop 이 없다");
  assert.ok(/onBodyScroll\?: \(\) => void/.test(src), "body 스크롤이 자식 보기로 전달되지 않는다");
  assert.ok(/useFollowTail<HTMLDivElement>\(autoScroll, newText, bodyRef\)/.test(src), "새 내용이 올 때 끝을 보지 않는다");
});

test("LiveDraft 는 두 보기 모두에 autoScroll 을 켠다", () => {
  const src = read("AgentPanel.tsx");
  assert.ok(/<CodeBlock[^>]*autoScroll/.test(src), "새 파일 초안이 끝을 따라가지 않는다");
  assert.ok(/<DiffPanel(?:[^>]|\n)*?autoScroll/.test(src), "기존 파일 diff 초안이 끝을 따라가지 않는다");
});

// ── 스스로 따라가기를 끄지 않는다 (빠른 스트리밍에서 "자동 스크롤이 안 되는" 원인) ──────────

test("isOwnScroll: 우리가 놓은 위치와 같으면 우리 이벤트다", () => {
  assert.equal(isOwnScroll(800, 800), true);
  assert.equal(isOwnScroll(800.4, 800), true, "소수점 오차");
  assert.equal(isOwnScroll(700, 800), false, "사용자가 움직였다");
  assert.equal(isOwnScroll(800, null), false, "아직 우리가 옮긴 적이 없다");
});

test("nextStick: 우리가 옮긴 뒤 내용이 더 붙어 바닥과 멀어져도 따라가기를 끄지 않는다", () => {
  // 우리가 scrollTop=800 으로 옮겼고, 이벤트가 도착하기 전에 내용이 600px 더 붙어 scrollHeight 가 1600 이 됐다.
  const m = { scrollTop: 800, scrollHeight: 1600, clientHeight: 200 };
  assert.equal(shouldStickToBottom(m.scrollTop, m.scrollHeight, m.clientHeight), false, "이벤트 시점엔 바닥에서 멀다");
  assert.equal(nextStick(true, m, 800), true, "자기 이벤트를 '사용자가 올렸다' 로 읽으면 따라가기가 영영 꺼진다");
});

test("nextStick: 사용자가 위로 올리면 끈다, 바닥으로 돌아오면 다시 켠다", () => {
  assert.equal(nextStick(true, { scrollTop: 300, scrollHeight: 1000, clientHeight: 200 }, 800), false);
  assert.equal(nextStick(false, { scrollTop: 790, scrollHeight: 1000, clientHeight: 200 }, 300), true);
});

test("nextStick: 우리 이벤트가 바닥이면 꺼져 있던 것도 켠다", () => {
  assert.equal(nextStick(false, { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }, 800), true);
});

test("대화 영역은 DOM 을 직접 관찰하는 훅으로 따라간다 — 자라는 것이 블록 글자 수에 안 들어 있어도", () => {
  const src = read("AgentPanel.tsx");
  assert.ok(/useStickToBottom\(scroller\)/.test(src), "대화 스크롤러가 useStickToBottom 에 묶여 있지 않다");
  assert.ok(/onScroll=\{stick\.onScroll\}/.test(src), "스크롤 이벤트가 훅으로 가지 않는다");
  assert.ok(!/nearBottom\(/.test(src), "예전 40px 판정이 남아 있다 — 자기 이벤트에 스스로 꺼진다");
  const hook = read("useFollowTail.ts");
  assert.ok(/new MutationObserver/.test(hook) && /requestAnimationFrame/.test(hook), "DOM 변화 관찰/프레임 병합이 없다");
});

test("로그 패널은 디바운스로 스크롤하지 않는다 — 새 줄이 빠르면 타이머가 계속 취소되어 영영 발동하지 않았다", () => {
  const src = read("LogPanel.tsx");
  assert.ok(/useLayoutEffect\(/.test(src), "그려진 직후 바닥으로 옮기지 않는다");
  assert.ok(/nextStick\(/.test(src), "체크박스가 자기 이벤트에 스스로 꺼진다");
  assert.ok(!/window\.setTimeout\(/.test(src), "50ms 디바운스가 남아 있다");
});
