import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isMultipleChoice } from "./multipleChoice.js";

test("번호 여러 개 목록은 다중 선택으로 감지한다", () => {
  assert.equal(isMultipleChoice("1) 사과\n2) 배"), true, "번호 두 개면 리스트");
  assert.equal(isMultipleChoice("1. A\n2. B"), true);
});

test("- 기호 두 줄도 목록으로 센다", () => {
  assert.equal(isMultipleChoice("- 선택가\n- 선택나"), true);
  assert.equal(isMultipleChoice("(A)\n(B)"), true);
});

test("선택 어휘만 있으면 약한 신호로 true", () => {
  assert.equal(isMultipleChoice("둘 중 하나를 골라 주세요"), true, "골라 + 중 하나");
  assert.equal(isMultipleChoice("어떤 것을 선택하시겠습니까"), true, "선택");
});

test("영문 pick/choose/select도 감지한다", () => {
  assert.equal(isMultipleChoice("Please choose one option"), true, "choose");
  assert.equal(isMultipleChoice("Which do you pick?"), true, "pick");
});

test("여러 목록이 없으면 false (느슨하게)", () => {
  assert.equal(isMultipleChoice("안녕하세요 어떻게 도와드릴까요"), false, "단문 질문");
  assert.equal(isMultipleChoice(""), false, "빈 문자열");
  assert.equal(isMultipleChoice(null), false, "null");
});

test("번호 하나만 있으면 리스트가 아니다", () => {
  assert.equal(isMultipleChoice("1) 첫 번째 항목만"), false, "번호 한 개");
});

test("기호 없는 평범한 두 문단은 목록이 아니다", () => {
  assert.equal(isMultipleChoice("Hello world\nThis is a test"), false, "영문 평문 2줄");
  assert.equal(isMultipleChoice("첫 번째 문장입니다\n두 번째 문장입니다"), false, "한글 평문 2줄");
  assert.equal(isMultipleChoice("Please explain\nThis feature"), false, "동사 없는 영문 2줄");
});
