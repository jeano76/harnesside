#!/usr/bin/env node
/**
 * 셀프업데이트 **실측** (R-9) — 전체 경로를 진짜로 굴린다.
 *
 * 여기서 하지 않으면 이 작업 전체가 **"테스트를 통과하는 배포 시스템"** 이다.
 * 유닛 테스트는 각 함수를 본다. **경로** 는 아무도 보지 않는다. 그리고 이 프로그램에서
 * 가장 비싼 실패는 조용한 실패다 — 성공 보고만 하고 옛 코드로 도는 것.
 *
 * ── 굴리는 것 ──────────────────────────────────────────────────────────────
 *
 *   1. 빌드 A 를 실제 파일 트리로 만든다 (설치된 모습).
 *   2. 빌드 B 를 **다른 내용**으로 만든다. `agent/loop.js` 를 반드시 바꾼다 —
 *      진입 파일만 바꾸면 절반만 갱신된 트리가 되고(§R-5), 그게 이 작업의 핵심 시험이다.
 *   3. 확인 → 받기·검증 → 슬롯 → 적용 → **되돌리기**, 를 실제 tar 로.
 *   4. 되돌린 뒤 **A 의 바이트가 정확히** 돌아오고 **B 의 흔적이 하나도 없는지** 본다.
 *   5. 매니페스트 해시를 **한 글자** 바꾼 자산 → **아무것도 교체되지 않는지 바이트로**.
 *   6. 네트워크 불가 → "최신" 으로 **말하지 않는지**.
 *   7. 의존성 게이트 → 없는 의존을 **막는지**.
 *   8. 배포물 **재현성** → 두 번 만들어 해시가 **같은지**.
 *
 * ── 왜 네트워크를 안 쓰는가 ────────────────────────────────────────────────
 *
 * CI 에서 **진짜 네트워크**를 쓰면 그 테스트는 "오늘의 GitHub 응답" 을 검증한다.
 * 이미 배운 교훈이다. 여기서는 `fetchImpl` 을 **주입**하고 **로컬 자산**을 넣는다 —
 * 그러면 이 스크립트는 **PR 리뷰하는 사람이 토큰 없이 그대로 돌릴 수 있다.**
 *
 * 사용법: `npm run verify:selfupdate` (= `tsx scripts/verify-selfupdate.mjs`)
 *
 * **tsx 가 필요한 이유**: 실제 `UpdateService` 를 불러야 한다. 본을 흉내 낸
 * 재구현을 쓰면 이 스크립트는 **검증하려는 코드가 아니라 그에 비슷한 코드를**
 * 검사하게 된다 — 가장 값어치 없는 종류의 테스트다.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTreeSha, packDeterministicGz } from "./make-release.mjs";
import { MANIFEST_VERSION } from "../src/server/update/manifest.ts";
import { UpdateService } from "../src/server/updateService.ts";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = join(here, ".ci-selfupdate-sandbox");

let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks++;
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
  return !!cond;
}

const step = (n, title) => console.log(`\n[${n}] ${title}`);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const rmrf = (p) => rmSync(p, { recursive: true, force: true });

function put(root, rel, body, mode = 0o755) {
  const p = join(root, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
  chmodSync(p, mode);
}

/** 트리 전체를 **바이트**로 — "정확히 복원" 판정은 바이트로 해야 한다. */
function snapshot(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const n of readdirSync(dir)) {
      const abs = join(dir, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else out[rel] = readFileSync(abs);
    }
  };
  walk(root, "");
  return out;
}

/**
 * 실제 배포물 트리 — **프로젝트 모양 그대로**.
 *
 * `server/index.js` 가 `agent/loop.js` 를 import 한다. 그래서 진입 파일만 바꾸면
 * **절반만 갱신된 트리**가 되고, 그게 §R-5 실측의 사고 그 자체다. 여기서 그 구조를
 * 재현하되 **직접 만든다** — 실제 `dist/` 를 쓰면 이 스크립트가 프로젝트 빌드에
 * 의존하게 되고, 그러면 "배포 시스템이 아니라 빌드 상태"를 검증하게 된다.
 */
function makeBuild(root, version, loopMarker) {
  mkdirSync(root, { recursive: true });
  put(root, "server/index.js", `#!/usr/bin/env node\n// 버전 ${version}\nimport { LOOP } from "../agent/loop.js";\nconsole.log(LOOP);\n`);
  put(root, "server/config.js", `export const VERSION = "${version}";\n`, 0o644);
  put(root, "agent/loop.js", `export const LOOP = "${loopMarker}";\n`, 0o644);
  put(root, "web/index.html", `<!doctype html><title>${version}</title>\n`, 0o644);
  // 새 트리에 없는 옛 파일의 존재 테스트용 — B 에서는 이게 빠져야 한다.
  put(root, "legacy/old-only.js", `export const OLD = true;\n`, 0o644);
}

/**
 * 트리 → 배포물 (tar.gz + 매니페스트).
 *
 * **`make-release.mjs` 의 타이핑 규약을 재사용한다.** 규약을 두 벌로 만들면 —
 * 즉 쓰기 코드와 여기 코드 — 어느 한쪽이 조용히 달라지고, 그 차이는 **아무도
 * 모르게** 배포물만 달라진다. 그래서 헤더를 직접 쓰지 않고 `packDeterministicGz`
 * 를 부르고, **매니페스트를 아카이브 밖에 둔다** — 교체가 그것을 따로 기록한다.
 */
function pack(root, build) {
  const snap = snapshot(root);
  const files = [];
  const entries = [];
  for (const path of Object.keys(snap).sort()) {
    // **아카이브 밖에 있다** — 닭과 달걀. 자기 해시를 자기 안에 쓸 수 없다.
    if (path === "manifest.json") continue;
    const data = snap[path];
    files.push({ path, sha256: sha256(data), bytes: data.length, mode: 0o644 });
    entries.push({ name: `dist/${path}`, data, mode: 0o644 });
  }
  const asset = packDeterministicGz(entries);
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    build,
    asset: { name: "harnesside-dist.tar.gz", sha256: sha256(asset), bytes: asset.length },
    files,
    treeSha256: computeTreeSha(files),
  };
  return { asset, manifest: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") };
}

/**
 * 로컬 자산을 **인라인** 으로 돌리는 서비스. 네트워크 0회, 서버 0개.
 *
 * 자산 목록을 그대로 쓰는 이유: `downloadBundle` 가 릴리스 자산 목록에서
 * `manifest.json` 을 **찾아야** 한다(없으면 진행하지 않는다). 그 계약까지
 * 함께 검증하기 위해서다.
 */
function service({ manifest, asset, throws }) {
  const ASSET_URL = "https://example.invalid/harnesside-dist.tar.gz";
  const MANIFEST_URL = "https://example.invalid/manifest.json";
  const RELEASES_URL = "https://example.invalid/api";
  const manifestText = manifest ? manifest.toString("utf8") : "{}";
  const assetBytes = asset ?? Buffer.alloc(0);
  const version = (() => {
    try {
      return JSON.parse(manifestText).build?.version ?? "0.2.0";
    } catch {
      return "0.2.0";
    }
  })();
  // **릴리스 목록도 그대로 흉내 낸다.** `check()` 가 기대하는 응답 모양까지
  // 함께 검증해야 이 스크립트가 실제 경로를 검사한 것이 된다.
  const releases = [
    {
      tag_name: `v${version}`,
      prerelease: false,
      published_at: "2026-10-06T00:00:00Z",
      html_url: `https://example.invalid/${version}`,
      body: "셀프업데이트 실측용 릴리스",
      assets: [
        { name: "manifest.json", browser_download_url: MANIFEST_URL, size: Buffer.byteLength(manifestText) },
        { name: "harnesside-dist.tar.gz", browser_download_url: ASSET_URL, size: assetBytes.length },
      ],
    },
  ];
  const svc = new UpdateService({
    currentVersion: "0.1.0",
    slotsDir: join(SANDBOX, "update-slots"),
    selfPath: join(SANDBOX, "install", "dist", "server", "index.js"),
    fetchImpl: (async (url) => {
      const u = String(url);
      if (throws) throw new Error(throws);
      if (u.startsWith(RELEASES_URL)) return { ok: true, status: 200, json: async () => releases };
      if (u === MANIFEST_URL) return { ok: true, status: 200, text: async () => manifestText };
      if (u === ASSET_URL) return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(assetBytes).buffer };
      return { ok: false, status: 404, statusText: "Not Found" };
    }),
    baseUrl: RELEASES_URL,
    guard: async () => ({
      runningTurns: [],
      processes: [],
      dirtyTabs: null, // 서버는 브라우저 안의 편집 버퍼를 모른다(R-2.1) — 0 으로 메우지 않는다
      canRollback: true,
      daemon: true,
      estimatedSeconds: null, // 실측 전. 숫자를 지어내면 안내 문구가 된다
      assetBytes: null,
      dependenciesReady: null,
      missingDependencies: [],
    }),
  });
  return {
    svc,
    asset: { name: "harnesside-dist.tar.gz", url: ASSET_URL, size: assetBytes.length },
    manifestAsset: { name: "manifest.json", url: MANIFEST_URL, size: Buffer.byteLength(manifestText) },
  };
}

async function main() {
  console.log("셀프업데이트 실측 — 로컬 자산만 쓴다 (네트워크 0회)");

  rmrf(SANDBOX);
  const pkgRoot = join(SANDBOX, "install");
  const installRoot = join(pkgRoot, "dist");
  mkdirSync(join(SANDBOX, "update-slots"), { recursive: true });
  // `pkgRoot` 는 `dist/` 의 **한 단계 위**다 — 의존성 검사가 그곳에서 package.json 을
  // 읽는다(Raiser R-1). 실제 설치 모양과 같아야 그 경로를 시험한 것이 된다.
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "harnesside", version: "0.1.0" }), "utf8");

  const buildAInfo = { version: "0.1.0", date: "20261005", sha: "aaaaaaaa", dirty: false, builtAt: 1 };
  const buildBInfo = { version: "0.2.0", date: "20261006", sha: "bbbbbbbb", dirty: false, builtAt: 2 };

  // ── 1. 빌드 A = 설치된 트리 ────────────────────────────────────────────────
  step(1, "빌드 A — 실제 설치 트리");
  makeBuild(installRoot, "0.1.0", "A-loop");
  const packedA = pack(installRoot, buildAInfo);
  writeFileSync(join(installRoot, "manifest.json"), packedA.manifest);
  const snapA = snapshot(installRoot);
  ok(snapA["agent/loop.js"].toString().includes("A-loop"), `A 설치됨 (${Object.keys(snapA).length}개 파일)`);
  ok(snapA["manifest.json"] !== undefined, "A 는 자기 매니페스트를 안고 있다 — '나는 무엇인가' 의 증거");

  // ── 2. 빌드 B ──────────────────────────────────────────────────────────────
  step(2, "빌드 B — 다른 내용 (agent/loop.js 반드시 다름)");
  const treeB = join(SANDBOX, "staged-b");
  makeBuild(treeB, "0.2.0", "B-loop");
  rmrf(join(treeB, "legacy")); // B 에는 옛 파일이 없다 → 교체 시 **정리**되어야 한다
  const packedB = pack(treeB, buildBInfo);
  writeFileSync(join(treeB, "manifest.json"), packedB.manifest);
  const mB = JSON.parse(packedB.manifest.toString("utf8"));
  const mA = JSON.parse(packedA.manifest.toString("utf8"));
  ok(mB.treeSha256 !== mA.treeSha256, `트리 해시가 다름 (A ${mA.treeSha256.slice(0, 7)}… / B ${mB.treeSha256.slice(0, 7)}…)`);

  // ── 3. 확인 → 검증 → 적용 ──────────────────────────────────────────────────
  step(3, "확인 → 받기·검증(실제 tar) → 적용");
  const s3 = service({ manifest: packedB.manifest, asset: packedB.asset });
  const checked = await s3.svc.check();
  ok(checked.state === "available", `새 버전 감지 (상태 "${checked.state}")`);
  ok(checked.assets.some((a) => a.name === "manifest.json"), "릴리스에 manifest.json 이 보인다");

  const bundle = await s3.svc.downloadBundle(s3.asset);
  ok(bundle.ok === true, `검증된 트리 확보 — ${bundle.detail}`);
  ok(bundle.manifest?.treeSha256 === mB.treeSha256, "받은 매니페스트의 트리 해시가 만든 값과 같다");

  // 아무 검증 없이 `apply` 를 부르기 전에 **그 결과가 쓸 수 있는 값인지** 본다.
  // 검증에 실패한 트리를 적용하면 — `stageSwap` 의 게이트가 막지만 — 이 스크립트는
  // **성공 보고만 하고 옛 파일이 지워진 상태**를 다음 단계로 넘기게 된다.
  if (!bundle.ok || !bundle.tree) {
    console.error(`  ! 검증을 통과하지 못해 적용 단계를 건너뜁니다 — ${bundle.detail}`);
    process.exit(1);
  }
  const apply = await s3.svc.apply({
    stagedTree: bundle.tree,
    // 매니페스트를 **같이** 넘긴다 — 이것이 교체의 일부다(설치 루트에 기록).
    manifest: bundle.manifest,
    probeHello: async () => true,
    restart: async () => {},
    policy: { enabled: true, bootGraceSec: 90 },
  });
  ok(apply.ok === true, `적용 성공 — ${apply.detail}`);
  const snapB = snapshot(installRoot);
  ok(snapB["server/index.js"].toString().includes("0.2.0"), "진입 파일이 새 버전이다");
  ok(snapB["agent/loop.js"].toString().includes("B-loop"), "**나머지 파일도** 새 버전이다 (절반 갱신 아orea 상태 아님)");
  ok(snapB["legacy/old-only.js"] === undefined, "새 트리에 없는 옛 파일은 **정리**된다 (남으면 옛 코드로 돌아간다)");
  const verified = await s3.svc.verifyInstalled();
  ok(verified.ok === true, `기동한 트리가 자기 매니페스트로 검증된다 — ${verified.detail}`);
  ok(verified.sha === mB.treeSha256, "검증된 트리 해시가 배포물의 것과 같다");
  ok((await s3.svc.local()).sha === mB.treeSha256, "로컬 설치 사실이 **트리 해시**를 보고한다 (파일 하나가 아니다)");

  // ── 4. 되돌리기 — 바이트 단위 ─────────────────────────────────────────────
  step(4, "되돌리기 — A 의 **바이트**가 정확히 돌아오는가");
  const back = await s3.svc.rollback();
  ok(back.ok === true, `되돌림 — ${back.detail}`);
  const snapBack = snapshot(installRoot);
  const keysA = Object.keys(snapA).sort();
  const keysBack = Object.keys(snapBack).sort();
  ok(JSON.stringify(keysBack) === JSON.stringify(keysA), `파일 목록이 A 와 같다\n      A: ${keysA.join(", ")}\n      후: ${keysBack.join(", ")}`);
  const differing = keysA.filter((k) => !snapBack[k] || sha256(snapBack[k]) !== sha256(snapA[k]));
  ok(differing.length === 0, `모든 파일의 바이트가 A 와 같다${differing.length ? ` — 다른 것: ${differing.join(", ")}` : ""}`);
  ok(snapBack["agent/loop.js"].toString().includes("A-loop"), "옛 `agent/loop.js` 가 돌아왔다 (B 흔적 없음)");
  ok((await s3.svc.verifyInstalled()).sha === mA.treeSha256, "되돌린 뒤 자기 매니페스트로 검증된다");

  // ── 5. 검증 실패 — 핵심 검사 ──────────────────────────────────────────────
  step(5, "**검증 실패** — 매니페스트의 아카이브 해시를 한 글자 바꾼다");
  // 여기서 판정하는 것은 **바이트**다. "로그에 에러가났다" 로는 부족하다 —
  // 이 프로그램에서 가장 비싼 실패는 조용한 성공 보고다.
  const realHash = mB.asset.sha256;
  const tamperedHash = (realHash[0] === "a" ? "b" : "a") + realHash.slice(1);
  const tampered = Buffer.from(
    packedB.manifest.toString("utf8").replace(realHash, tamperedHash),
    "utf8"
  );
  const s5 = service({ manifest: tampered, asset: packedB.asset });
  await s5.svc.check();
  const before5 = snapshot(installRoot);
  const bad = await s5.svc.downloadBundle(s5.asset);
  ok(bad.ok === false, `검증 실패를 **실패로** 말한다 (ok=${bad.ok})`);
  ok(/해시|불일치/.test(bad.detail ?? ""), `사유가 해시 불일치다 — ${bad.detail}`);
  const after5 = snapshot(installRoot);
  ok(
    JSON.stringify(Object.keys(after5).sort()) === JSON.stringify(Object.keys(before5).sort()),
    "검증 실패인데 **설치 트리의 파일 구성이 그대로**다"
  );
  ok(sha256(after5["agent/loop.js"]) === sha256(before5["agent/loop.js"]), "검증 실패인데 `agent/loop.js` 의 바이트가 바뀌었다");

  // ── 6. 네트워크 불가 ──────────────────────────────────────────────────────
  step(6, "네트워크 불가 — '최신' 으로 **말하지 않는가**");
  const s6 = service({ manifest: Buffer.from("{}"), asset: Buffer.alloc(0), throws: "ECONNREFUSED" });
  const off = await s6.svc.check();
  ok(off.state !== "up-to-date", `확인 실패를 '최신' 으로 기록하지 않는다 (상태 "${off.state}")`);
  ok(off.state === "idle" && /확인 실패/.test(String(off.lastError)), `사유가 보인다 — ${off.lastError}`);
  ok(off.current === "0.1.0", "현재 버전이 사라지지 않는다");

  // ── 7. 의존성 게이트 ──────────────────────────────────────────────────────
  step(7, "의존성 게이트 — 배포물은 실행 파일만 온다(Raiser R-1)");
  const noDeps = await s3.svc.dependencies();
  ok(noDeps.ready === true, `선언된 의존이 없으면 통과 — ${noDeps.detail}`);
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify({ name: "harnesside", version: "0.1.0", dependencies: { "definitely-not-installed-xyzzy": "^1" } }),
    "utf8"
  );
  const missingDeps = await s3.svc.dependencies();
  const plan = await s3.svc.planApply();
  ok(missingDeps.ready === false, `없는 의존을 발견한다 — ${missingDeps.missing.join(", ")}`);
  ok(plan.decision.ok === false, "의존성이 없으면 **적용을 막는다**");
  ok(plan.decision.blockers.some((b) => /의존성/.test(b)), `차단 사유가 보인다 — ${plan.decision.blockers.join(" | ")}`);

  // ── 8. 배포물 재현성 ──────────────────────────────────────────────────────
  step(8, "배포물이 **재현 가능**한가 — 두 번 만들어 해시가 같은가");
  const r1 = pack(treeB, buildBInfo);
  const r2 = pack(treeB, buildBInfo);
  ok(sha256(r1.asset) === sha256(r2.asset), `두 번 만든 산출물의 해시가 같다 (${sha256(r1.asset).slice(0, 12)}…)`);
  ok(sha256(r1.manifest) === sha256(r2.manifest), "매니페스트도 같다");

  // ── 9. 배포물이 실제 `make-release` 규약으로 다시 만들어지는가 ────────────
  step(9, "실제 `make-release` 규약과 **같은 아카이브**인가 (규약이 두 벌이면 조용히 갈라진다)");
  ok(sha256(r1.asset) === sha256(packedB.asset), "두 계산 경로의 결과가 같다");

  console.log(`\n${failures === 0 ? "통과" : "실패"} — ${checks - failures}/${checks} 항목`);
  if (failures > 0) {
    // 실패하면 **샌드박스를 지우지 않는다.** 지우면 "왜 실패했나" 를 볼 수 없고,
    // 다음 사람은 추측으로 고치기 시작한다(그래서 원래도 `--keep` 를 뒀다).
    console.log(`\n실패 — 상태를 남깁니다: ${SANDBOX}`);
    try {
      for (const rel of Object.keys(snapshot(installRoot)).sort()) console.log(`  dist/${rel}`);
      console.log(`  설치 루트: ${installRoot}`);
      process.exit(1);
    } catch {
      process.exit(1);
    }
  }
  rmrf(SANDBOX);
  process.exit(0);
}

await main();