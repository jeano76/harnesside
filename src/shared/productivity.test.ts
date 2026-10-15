import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeProductivity } from "./productivity.js";

describe("U-12 productivity", () => {
  it("빈 데이터 → 판정 불가 (0으로 채우지 않음)", () => {
    const s = summarizeProductivity([]);
    assert.equal(s.verdict, "insufficient");
    assert.match(s.message, /판정 불가/);
  });
  it("표본 부족 → 판정 불가", () => {
    const s = summarizeProductivity([
      { kind: "palette.open", at: 1 },
      { kind: "palette.select", at: 2 },
    ]);
    assert.equal(s.verdict, "insufficient");
  });
  it("충분한 표본 → available", () => {
    const s = summarizeProductivity([
      { kind: "palette.open", at: 1 },
      { kind: "palette.open", at: 2 },
      { kind: "palette.select", at: 3 },
      { kind: "keymap.change", at: 4 },
      { kind: "task.accept", at: 5 },
    ]);
    assert.equal(s.verdict, "available");
    assert.equal(s.byKind["palette.open"], 2);
  });
});
