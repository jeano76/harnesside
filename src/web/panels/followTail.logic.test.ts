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
import { shouldStickToBottom, STICK_THRESHOLD_PX } from "./followTail.js";

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
