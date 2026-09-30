import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCheckpoint, readCheckpoint, clearCheckpoint, Checkpoint } from "./checkpoint.js";

function sample(): Checkpoint {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    reason: "manual",
    goal: "test goal",
    steps: [{ description: "step 1", status: "todo" }],
    files: [{ path: "a.ts", status: "read" }],
    pendingToolCall: null,
    mustPreserve: ["keep this"],
  };
}

test("readCheckpoint returns null when nothing was ever written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-test-"));
  try {
    assert.equal(await readCheckpoint(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeCheckpoint then readCheckpoint round-trips the exact data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-test-"));
  try {
    const checkpoint = sample();
    await writeCheckpoint(dir, checkpoint);
    const read = await readCheckpoint(dir);
    // **쓴 값이 하나도 바뀌지 않아야 한다**(라운드트립의 의미).
    //
    // 단, `readCheckpoint` 는 배열 필드를 **정규화** 한다(없는 필드는 빈 배열/문자열로).
    // 키 집합까지 같아지기를 요구하면 그 보장을 못 하게 된다 — 손으로 만든 파일 하나가
    // 턴을 TypeError 로 죽인 실제 사고(배열 필드 없음)의 유일한 방지가 이 정규화다.
    // 그래서 "값 보존"을 필드별로 확인하고, 추가된 기본값도 **의도된 것** 임을 고정한다.
    assert.ok(read, "체크포인트가 사라졌다");
    assert.deepEqual(
      { ...read, recentActions: undefined, summary: undefined },
      { ...checkpoint, recentActions: undefined, summary: undefined },
      "쓴 값이 바뀌었다",
    );
    // 정규화로 채워진 기본값 — **빈 배열과 빈 문자열** 이지 undefined 가 아니다.
    assert.deepEqual(read!.recentActions, []);
    assert.equal(read!.summary, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("**반만 써진 체크포인트** 는 턴을 죽이지 않는다 — 정규화가 존재하는 이유", async () => {
  // 실측: 배열 필드가 없는 파일(손으로 만들었거나 정전으로 잘림)이면 소비자의
  // `checkpoint.files.length` 가 TypeError 를 던졌고, 그 원문이 **사용자 화면에**
  // 그대로 노출됐다. "재개 없음" 으로 읽히는 게 아니라 내부 오류가 떠야 하는 순간이다.
  const dir = await mkdtemp(join(tmpdir(), "harnesside-test-"));
  try {
    await mkdir(join(dir, ".harnesside", "state"), { recursive: true });
    await writeFile(
      join(dir, ".harnesside", "state", "checkpoint.json"),
      JSON.stringify({ version: 1, timestamp: "2026-01-01T00:00:00.000Z", reason: "manual", goal: "반쪽짜리" }),
      "utf8",
    );
    const read = await readCheckpoint(dir);
    assert.ok(read, "부분 파일을 무시해 버렸다 — 사용자는 재개할 수 있다");
    // **배열 필드는 항상 배열** — 소비자가 `.length` 를 믿어도 된다.
    assert.deepEqual(read!.files, []);
    assert.deepEqual(read!.steps, []);
    assert.deepEqual(read!.recentActions, []);
    assert.equal(read!.goal, "반쪽짜리");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("**알 수 없는 형식** 은 null — 반쪽짜리로 턴을 시작하지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-test-"));
  try {
    await mkdir(join(dir, ".harnesside", "state"), { recursive: true });
    const p = join(dir, ".harnesside", "state", "checkpoint.json");
    // 다른 version 은 **모르는 것** 이다. 추측해서 재개하지 않는다.
    await writeFile(p, JSON.stringify({ version: 2, goal: "미래 형식" }), "utf8");
    assert.equal(await readCheckpoint(dir), null, "다른 형식을 리드하지 않았다");
    // JSON 이 아예 아니어도 예외를 턴에 흘리지 않는다(같은 결과).
    await writeFile(p, "{ 이건 json 아님", "utf8");
    assert.equal(await readCheckpoint(dir), null, "깨진 JSON 이 예외를 던졌다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeCheckpoint creates .harnesside/state/ if it doesn't exist yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-test-"));
  try {
    // no .harnesside directory exists at all in this fresh temp dir
    await writeCheckpoint(dir, sample());
    const read = await readCheckpoint(dir);
    assert.ok(read);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearCheckpoint deletes the file so readCheckpoint returns null afterward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-test-"));
  try {
    await writeCheckpoint(dir, sample());
    assert.ok(await readCheckpoint(dir));
    await clearCheckpoint(dir);
    assert.equal(await readCheckpoint(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearCheckpoint on a project with no checkpoint yet is a no-op, not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-test-"));
  try {
    await assert.doesNotReject(() => clearCheckpoint(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
