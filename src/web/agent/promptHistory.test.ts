/**
 * 프롬프트 히스토리 규칙 — 사용자가 실제로 누르는 순서 그대로 검사한다.
 *
 * 세 가지를 따로 지킨다. 하나라도 깨지면 사람이 잃는다:
 *  1. 과거가 **순서대로** 나온다 (오래된 것부터)
 *  2. **쓰던 글**은 돌아오면 되살아난다 (브라우즈 끝에서 사라지지 않는다)
 *  3. **여러 줄 프롬프트**를 고치는 중에는 과거가 끼어들지 않는다
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildHistory,
  historyState,
  recallUp,
  recallDown,
  cancelBrowse,
  caretLine,
  shouldRecallUp,
  shouldRecallDown,
  type PromptHistoryState,
} from "./promptHistory.js";

const S = (items: string[]): PromptHistoryState => historyState(items);

// ── 1. 과거 목록 만들기 ────────────────────────────────────────────────────

test("**빈 줄은 버린다** — `↑` 로 빈 줄이 나오면 버그다", () => {
  assert.deepEqual(buildHistory(["", "   ", "\n"]), []);
});

test("**연속 중복은 하나로** — 같은 말을 두 번 연속 보낸 건 한 번만 꺼낸다", () => {
  assert.deepEqual(buildHistory(["같은 말", "같은 말", "다른 말"]), ["같은 말", "다른 말"]);
});

test("**연속 아닌 중복은 지우지 않는다** — Set 으로 만들면 셋 중 하나가 사라진다", () => {
  assert.deepEqual(buildHistory(["1번", "2번", "1번"]), ["1번", "2번", "1번"]);
});

test("앞뒤 공백을 정리한다 — 보낸 적 없는 말이 공백 때문에 잘려 나오면 안 된다", () => {
  assert.deepEqual(buildHistory(["  안녕  ", "하이"]), ["안녕", "하이"]);
});

// ── 2. 커서 위치로 지킨다 ───────────────────────────────────────────────────

test("**두 줄 프롬프트의 둘째 줄에서 `↑`** 는 과거가 아니라 커서 이동이다", () => {
  const t = "첫 줄\n둘째 줄";
  assert.equal(shouldRecallUp(t, 0), true, "첫 줄에서는 과거로 가야 한다");
  assert.equal(shouldRecallUp(t, t.indexOf("둘째 줄")), false, "둘째 줄에서 과거로 가면 본문을 못 고친다");
  assert.equal(caretLine(t, t.indexOf("둘째 줄")), 1);
});

test("**커서가 끝이 아닐 때 `↓`** 는 미래로 가지 않는다", () => {
  const t = "가운데 커서";
  assert.equal(shouldRecallDown(t, 3), false);
  assert.equal(shouldRecallDown(t, t.length), true, "마지막에 있으면 앞으로 갈 수 있다");
});

test("커서를 범위 밖으로 줘도 줄 수가 튀지 않는다 — 수학만 견뎌야 하는 곳이다", () => {
  assert.equal(caretLine("a\nb", -5), 0);
  assert.equal(caretLine("a\nb", 999), 1);
});

// ── 3. 과거/미래 이동 ───────────────────────────────────────────────────────

test("**`↑` 는 오래된 것부터** 나온다 (셸과 반대 순서가 아니라 실제 습관대로)", () => {
  const h = S(["첫 질문", "두 번째", "세 번째"]);
  let st = h;
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = recallUp(st, "");
    assert.ok(r, `${i}번째에서 멈췄다`);
    st = r!.next;
    seen.push(r!.text);
  }
  assert.deepEqual(seen, ["세 번째", "두 번째", "첫 질문"]);
});

test("**처음 입력창에 있던 글은 stash 에 남고**, 최신 다음에서 되살아난다", () => {
  let st = S(["옛 질문"]);
  const up = recallUp(st, "반쯤 쓴 문장")!;      // 브라우즈 시작
  st = up.next;
  assert.equal(up.text, "옛 질문");
  const down = recallDown(st)!;                  // 최신 다음으로
  assert.equal(down.text, "반쯤 쓴 문장", "쓰던 글이 사라졌다 — 사용자가 확인하려고 눌렀을 뿐이다");
  assert.equal(down.next.index, 1);
});

test("**최신보다 더 앞으로는 가지 않는다**", () => {
  // 항목 하나는 있으므로 `↑` 는 정상적으로 꺼낸다. 꺼낼 것이 없는 쪽만 검사한다.
  assert.equal(recallUp(S(["a"]), "")!.text, "a");
  assert.equal(recallUp(S([]), ""), null, "빈 히스토리에서 무언가를 꺼냈다");
  assert.equal(recallDown(S(["a", "b"])), null, "새 입력 상태에서 앞으로 갈 곳이 있다");
});

test("**가장 오래된 것에서 `↑`** 는 아무 일도 없다 — 커서가 튀면 안 된다", () => {
  let st = S(["하나"]);
  st = recallUp(st, "")!.next;   // index 0
  assert.equal(recallUp(st, ""), null);
});

test("**중간에서 `↓`** 는 그 다음 과거로 간다", () => {
  let st = S(["1번", "2번", "3번"]);
  st = recallUp(st, "")!.next;                 // 3번
  st = recallUp(st, "")!.next;                 // 2번
  const d = recallDown(st)!;
  assert.equal(d.text, "3번");
});

// ── 4. 글 을 고치면 브라우즈를 그만둔다 ────────────────────────────────────────

test("**글을 고치면 `↑` 는 최신부터 다시** — 본인이 한 곳에서 계속 뒤로 간다", () => {
  let st = S(["1번", "2번"]);
  st = recallUp(st, "")!.next;
  st = cancelBrowse(st);
  assert.equal(st.index, 2);
  assert.equal(recallUp(st, "")!.text, "2번");
});

test("**이미 새 입력 상태면** 글 고쳐도 상태는 그대로다 (불필요한 새 객체를 만들지 않는다)", () => {
  const st = S(["1번"]);
  assert.equal(cancelBrowse(st), st, "같은 객체를 돌려주지 않았다 — 렌더가 불필요하게 돈다");
});

// ── 5. 비어 있는 히스토리 ──────────────────────────────────────────────────

test("**히스토리가 비면** `↑` `↓` 다 아무 일도 없다 — 커서가 움직여야 한다", () => {
  const st = S([]);
  assert.equal(recallUp(st, "x"), null);
  assert.equal(recallDown(st), null);
});