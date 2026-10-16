import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetToolOutput, effectiveCap } from "./contextBudget.js";

test("상한 이하이면 원문 그대로 — 잘리지 않았는데 잘렸다고 하지 않는다", () => {
  const r = budgetToolOutput("a\nb\nc", 1000, "p");
  assert.equal(r.truncated, false);
  assert.equal(r.text, "a\nb\nc");
});

test("10만 줄 출력도 상한 이하 · 실패 줄과 뒤쪽 요약이 남고 · 잘린 사실과 경로가 적힌다", () => {
  const lines: string[] = [];
  for (let i = 0; i < 100_000; i++) lines.push(`ok ${i} - some passing test name`);
  lines[50_000] = "not ok 50001 - 결제 합계 계산 FAIL: expected 3 got 4";
  lines.push("# tests 100001", "# fail 1");
  const cap = 6000;
  const r = budgetToolOutput(lines.join("\n"), cap, ".harnesside/tool-output/x.txt");
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= cap, `상한 초과: ${r.text.length} > ${cap}`);
  assert.ok(r.text.includes("not ok 50001 - 결제 합계 계산"), "중간의 실패 줄이 사라졌다");
  assert.ok(r.text.includes("# fail 1"), "끝부분의 실패 요약이 사라졌다");
  assert.ok(r.text.includes("ok 0 -"), "앞부분이 사라졌다");
  assert.ok(r.text.includes(".harnesside/tool-output/x.txt"), "원문 경로가 없다");
  assert.match(r.text, /줄 생략/);
  assert.ok(r.omittedLines > 99_000);
});

test("저장 경로가 없으면 '저장하지 못했다' 고 말한다 — 경로를 지어내지 않는다", () => {
  const r = budgetToolOutput("x\n".repeat(5000), 1000, null);
  assert.match(r.text, /저장하지 못했다/);
});

test("한 줄이 상한보다 길어도 상한 이하로 자른다", () => {
  const r = budgetToolOutput("y".repeat(200_000), 2000, "p");
  assert.ok(r.text.length <= 2000, String(r.text.length));
  assert.equal(r.truncated, true);
});

test("effectiveCap: 남은 여유가 적을수록 더 엄격하고 · 미측정이면 기준 그대로 · 바닥 1000", () => {
  assert.equal(effectiveCap(12_000, 90_000, null), 12_000);
  assert.equal(effectiveCap(12_000, 90_000, 0), 12_000);
  const tight = effectiveCap(12_000, 90_000, 85_000);
  assert.ok(tight < 12_000 && tight >= 1_000, String(tight));
  assert.ok(effectiveCap(12_000, 90_000, 70_000) > tight);
  assert.equal(effectiveCap(12_000, 90_000, 89_999), 1_000);
});
