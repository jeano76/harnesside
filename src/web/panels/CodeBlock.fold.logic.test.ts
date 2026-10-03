/**
 * 코드 블록 **접기 규칙** 테스트 (§4 · "폴드 UI").
 *
 * React 렌더링은 여기서 검증하지 않는다. 접기가 보여져야 할 때만 보이게 한다는
 * 규칙의 핵심인 `canToggle` 결정이 Pure 함수(computeFold)로 분리되어 있는지, 그리고
 * 그 규칙이 지켜지는지를 확인한다 — 이 계산이 컴포넌트 안에 가려 있으면 요구한 "폴드 UI
 * 가 보이느냐"가 실제로는 "보이지 않는다"가 될 수 있다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeFold, FIRST_COLLAPSED_LINES } from "./CodeBlock.js";

const longLines = Array.from({ length: 30 }, (_, i) => "line" + i); // 30 lines > 24
const shortLines = ["only", "three"]; // 3 lines

test("collapsible AND over 24 줄이면 **접기 UI 가 보인다** (canToggle=true)", () => {
  const f = computeFold(longLines, true);
  assert.equal(f.canToggle, true, "30줄+collapsible 에서 접기 버튼이 보이지 않았다");
  assert.equal(f.lineCount, 30);
});

test("24 줄 이하면 **접기 UI 가 안 보인다** (canToggle=false)", () => {
  // 경계: 정확히 24 줄은 "지나치지 않은" 짧음.
  const atBoundary = Array.from({ length: FIRST_COLLAPSED_LINES }, () => "x");
  assert.equal(computeFold(atBoundary, true).canToggle, false, "정확히 24줄이 접기 버튼 보였다");

  // 25 줄은 비로소 넘음.
  const overBoundary = Array.from({ length: FIRST_COLLAPSED_LINES + 1 }, () => "x");
  assert.equal(computeFold(overBoundary, true).canToggle, true, "25줄도 접기 불가 — 경계가 틀렸다");

  // 짧은 텍스트는 collapsible 이여도 안 보인다.
  assert.equal(computeFold(shortLines, true).canToggle, false, "짧은 출력에 펼치기 버튼이 거짓으로 보였다");
});

test("collapsible=false 이면 줄이 길어도 **접기 UI 가 안 보인다** (canToggle=false)", () => {
  // 명령줄만 하이라이트되는 등 접기를 원하지 않는 블록.
  assert.equal(computeFold(longLines, false).canToggle, false, "collapsible 아닌 긴 출력도 접을 수 있었다");
});

test("computeFold 의 결과는 CodeBlock 내부 계산과 **동일한 규칙**이다", () => {
  // CodeBlock 은 inline 으로 `canToggle = collapsible && tooLong` 을 썼다. 이 테스트는
  // 그 규칙이 분리된 함수에 그대로 유지됨을 고정한다 — 코드가 다시 안으로 숨겨지거나
  // 규칙이 바뀌면 떨어진다.
  const lines = Array.from({ length: 40 }, () => "x");
  assert.equal(computeFold(lines, true).canToggle, lines.length > FIRST_COLLAPSED_LINES);
});
