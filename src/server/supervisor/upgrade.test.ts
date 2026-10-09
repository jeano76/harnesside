/**
 * 업데이트 위임 검사 — 되돌리기는 **범위 안**에서만, 증거(마커)는 남긴다.
 *
 * 실제 `installTree` 를 쓰되 샌드박스(stateDir·slotsDir·installRoot 전부 tmp)에서
 * 돈다. git 체크아웃 거부는 진짜 `.git` 디렉터리로 확인한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPGRADE_EXIT_CODE,
  readPendingMarker,
  checkUpdateConfirmed,
  rollbackUpdate,
} from "./upgrade.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-upgrade-"));
  const stateDir = join(dir, "state");
  const slotsDir = join(dir, "slots");
  const root = join(dir, "root");
  await mkdir(stateDir, { recursive: true });
  await mkdir(slotsDir, { recursive: true });
  await mkdir(root, { recursive: true });
  return { dir, stateDir, slotsDir, root, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const marker = (slot: string | null) =>
  JSON.stringify({ swappedAt: 1, tree: "/x", slot, treeSha256: "abc", target: { version: "9.9.9" } });

test("종료 코드 42 는 크래시(1)·정상(0)과 다르다", () => {
  assert.notEqual(UPGRADE_EXIT_CODE, 0);
  assert.notEqual(UPGRADE_EXIT_CODE, 1);
});

test("마커 없으면 확인으로 본다 — 자식이 소비한 뒤다", async () => {
  const s = await sandbox();
  try {
    const r = await checkUpdateConfirmed(s.stateDir);
    assert.equal(r.confirmed, true);
  } finally {
    await s.cleanup();
  }
});

test("마커 남으면 미확인 — 대상을 말해준다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.stateDir, "update-pending.json"), marker(join(s.slotsDir, "v-9/slot/tree")));
    const r = await checkUpdateConfirmed(s.stateDir);
    assert.equal(r.confirmed, false);
    assert.match(r.reason, /9\.9\.9/);
  } finally {
    await s.cleanup();
  }
});

test("슬롯에서 되돌리고 마커는 옆으로 옮긴다", async () => {
  const s = await sandbox();
  try {
    const slotTree = join(s.slotsDir, "v-9", "slot", "tree");
    await mkdir(slotTree, { recursive: true });
    await writeFile(join(slotTree, "app.txt"), "old-version");
    await writeFile(join(s.root, "app.txt"), "new-broken");
    await writeFile(join(s.stateDir, "update-pending.json"), marker(slotTree));
    const r = await rollbackUpdate(s.stateDir, s.slotsDir, s.root);
    assert.equal(r.ok, true, r.detail);
    assert.equal(await readFile(join(s.root, "app.txt"), "utf8"), "old-version");
    // 마커는 지우지 않고 옮긴다 — 무엇이 있었는지가 증거다.
    await assert.rejects(stat(join(s.stateDir, "update-pending.json")));
    assert.match(r.detail, /old-version|되돌렸습니다/);
  } finally {
    await s.cleanup();
  }
});

test("마커에 슬롯이 없으면 손대지 않는다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.stateDir, "update-pending.json"), marker(null));
    await writeFile(join(s.root, "app.txt"), "untouched");
    const r = await rollbackUpdate(s.stateDir, s.slotsDir, s.root);
    assert.equal(r.ok, false);
    assert.equal(await readFile(join(s.root, "app.txt"), "utf8"), "untouched");
  } finally {
    await s.cleanup();
  }
});

test("슬롯 범위 밖은 거부한다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.stateDir, "update-pending.json"), marker("/etc/passwd"));
    const r = await rollbackUpdate(s.stateDir, s.slotsDir, s.root);
    assert.equal(r.ok, false);
    assert.match(r.detail, /범위 밖/);
  } finally {
    await s.cleanup();
  }
});

test("git 체크아웃에는 손대지 않는다", async () => {
  const s = await sandbox();
  try {
    const slotTree = join(s.slotsDir, "v-9", "slot", "tree");
    await mkdir(slotTree, { recursive: true });
    await writeFile(join(slotTree, "app.txt"), "old");
    await mkdir(join(s.root, ".git"), { recursive: true });
    await writeFile(join(s.stateDir, "update-pending.json"), marker(slotTree));
    const r = await rollbackUpdate(s.stateDir, s.slotsDir, s.root);
    assert.equal(r.ok, false);
    assert.match(r.detail, /체크아웃/);
    // 실패하면 마커도 남긴다 — 다음 판단의 재료다.
    assert.deepEqual(await readPendingMarker(s.stateDir), JSON.parse(marker(slotTree)));
  } finally {
    await s.cleanup();
  }
});
