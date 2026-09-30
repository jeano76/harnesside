/**
 * 업데이트 서비스 테스트 (§5.13.1) — **판단이 아니라 배선** 을 검사한다.
 *
 * `pipeline.test.ts` 가 순수 계산을 검증했다면 여기는 "네트워크를 못 쓰는 것을 어떻게
 * 말하는가" 를 본다. 이 프로그램에서 가장 위험한 실패는 조용한 실패다:
 *  - 확인 실패인데 "최신" 으로 남으면 사용자는 구버전인 줄 모른다
 *  - 403(레이트리밋)을 "업데이트 없음" 으로 바꾸면 아무도 다시 확인하지 않는다
 *  - 슬롯을 못 만들었는데 적용을 허용하면 되돌릴 곳이 없다
 *
 * GitHub 응답은 **주입**한다 — 진짜 네트워크는 쓰지 않는다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService } from "./updateService.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-upd-"));
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

function release(version: string, over: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    prerelease: false,
    published_at: "2026-01-01T00:00:00Z",
    html_url: `https://example.invalid/${version}`,
    body: "릴리스 노트",
    assets: [{ name: "harnesside.tgz", browser_download_url: "https://example.invalid/h.tgz", size: 11 }],
    ...over,
  };
}

function svc(dir: string, fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  return new UpdateService({
    currentVersion: "0.1.0",
    slotsDir: join(dir, "slots"),
    selfPath: join(dir, "harnesside"),
    fetchImpl,
    baseUrl: "https://example.invalid/api",
    guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: true, daemon: true, estimatedSeconds: 3, assetBytes: 1024 }),
    ...over,
  });
}

test("새 버전이 있으면 **버전 비교** 로 고른다 — 문자열 정렬은 v2 를 v10 뒤에 둔다", async () => {
  const s = await sandbox();
  try {
    const f = (async () => ({ ok: true, json: async () => [release("0.9.0"), release("0.10.0"), release("0.2.0")] })) as unknown as typeof fetch;
    const st = await svc(s.dir, f).check();
    assert.equal(st.remote?.version, "0.10.0", `버전 정렬이 아니다: ${st.remote?.version}`);
    assert.equal(st.state, "available");
    assert.match(st.remote?.notes ?? "", /릴리스 노트/);
  } finally {
    await s.cleanup();
  }
});

test("현재와 같으면 `up-to-date` — 확인했다는 사실이 보인다", async () => {
  const s = await sandbox();
  try {
    const f = (async () => ({ ok: true, json: async () => [release("0.1.0")] })) as unknown as typeof fetch;
    const st = await svc(s.dir, f).check();
    assert.equal(st.state, "up-to-date");
    assert.equal(st.lastCheckedAt !== null, true);
  } finally {
    await s.cleanup();
  }
});

test("레이트리밋(403)은 **'업데이트 없음' 이 아니라 '확인 못 함'** 이다", async () => {
  const s = await sandbox();
  try {
    const f = (async () => ({ ok: false, status: 403, statusText: "rate limited" })) as unknown as typeof fetch;
    const st = await svc(s.dir, f).check();
    assert.notEqual(st.state, "up-to-date", "레이트리밋을 '최신' 으로 기록했다");
    assert.match(String(st.lastError), /403|레이트리밋/);
  } finally {
    await s.cleanup();
  }
});

test("네트워크가 죽어도 **오류를 말하고 예전 상태로** 남는다", async () => {
  const s = await sandbox();
  try {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const errors: string[] = [];
    const st = await svc(s.dir, f, { onError: (m) => errors.push(m) }).check();
    assert.equal(st.state, "idle");
    assert.match(String(st.lastError), /확인 실패/);
    assert.equal(errors.length, 1, "실패를 알리지 않았다");
    assert.equal(st.current, "0.1.0", "현재 버전이 사라졌다");
  } finally {
    await s.cleanup();
  }
});

test("채널이 다르면 **버린다** — beta 를 stable 목록에 섞지 않는다", async () => {
  const s = await sandbox();
  try {
    const f = (async () => ({
      ok: true,
      json: async () => [release("0.2.0", { prerelease: true }), release("0.1.5")],
    })) as unknown as typeof fetch;
    const st = await svc(s.dir, f).check();
    assert.equal(st.remote?.version, "0.1.5", `prerelease 가 섞였다: ${st.remote?.version}`);
  } finally {
    await s.cleanup();
  }
});

test("자산은 **검증 후** 슬롯에 쓰인다 — 임시 경로가 아닌 곳에 먼저 쓰지 않는다", async () => {
  const s = await sandbox();
  try {
    const f = (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("hello world").buffer })) as unknown as typeof fetch;
    const up = svc(s.dir, f);
    const r = await up.downloadAsset({ name: "harnesside.tgz", url: "https://example.invalid/h.tgz", size: 11 });
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.path?.includes("slots/v-0.1.0"), `슬롯 밖이다: ${r.path}`);
    assert.equal((await readFile(r.path!, "utf8")), "hello world");
    // **.tmp 가 남지 않는다** — 검증 전 파일이 남아 있으면 다음 실행이 그것을 쓴다.
    const files = await readdir(join(s.dir, "slots", "v-0.1.0"));
    assert.equal(files.some((f) => f.endsWith(".tmp")), false, `임시 파일이 남았다: ${files.join(",")}`);
  } finally {
    await s.cleanup();
  }
});

test("크기가 다르면 **쓰지 않는다** — 조용히 쓰면 깨진 파일이 슬롯에 남는다", async () => {
  const s = await sandbox();
  try {
    const f = (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("short").buffer })) as unknown as typeof fetch;
    const r = await svc(s.dir, f).downloadAsset({ name: "h.tgz", url: "https://x.invalid/h", size: 999 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /크기/);
  } finally {
    await s.cleanup();
  }
});

test("롤백 슬롯은 **상한(3개)** 을 지키고 오래된 것부터 지운다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.dir, "harnesside"), "현재 실행 파일");
    const up = svc(s.dir, (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch);
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      // 버전별로 슬롯 디렉터리를 만든다(파일을 그때 읽으므로 미리 준비).
      await mkdirSafe(join(s.dir, "slots"));
      up.setRemoteForTest?.(v);
      const r = await up.makeSlot();
      assert.equal(r.ok, true, r.detail);
    }
    const st = up.get();
    assert.equal(st.slots.length, 3, `슬롯이 ${st.slots.length}개 — 상한을 넘었다`);
  } finally {
    await s.cleanup();
  }
});

test("되돌릴 수 없으면 **적용을 막는다** — D14", async () => {
  const s = await sandbox();
  try {
    const up = new UpdateService({
      currentVersion: "0.1.0",
      slotsDir: join(s.dir, "slots"),
      selfPath: join(s.dir, "harnesside"),
      fetchImpl: (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch,
      guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: false, daemon: false, estimatedSeconds: 5, assetBytes: 2048 }),
    });
    const { decision } = await up.planApply();
    assert.equal(decision.ok, false, "되돌릴 곳이 없는데 허용했다");
    assert.ok(decision.blockers.some((b) => /되돌릴 수 없/.test(b)), `사유가 없다: ${decision.blockers.join("|")}`);
  } finally {
    await s.cleanup();
  }
});

test("로컬 설치 사실 — **모르면 null** 이지 빈 문자열이 아니다", async () => {
  const s = await sandbox();
  try {
    const up = svc(s.dir, (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch);
    const missing = await up.local();
    assert.equal(missing.sha, null, "파일을 못 읽었는데 해시를 만들었다");
    await writeFile(join(s.dir, "harnesside"), "binary");
    const present = await up.local();
    assert.equal(typeof present.sha, "string");
    assert.equal(present.version, "0.1.0");
  } finally {
    await s.cleanup();
  }
});

async function mkdirSafe(p: string) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(p, { recursive: true });
}
