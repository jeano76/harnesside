import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideStartRoot, inspectStart, readLastWorkspace, rememberWorkspace, lastWorkspaceFile } from "./lastWorkspace.js";

const base = { cwd: "/home/u", last: "/work/proj", lastIsDir: true };

test("어디서 시작하든 마지막 작업 폴더로 간다 — 프로젝트인 폴더에서 띄워도 마찬가지", () => {
  const r = decideStartRoot(base);
  assert.equal(r.moved, true);
  assert.equal(r.root, "/work/proj");
  assert.match(r.reason, /--here/, "벗어나는 방법을 말한다");
  const fromProject = decideStartRoot({ ...base, cwd: "/work/other" });
  assert.equal(fromProject.moved, true);
  assert.equal(fromProject.root, "/work/proj");
});

test("--here 는 항상 현재 폴더에서 시작한다", () => {
  const r = decideStartRoot({ ...base, here: true });
  assert.equal(r.moved, false);
  assert.equal(r.root, "/home/u");
});

test("기록이 없거나 이미 그 폴더거나 사라졌으면 현재 폴더에서 시작한다", () => {
  assert.equal(decideStartRoot({ ...base, last: null }).moved, false);
  assert.equal(decideStartRoot({ ...base, cwd: "/work/proj" }).moved, false);
  const gone = decideStartRoot({ ...base, lastIsDir: false });
  assert.equal(gone.moved, false);
  assert.match(gone.reason, /더 이상 없어/);
});

test("기록은 파일에 남고 다시 읽힌다 — 깨졌거나 없으면 null", async () => {
  const home = await mkdtemp(join(tmpdir(), "harnesside-lastws-"));
  try {
    assert.equal(await readLastWorkspace(home), null, "없으면 null");
    assert.equal(await rememberWorkspace(home, "/work/proj", 123), true);
    assert.deepEqual(await readLastWorkspace(home), { path: "/work/proj", at: 123 });
    await writeFile(lastWorkspaceFile(home), "{ 깨진 json", "utf8");
    assert.equal(await readLastWorkspace(home), null, "깨졌으면 null — 시작을 막지 않는다");
    assert.ok(!(await readFile(lastWorkspaceFile(home), "utf8").catch(() => "")).includes(".tmp"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("inspectStart: 사라졌거나 기록이 없는 마지막 폴더는 디렉터리가 아니다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-inspect-"));
  try {
    const proj = join(dir, "proj");
    await mkdir(proj, { recursive: true });
    assert.equal((await inspectStart(proj)).lastIsDir, true);
    assert.equal((await inspectStart(join(dir, "nope"))).lastIsDir, false);
    assert.equal((await inspectStart(null)).lastIsDir, false);
    const f = join(dir, "file.txt");
    await writeFile(f, "x");
    assert.equal((await inspectStart(f)).lastIsDir, false, "파일은 디렉터리가 아니다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
