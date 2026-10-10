import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideStartRoot, inspectStart, readLastWorkspace, rememberWorkspace, lastWorkspaceFile } from "./lastWorkspace.js";

const base = { cwd: "/home/u", last: "/work/proj", lastIsDir: true, cwdIsProject: false };

test("프로젝트로 쓴 적 없는 폴더(홈 등)에서 시작하면 마지막 작업 폴더로 간다", () => {
  const r = decideStartRoot(base);
  assert.equal(r.moved, true);
  assert.equal(r.root, "/work/proj");
  assert.match(r.reason, /--here/, "벗어나는 방법을 말한다");
});

test("이미 프로젝트인 폴더에서 띄웠으면 옮기지 않는다 — 새 프로젝트를 이전 프로젝트로 납치하지 않는다", () => {
  const r = decideStartRoot({ ...base, cwd: "/work/other", cwdIsProject: true });
  assert.equal(r.moved, false);
  assert.equal(r.root, "/work/other");
  assert.match(r.reason, /--last/);
});

test("--here 는 항상 현재 폴더, --last 는 프로젝트 폴더에서도 마지막 폴더", () => {
  assert.equal(decideStartRoot({ ...base, here: true }).moved, false);
  const f = decideStartRoot({ ...base, cwd: "/work/other", cwdIsProject: true, forceLast: true });
  assert.equal(f.moved, true);
  assert.equal(f.root, "/work/proj");
  assert.equal(decideStartRoot({ ...base, here: true, forceLast: true }).moved, false, "--here 가 우선");
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

test("inspectStart: 표지 파일이 있는 폴더는 프로젝트, 빈 폴더는 아니다. 사라진 마지막 폴더는 디렉터리가 아니다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-inspect-"));
  try {
    const empty = join(dir, "empty");
    const proj = join(dir, "proj");
    await mkdir(empty, { recursive: true });
    await mkdir(join(proj, ".git"), { recursive: true });
    assert.equal((await inspectStart(empty, proj)).cwdIsProject, false);
    assert.equal((await inspectStart(proj, empty)).cwdIsProject, true);
    assert.equal((await inspectStart(empty, proj)).lastIsDir, true);
    assert.equal((await inspectStart(empty, join(dir, "nope"))).lastIsDir, false);
    assert.equal((await inspectStart(empty, null)).lastIsDir, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
