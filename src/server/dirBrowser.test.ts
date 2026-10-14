import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { listDirs, MAX_DIR_ENTRIES } from "./dirBrowser.js";

async function fixture<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-dirs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("하위 폴더만, 이름순으로, 파일은 빼고 돌려준다. 숨김 폴더는 개수만 알려준다", () =>
  fixture(async (dir) => {
    await mkdir(join(dir, "b"));
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, ".hidden"));
    await writeFile(join(dir, "file.txt"), "x");
    const r = await listDirs(dir, { fallback: "/", home: "/h" });
    assert.ok(r.ok);
    assert.deepEqual(r.value.entries.map((e) => e.name), ["a", "b"]);
    assert.equal(r.value.hiddenCount, 1);
    assert.equal(r.value.parent, dirname(dir));
    assert.equal(r.value.entries[0].path, join(dir, "a"));
    const withHidden = await listDirs(dir, { fallback: "/", home: "/h", showHidden: true });
    assert.ok(withHidden.ok);
    assert.deepEqual(withHidden.value.entries.map((e) => e.name), [".hidden", "a", "b"]);
  }));

test("폴더로 가는 심볼릭 링크는 폴더로 본다", () =>
  fixture(async (dir) => {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    const r = await listDirs(dir, { fallback: "/", home: "/h" });
    assert.ok(r.ok);
    assert.deepEqual(r.value.entries.map((e) => e.name), ["link", "real"]);
  }));

test("빈 입력은 fallback, ~ 는 홈, 상대 경로·없는 경로·파일은 거부한다. 최상위의 parent 는 null", () =>
  fixture(async (dir) => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "f"), "x");
    const fb = await listDirs("", { fallback: dir, home: "/nonexistent-home" });
    assert.ok(fb.ok && fb.value.path === dir);
    const home = await listDirs("~/sub", { fallback: "/", home: dir });
    assert.ok(home.ok && home.value.path === join(dir, "sub"));
    const rel = await listDirs("relative/x", { fallback: "/", home: "/h" });
    assert.ok(!rel.ok && rel.reason === "invalid");
    const gone = await listDirs(join(dir, "nope"), { fallback: "/", home: "/h" });
    assert.ok(!gone.ok && gone.reason === "not-found");
    const file = await listDirs(join(dir, "f"), { fallback: "/", home: "/h" });
    assert.ok(!file.ok && file.reason === "not-found");
    const root = await listDirs("/", { fallback: "/", home: "/h" });
    assert.ok(root.ok && root.value.parent === null);
  }));

test("너무 많으면 잘라내고 알린다", () =>
  fixture(async (dir) => {
    await Promise.all(Array.from({ length: MAX_DIR_ENTRIES + 5 }, (_, i) => mkdir(join(dir, `d${String(i).padStart(4, "0")}`))));
    const r = await listDirs(dir, { fallback: "/", home: "/h" });
    assert.ok(r.ok);
    assert.equal(r.value.entries.length, MAX_DIR_ENTRIES);
    assert.equal(r.value.truncated, true);
  }));
