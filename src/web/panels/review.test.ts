/**
 * 변경 검토 패널 테스트 (M2 · §10.2).
 *
 * 여기서 가장 무서운 실패는 **되돌리기가 사용자의 새 편집을 지우는 것** 이다.
 * 그래서 "결정 이후 변경" 케이스를 반복해서 검증한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  hashOf,
  makeItem,
  decide,
  refreshHashes,
  revert,
  summarize,
  summaryLabel,
  sortForReview,
  type ReviewItem,
} from "./review.js";

const item = (path: string, over: Partial<ReviewItem> = {}): ReviewItem =>
  makeItem(path, 3, 1, hashOf("v1"), 1000) && { ...makeItem(path, 3, 1, hashOf("v1"), 1000), ...over };

test("결정은 **한 번만** — 이중 실행 방지", () => {
  const a = decide([item("a.ts")], item("a.ts").id, "approved");
  assert.equal(a.changed, true);
  const again = decide(a.items, item("a.ts").id, "approved");
  assert.equal(again.changed, false, "같은 승인 두 번");
  assert.match(again.reason, /이미 승인/);
  // 반대 결정은 가능해야 한다 (사용자가 생각을 바꿈)
  const flip = decide(a.items, item("a.ts").id, "rejected");
  assert.equal(flip.changed, true);
});

test("없는 항목은 거부하고 **이유** 를 말한다", () => {
  const r = decide([], "없는 id", "approved");
  assert.equal(r.changed, false);
  assert.match(r.reason, /찾을 수 없/);
});

test("결정 시점의 해시를 **기록**한다 — 이것이 stale 판정의 기준", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "approved");
  assert.equal(d.items[0].decidedHash, hashOf("v1"));
});

test("결정 후 내용이 바뀌면 **승인이 무효화**된다", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "approved");
  assert.equal(d.items[0].state, "approved");
  const refreshed = refreshHashes(d.items, { "a.ts": hashOf("v2") });
  assert.equal(refreshed[0].state, "stale", "바뀐 내용을 그대로 승인했다");
  assert.match(refreshed[0].note ?? "", /다시 검토/);
});

test("거절 후 변경되어도 stale 이 된다", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "rejected");
  assert.equal(refreshHashes(d.items, { "a.ts": hashOf("v2") })[0].state, "stale");
});

test("미결정 항목은 변경되어도 **stale 가 아니다** (애초에 결정이 없으므로)", () => {
  const it = item("a.ts");
  const r = refreshHashes([it], { "a.ts": hashOf("v2") });
  assert.equal(r[0].state, "pending");
  assert.equal(r[0].currentHash, hashOf("v2"), "현재 해시를 갱신하지 않았다");
});

test("해시가 같으면 상태가 유지된다", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "approved");
  assert.equal(refreshHashes(d.items, { "a.ts": hashOf("v1") })[0].state, "approved");
});

test("되돌리기는 **사본을 남긴다** — 실패하면 복구할 곳이 있어야 한다", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "rejected");
  const r = revert(d.items, it.id, "/tmp/bak/a.ts", "이전 내용");
  assert.equal(r.ok, true);
  assert.equal(r.backup, "/tmp/bak/a.ts");
  assert.equal(r.items[0].state, "reverted");
  assert.match(r.reason, /되돌렸습니다/);
});

test("**stale 은 되돌리지 않는다** — 사용자의 새 편집을 지우게 된다", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "rejected");
  const stale = refreshHashes(d.items, { "a.ts": hashOf("v2") });
  const r = revert(stale, it.id, "/tmp/bak/a.ts", "이전 내용");
  assert.equal(r.ok, false, "바뀐 내용을 되돌렸다 — 지금 편집이 사라진다");
  assert.match(r.reason, /지금 내용을 잃습니다/);
});

test("미결정 항목은 되돌리지 않는다", () => {
  const it = item("a.ts");
  const r = revert([it], it.id, "/tmp/bak", "원본");
  assert.equal(r.ok, false);
  assert.match(r.reason, /아직 결정되지/);
});

test("이미 되돌린 항목은 다시 되돌리지 않는다", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "rejected");
  const first = revert(d.items, it.id, "/tmp/bak", "원본");
  const second = revert(first.items, it.id, "/tmp/bak2", "원본");
  assert.equal(second.ok, false);
  assert.match(second.reason, /이미 되돌렸/);
});

test("원본 내용이 비면 되돌리지 않는다 — 빈 파일로 덮어쓴다", () => {
  const it = item("a.ts");
  const d = decide([it], it.id, "rejected");
  const r = revert(d.items, it.id, "/tmp/bak", "");
  assert.equal(r.ok, false, "빈 원본으로 덮어썼다");
});

test("없으면 거부", () => {
  const r = revert([], "nope", "/tmp/bak", "x");
  assert.equal(r.ok, false);
  assert.match(r.reason, /찾을 수 없/);
});

test("요약: **검토 대기** 와 완료가 구분된다", () => {
  const a = decide([item("a.ts")], item("a.ts").id, "approved").items;
  const b = decide([item("b.ts")], item("b.ts").id, "rejected").items;
  const s = summarize([...a, ...b, item("c.ts")]);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.needsReview, true);
  assert.equal(s.total, 3);
  // stale 도 "검토가 남아 있다" 다
  const stale = summarize(refreshHashes(a, { "a.ts": hashOf("v9") }));
  assert.equal(stale.needsReview, true, "stale 인데 검토가 끝났다고 했다");
  assert.equal(stale.stale, 1);
});

test("검토가 하나도 없으면 '완료' 가 아니라 **needsReview=false** 로만 말한다", () => {
  const a = decide([item("a.ts")], item("a.ts").id, "approved").items;
  const s = summarize(a);
  assert.equal(s.needsReview, false);
  assert.equal(s.pending, 0);
});

test("요약 라벨: 대기/다시 검토 수를 **숫자로** 보여준다", () => {
  const it = item("a.ts"); // +3 −1
  const d = decide([it], it.id, "approved");
  const stale = refreshHashes(d.items, { "a.ts": hashOf("v2") });
  const label = summaryLabel(summarize(stale));
  assert.match(label, /\+3/);
  assert.match(label, /−1/);
  assert.match(label, /다시 검토 1/);
  // stale 은 "검토 대기" 로도 센다 — 사용자가 할 일이 남아 있다
  assert.match(label, /검토 대기 1/);
  assert.equal(summaryLabel(summarize([])), "변경 없음");
});

test("정렬: **다시 검토 → 대기** 순 — 사용자가 볼 것을 먼저", () => {
  const items: ReviewItem[] = [
    { ...item("z.ts"), state: "approved" },
    { ...item("a.ts"), state: "pending" },
    { ...item("m.ts"), state: "stale" },
    { ...item("b.ts"), state: "reverted" },
  ];
  assert.deepEqual(sortForReview(items).map((i) => i.state), ["stale", "pending", "approved", "reverted"]);
  // 같은 상태 안에서는 경로순 — 목록이 실행마다 달라지면 안 된다
  const two = sortForReview([{ ...item("z.ts"), state: "pending" }, { ...item("a.ts"), state: "pending" }]);
  assert.deepEqual(two.map((i) => i.path), ["a.ts", "z.ts"]);
});

test("해시는 내용이 바뀌면 **반드시** 달라진다", () => {
  assert.notEqual(hashOf("v1"), hashOf("v2"));
  assert.equal(hashOf("v1"), hashOf("v1"));
  // 한 글자만 달라도 (I/O 같은 짧은 문자열에서도)
  assert.notEqual(hashOf("a"), hashOf("b"));
  assert.equal(hashOf(""), hashOf(""));
});
