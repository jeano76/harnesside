/**
 * 토큰 정본 검사 — PROMPT_UX_COMMERCIAL.md §3.13.
 * "뒤집으면 실패" 확인용: 값을 바꾸면 이 검사가 깨진다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COLOR, FONT, SPACE, RADIUS, LAYOUT, BLOCK_KIND_META, toneColor, statusGlyph } from "./tokens.js";

describe("tokens: 색상 정본 (§3.13)", () => {
  it("본문·메타·테두리·배경이 GitHub Dark 계열 고정값이다", () => {
    assert.equal(COLOR.FG, "#c9d1d9");
    assert.equal(COLOR.DIM, "#8b949e");
    assert.equal(COLOR.BORDER, "#30363d");
    assert.equal(COLOR.CODE_BG, "#161b22");
    assert.equal(COLOR.SURFACE_1, "#0d1117");
  });
  it("의미색이 고정값이다 (링크·성공·오류·경고·강조)", () => {
    assert.equal(COLOR.BLUE, "#79c0ff");
    assert.equal(COLOR.GREEN, "#7ee787");
    assert.equal(COLOR.GOOD, "#3fb950");
    assert.equal(COLOR.RED, "#ff7b72");
    assert.equal(COLOR.ERROR, "#f85149");
    assert.equal(COLOR.YELLOW, "#d29922");
    assert.equal(COLOR.PURPLE, "#d2a8ff");
    assert.equal(COLOR.ACTIVE_BLUE, "#0078d4");
  });
  it("toneColor가 상태바 기존 매핑과 같다", () => {
    assert.equal(toneColor("error"), "#f85149");
    assert.equal(toneColor("warn"), "#d29922");
    assert.equal(toneColor("good"), "#3fb950");
    assert.equal(toneColor(undefined), COLOR.DIM);
    assert.equal(toneColor("normal"), COLOR.DIM);
  });
  it("statusGlyph가 색+기호+말을 함께 준다 (색만 아님)", () => {
    const done = statusGlyph(true);
    const busy = statusGlyph(false);
    assert.equal(done.glyph, "✓");
    assert.equal(busy.glyph, "▸");
    assert.notEqual(done.color, busy.color);
    assert.ok(done.label.length > 0 && busy.label.length > 0);
  });
});

describe("tokens: 타이포·간격·레이아웃 수치", () => {
  it("폰트 스케일이 고정값이다", () => {
    assert.equal(FONT.BODY, 12);
    assert.equal(FONT.BODY_LARGE, 13);
    assert.equal(FONT.AUX, 11);
    assert.equal(FONT.META, 10);
    assert.equal(FONT.LINE_BODY, 1.6);
    assert.equal(FONT.LINE_CODE, 1.5);
    assert.equal(FONT.TAB_SIZE, 2);
  });
  it("간격이 고정값이다 (묶음16·블록8·중첩12·3단계상한)", () => {
    assert.equal(SPACE.TURN_GAP, 16);
    assert.equal(SPACE.BLOCK_GAP, 8);
    assert.equal(SPACE.NEST, 12);
    assert.equal(SPACE.MAX_NEST, 3);
  });
  it("반경·레이아웃이 고정값이다", () => {
    assert.equal(RADIUS.S, 4);
    assert.equal(RADIUS.M, 6);
    assert.equal(LAYOUT.ACTIVITY_WIDTH, 40);
    assert.equal(LAYOUT.STATUS_HEIGHT, 20);
    assert.equal(LAYOUT.FOLD_AT_LINES, 24);
  });
  it("블록 9종 메타가 비어 있지 않다", () => {
    for (const k of ["user", "assistant", "think", "shell", "file", "edit", "search", "approval", "notice"] as const) {
      assert.ok(BLOCK_KIND_META[k].glyph.length > 0, k);
      assert.ok(BLOCK_KIND_META[k].label.length > 0, k);
    }
  });
});
