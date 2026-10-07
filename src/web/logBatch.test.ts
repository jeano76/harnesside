import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LogEntry } from "../server/logRing.js";
import { createBatcher, mergeLogs } from "./logBatch.js";

const e = (seq: number) => ({ seq }) as LogEntry;

test("mergeLogs — 이미 본 seq 는 버리고, 상한을 넘으면 앞을 자른다", () => {
  assert.deepEqual(mergeLogs([e(1), e(2)], [e(2), e(3), e(3), e(4)]).map((x) => x.seq), [1, 2, 3, 4]);
  const prev = [e(1)];
  assert.equal(mergeLogs(prev, [e(1)]), prev, "새 것이 없으면 같은 배열(렌더 생략)");
  assert.deepEqual(mergeLogs([e(1), e(2)], [e(3), e(4)], 3).map((x) => x.seq), [2, 3, 4]);
});

test("createBatcher — 한 프레임 안의 항목은 flush 한 번으로 묶인다", () => {
  const flushed: number[][] = [];
  const frames: Array<() => void> = [];
  const b = createBatcher<number>((xs) => flushed.push(xs), (cb) => void frames.push(cb));
  for (let i = 0; i < 500; i++) b.push(i);
  assert.equal(frames.length, 1, "스케줄은 한 번만");
  frames.shift()!();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].length, 500);
  b.push(500);
  assert.equal(frames.length, 1, "flush 뒤에는 다시 스케줄");
  frames.shift()!();
  assert.deepEqual(flushed[1], [500]);
});
