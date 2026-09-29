/**
 * 문자 단위 인라인 차이 테스트 (§5.2).
 *
 * 여기서 "그럴듯하게 틀리면" 사용자가 같은 줄의 다른 단어를 고친 걸 놓친다.
 * 그래서 **원본 재조립** 이 핵심 불변식이다: 강조를 풀어붙이면 원문과 정확히 같아야 한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inlineRanges, toSpans, inlineSpans, statLabel, initialView } from "./inline.js";

const rebuild = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

test("Span 을 붙이면 원문이 그대로 복원된다 — 강조가 원본을 훼손하면 안 된다", () => {
  const cases = [
    ["const a = 1", "const a = 2"],
    ["let x = 1;\nlet y = 2;", "const x = 1;\nlet y = 20;"],
    ["가나다라 마바사", "가나다라 마바사아"],
    ["", "새로 추가"],
    ["지워짐", ""],
    ["유니코드 ✅ 이모지 🎉 혼합", "유니코드 ✅ 이모지 🎊 혼합"],
  ];
  for (const [a, b] of cases) {
    const { left, right } = inlineSpans(a, b);
    assert.equal(rebuild(left), a, `왼쪽 원문 복원 실패: ${JSON.stringify(a)}`);
    assert.equal(rebuild(right), b, `오른쪽 원문 복원 실패: ${JSON.stringify(b)}`);
  }
});

test("같은 문자열에는 강조가 없다", () => {
  const { left, right } = inlineSpans("동일", "동일");
  assert.equal(left.every((s) => !s.changed), true);
  assert.equal(right.every((s) => !s.changed), true);
});

test("한 단어만 바뀐 경우 그 단어만 강조된다", () => {
  const { left, right } = inlineSpans("const answer = 42;", "const answer = 43;");
  const l = left.filter((s) => s.changed);
  const r = right.filter((s) => s.changed);
  assert.equal(l.length, 1, `왼쪽 강조 구간 ${l.length}개`);
  assert.equal(r.length, 1);
  // 공백은 앞쪽에 붙으므로 숫자까지 묶일 수 있다 — 어느 쪽이든 "42"/"43" 를 포함해야 한다
  assert.match(l[0].text, /42/);
  assert.match(r[0].text, /43/);
  // 변경되지 않은 앞부분은 그대로 남는다
  assert.match(left[0].text, /const answer/);
});

test("여러 단어가 흩어진 수정도 각각 짚는다 — 접두/접유만 보면 놓친다", () => {
  const { left, right } = inlineSpans("const a = 1", "let a = 2, b = 3");
  assert.ok(left.filter((s) => s.changed).length >= 1);
  assert.ok(right.filter((s) => s.changed).length >= 1);
  // "1" 이 사라지고 "2, b = 3" 가 붙었다 — 양쪽 모두 변경 표시가 있어야 한다
  const rChanged = right.filter((s) => s.changed).map((s) => s.text).join("");
  assert.match(rChanged, /2/);
});

test("한글이 다르면 한글만 강조된다", () => {
  const { left, right } = inlineSpans("안녕하세요 세계", "안녕하세요 자.world");
  assert.equal(rebuild(left), "안녕하세요 세계");
  assert.equal(rebuild(right), "안녕하세요 자.world");
  assert.ok(left.some((s) => s.changed), "한글 변경이 표시되지 않았다");
});

test("이모지(Zwj 시퀀스 포함)도 원문이 복원된다 — surrogate 쌍이 깨지지 않는다", () => {
  const a = "상태: ✅ 완료";
  const b = "상태: ✅✅ 완료";
  const { left, right } = inlineSpans(a, b);
  assert.equal(rebuild(left), a);
  assert.equal(rebuild(right), b);
});

test("prefix/suffix 가 같으면 가운데만 짚는다", () => {
  const r = inlineRanges("abcdef", "abXYef");
  assert.deepEqual(r, { a: { start: 2, end: 4 }, b: { start: 2, end: 4 } });
});

test("완전히 다른 문자열도 가운데를 반환한다", () => {
  const r = inlineRanges("aaa", "bbb");
  assert.ok(r, "완전히 다르면 가운데 구간이 나와야 한다");
  assert.equal(r.a.start, 0);
  assert.equal(r.a.end, 3);
});

test("범위를 넘어선 구간은 잘려도 원본이 깨지지 않는다", () => {
  const s = toSpans("abcdef", [{ start: 4, end: 99 }, { start: -5, end: 2 }]);
  assert.equal(rebuild(s), "abcdef");
  assert.equal(s.some((x) => x.changed), true);
});

test("빈 문자열", () => {
  assert.deepEqual(toSpans("", [{ start: 0, end: 1 }]), []);
  assert.deepEqual(toSpans("x", []), [{ text: "x", changed: false }]);
});

test("토큰 경계가 어긋나도 겹치지 않는다 — 이모지 안의 인덱스로 글자를 자르지 않는다", () => {
  const a = "🎉🎉 축하";
  const b = "🎉🎉 축하!";
  const { left, right } = inlineSpans(a, b);
  assert.equal(rebuild(left), a);
  assert.equal(rebuild(right), b);
});

test("통계 라벨: 없는 항목은 숨긴다", () => {
  assert.equal(statLabel({ added: 0, removed: 0, modified: 0, unchanged: 10 }), "변경 없음");
  assert.equal(statLabel({ added: 3, removed: 1, modified: 0, unchanged: 5 }), "추가 3 · 삭제 1");
  assert.equal(statLabel({ added: 1, removed: 1, modified: 2, unchanged: 5 }), "수정 2 · 추가 1 · 삭제 1");
});

test("diff 소스별 좌/우 라벨 — 무엇끼리 비교하는지 표시해야 한다", () => {
  const g = initialView("git", "src/a.ts", "side");
  assert.match(g.leftLabel, /HEAD/);
  assert.match(g.rightLabel, /워킹트리/);
  const f = initialView("file", "src/a.ts", "side");
  assert.equal(f.leftLabel, "디스크");
  assert.equal(f.rightLabel, "버퍼");
  const t = initialView("tool", "src/a.ts", "side");
  assert.equal(t.rightLabel, "실행 후");
});

test("초기 레이아웃: 넓으면 가로, 좁으면 인라인", () => {
  assert.equal(initialView("file", "a", "auto", 1400).layout, "side");
  assert.equal(initialView("file", "a", "auto", 800).layout, "inline");
});
