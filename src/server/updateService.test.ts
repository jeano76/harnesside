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
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService } from "./updateService.js";
import { computeTreeSha, MANIFEST_VERSION, sha256, type ManifestFile, type ReleaseManifest } from "./update/manifest.js";

/** 실제 트리에서 매니페스트를 만든다 — 이론적 해시를 쓰면 아무것도 검증하지 않는다. */
async function manifestOf(root: string): Promise<ReleaseManifest> {
  const { readdir: rd } = await import("node:fs/promises");
  const walk = async (dir: string, prefix: string): Promise<string[]> => {
    const out: string[] = [];
    for (const n of await rd(dir)) {
      const rel = prefix ? `${prefix}/${n}` : n;
      const abs = join(dir, n);
      const st = await (await import("node:fs/promises")).stat(abs);
      if (st.isDirectory()) out.push(...(await walk(abs, rel)));
      else out.push(rel);
    }
    return out;
  };
  const files: ManifestFile[] = [];
  for (const rel of (await walk(root, "")).sort()) {
    const data = await readFile(join(root, ...rel.split("/")));
    files.push({ path: rel, sha256: sha256(data), bytes: data.byteLength, mode: 0o644 });
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    build: { version: "0.1.0", date: "20261005", sha: "08c4467", dirty: false, builtAt: 1 },
    asset: { name: "harnesside-portable-linux-x64.zip", sha256: sha256("a"), bytes: 1 },
    files,
    treeSha256: computeTreeSha(files),
  };
}

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-upd-"));
  // **실제 설치 모양**(포터블 zip 을 푼 자리)을 따른다: 설치 루트 = 패키지 루트이고,
  // 그 아래에 `dist/` 와 `package.json` 이 있다. 의존성 검사는 설치 루트의
  // package.json 을 읽는다(Raiser R-1) — 이 배치가 아니면 그 경로를 못 시험한다.
  const pkgRoot = join(dir, "install");
  const root = pkgRoot;
  await mkdirSafe(join(root, "dist", "server"));
  await writeFile(join(root, "dist", "server", "index.js"), "진입점", "utf8");
  await writeFile(join(pkgRoot, "package.json"), JSON.stringify({ name: "harnesside", version: "0.1.0", dependencies: { "node-pty": "^1.1.0" } }), "utf8");
  return { dir, root, pkgRoot, selfPath: join(root, "dist", "server", "index.js"), cleanup: async () => rm(dir, { recursive: true, force: true }) };
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
    selfPath: join(dir, "install", "dist", "server", "index.js"),
    fetchImpl,
    baseUrl: "https://example.invalid/api",
    guard: async () => ({
      runningTurns: [], processes: [], dirtyTabs: null, canRollback: true, daemon: true,
      estimatedSeconds: null, assetBytes: 1024, dependenciesReady: true, missingDependencies: [],
    }),
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
      selfPath: s.selfPath,
      fetchImpl: (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch,
      guard: async () => ({
        runningTurns: [], processes: [], dirtyTabs: null, canRollback: false, daemon: false,
        estimatedSeconds: null, assetBytes: 2048, dependenciesReady: true, missingDependencies: [],
      }),
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
    // 매니페스트가 없으므로 **검증할 수 없다** → 해시는 null.
    // 예전엔 `selfPath` **한 파일**의 해시를 "설치 해시" 로 보고했다. 그래서
    // `agent/loop.js` 가 옛 버전인 상태를 통과시켰다 — §R-5 실측의 그 사고.
    const unverifiable = await up.local();
    assert.equal(unverifiable.sha, null, "검증 없이 해시를 만들었다 — 검증하는 것보다 나쁘다");
    // 이 테스트는 **소스에서** 돈다(tsx). 그때는 주입 파일이 없으므로
    // "개발 실행" 이 사실로 나오는 게 **맞다** — `0.0.0` 으로 메우지 않는다.
    // 주입이 된 경우는 R-9 `verify-selfupdate.mjs` 가 실제 빌드로 본다.
    assert.equal(unverifiable.stamped, false, "주입 파일이 없는데 주입된 것처럼 말한다");
    assert.equal(unverifiable.date, null, "개발 실행에 빌드 날짜가 있다");
    assert.equal(unverifiable.commit, null);
    assert.equal(unverifiable.version, "0.1.0");
  } finally {
    await s.cleanup();
  }
});

test("설치된 트리가 자기 매니페스트와 맞으면 **트리 해시**를 보고한다", async () => {
  const s = await sandbox();
  try {
    // 실제 트리에서 매니페스트를 만든다 — 이론적 해시를 쓰지 않는다.
    const m = await manifestOf(s.root);
    await writeFile(join(s.root, "portable-manifest.json"), JSON.stringify(m, null, 2), "utf8");
    const up = svc(s.dir, (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch);
    const v = await up.verifyInstalled();
    assert.equal(v.ok, true, v.detail);
    assert.equal(v.sha, m.treeSha256);
    assert.equal((await up.local()).sha, m.treeSha256, "로컬 사실이 검증한 트리 해시와 다르다");
    // portable-manifest.json 자신은 **검증에서 빠진다** — 자기 해시를 자기 안에 쓸 수는 없다.
    assert.deepEqual(v.extra, [], "매니페스트 자신을 '목록에 없는 파일' 로 잡았다");
  } finally {
    await s.cleanup();
  }
});

// ── Raiser R-1: 배포물에 node_modules 가 없다 ─────────────────────────────

test("**의존성이 없으면 적용을 막을 근거**가 생긴다 — 조용히 깨뜨리지 않는다", async () => {
  const s = await sandbox();
  try {
    const up = svc(s.dir, (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch);
    const deps = await up.dependencies();
    // 샌드박스에는 `node_modules` 가 없다 → 없는 것이 사실이다.
    assert.equal(deps.ready, false, `없는 의존을 '있다' 고 말했다: ${deps.detail}`);
    assert.ok(deps.missing.length > 0, "어떤 의존이 없는지 말하지 않는다");
    const { decision } = await up.planApply();
    assert.equal(decision.ok, false, "의존성이 없는데 적용을 허용했다");
    assert.ok(decision.blockers.some((b) => /의존성/.test(b)), `차단 사유가 없다: ${decision.blockers.join("|")}`);
  } finally {
    await s.cleanup();
  }
});

async function mkdirSafe(p: string) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(p, { recursive: true });
}
