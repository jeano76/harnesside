import { test } from "node:test";
import assert from "node:assert/strict";
import { bootFailureLines, describeBootFailure, firstLine, UNKNOWN } from "./bootFailure.js";

test("실패 단계는 네 가지를 말한다 — 원인을 모르면 '확인 못 함' (지어내지 않는다)", () => {
  const f = describeBootFailure({ n: 8, name: "헬스체크 대기", ok: false, detail: "모델 서버 미기동", why: null, next: null })!;
  assert.equal(f.where, "8/12 헬스체크 대기");
  assert.equal(f.what, "모델 서버 미기동");
  assert.equal(f.why, UNKNOWN);
  assert.match(f.next, /확인 못 함/);
});

test("성공·미구현 단계는 실패로 말하지 않는다", () => {
  assert.equal(describeBootFailure({ n: 3, name: "x", ok: true, detail: "" }), null);
  assert.equal(describeBootFailure({ n: 9, name: "x", ok: false, detail: "", pending: true }), null);
  assert.deepEqual(bootFailureLines({ n: 3, name: "x", ok: true, detail: "" }), []);
});

test("원본 로그는 첫 의미 있는 줄 하나만, 200자로 자른다", () => {
  assert.equal(firstLine("\n\n  error: bind failed: Address already in use\nmore"), "error: bind failed: Address already in use");
  assert.equal(firstLine(""), null);
  assert.equal(firstLine("x".repeat(300))!.length, 200);
  const lines = bootFailureLines({ n: 11, name: "Chrome 기동", ok: false, detail: "d", why: "line1\nline2", next: "sudo apt install chromium" });
  assert.deepEqual(lines, ["       · 왜: line1", "       · 다음: sudo apt install chromium"]);
});
