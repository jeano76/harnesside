/** BlockHeader 계약 검사 (§3.12). 뒤집으면 실패해야 한다. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headerText, headerLabel } from "./BlockHeader.js";

describe("BlockHeader 계약", () => {
  it("순서가 도형+이름+대상+상태다", () => {
    assert.equal(headerText("shell", "ls -la", "exit 0"), "▸ Run shell · ls -la · exit 0");
    assert.equal(headerText("file", "a.ts"), "📄 Open · a.ts");
  });
  it("빈 대상·상태는 생략하고 지어내지 않는다", () => {
    assert.equal(headerText("assistant"), "🤖 Answer");
    assert.equal(headerText("shell", "   ", "  "), "▸ Run shell");
  });
  it("라벨이 비어 있지 않다", () => {
    for (const k of ["shell", "file", "search", "approval"] as const) {
      const m = headerLabel(k);
      assert.ok(m.glyph.length > 0 && m.label.length > 0);
    }
  });
});
