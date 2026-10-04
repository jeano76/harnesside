/** NoticeService 배선 검사 (M13). 뒤집으면 실패해야 한다. */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { NoticeService } from "./noticeService.js";

const CLEANUPS: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of CLEANUPS) await c();
});

async function sandbox(): Promise<{ dir: string; stateFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-notice-"));
  CLEANUPS.push(async () => rm(dir, { recursive: true, force: true }));
  return { dir, stateFile: join(dir, "state", "notices.json") };
}

async function modelDir(): Promise<{ dir: string; list: (p: string) => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-models-"));
  CLEANUPS.push(async () => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "Ornith-1.5-35B-Q5_K_M.gguf"), "x");
  const { readdir } = await import("node:fs/promises");
  return { dir, list: (p: string) => readdir(p) };
}

describe("NoticeService", () => {
  it("새 모델이면 알리고, 없으면 빈 목록이다 (조용히 성공이 아니다)", async () => {
    const { stateFile } = await sandbox();
    const { dir, list } = await modelDir();
    const svc = new NoticeService(stateFile);
    await svc.load();
    const r = await svc.refreshModels(dir, list, "/models/Ornith-1.5-35B-Q4_K_M.gguf");
    assert.equal(r.scanned, 1);
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!.title, /새 모델 발견/);
  });
  it("같은 파일을 두 번 훑어도 두 번 알리지 않는다", async () => {
    const { stateFile } = await sandbox();
    const { dir, list } = await modelDir();
    const svc = new NoticeService(stateFile);
    await svc.load();
    await svc.refreshModels(dir, list, "/models/Ornith-1.5-35B-Q4_K_M.gguf");
    const r2 = await svc.refreshModels(dir, list, "/models/Ornith-1.5-35B-Q4_K_M.gguf");
    assert.equal(r2.added, 0);
    assert.equal(r2.notices.length, 1);
  });
  it("silence 는 디스크에 남고 재시작 후에도 다시 뜨지 않는다", async () => {
    const { stateFile } = await sandbox();
    const { dir, list } = await modelDir();
    const svc = new NoticeService(stateFile);
    await svc.load();
    await svc.refreshModels(dir, list, "/models/Ornith-1.5-35B-Q4_K_M.gguf");
    const id = svc.list()[0]!.id;
    assert.equal(await svc.silence(id), true);
    assert.equal(svc.list().length, 0);

    const svc2 = new NoticeService(stateFile); // 서버 재시작
    await svc2.load();
    const r = await svc2.refreshModels(dir, list, "/models/Ornith-1.5-35B-Q4_K_M.gguf");
    assert.equal(r.notices.length, 0, "무시한 항목이 재시작 후 다시 떴다");
  });
  it("dismiss 는 이번 세션만 숨기고 재시작하면 다시 보인다", async () => {
    const { stateFile } = await sandbox();
    const { dir, list } = await modelDir();
    const svc = new NoticeService(stateFile);
    await svc.load();
    await svc.refreshModels(dir, list, "/models/Ornith-1.5-35B-Q4_K_M.gguf");
    const id = svc.list()[0]!.id;
    assert.equal(svc.dismiss(id), true);
    assert.equal(svc.list().length, 0);

    const svc2 = new NoticeService(stateFile);
    await svc2.load();
    const r = await svc2.refreshModels(dir, list, "/models/Ornith-1.5-35B-Q4_K_M.gguf");
    assert.equal(r.notices.length, 1, "읽음 처리한 항목이 재시작 후에도 안 보인다 — dismiss 가 영구가 됐다");
  });
  it("없는 id 의 dismiss/silence 는 false (404 로 알린다)", async () => {
    const { stateFile } = await sandbox();
    const svc = new NoticeService(stateFile);
    await svc.load();
    assert.equal(svc.dismiss("nope"), false);
    assert.equal(await svc.silence("nope"), false);
  });
  it("현재 모델을 모르면 훑지 않는다 — 모름을 없음으로 말하지 않는다", async () => {
    const { stateFile } = await sandbox();
    const { dir, list } = await modelDir();
    const svc = new NoticeService(stateFile);
    await svc.load();
    const r = await svc.refreshModels(dir, list, null);
    assert.equal(r.scanned, 0);
    assert.equal(r.notices.length, 0);
  });
  it("깨진 silence 파일은 에러로 알린다 (조용히 버리지 않는다)", async () => {
    const { stateFile } = await sandbox();
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, "{broken", "utf8");
    const svc = new NoticeService(stateFile);
    await assert.rejects(() => svc.load(), /깨졌습니다/);
  });
});
