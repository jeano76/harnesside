/**
 * 파일 변경 감지 테스트 (§5.2 "파일 변경" 행).
 *
 * chokidar 는 **진짜 파일시스템**이라 fake timer 로 못 속인다. 그래서 임시 디렉터리
 * 에 실제로 쓰고 실제로 기다린다. 느리지만 이 테스트가 틀리면 사용자가 자기 저장을
 * "외부 변경" 으로 오해하거나, 저장을 할 때마다 충돌 창을 본다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceWatcher, type ChangeEvent } from "./fsWatcher.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-fsw-"));
  await mkdir(join(dir, "src"), { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 감시자가 준비될 시간을 준다(첫 이벤트를 놓치면 조용히 통과해 버린다). */
const SETTLE = 700;

test("파일을 쓰면 변경이 보고된다", async () => {
  const s = await sandbox();
  const seen: ChangeEvent[] = [];
  const w = new WorkspaceWatcher({ root: s.dir, onChange: (e) => seen.push(e), debounceMs: 60 });
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  try {
    await writeFile(join(s.dir, "src", "a.ts"), "const x = 1\n");
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(seen.length > 0, "변경이 전혀 보고되지 않았다");
    assert.equal(seen.some((e) => e.path === "src/a.ts"), true, `경로가 다르게 보고됐다: ${JSON.stringify(seen.map((e) => e.path))}`);
    assert.equal(seen.every((e) => e.self === false), true, "외부 쓰기를 자기 쓰기로 표시했다");
  } finally {
    await w.stop();
    await s.cleanup();
  }
});

test("여러 번 써도 **한 번만** 보고된다 — tmp→rename 은 이벤트 2개를 만든다", async () => {
  const s = await sandbox();
  const seen: ChangeEvent[] = [];
  const w = new WorkspaceWatcher({ root: s.dir, onChange: (e) => seen.push(e), debounceMs: 150 });
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  try {
    const p = join(s.dir, "b.ts");
    await writeFile(p, "1\n");
    await new Promise((r) => setTimeout(r, 120));
    await writeFile(p, "2\n");
    await new Promise((r) => setTimeout(r, 120));
    await writeFile(`${p}.harnesside-tmp`, "2\n");
    await new Promise((r) => setTimeout(r, 900));
    const forB = seen.filter((e) => e.path === "b.ts");
    assert.equal(forB.length, 1, `한 번의 저장이 ${forB.length} 번 보고됐다: ${JSON.stringify(forB.map((e) => e.kind))}`);
    // 임시 파일은 감시 대상이 아니다 — 사용자에게 보여선 안 되는 경로다
    assert.equal(seen.some((e) => e.path.includes("harnesside-tmp")), false, "임시 파일이 보고됐다");
  } finally {
    await w.stop();
    await s.cleanup();
  }
});

test("**자기 쓰기**는 표시된다 — 사용자가 자기 저장을 충돌로 오해하지 않게", async () => {
  const s = await sandbox();
  const seen: ChangeEvent[] = [];
  const w = new WorkspaceWatcher({ root: s.dir, onChange: (e) => seen.push(e), debounceMs: 60 });
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  try {
    w.noteSelfWrite("src/c.ts");
    // 우리가 하는 저장: tmp → rename (이벤트 2개)
    await writeFile(join(s.dir, "src", "c.ts.harnesside-tmp"), "저장됨\n");
    await new Promise((r) => setTimeout(r, 200));
    const { rename } = await import("node:fs/promises");
    await rename(join(s.dir, "src", "c.ts.harnesside-tmp"), join(s.dir, "src", "c.ts"));
    await new Promise((r) => setTimeout(r, 900));
    const forC = seen.filter((e) => e.path === "src/c.ts");
    assert.ok(forC.length > 0, "자기 쓰기가 보고되지 않았다");
    assert.equal(forC.every((e) => e.self), true, `자기 쓰기를 외부 변경으로 표시했다: ${JSON.stringify(forC)}`);
  } finally {
    await w.stop();
    await s.cleanup();
  }
});

test("경로 표기는 항상 **슬래시** — Windows 형식은 웹에서 경로를 깨뜨린다", async () => {
  const s = await sandbox();
  const seen: ChangeEvent[] = [];
  const w = new WorkspaceWatcher({ root: s.dir, onChange: (e) => seen.push(e), debounceMs: 60 });
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  try {
    await writeFile(join(s.dir, "src", "d.ts"), "x\n");
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(seen.every((e) => !e.path.includes("\\")), `역슬래시가 섞였다: ${JSON.stringify(seen.map((e) => e.path))}`);
    assert.equal(seen.some((e) => e.path === "src/d.ts"), true);
  } finally {
    await w.stop();
    await s.cleanup();
  }
});

test("루트 밖 경로는 보고하지 않는다", async () => {
  const s = await sandbox();
  const seen: ChangeEvent[] = [];
  const w = new WorkspaceWatcher({ root: join(s.dir, "src"), onChange: (e) => seen.push(e), debounceMs: 60 });
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  try {
    await writeFile(join(s.dir, "outside.txt"), "x\n");
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(seen.some((e) => e.path.includes("outside.txt")), false, "워크스페이스 밖 파일이 보고됐다");
  } finally {
    await w.stop();
    await s.cleanup();
  }
});

test("node_modules 는 감시하지 않는다 — 순회만느라 이벤트 루프를 잡는다", async () => {
  const s = await sandbox();
  await mkdir(join(s.dir, "node_modules", "x"), { recursive: true });
  const seen: ChangeEvent[] = [];
  const w = new WorkspaceWatcher({ root: s.dir, onChange: (e) => seen.push(e), debounceMs: 60 });
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  try {
    await writeFile(join(s.dir, "node_modules", "x", "i.js"), "1\n");
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(seen.length, 0, `node_modules 가 보고됐다: ${JSON.stringify(seen.map((e) => e.path))}`);
  } finally {
    await w.stop();
    await s.cleanup();
  }
});

test("stop() 은 타이머를 모두 없앤다 — 프로세스가 안 끝나면 안 된다", async () => {
  const s = await sandbox();
  let calls = 0;
  const w = new WorkspaceWatcher({ root: s.dir, onChange: () => calls++, debounceMs: 200 });
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  await writeFile(join(s.dir, "e.ts"), "x\n");
  await w.stop();
  assert.equal(w.watching, false);
  const before = calls;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(calls, before, "stop() 후에도 이벤트가 도착했다");
  await s.cleanup();
});

test("start() 를 두 번 불러도 감시기는 하나다", async () => {
  const s = await sandbox();
  const seen: ChangeEvent[] = [];
  const w = new WorkspaceWatcher({ root: s.dir, onChange: (e) => seen.push(e), debounceMs: 60 });
  w.start();
  w.start();
  await new Promise((r) => setTimeout(r, SETTLE));
  try {
    await writeFile(join(s.dir, "f.ts"), "x\n");
    await new Promise((r) => setTimeout(r, 900));
    const n = seen.filter((e) => e.path === "f.ts").length;
    assert.equal(n, 1, `중복 감시로 ${n} 번 보고됐다`);
  } finally {
    await w.stop();
    await s.cleanup();
  }
});
