import { test } from "node:test";
import assert from "node:assert/strict";
import { isBrokenPipe, installPipeGuard, safeWrite } from "./safeOutput.js";
import { EventEmitter } from "node:events";

test("EPIPE 류는 '끊긴 파이프' 로 본다", () => {
  assert.equal(isBrokenPipe(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
  assert.equal(isBrokenPipe(Object.assign(new Error("x"), { code: "ERR_STREAM_DESTROYED" })), true);
  assert.equal(isBrokenPipe(new Error("진짜 버그")), false);
  assert.equal(isBrokenPipe(null), false);
});

test("스트림 error 를 삼키면 uncaughtException 이 되지 않는다", () => {
  const s = Object.assign(new EventEmitter(), { write: () => true });
  assert.throws(() => s.emit("error", new Error("EPIPE")), "처리기가 없으면 던진다(= 서버에서는 uncaughtException)");
  installPipeGuard([s as never]);
  assert.doesNotThrow(() => s.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
});

test("safeWrite — 닫힌 스트림·던지는 스트림에도 죽지 않고 false", () => {
  const w: string[] = [];
  assert.equal(safeWrite({ write: (t) => w.push(t), on: () => {} }, "a"), true);
  assert.equal(safeWrite({ write: () => { throw new Error("x"); }, on: () => {} }, "a"), false);
  assert.equal(safeWrite({ write: () => true, on: () => {}, destroyed: true }, "a"), false);
  assert.equal(safeWrite({ write: () => true, on: () => {}, writable: false }, "a"), false);
  assert.deepEqual(w, ["a"]);
});
