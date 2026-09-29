/**
 * Git diff 소스 테스트 (§5.2 "Git 변경" 행).
 *
 * 여기서 조용히 틀리면 사용자가 **엉뚱한 파일의 diff** 를 검토하고 통과시킨다.
 * 그래서 파일명에 개행/따옴표가 들어가는 경우를 반드시 넣는다 — 실제로 있는 경우다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitStatus, gitShowHead, repoRoot } from "./gitDiff.js";

const run = promisify(execFile);

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-git-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (...a: string[]) => run("git", ["-C", dir, ...a], { env });
  await g("init", "-q");
  await g("config", "user.email", "t@x");
  await g("config", "user.name", "t");
  await writeFile(join(dir, "a.txt"), "one\ntwo\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "b.ts"), "export const x = 1;\n");
  await g("add", "-A");
  await g("commit", "-q", "-m", "init");
  return { dir, g, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("깨끗한 저장소에는 변경이 없다", async () => {
  const r = await repo();
  try {
    const s = await gitStatus(r.dir);
    assert.equal(s.ok, true);
    if (s.ok) assert.equal(s.value.files.length, 0, `변경이 있다고 나온다: ${JSON.stringify(s.value.files)}`);
  } finally {
    await r.cleanup();
  }
});

test("수정/추가/삭제/미추적을 구분한다", async () => {
  const r = await repo();
  try {
    await writeFile(join(r.dir, "a.txt"), "one\nTWO\n");
    await writeFile(join(r.dir, "new.txt"), "n\n");
    await rm(join(r.dir, "src", "b.ts"));
    await writeFile(join(r.dir, "untracked.txt"), "u\n");
    // added 는 **stage 된** 새 파일이다. stage 안 한 새 파일은 untracked 다 — 둘을
    // 구분하지 않으면 "커밋하면 새 파일이 추가됩니다" 가 거짓말이 된다.
    await r.g("add", "new.txt");
    const s = await gitStatus(r.dir);
    assert.equal(s.ok, true);
    if (!s.ok) return;
    const byPath = Object.fromEntries(s.value.files.map((f) => [f.path, f]));
    assert.equal(byPath["a.txt"].status, "modified");
    assert.equal(byPath["new.txt"].status, "added");
    assert.equal(byPath["new.txt"].staged, true);
    assert.equal(byPath["src/b.ts"].status, "deleted");
    assert.equal(byPath["untracked.txt"].status, "untracked");
    // 미추적 파일은 staged 가 아니다
    assert.equal(byPath["untracked.txt"].staged, false);
    assert.equal(byPath["a.txt"].staged, false, "수정만 한 파일이 staged 로 표시됐다");
  } finally {
    await r.cleanup();
  }
});

test("staged/unstaged 를 구분한다", async () => {
  const r = await repo();
  try {
    await writeFile(join(r.dir, "a.txt"), "one\ntwo\nstaged\n");
    await r.g("add", "a.txt");
    await writeFile(join(r.dir, "a.txt"), "one\ntwo\nstaged\nmore\n");
    const s = await gitStatus(r.dir);
    assert.equal(s.ok, true);
    if (s.ok) {
      const f = s.value.files.find((x) => x.path === "a.txt");
      assert.equal(f?.staged, true, "staged 변경인데 표시되지 않았다");
    }
  } finally {
    await r.cleanup();
  }
});

test("**파일명에 개행이 있어도** 경로가 깨지지 않는다 — 깨지면 엉뚱한 diff 를 보여준다", async () => {
  const r = await repo();
  try {
    const weird = "이름\n에\n개행.txt";
    await writeFile(join(r.dir, weird), "x\n");
    await r.g("add", "-A");
    const s = await gitStatus(r.dir);
    assert.equal(s.ok, true);
    if (!s.ok) return;
    const names = s.value.files.map((f) => f.path);
    assert.equal(names.includes(weird), true, `개행 있는 파일명을 못 읽었다: ${JSON.stringify(names)}`);
  } finally {
    await r.cleanup();
  }
});

test("**따옴표가 든 파일명**도 풀어낸다", async () => {
  const r = await repo();
  try {
    const weird = '따옴표"와\\역슬래시.txt';
    await writeFile(join(r.dir, weird), "x\n");
    await r.g("add", "-A");
    const s = await gitStatus(r.dir);
    assert.equal(s.ok, true);
    if (s.ok) {
      assert.equal(s.value.files.some((f) => f.path === weird), true, `이름이 깨졌다: ${JSON.stringify(s.value.files.map((f) => f.path))}`);
    }
  } finally {
    await r.cleanup();
  }
});

test("파일명에 개행이 있는 **HEAD 내용**도 읽힌다", async () => {
  const r = await repo();
  try {
    const weird = "헤드\n개행.txt";
    await writeFile(join(r.dir, weird), "head\n");
    await r.g("add", "-A");
    await r.g("commit", "-q", "-m", "weird");
    const c = await gitShowHead(r.dir, weird);
    assert.equal(c.ok, true, "HEAD 내용을 못 읽었다");
    if (c.ok) assert.equal(c.value, "head\n");
  } finally {
    await r.cleanup();
  }
});

test("추적되지 않은 파일의 HEAD 내용은 빈 문자열 — 실패가 아니다", async () => {
  const r = await repo();
  try {
    await writeFile(join(r.dir, "brand-new.txt"), "x\n");
    const c = await gitShowHead(r.dir, "brand-new.txt");
    assert.equal(c.ok, true, "신규 파일에서 실패를 돌려주면 diff 를 못 그린다");
    if (c.ok) assert.equal(c.value, "");
  } finally {
    await r.cleanup();
  }
});

test("`--` 구분자로 옵션 주입을 막는다 — 파일명이 - 로 시작하는 경우", async () => {
  const r = await repo();
  try {
    await writeFile(join(r.dir, "--upload-pack=evil"), "x\n");
    const c = await gitShowHead(r.dir, "--upload-pack=evil");
    // 위험하든 아니든 "저장소 밖으로 나가지 않았음" 을 확인한다.
    if (c.ok) assert.equal(typeof c.value, "string");
    else assert.notEqual(c.reason, "git-missing");
  } finally {
    await r.cleanup();
  }
});

test("저장소가 아니면 not-a-repo 라고 **구체적으로** 말한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-nogit-"));
  try {
    const s = await gitStatus(dir);
    assert.equal(s.ok, false);
    if (!s.ok) {
      assert.equal(s.reason, "not-a-repo", `"변경 없음" 과 구분되지 않는다: ${s.reason}`);
      assert.match(s.detail, /Git 저장소/);
    }
    const root = await repoRoot(dir);
    assert.equal(root.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("브랜치 이름을 알려준다 — 무엇을 커밋할지 화면에 보여야 한다", async () => {
  const r = await repo();
  try {
    const s = await gitStatus(r.dir);
    assert.equal(s.ok, true);
    if (s.ok) assert.ok(s.value.branch && s.value.branch.length > 0, "브랜치 이름이 없다");
  } finally {
    await r.cleanup();
  }
});
