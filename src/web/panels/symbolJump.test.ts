/** symbolJump 검사 — 뒤집으면 실패해야 한다. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isJumpableKind, tokenColumn, isIdentifierText } from "./symbolJump.js";
import type { Token } from "../editor/highlight.js";

describe("symbolJump", () => {
  it("식별자 토큰만 점프 대상이다", () => {
    assert.ok(isJumpableKind("function"));
    assert.ok(isJumpableKind("plain"));
    assert.ok(isJumpableKind("type"));
    assert.ok(!isJumpableKind("keyword"), "키워드를 누르면 빈 정의가 돌아온다 — 보내지 않는다");
    assert.ok(!isJumpableKind("string"));
    assert.ok(!isJumpableKind("comment"));
    assert.ok(!isJumpableKind("number"));
    assert.ok(!isJumpableKind("punct"));
  });
  it("토큰 시작 열을 누적한다", () => {
    const toks: Token[] = [
      { kind: "plain", text: "const v = " },
      { kind: "function", text: "foo" },
      { kind: "punct", text: "();" },
    ];
    assert.equal(tokenColumn(toks, 0), 1);
    assert.equal(tokenColumn(toks, 1), 11);
    assert.equal(tokenColumn(toks, 2), 14);
  });
  it("공백 조각은 식별자가 아니다", () => {
    assert.ok(!isIdentifierText("   "));
    assert.ok(isIdentifierText("foo("));
  });
});
