/**
 * diff 테스트 (§5.2 · §10.2).
 *
 * diff 는 "그럴듯하게 틀릴 수 있는" 계산이다. 검증하지 않으면 사용자는 그럴듯한
 * 틀린 diff 를 믿고 검토를 통과시킨다 — 코드 리뷰에서 가장 위험한 종류의 오류.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diffText, diffLines, buildHunks, layoutFor, pairModifications } from "./diff.js";

test("변경 없으면 hunk 가 없다", () => {
  const r = diffText("a\nb\nc", "a\nb\nc");
  assert.equal(r.stat.added, 0);
  assert.equal(r.stat.removed, 0);
  assert.equal(r.hunks.length, 0);
  assert.equal(r.wholeFileChanged, false);
});

test("한 줄 수정은 **modify 한 줄** 로 잡힌다 — 삭제 1 + 추가 1 로 부풀지 않는다", () => {
  const r = diffText("a\nb\nc", "a\nB2\nc");
  // 한 줄 교체는 +1/−1 이다(git 과 동일). modify 로 묶이지 않으면 통계가 두 배로 부풀고
  // 인라인 폴백에서 문자 단위 강조를 할 대상이 사라진다.
  assert.equal(r.stat.modified, 1);
  assert.equal(r.stat.added, 1);
  assert.equal(r.stat.removed, 1);
  assert.equal(r.hunks.length, 1);
  // modify 짝은 **2줄** 이다 — 인라인 폴백에서 문자 단위 강조를 하려면 두 줄이 다 필요하다.
  const kinds = r.hunks[0].lines.map((l) => l.kind);
  assert.deepEqual(kinds, ["context", "modify", "modify", "context"]);
  assert.equal(mod0(r).text, "b", "짝의 첫 줄은 이전 내용");
  assert.equal(mod1(r).text, "B2", "짝의 둘째 줄은 새 내용");
});

/** modify 짝의 첫 줄/둘째 줄을 꺼낸다(테스트가 짝 구조를 직접 확인하도록). */
function mod0(r: ReturnType<typeof diffText>) {
  return r.hunks.flatMap((h) => h.lines).find((l) => l.kind === "modify")!;
}
function mod1(r: ReturnType<typeof diffText>) {
  return r.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "modify")[1];
}

test("순수 추가(기존 줄이 그대로)는 add 다 — modify 로 잘못 묶지 않는다", () => {
  const r = diffText("a\nc", "a\nb\nc");
  assert.equal(r.stat.added, 1, "추가된 줄을 수정으로 세면 \"무엇을 추가했나\" 가 안 보인다");
  assert.equal(r.stat.modified, 0);
  assert.equal(r.hunks[0].lines.some((l) => l.kind === "add" && l.text === "b"), true);
});

test("줄 삭제도 정확히 잡는다", () => {
  const r = diffText("a\nb\nc", "a\nc");
  assert.equal(r.stat.removed, 1);
  const del = r.hunks[0].lines.find((l) => l.kind === "del");
  assert.equal(del?.text, "b");
});

test("hunk 는 변경 주변만 담는다 — 전체를 보내지 않는다", () => {
  const a = Array.from({ length: 200 }, (_, i) => `줄 ${i}`);
  const b = [...a];
  b[100] = "바뀐 줄";
  const r = diffText(a.join("\n"), b.join("\n"), 3);
  // 한 줄 교체 = 수정 1건, +1/−1
  assert.equal(r.stat.modified, 1);
  assert.equal(r.stat.added, 1);
  assert.equal(r.stat.removed, 1);
  // 3줄 문맥 + modify 짝 2줄 = 8줄
  assert.ok(r.hunks[0].lines.length <= 8, `hunk 가 ${r.hunks[0].lines.length} 줄이다 — 주변 3줄만 있어야 한다`);
  assert.ok(r.stat.unchanged > 190, "변경 주변의 문맥 줄을 통째로 보내는 것이 아니다");
});

test("여러 위치 변경 → 여러 hunk", () => {
  const a = Array.from({ length: 100 }, (_, i) => `줄 ${i}`);
  const b = [...a];
  b[10] = "A";
  b[80] = "B";
  const r = diffText(a.join("\n"), b.join("\n"), 2);
  assert.equal(r.hunks.length, 2, "변경이 둘인데 hunk 가 하나다");
});

test("hunk 헤더에 이전/현재 시작 줄이 들어간다", () => {
  const r = diffText("a\nb\nc", "a\nX\nc");
  assert.match(r.hunks[0].header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
});

test("전체 변경으로 판단된다 — 그러면 hunk 지도가 의미가 없다", () => {
  const r = diffText("a\nb", "x\ny");
  assert.equal(r.wholeFileChanged, true);
  assert.equal(r.stat.unchanged, 0);
});

test("빈 문자열과의 비교", () => {
  const r = diffText("", "a\nb");
  assert.equal(r.stat.added, 2);
  const r2 = diffText("a\nb", "");
  assert.equal(r2.stat.removed, 2);
  assert.equal(diffText("", "").hunks.length, 0);
});

test("아주 큰 입력에서도 터지지 않는다 — O(n*m) 상한이 있다", () => {
  const big = Array.from({ length: 20_000 }, (_, i) => `줄 ${i}`);
  const t0 = Date.now();
  const r = diffText(big.join("\n"), big.join("\n"));
  assert.equal(r.stat.added, 0, "동일한 파일에 차이가 있다고 나왔다");
  assert.ok(Date.now() - t0 < 5000, "느리다");
});

test("레이아웃: 기본은 가로, 좁으면 인라인 — **사용자 설정이 우선**", () => {
  assert.equal(layoutFor(1600), "side", "넓은 화면인데 인라인");
  assert.equal(layoutFor(1000), "side");
  assert.equal(layoutFor(800), "inline", "좁은데 가로로 억지로");
  // 사용자가 명시하면 폭을 무시한다
  assert.equal(layoutFor(400, "side"), "side", "사용자 설정을 레이아웃이 덮어썼다");
  assert.equal(layoutFor(4000, "inline"), "inline");
});

test("modify 쌍은 인라인 폴백에서 한 쌍으로 묶인다", () => {
  const lines = [
    { line: 1, text: "a", kind: "context" as const },
    { line: 2, text: "old", kind: "del" as const },
    { line: 2, text: "new", kind: "add" as const },
    { line: 3, text: "c", kind: "context" as const },
  ];
  const paired = pairModifications(lines);
  assert.equal(paired[1].kind, "modify");
  assert.equal(paired[2].kind, "modify");
  assert.equal(paired[1].pairedWith, 2);
  assert.equal(paired[2].pairedWith, 2);
  assert.equal(paired[0].kind, "context", "문맥 줄이 바뀌었다");
});

test("연속 del 은 modify 로 묶이지 않는다 — 실제 삭제다", () => {
  const lines = [
    { line: 1, text: "a", kind: "del" as const },
    { line: 2, text: "b", kind: "del" as const },
    { line: 1, text: "x", kind: "add" as const },
  ];
  const paired = pairModifications(lines);
  assert.deepEqual(paired.map((l) => l.kind), ["del", "del", "add"]);
});

test("연속 add 도 마찬가지 — 여러 줄 추가를 수정으로 뭉개지 않는다", () => {
  const lines = [
    { line: 1, text: "a", kind: "del" as const },
    { line: 1, text: "x", kind: "add" as const },
    { line: 2, text: "y", kind: "add" as const },
  ];
  const paired = pairModifications(lines);
  assert.deepEqual(paired.map((l) => l.kind), ["del", "add", "add"]);
});

test("한 쌍을 묶은 뒤 **다음 쌍도** 묶는다 — 이전 짝이 다음 짝을 흡수하지 않는다", () => {
  // 버그의 재발 방지: del/add 를 짝지은 뒤 인덱스를 잘못 옮기면, 두 번째 del/add 가
  // 다시 del 로 보고되어 한 쌍이 사라지거나 세 번 짝지어진다.
  const lines = [
    { line: 1, text: "a", kind: "del" as const },
    { line: 1, text: "A", kind: "add" as const },
    { line: 2, text: "b", kind: "del" as const },
    { line: 2, text: "B", kind: "add" as const },
    { line: 3, text: "c", kind: "context" as const },
  ];
  const paired = pairModifications(lines);
  assert.deepEqual(paired.map((l) => l.kind), ["modify", "modify", "modify", "modify", "context"]);
  assert.equal(paired[0].text, "a");
  assert.equal(paired[1].text, "A");
  assert.equal(paired[2].text, "b");
  assert.equal(paired[3].text, "B");
});

test("통계가 본문과 일치한다 — 어긋나면 화면이 거짓말을 한다", () => {
  const r = diffText("a\nb\nc\nd", "a\nX\nc\nY");
  const all = r.hunks.flatMap((h) => h.lines);
  const add = all.filter((l) => l.kind === "add").length;
  const del = all.filter((l) => l.kind === "del").length;
  const modPairs = all.filter((l) => l.kind === "modify").length / 2;
  const ctx = all.filter((l) => l.kind === "context").length;
  // 이 변경은 전부 1:1 교체이므로 modify 짝 2개여야 한다.
  assert.equal(modPairs, 2, "한 줄 교체를 modify 로 묶지 못했다");
  assert.equal(r.stat.modified, modPairs, "수정 건수가 본문과 다르다");
  // modify 는 +1/−1 로 합계에도 들어가므로 add/del 도 짝수만큼 늘어난다.
  assert.equal(r.stat.added, add + modPairs, "추가 통계가 본문과 다르다");
  assert.equal(r.stat.removed, del + modPairs, "삭제 통계가 본문과 다르다");
  // hunk 밖 문맥은 세지 않으므로 "이상" 이어야 한다
  assert.ok(r.stat.unchanged >= ctx);
});

test("통계 합계가 헤더 표기와 일치한다 — '+N −M' 은 눈에 보이는 줄 수다", () => {
  // 순수 추가 2 + 순수 삭제 1 + 수정 1 → +4 −2 (수정도 +1/−1)
  const r = diffText("a\nb\nc\nd", "a\nX\nc\ne\nf");
  assert.equal(r.stat.modified, 1);
  assert.equal(r.stat.added, 1 + 1 + 1, "순수 추가 1 + 수정 1");
  assert.equal(r.stat.removed, 1 + 1, "순수 삭제 1 + 수정 1");
});
