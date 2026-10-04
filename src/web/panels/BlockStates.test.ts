/** BlockStates 3상태 검사 (§3.4). 뒤집으면 실패해야 한다. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBlankQuery } from "./BlockStates.js";

describe("BlockStates 판정", () => {
  it("공백만 있는 검색어는 빈 것으로 본다", () => {
    assert.equal(isBlankQuery(""), true);
    assert.equal(isBlankQuery("   "), true);
    assert.equal(isBlankQuery("  \t\n "), true);
  });
  it("글자가 있으면 빈 것이 아니다", () => {
    assert.equal(isBlankQuery("a"), false);
    assert.equal(isBlankQuery("  fix  "), false);
  });
});
