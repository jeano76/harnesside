/**
 * 승인 카드 카운트다운 로직 (§S-6: 60초 뒤 자동 거절이 화면에 보여야 한다).
 *
 * DOM 없이 순수 함수만 검증한다 — 카드는 1초 간격으로 now를 갱신하고
 * left<=0이면 "기한이 지났습니다"를 그린다. 서버는 timeoutSec 60으로
 * settle(id, "timeout") 한다(`src/server/approval.ts:50,118`).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { secondsLeft } from "./ApprovalCard.js";

const req = (expiresAt: number) => ({ id: "a", expiresAt }) as Parameters<typeof secondsLeft>[0];

test("60초 요청은 60초 남는다 — 0으로 채우지 않는다", () => {
  assert.equal(secondsLeft(req(60_000), 0), 60);
});

test("기한이 지나면 0 — 음수로 내려가지 않는다", () => {
  assert.equal(secondsLeft(req(60_000), 60_000), 0);
  assert.equal(secondsLeft(req(60_000), 90_000), 0);
});

test("올림이다 — 0.5초 지났다고 59초로 깎지 않는다", () => {
  // ceil: 59.5초 남으면 60초로 보인다 — 남은 시간을 깎아 사용자가 늦었다고 느끼지 않게.
  assert.equal(secondsLeft(req(60_000), 500), 60);
  assert.equal(secondsLeft(req(60_000), 59_000), 1);
});
