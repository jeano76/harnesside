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

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeCrashLog, archiveHarmlessCrashLog, isOnlyBrokenPipe } from "../crashHandler.js";

const hdr = (kind: string, body: string) => `\n[2026-10-04T10:33:30.014Z] harnesside fatal error (${kind}):\n${body}\n`;

test("크래시 기록이 EPIPE 뿐일 때만 '무해'로 본다", () => {
  assert.equal(isOnlyBrokenPipe(hdr("uncaughtException", "Error: write EPIPE\n    at x") + hdr("uncaughtException", "Error: write EPIPE\n    at y")), true);
  assert.equal(isOnlyBrokenPipe(hdr("uncaughtException", "Error: write EPIPE\n    at x") + hdr("uncaughtException", "TypeError: 진짜 버그")), false);
  assert.equal(isOnlyBrokenPipe("아무 기록도 아님"), false);
});

test("확인 처리 — 지우지 않고 보관 폴더로 옮기며, 다음엔 기록이 없다", () => {
  const root = mkdtempSync(join(tmpdir(), "hs-crash-"));
  mkdirSync(join(root, ".harnesside"), { recursive: true });
  writeFileSync(join(root, ".harnesside", "crash.log"), hdr("uncaughtException", "TypeError: 진짜 버그"));
  assert.equal(archiveHarmlessCrashLog(root), false, "진짜 크래시는 자동으로 숨기지 않는다");
  assert.equal(existsSync(join(root, ".harnesside", "crash.log")), true);
  const r = acknowledgeCrashLog(root);
  assert.equal(r.moved, true);
  assert.equal(existsSync(join(root, ".harnesside", "crash.log")), false);
  assert.equal(readdirSync(join(root, ".harnesside", "crash-archive")).length, 1);
  assert.equal(acknowledgeCrashLog(root).moved, false, "두 번째는 옮길 것이 없다");
});

test("EPIPE 뿐인 기록(정리 안내 줄 포함)은 시작할 때 자동으로 옮긴다", () => {
  const root = mkdtempSync(join(tmpdir(), "hs-crash-"));
  mkdirSync(join(root, ".harnesside"), { recursive: true });
  writeFileSync(join(root, ".harnesside", "crash.log"), hdr("uncaughtException", "Error: write EPIPE\n    at x") + "\n(이후 같은 EPIPE 항목 413,429건 — 크기 263MB — 은 원인 수정 후 정리함)\n");
  assert.equal(archiveHarmlessCrashLog(root), true);
  assert.equal(existsSync(join(root, ".harnesside", "crash.log")), false);
});
