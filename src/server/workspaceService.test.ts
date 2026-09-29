/**
 * 워크스페이스 서비스 테스트 (§8.3) — **전이**가 도메인 계산만큼 정확해야 한다.
 *
 * `workspace.test.ts` 가 "무엇이 바뀌는가" 를 검사했다면, 여기는 "**바뀌었는가**" 다.
 * 특히 세 가지를 본다: 실패한 전이가 이전 상태를 **보존**하는가, 확인 없이 전환되지 않는가,
 * 경계 문장이 **소비되지 않은 채** 쌓이는가.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type WorkspaceChange } from "./workspaceService.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-wssvc-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function nodeRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), '{"name":"a"}');
  await writeFile(join(dir, "CLAUDE.md"), "규칙");
  await mkdir(join(dir, ".git"), { recursive: true });
}

test("부팅 시 지문을 **한 번** 구하고 루트로 쓴다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    await nodeRepo(a);
    const svc = new WorkspaceService({ root: a });
    await svc.init();
    assert.equal(svc.root(), a);
    assert.equal(svc.baseDir(), a, "도구 기준 디렉터리도 같은 값이어야 한다");
    assert.deepEqual(svc.current.kind, ["node"]);
  } finally {
    await s.cleanup();
  }
});

test("전환은 **확인 없이는** 되지 않는다 — 사용자가 모르는 사이에 쓰기 대상이 바뀌면 안 된다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await nodeRepo(a);
    await nodeRepo(b);
    const svc = new WorkspaceService({ root: a });
    await svc.init();
    const r = await svc.switchTo(b);
    assert.equal(r.ok, false, "확인 없이 전환됐다");
    assert.equal(r.ok === false && r.reason, "needs-confirm");
    assert.equal(svc.root(), a, "루트가 바뀌었다 — 확인을 무시했다");
  } finally {
    await s.cleanup();
  }
});

test("전환은 **셋을 한꺼번에** 바꾼다 — 루트·baseDir·규칙", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await nodeRepo(a);
    await nodeRepo(b);
    await rm(join(b, "CLAUDE.md"));
    const changes: WorkspaceChange[] = [];
    const svc = new WorkspaceService({ root: a, onChange: (e) => changes.push(e) });
    await svc.init();
    const r = await svc.switchTo(b, { confirm: true });
    assert.equal(r.ok, true);
    assert.equal(svc.root(), b, "루트");
    assert.equal(svc.baseDir(), b, "도구 기준 디렉터리 — 이것이 빠지면 조용히 옛 폴더에 쓴다");
    assert.equal(svc.rules().length, 0, "규칙은 새 루트 기준으로");
    assert.equal(changes.length, 1, "전환 사실을 알렸다");
    assert.equal(changes[0].from.root, a);
    assert.equal(changes[0].to.root, b);
  } finally {
    await s.cleanup();
  }
});

test("전환이 **실패하면 이전 상태가 그대로다** — 없는 폴더로 이동해도 잃지 않는다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    await nodeRepo(a);
    const svc = new WorkspaceService({ root: a });
    await svc.init();
    const missing = await svc.switchTo(join(s.dir, "없는폴더"), { confirm: true });
    assert.equal(missing.ok, false);
    assert.equal(svc.root(), a, "실패한 전이가 이전 상태를 망가뜨렸다");
    // 파일도 아니어야 거절된다 — "폴더" 를 말하는데 파일을 받으면 조용히 엉뚱한 곳이 된다.
    const f = join(a, "package.json");
    const notDir = await svc.switchTo(f, { confirm: true });
    assert.equal(notDir.ok, false);
    assert.equal(notDir.ok === false && notDir.reason, "not-a-directory");
    assert.equal(svc.root(), a);
  } finally {
    await s.cleanup();
  }
});

test("미리보기는 **아무것도 바꾸지 않는다** — 보러 가는 것만으로 루트가 바뀌면 안 된다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await nodeRepo(a);
    await nodeRepo(b);
    const svc = new WorkspaceService({ root: a });
    await svc.init();
    const p = await svc.preview(b, [join(a, "src", "x.ts")]);
    assert.equal(p.ok, true);
    assert.equal(svc.root(), a, "미리보기만 했는데 루트가 바뀌었다");
    if (!p.ok) return;
    assert.equal(p.value.to.root, b);
    assert.equal(p.value.orphanedTabs.length, 1, "새 루트 밖 탭을 말해야 합니다");
    assert.equal(p.value.tabs[0].ok, false, "옮길 수 없는 탭은 옮기지 않는다");
    assert.match(p.value.note, new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(p.value.carriesPriorContext, true);
  } finally {
    await s.cleanup();
  }
});

test("같은 폴더로의 전환은 **거절**한다 — 조용히 '바뀜' 으로 기록하면 안 된다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    await nodeRepo(a);
    const svc = new WorkspaceService({ root: a });
    await svc.init();
    const r = await svc.switchTo(a, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "same-root");
  } finally {
    await s.cleanup();
  }
});

test("경계 문장은 **소비되지 않은 채** 쌓인다 — 모델에게 갔다고 말할 근거가 없다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    const c = join(s.dir, "c");
    await nodeRepo(a);
    await nodeRepo(b);
    await nodeRepo(c);
    const svc = new WorkspaceService({ root: a });
    await svc.init();
    assert.deepEqual(svc.pendingNotes(), [], "전환 전부터 문장이 있다");
    await svc.switchTo(b, { confirm: true });
    await svc.switchTo(c, { confirm: true });
    assert.equal(svc.pendingNotes().length, 2, "두 번 전환했으면 경계가 두 개다");
    // 소비는 한 번에 — "어느 전환의 문장인지" 알 수 없게 되면 안 된다.
    const taken = svc.takeNotes();
    assert.equal(taken.length, 2);
    assert.deepEqual(svc.pendingNotes(), [], "소비했는데 다시 나온다");
  } finally {
    await s.cleanup();
  }
});

test("전환은 **경로 표기**가 달라도 같은 폴더로 본다 — 정규화 없이 비교하면 어긋난다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    await nodeRepo(a);
    const svc = new WorkspaceService({ root: a });
    await svc.init();
    const r = await svc.switchTo(`${a}/.`, { confirm: true });
    assert.equal(r.ok, false, "같은 폴더인데 전환됐다");
  } finally {
    await s.cleanup();
  }
});
