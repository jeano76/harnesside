/**
 * 슬래시 메뉴 스크롤 계산 (R: "화살표로 이동 시 다음 항목으로 자동 스크롤이 안 된다").
 *
 * 고장: 리스트박스는 `maxHeight:240, overflowY:auto` 인데 **아무도 스크롤하지 않았다.**
 * 그래서 표시만 화면 아래로 사라지고 목록이 멈췄다.
 *
 * 여기서 고정하는 것 — **"최소한만" 움직인다**가 핵심이다. 필요 이상으로 스크롤하면
 * 사용자가 보던 항목이 위로 사라지고 그것도 못 보게 된다. 한 칸씩 연속으로 내려가야
 * "누르고 있다" 는 느낌이 난다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { scrollTopToShow } from "./slashScroll.js";

const H = 240; // maxHeight
const ROW = 24; // 항목 높이 (padding 4+4 + fontSize 12 줄)

test("첫 항목은 **아무것도 안 움직인다** — 이미 보이면 손대지 않는다", () => {
  assert.equal(scrollTopToShow({ scrollTop: 0, clientHeight: H, itemTop: 0, itemHeight: ROW }), 0);
});

test("**아래로 넘기면** 선택이 보이도록 내려간다", () => {
  // 240px 창에 24px 행 → 10개가 보인다. 11번째(인덱스 10, itemTop 240)는 딱 경계 밖.
  const next = scrollTopToShow({ scrollTop: 0, clientHeight: H, itemTop: 240, itemHeight: ROW });
  assert.equal(next, 240 + ROW - H, "선택이 보이지 않는데 목록이 안 움직였다");
});

test("**연속으로 한 칸씩** 내려간다 — 필요한 만큼만", () => {
  // 목록이 길수록 이 성질이 중요하다. 항목 수를 늘려서 검사한다:
  // 240px 창에 24px 행 = 10개가 보인다.
  const COUNT = 100;
  let top = 0;
  let maxJump = 0;
  const seen: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    const next = scrollTopToShow({ scrollTop: top, clientHeight: H, itemTop: i * ROW, itemHeight: ROW });
    maxJump = Math.max(maxJump, Math.abs(next - top));
    top = next;
    seen.push(top);
  }
  // 0..9 는 그대로 (처음부터 보이는 구간).
  assert.deepEqual(seen.slice(0, 10), new Array(10).fill(0), "아직 보이는 구간에서 움직였다");
  // **어떤 순간에도 한 칸(ROW)보다 많이 움직이지 않는다.**
  // 이것이 "최소한만" 의 정확한 정의다 — 한 번에 맨 아래로 뛰지 않는다.
  assert.equal(maxJump, ROW, `한 번에 ${maxJump}px 움직였다 — 필요한 만큼만 이어야 한다`);
  // 끝까지 가면 맨 아래에 붙어 있어야 한다 (마지막 항목의 아랫변 기준).
  assert.equal(seen[COUNT - 1], (COUNT - 1) * ROW + ROW - H, "맨 아래에서 위치가 잘못됐다");
});

test("**위로 넘기면** 선택이 보이도록 올린다", () => {
  const next = scrollTopToShow({ scrollTop: 500, clientHeight: H, itemTop: 300, itemHeight: ROW });
  assert.equal(next, 300, "위로 넘겼는데 목록이 따라오지 않았다");
});

test("**맨 아래** 에서도 더 내려가지 않는다 — 음수가 되지 않는다", () => {
  const lastTop = 100 * ROW; // 항목 100개
  const next = scrollTopToShow({ scrollTop: 0, clientHeight: H, itemTop: lastTop, itemHeight: ROW });
  assert.equal(next, lastTop + ROW - H, "마지막 항목의 위치가 잘못됐다");
  assert.ok(next >= 0, "scrollTop 이 음수가 됐다");
});

test("**보이는 중이면** 그대로 둔다 — 무관한 스크롤은 부작용이다", () => {
  // scrollTop 100 → 보이는 범위 100..340. itemTop 200 은 그 안이다.
  assert.equal(scrollTopToShow({ scrollTop: 100, clientHeight: H, itemTop: 200, itemHeight: ROW }), 100);
  // 아랫변만 딱 걸치는 것은 움직이지 않는다 (경계는 "보인다" 다).
  assert.equal(scrollTopToShow({ scrollTop: 100, clientHeight: H, itemTop: 340 - ROW, itemHeight: ROW }), 100);
});

test("**숫자가 아니면** 조용히 아무것도 안 하는데, 그것이 '이미 보인다' 와 구분된다", () => {
  // NaN 이면 아래 비교가 전부 false 가 되어 원래 값이 돌아온다.
  // scrollTop 이 NaN 인 경우에도 NaN 이 그대로 나가지 않고 0 이 되어야
  // "DOM 이 아직 준비되지 않았다" 는 사실이 **0 위치**로 표현된다.
  const out = scrollTopToShow({ scrollTop: Number.NaN, clientHeight: H, itemTop: Number.NaN, itemHeight: Number.NaN });
  assert.ok(Number.isFinite(out), `NaN 이 그대로 통과했다: ${out}`);
  assert.equal(out, 0);
});

test("**높이가 0** 이면 아래 경계가 항목 윗변과 다를 수 있다 — 그래도 음수는 안 된다", () => {
  // clientHeight 가 0 이면 "아랫변을 컨테이너 아랫변에 맞춘다" 는
  // scrollTop = itemBottom 가 된다(500+24). 기하학적으로 일관된 값이다.
  const next = scrollTopToShow({ scrollTop: 100, clientHeight: 0, itemTop: 500, itemHeight: ROW });
  assert.equal(next, 524, "아랫변 정렬 값이 이상하다");
  assert.ok(next >= 0, "scrollTop 이 음수가 됐다");
});