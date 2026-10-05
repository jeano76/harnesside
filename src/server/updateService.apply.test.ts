/**
 * 업데이트 **적용** 실측 — 교체 → 부팅 확인 → 실패 시 롤백. **트리 단위**(R-5).
 *
 * 여기서 실행 파일을 **실제 바이너리로 쓰지 않는다.** temp 디렉터리에 `dist/server/index.js`
 * 모양의 **트리**를 만들고 새 트리를 갈아끼운 뒤, "기동" 하는지 안 하는지를 정하게 한다.
 * 그러면 두 경우를 **같은 머신에서** 볼 수 있고, 실패 경로가 실제로 트리를 되돌리는지
 * 확인할 수 있다.
 *
 * ── 왜 트리인가 (R-5 실측) ─────────────────────────────────────────────────
 *
 * 예전 테스트는 `harnesside` **파일 하나**를 교체했다. 그래서 통과했다. 그런데 배포물은
 * `dist/` **트리**다 — `server/index.js` 가 `agent/loop.js` 를 import 한다. 파일 하나만
 * 갈아끼우면 나머지는 옛 버전이고, **해시도 통과하고 부팅도 성공한다.**
 * 조용히 틀어진다. 그래서 이 파일은 **트리**를 다룬다.
 *
 * 검사하는 것:
 *  1. 새 버전이 기동하면 **성공** — 그리고 그 트리가 실제로 놓인다.
 *  2. 새 버전이 기동하지 못하면 **되돌림** — 그리고 **옛 트리가 정확히** 돌아온다.
 *  3. 되돌릴 곳이 없으면 **시도조차 하지 않는다**.
 *  4. **인수 조건 1(R-5)**: 파일 하나만 낡게 만든 시나리오 — 롤백하면 A 의 파일이
 *     **정확히** 복원되고 B 의 파일이 **하나도 남지 않는다.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService } from "./updateService.js";
import { DEFAULT_ROLLBACK } from "./update/pipeline.js";
import { computeTreeSha, MANIFEST_VERSION, sha256, type ManifestFile, type ReleaseManifest } from "./update/manifest.js";

/**
 * 설치 트리 픽스처 — **진짜 모양**을 따른다.
 *
 *   install/dist/server/index.js   ← selfPath. installRoot() 는 그 두 단계 위 = install/dist
 *   install/dist/agent/loop.js
 *   slots/
 *
 * 예전 픽스처는 `selfPath` 를 sandbox 맨 위에 두었다. 그러면 `installRoot()` 가
 * sandbox **바깥**(tmpdir 루프 쪽)을 가리킨다 — 설계를 바꾸면서 테스트가 그 위험을
 * 안고 있었다. 지금은 트리 모양을 지킨다.
 */
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-apply-"));
  const root = join(dir, "install", "dist");
  await mkdir(join(root, "server"), { recursive: true });
  await mkdir(join(root, "agent"), { recursive: true });
  return {
    dir,
    root,
    selfPath: join(root, "server", "index.js"),
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

/** 파일을 쓴다. 실행 권한은 **실제로** 준다 — 없으면 되돌린 트리가 바로 실패한다. */
async function put(root: string, rel: string, body: string, mode = 0o755): Promise<void> {
  const p = join(root, ...rel.split("/"));
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body, "utf8");
  await chmod(p, mode);
}

/** 픽스처 트리를 전부 읽는다. "정확히 복원" 판정에 쓴다. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const n of await readdir(dir)) {
      const abs = join(dir, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      const st = await stat(abs);
      if (st.isDirectory()) await walk(abs, rel);
      else out[rel] = await readFile(abs, "utf8");
    }
  };
  await walk(root, "");
  return out;
}

/** 배포물 매니페스트를 **실제 트리에서** 만든다 — 이론적 해시를 쓰지 않는다. */
async function manifestOf(root: string, build = { version: "0.1.0", date: "20261005", sha: "08c4467" }): Promise<ReleaseManifest> {
  const snap = await snapshot(root);
  const files: ManifestFile[] = Object.keys(snap)
    .sort()
    .map((path) => {
      const data = Buffer.from(snap[path], "utf8");
      return { path, sha256: sha256(data), bytes: data.byteLength, mode: 0o644 };
    });
  return {
    manifestVersion: MANIFEST_VERSION,
    build: { ...build, dirty: false, builtAt: 1 },
    asset: { name: "harnesside-dist.tar.gz", sha256: sha256("archive"), bytes: 10 },
    files,
    treeSha256: computeTreeSha(files),
  };
}

async function writeManifest(root: string, m: ReleaseManifest): Promise<void> {
  await writeFile(join(root, "manifest.json"), JSON.stringify(m, null, 2) + "\n", "utf8");
}

/** 빌드 A 트리. */
async function buildA(root: string): Promise<ReleaseManifest> {
  await put(root, "server/index.js", "#!/bin/sh\necho '버전 0.1.0'\n");
  await put(root, "agent/loop.js", "export const LOOP = 'A';\n", 0o644);
  const m = await manifestOf(root);
  await writeManifest(root, m);
  return m;
}

/** 빌드 B 트리 — **B 만 다른 별도 디렉터리**. */
async function buildB(dir: string): Promise<{ tree: string; manifest: ReleaseManifest }> {
  const tree = join(dir, "staged-b");
  await mkdir(tree, { recursive: true });
  await put(tree, "server/index.js", "#!/bin/sh\necho '버전 0.2.0'\n");
  await put(tree, "agent/loop.js", "export const LOOP = 'B';\n", 0o644);
  const manifest = await manifestOf(tree, { version: "0.2.0", date: "20261006", sha: "abc1234" });
  await writeManifest(tree, manifest);
  return { tree, manifest };
}

function svc(s: Awaited<ReturnType<typeof sandbox>>, over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  return new UpdateService({
    currentVersion: "0.1.0",
    slotsDir: join(s.dir, "slots"),
    selfPath: s.selfPath,
    fetchImpl: (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch,
    guard: async () => ({
      runningTurns: [], processes: [], dirtyTabs: null, canRollback: true, daemon: true,
      estimatedSeconds: null, assetBytes: 1024, dependenciesReady: true, missingDependencies: [],
    }),
    ...over,
  });
}

test("새 버전이 **기동하면 성공** — 그리고 그 트리가 실제로 놓인다", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const b = await buildB(s.dir);
    const up = svc(s);
    const restarts: string[] = [];
    const r = await up.apply({
      stagedTree: b.tree,
      probeHello: async () => true,
      restart: async () => void restarts.push("restart"),
      now: (() => {
        let t = 1_000_000;
        return () => (t += 200);
      })(),
      policy: { enabled: true, bootGraceSec: 90 },
    });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.rolledBack, false);
    assert.equal(r.verdict, "healthy");
    // **교체만으로는 아무것도 바뀌지 않는다.** 재기동이 없으면 성공 보고만 하고
    // 옛 프로세스가 계속 돈다(실측으로 확인된 순서 버그).
    assert.equal(restarts.length, 1, "교체 후 재기동을 안 했다 — 새 버전이 실행된 적 없다");
    const snap = await snapshot(s.root);
    assert.equal(snap["server/index.js"], "#!/bin/sh\necho '버전 0.2.0'\n", "진입 파일이 교체되지 않았다");
    // **이게 핵심**이다 — 나머지 파일도 새 버전이어야 한다.
    assert.equal(snap["agent/loop.js"], "export const LOOP = 'B';\n", "옛 버전의 파일이 남아 있다 — 조용히 틀어진다");
    // 실행 가능해야 한다 — mode 가 없으면 되돌린 트리가 바로 실패한다.
    assert.equal((await stat(s.selfPath)).mode & 0o111, 0o111, "실행 권한이 없다");
    // 기동한 트리가 **자기 매니페스트로** 검증된다 — "교체한 것"과 "실행된 것"의 일치.
    const v = await up.verifyInstalled();
    assert.equal(v.ok, true, v.detail);
    assert.equal(v.sha, b.manifest.treeSha256, "기동한 트리 해시가 교체한 것과 다르다");
  } finally {
    await s.cleanup();
  }
});

test("기동하지 못하면 **되돌린다** — 그리고 옛 트리가 **정확히** 돌아온다", async () => {
  const s = await sandbox();
  try {
    const mA = await buildA(s.root);
    const before = await snapshot(s.root);
    const b = await buildB(s.dir);
    const up = svc(s);
    const restarts: string[] = [];
    const ticks: number[] = [];
    let t = 1_000_000;
    const r = await up.apply({
      stagedTree: b.tree,
      probeHello: async () => false,
      restart: async () => void restarts.push("restart"),
      onTick: (x) => ticks.push(x),
      now: () => (t += 1_000),
      policy: { enabled: true, bootGraceSec: 3 },
    });
    assert.equal(r.ok, false, "기동 실패인데 성공으로 보고했다");
    assert.equal(r.rolledBack, true, "되돌리지 않았다");
    assert.equal(r.verdict, "failed");
    assert.match(r.detail, /기동 신호/, `사유가 원본 문장이 아니다: ${r.detail}`);
    // 교체 → 재기동(1회) → 확인 실패 → 되돌리고 **다시** 띄워야(총 2회) 한다.
    assert.equal(restarts.length, 2, `재기동 횟수 ${restarts.length} — 되돌린 뒤 다시 띄워야 한다`);
    // ── R-5 인수 조건 1: **바이트 단위로** 돌아왔는가 ──────────────────────
    const after = await snapshot(s.root);
    assert.deepEqual(after, before, `옛 트리가 정확히 복원되지 않았다.\n전: ${JSON.stringify(before)}\n후: ${JSON.stringify(after)}`);
    assert.equal((await up.verifyInstalled()).sha, mA.treeSha256, "되돌린 뒤 트리 해시가 빌드 A 와 다르다");
    assert.ok(ticks.length > 0, "기다리는 동안 아무 말도 하지 않았다");
  } finally {
    await s.cleanup();
  }
});

test("**되돌릴 곳이 없으면 시도조차 하지 않는다** — 트리를 바꿔 놓고 되돌릴 곳이 없다", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const before = await snapshot(s.root);
    const b = await buildB(s.dir);
    const up = svc(s, {
      guard: async () => ({
        runningTurns: [], processes: [], dirtyTabs: null, canRollback: false, daemon: true,
        estimatedSeconds: null, assetBytes: 1024, dependenciesReady: true, missingDependencies: [],
      }),
    });
    let probed = false;
    const r = await up.apply({
      stagedTree: b.tree,
      probeHello: async () => {
        probed = true;
        return true;
      },
      restart: async () => {},
    });
    assert.equal(r.ok, false, "되돌릴 곳이 없는데 적용했다");
    assert.equal(r.rolledBack, false);
    assert.match(r.detail, /되돌릴 수 없/, `차단 사유가 없다: ${r.detail}`);
    assert.equal(probed, false, "거부했는데 기동 확인까지 했다");
    assert.deepEqual(await snapshot(s.root), before, "거부했는데 트리를 바꿔 버렸다");
  } finally {
    await s.cleanup();
  }
});

test("교체 전 **임시 파일이 남지 않는다** — 반만 남은 파일을 다음 실행이 쓴다", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const b = await buildB(s.dir);
    const up = svc(s);
    await up.apply({ stagedTree: b.tree, probeHello: async () => true, restart: async () => {} });
    const left = Object.keys(await snapshot(s.root)).filter((f) => f.includes("harnesside-tmp"));
    assert.deepEqual(left, [], `임시 파일이 남았다: ${left.join(", ")}`);
  } finally {
    await s.cleanup();
  }
});

test("**새 트리에 없는 옛 파일은 정리된다** — 남으면 옛 코드로 돌아간다", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    // A 에만 있던 파일 — B 에는 없다.
    await put(s.root, "agent/removed.js", "export const OLD = 1;\n", 0o644);
    const mA = await manifestOf(s.root);
    await writeManifest(s.root, mA);
    const b = await buildB(s.dir);
    const up = svc(s);
    await up.apply({ stagedTree: b.tree, probeHello: async () => true, restart: async () => {} });
    const snap = await snapshot(s.root);
    assert.equal("agent/removed.js" in snap, false, "새 트리에 없는 옛 파일이 남아 있다 — import 하면 옛 코드로 돌아간다");
    // 남지 않았으므로 **검증도 통과**한다. 목록 대조가 이것을 잡는다.
    const v = await up.verifyInstalled();
    assert.equal(v.ok, true, v.detail);
  } finally {
    await s.cleanup();
  }
});

// ── R-5 인수 조건 1: 절반만 갱신된 트리 ────────────────────────────────────

test("**절반만 갱신된 트리**(진입 파일만 새 버전)를 검증이 잡아낸다", async () => {
  // 이 시나리오는 **파일 하나만 검사하는 구현으로는 통과할 수 없다.** 통과하면 진짜 고친 것이다.
  //
  // 상태를 정직하게 만든다: 매니페스트는 **B**(새 버전)인데 `agent/loop.js` 는 **A**.
  // `server/index.js` 도 B. 즉 **해시가 맞는데 틀린 상태**가 아니라,
  // **진입 파일만 새 버전이고 나머지가 옛 버전**인 상태다 — §R-5 실측의 그 사고.
  const s = await sandbox();
  try {
    const b = await buildB(s.dir);
    // B 의 진입 파일과 매니페스트만 가져온다. 나머지(loop.js)는 A 로 남긴다.
    await put(s.root, "server/index.js", "#!/bin/sh\necho '버전 0.2.0'\n");
    await writeFile(join(s.root, "manifest.json"), JSON.stringify(b.manifest, null, 2) + "\n", "utf8");
    // loop.js 는 아직 없다 → 없는 파일로 잡힌다. **내용이 옛 버전인 경우**도 따로 본다.
    await put(s.root, "agent/loop.js", "export const LOOP = 'A';\n", 0o644);

    const v = await svc(s).verifyInstalled();
    assert.equal(v.ok, false, "절반만 갱신된 트리를 통과시켰다 — 부팅은 성공하고 옛 로직으로 도는 상태가 된다");
    assert.equal(v.mismatched[0]?.path, "agent/loop.js", `어느 파일이 틀렸는지 특정하지 못했다: ${JSON.stringify(v.mismatched)}`);
    // 그리고 **설치 해시는 null 이어야 한다** — 파일 하나의 해시를 대신 보고하지 않는다.
    const local = await svc(s).local();
    assert.equal(local.sha, null, "검증에 실패했는데 설치 해시를 보고했다 — 그것은 아orea 상태라고 부르는 조용한 실패다");
  } finally {
    await s.cleanup();
  }
});

test("**롤백 슬롯은 트리 단위로** 만들어지고 상한 3개를 지킨다", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const up = svc(s);
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      await mkdir(join(s.dir, "slots"), { recursive: true });
      up.setRemoteForTest(v);
      const r = await up.makeSlot();
      assert.equal(r.ok, true, r.detail);
    }
    const st = up.get();
    assert.equal(st.slots.length, 3, `슬롯이 ${st.slots.length}개 — 상한을 넘었다`);
    // 슬롯은 **트리**다 — 파일 하나가 아니다.
    const snap = await snapshot(st.slots[st.slots.length - 1]);
    assert.ok("server/index.js" in snap, `슬롯에 트리가 없다: ${Object.keys(snap).join(", ")}`);
  } finally {
    await s.cleanup();
  }
});

test("rollback() 은 가장 최근 슬롯으로 되돌린다 — **트리 전체**를", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const b = await buildB(s.dir);
    const up = svc(s);
    await up.stageSwap(b.tree);
    const r = await up.rollback();
    assert.equal(r.ok, true, r.detail);
    const snap = await snapshot(s.root);
    assert.equal(snap["server/index.js"], "#!/bin/sh\necho '버전 0.1.0'\n", "슬롯 내용이 돌아오지 않았다");
    assert.equal(snap["agent/loop.js"], "export const LOOP = 'A';\n", "나머지 파일이 돌아오지 않았다");
    assert.equal((await stat(s.selfPath)).mode & 0o111, 0o111, "실행 권한이 없다");
  } finally {
    await s.cleanup();
  }
});

test("rollback() 은 슬롯이 없으면 시도하지 않는다", async () => {
  const s = await sandbox();
  try {
    const r = await svc(s).rollback();
    assert.equal(r.ok, false);
    assert.match(r.detail, /슬롯이 없습니다/);
  } finally {
    await s.cleanup();
  }
});

test("rollback() 은 슬롯 범위 밖의 경로를 거부한다", async () => {
  const s = await sandbox();
  try {
    const up = svc(s);
    const evil = join(s.dir, "..", "outside");
    const r = await up.rollback(evil);
    assert.equal(r.ok, false);
    assert.match(r.detail, /범위 밖/);
    // 뒤집으면 실패해야 한다: 거부 없이 통과하면 임의 파일 복사가 된다
    assert.equal(r.path, undefined);
  } finally {
    await s.cleanup();
  }
});

test("stageSwap() 은 슬롯을 **먼저** 만들고 교체한다 (순서 고정)", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const before = await snapshot(s.root);
    const b = await buildB(s.dir);
    const up = svc(s);
    const r = await up.stageSwap(b.tree);
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.slot, "슬롯 경로가 없다 — 교체 전에 되돌릴 곳을 만들어야 한다");
    const snap = await snapshot(s.root);
    assert.equal(snap["server/index.js"], "#!/bin/sh\necho '버전 0.2.0'\n", "교체되지 않았다");
    // 슬롯에는 **교체 전 트리**가 있다.
    assert.deepEqual(await snapshot(r.slot!), before, "슬롯에 교체 전 트리가 없다");
  } finally {
    await s.cleanup();
  }
});

test("**grace 안에 신호가 오면 기다리지 않는다** — 90초를 다 기다리는 것이 아니다", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const b = await buildB(s.dir);
    let calls = 0;
    let t = 1_000_000;
    const r = await svc(s).apply({
      stagedTree: b.tree,
      probeHello: async () => {
        calls++;
        return calls >= 3;
      },
      restart: async () => {},
      now: () => (t += 100),
      policy: { enabled: true, bootGraceSec: 90 },
    });
    assert.equal(r.ok, true, r.detail);
    assert.equal(calls, 3, `세 번이 아니라 ${calls} 번 물었다`);
  } finally {
    await s.cleanup();
  }
});

test("롤백 정책이 꺼져 있으면 grace 도 **무시** 된다 — 기다리는 척 하지 않는다", async () => {
  const s = await sandbox();
  try {
    await buildA(s.root);
    const b = await buildB(s.dir);
    let t = 1_000_000;
    const r = await svc(s).apply({
      stagedTree: b.tree,
      probeHello: async () => false,
      restart: async () => {},
      now: () => (t += 50),
      policy: { enabled: false, bootGraceSec: DEFAULT_ROLLBACK.bootGraceSec },
    });
    assert.equal(r.ok, false);
    assert.equal(r.elapsedSec <= 1, true, `꺼져 있는데 ${r.elapsedSec}초 기다렸다`);
  } finally {
    await s.cleanup();
  }
});