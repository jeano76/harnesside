/**
 * 파일 생성 초안 추출 테스트.
 *
 * 이 테스트가 지키는 것: 인자 JSON 이 **아직 완성되지 않은 상태**(조각 단위로 도착)에서도
 * 본문이 실시간으로 보인다. 끝까지 기다려야만 보인다면 "파일 작성 중" 표시는 의미가 없다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { draftView } from "./draft.js";

test("완성된 인자에서 경로와 본문을 꺼내고 이스케이프를 푼다", () => {
  const v = draftView(String.raw`{"path":"src/a.py","content":"def f():\n\treturn \"hi\"\n"}`);
  assert.equal(v.path, "src/a.py");
  assert.equal(v.hasBody, true);
  assert.equal(v.text, 'def f():\n\treturn "hi"\n');
});

test("본문이 조각으로 도착해도 지금까지 온 만큼 보인다", () => {
  const partial = String.raw`{"path":"a.txt","content":"첫 줄\n둘째 줄 진행`;
  const v = draftView(partial);
  assert.equal(v.path, "a.txt");
  assert.equal(v.text, "첫 줄\n둘째 줄 진행");
});

test("끝에 걸친 역슬래시는 다음 조각을 기다리며 버린다", () => {
  const v = draftView('{"path":"a","content":"abc\\');
  assert.equal(v.text, "abc");
});

test("경로가 아직 없으면 null, 본문 키가 없으면 원문을 보여준다", () => {
  const early = draftView('{"con');
  assert.equal(early.path, null);
  assert.equal(early.hasBody, false);
  assert.equal(early.text, '{"con');
});

test("유니코드 이스케이프를 푼다", () => {
  const v = draftView(String.raw`{"content":"한글"}`);
  assert.equal(v.text, "한글");
});
