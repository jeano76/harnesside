import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePaletteQuery,
  parseGotoLine,
  truncateInfo,
  formatAgentContext,
  SCOPE_BADGE,
  PREFIX_HELP,
} from "./prefix.js";

describe("U-1 palette prefix", () => {
  it("6종 접두어 파싱", () => {
    assert.equal(parsePaletteQuery(">build").scope, "commands");
    assert.equal(parsePaletteQuery("@rankFiles").scope, "symbols");
    assert.equal(parsePaletteQuery("#TODO").scope, "search");
    assert.equal(parsePaletteQuery(":src/a.ts:12").scope, "files");
    assert.equal(parsePaletteQuery("!test").scope, "recipes");
    assert.equal(parsePaletteQuery("loop").scope, "all");
    assert.equal(parsePaletteQuery("").scope, "all");
  });
  it("접두어 없는 질의는 전체 + 원문 유지", () => {
    const p = parsePaletteQuery("  loop  ");
    assert.equal(p.scope, "all");
    assert.equal(p.query, "  loop  ");
    assert.equal(p.explicit, false);
  });
  it("접두어 도움말은 항상 5개 (문서 없이 발견)", () => {
    assert.equal(PREFIX_HELP.length, 5);
    for (const h of PREFIX_HELP) assert.ok(h.prefix && h.labelKey);
  });
  it("범주 표시는 글자+모양 둘 다 (색만 아님)", () => {
    for (const [scope, b] of Object.entries(SCOPE_BADGE)) {
      assert.ok(b.letter, scope);
      assert.ok(b.glyph, scope);
    }
  });
  it("잘림 표기: 전체>표시일 때만 truncated", () => {
    assert.equal(truncateInfo(50, 12).truncated, true);
    assert.equal(truncateInfo(5, 12).truncated, false);
    assert.deepEqual(truncateInfo(50, 12), { shown: 12, total: 50, truncated: true });
  });
  it("줄 이동 파서: path:line:col, 아니면 null (지어내지 않음)", () => {
    assert.deepEqual(parseGotoLine("src/a.ts:12"), { path: "src/a.ts", line: 12, col: 1 });
    assert.deepEqual(parseGotoLine("src/a.ts:12:3"), { path: "src/a.ts", line: 12, col: 3 });
    assert.equal(parseGotoLine("no-colon-here"), null);
    assert.equal(parseGotoLine("a.ts:0"), null);
    assert.equal(parseGotoLine(":12"), null);
  });
  it("에이전트 맥락 칩: 파일은 [path:line]", () => {
    assert.equal(formatAgentContext({ kind: "file", label: "x", path: "src/a.ts", line: 12 }), "[src/a.ts:12]");
    assert.equal(formatAgentContext({ kind: "command", label: "palette.open" }), "[cmd:palette.open]");
  });
});
