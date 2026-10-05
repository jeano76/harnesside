#!/usr/bin/env node
/**
 * 배포물 만들기 (R-3) — `release/` 아래 세 가지를 낸다.
 *
 *   harnesside-dist.tar.gz   배포물 (dist/ 트리)
 *   manifest.json             안으로 **무엇이** 들어 있는지와 각 파일 해시
 *   SHA256SUMS                사람이 `sha256sum -c` 로 확인하는 텍스트
 *
 * ── 왜 tar 를 **직접 쓴다** ──────────────────────────────────────────────────
 *
 * 1. **재현성**(R-3.3). `tar czf` 는 기본적으로 **같은 입력에서도 바이트가 매번 다르다.**
 *    mtime·inode·gzip 헤더의 타임스탬프가 들어간다. 그러면 "sha256 이 커밋과 1:1 대응한다" 는
 *    말이 **거짓**이 되고, R-1 의 "이 빌드가 이 커밋에서 나왔다" 는 전제가 무너진다.
 *    `--sort=name --mtime=@0 --owner=0 --group=0 | gzip -n` 로도 되지만 **GNU tar 전용**이라
 *    macOS·busybox 에서 조용히 다른 값이 나온다.
 * 2. **배제 규칙을 한 곳에 두기**(R-3.4). CI 가 부르는 파일과 로컬이 부르는 파일이 같아야 한다.
 * 3. `src/setup/tarGz.ts` 가 이미 **tar 읽기**를 순수 표준 라이브러리로 한다. 쓰기도 같은
 *    방식으로 두는 게 대칭이고, 검증(읽기)과 생성(쓰기)이 한 형식을 공유한다.
 *
 * **한계(정직하게)**: 배포물은 `dist/` 다. 심볼릭 링크·디바이스 노드를 담지 않는다.
 * 나중에 그런 것이 필요해지면 그때 확장한다 — 지금 넣지 않는다.
 *
 * 사용법:
 *   node scripts/make-release.mjs                 # 만든다
 *   node scripts/make-release.mjs --check         # 만들지 않고 유효성만
 *   node scripts/make-release.mjs --verify-repro  # 두 번 만들어 **비교**한다(인수 조건 1)
 *   node scripts/make-release.mjs --require-clean # 더티면 실패 (릴리스 워크플로)
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 배포물에 **무엇을 넣는지** — 정본은 이 목록이다 (R-3.4).
 *
 * CI 에만 있는 배제 규칙은 로컬 배포물과 CI 배포물이 달라진다. 그래서 **여기** 있고,
 * 여기서 읽는다. `package.json` 의 `files`(`["dist","README.md","LICENSE"]`)는
 * **npm 배포**의 정본이고, 이 스크립트는 **GitHub Releases** 의 정본이다.
 */
export const MANIFEST_RELPATH = "manifest.json";
export const ASSET_NAME = "harnesside-dist.tar.gz";

/** 배포물에 **들어가지 않는** 것 — 이유를 적는다. 나중에 되돌리기 위해서. */
export const EXCLUDE = [
  { pattern: /\.map$/, reason: "소스맵 — 배포물에서 읽지 않는다" },
  { pattern: /\.harnesside-tmp$/, reason: "교체 중 남은 임시 파일" },
  { pattern: /node_modules\//, reason: "의존성은 배포물이 아니라 사전 설치 대상이다(Raiser R-1)" },
];

/** 빌드 트리 루트 — tar 안에서의 첫 디렉터리 이름. 풀 때 `strip:1` 과 짝이다. */
export const TREE_TOP = "dist";

function excluded(rel) {
  for (const e of EXCLUDE) if (e.pattern.test(rel)) return e;
  return null;
}

function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const abs = join(dir, name);
    const rel = relative(base, abs).split("\\").join("/");
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    // 심볼릭 링크는 따라가지 않는다 — 루트 밖을 세거나 복사하는 사고를 막는다.
    if (st.isDirectory()) out.push(...walk(abs, base));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

// ── ustar 헤더 (512 바이트) ─────────────────────────────────────────────────
const BLOCK = 512;

function octal(value, len) {
  // ustar 숫자 필드는 **0 으로 채운 8진수 + NUL** 이다. 빈칸(스페이스)은 BSD 확장이고
  // 읽는 쪽마다 다르게 본다. 여기가 조용히 깨지는 자리다.
  const s = Math.floor(value).toString(8);
  if (s.length > len - 1) throw new Error(`tar 필드가 넘칩니다: ${value} (${len}바이트)`);
  return s.padStart(len - 1, "0") + "\0";
}

function ustarHeader({ name, size, mode, mtime = 0, type = "0" }) {
  const buf = Buffer.alloc(BLOCK, 0);
  // 100바이트를 넘으면 prefix(155)로 나눈다 — ustar 가 지원하는 방식이다.
  // 256자를 넘으면 **조용히 자르지 않는다.** 자르면 파일 이름이 다른 파일과 같아지고,
  // 그 순간 매니페스트가 아무것도 증명하지 못한다.
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", name.length - 100);
    if (cut < 0) throw new Error(`tar 항목 이름이 너무 깁니다(256자 초과): ${name}`);
    prefix = name.slice(0, cut);
    const short = name.slice(cut + 1);
    if (Buffer.byteLength(short) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`tar 항목 이름이 너무 깁니다: ${name}`);
    }
    buf.write(short, 0, 100, "utf8");
  } else {
    buf.write(name, 0, 100, "utf8");
  }
  buf.write(octal(mode & 0o7777, 8), 100, 8, "latin1"); // mode
  buf.write(octal(0, 8), 108, 8, "latin1"); // uid — 항상 0 (재현성)
  buf.write(octal(0, 8), 116, 8, "latin1"); // gid
  buf.write(octal(size, 12), 124, 12, "latin1"); // size
  buf.write(octal(mtime, 12), 136, 12, "latin1"); // mtime — 항상 0 (재현성)
  buf.write("        ", 148, 8, "latin1"); // chksum 자리 — 스페이스로 채운다
  buf.write(type, 156, 1, "latin1");
  buf.write("ustar\0", 257, 6, "latin1");
  buf.write("00", 263, 2, "latin1");
  buf.write("harnesside", 265, 32, "latin1"); // uname — 소유자 이름도 고정
  buf.write("harnesside", 297, 32, "latin1"); // gname
  if (prefix) buf.write(prefix, 345, 155, "utf8");
  // chksum: 헤더 바이트의 합. **chksum 필드 8바이트는 스페이스로 두고 계산**한다.
  buf.write(octal(buf.reduce((a, b) => a + b, 0), 8), 148, 8, "latin1");
  return buf;
}

function pad(size) {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

/**
 * 결정론적 tar.gz — **같은 입력 → 같은 바이트**(R-3.3 인수 조건 1).
 *
 * 고정한 것: 파일 순서(정렬), mtime(0), uid/gid(0), 소유자 이름, gzip 헤더 타임스탬프.
 * gzip 은 `{ level: 9, mtime: 0 }` 로 줘야 헤더에 타임스탬프가 안 들어간다 —
 * 이 한 줄을 빼면 "재현 가능하다" 는 문장이 거짓이 된다.
 */
export function packDeterministicGz(entries) {
  const chunks = [];
  for (const e of entries) {
    const data = e.data;
    chunks.push(ustarHeader({ name: e.name, size: data.length, mode: e.mode }));
    chunks.push(data);
    chunks.push(pad(data.length));
  }
  // tar 는 두 개의 0 블록으로 끝난다. 이게 없으면 일부 리더는 잘린 파일로 본다.
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

// ── 실제 작업 ────────────────────────────────────────────────────────────────

function gitDirty() {
  try {
    const s = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return s === "" ? false : true;
  } catch {
    return null;
  }
}

function readBuildInfoJson() {
  // R-1 이 주입한 값이 **그 빌드**의 정본이다. 여기서 새로 만들지 않는다 —
  // 그러면 매니페스트의 날짜가 파일 mtime 나 실행 시각으로 밀린다.
  try {
    const p = join(root, "dist", "server", "buildInfo.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 트리 해시 — **정렬된** `경로 해시` 목록에서 만든다. 순서만 달라도 같아야 한다. */
export function computeTreeSha(files) {
  const lines = [...files].map((f) => `${f.path} ${f.sha256}`).sort();
  return sha256(lines.join("\n") + "\n");
}

function parseOctal(buf) {
  const s = buf.toString("latin1").replace(/\0.*$/, "").trim();
  return s === "" ? 0 : parseInt(s, 8) || 0;
}

/**
 * gzip → tar → 엔트리 이름. **체크섬까지 검증한다.**
 *
 * 헤더를 직접 쓰면 한 바이트씩 틀려도 `gzipSync` 는 아무 말 없이 tar 를 뱉는다.
 * 읽어봐야 안다. 그리고 이 읽는 규칙이 정본이어야 한다 — 실제로 사용할
 * `extractTarGz` 와 같은 규칙으로 쓴다.
 */
function unpackEntries(tarGz) {
  const tar = gunzipSync(tarGz);
  const out = [];
  let pos = 0;
  while (pos + BLOCK <= tar.length) {
    const h = tar.subarray(pos, pos + BLOCK);
    let zero = true;
    for (let i = 0; i < BLOCK && zero; i++) if (h[i] !== 0) zero = false;
    if (zero) break;
    const magic = h.subarray(257, 262).toString("latin1");
    if (magic !== "ustar") throw new Error(`selfCheck: tar 가 아닙니다 (매직 "${magic}")`);
    const declared = parseOctal(h.subarray(148, 156));
    const copy = Buffer.from(h);
    copy.write("        ", 148, 8, "latin1");
    const actual = copy.reduce((a, b) => a + b, 0);
    if (declared !== actual) throw new Error(`selfCheck: tar 헤더 체크섬이 다릅니다 (선언 ${declared} / 계산 ${actual})`);
    const name = h.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    const prefix = h.subarray(345, 500).toString("utf8").replace(/\0+$/, "");
    const size = parseOctal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    if (type === "0" || type === "5") out.push({ name: prefix ? `${prefix}/${name}` : name, size });
    pos += BLOCK + size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
  }
  return out;
}

/**
 * 배포물을 만든다.
 *
 * ── 매니페스트가 아카이브 **밖**에 있는 이유 (닭과 달걀) ────────────────────
 *
 * 처음엔 `manifest.json` 을 아카이브 **안에** 넣었다. 그러면 **풀릴 수 없다**:
 *   아카이브 해시 → 매니페스트에 넣음 → 매니페스트를 아카이브에 넣음 → 해시 변함 → 다시 → …
 * 두 번 다시 만들어도 선언과 실제가 다르다.
 *
 * 그래서 **매니페스트는 별도 자산**이다. 아카이브에는 `dist/` 파일만 담고, 설치할 때
 * 매니페스트를 설치 루트에 **따로** 쓴다(`manifest.json` 은 트리 해시에서 제외된다 —
 * 자기 해시를 자기 안에 쓸 수는 없다).
 *
 * 그 대가는 분명하다: **매니페스트는 신뢰의 입구**다. 그 신뢰는 HTTPS 와 GitHub 계정에서
 * 나온다 — 해시가 아니다(코드 서명 없음, §0.2). 그래도 나쁘지 않다: **하나의 자산만**
 * 신뢰하면 되고, 그 하나가 나머지 전부를 증명한다.
 */
export function build() {
  const dist = join(root, TREE_TOP);
  if (!existsSync(dist)) {
    throw new Error(
      `${TREE_TOP}/ 가 없습니다 — 먼저 빌드하십시오 (npm run build). 배포물이 비어 있으면 조용한 성공이 되므로 여기서 멈춘다.`
    );
  }
  const bi = readBuildInfoJson();
  const build = {
    version: bi?.version ?? null,
    date: bi?.date ?? null,
    sha: bi?.sha ?? null,
    dirty: bi?.dirty ?? null,
    builtAt: bi?.builtAt ?? null,
  };
  if (!build.date || !build.sha) {
    throw new Error(
      `빌드 신원이 없습니다(${TREE_TOP}/server/buildInfo.json). 날짜와 커밋 없는 배포물은 "이게 어느 것인지" 를 증명하지 못합니다.`
    );
  }

  const all = walk(dist);
  const rels = all.filter((r) => !excluded(r));
  const entries = [];
  const files = [];
  for (const rel of rels) {
    const abs = join(dist, ...rel.split("/"));
    const data = readFileSync(abs);
    const st = statSync(abs);
    const mode = st.mode & 0o777 || 0o644;
    files.push({ path: rel, sha256: sha256(data), bytes: data.length, mode });
    entries.push({ name: `${TREE_TOP}/${rel}`, data, mode });
  }
  // **정렬** — tar 안의 순서가 해시를 만든다.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const asset = packDeterministicGz(entries);
  const manifest = {
    manifestVersion: 1,
    build,
    asset: { name: ASSET_NAME, sha256: sha256(asset), bytes: asset.length },
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    treeSha256: computeTreeSha(files),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const sums = [`${manifest.asset.sha256}  ${ASSET_NAME}`, `${sha256(manifestBytes)}  ${MANIFEST_RELPATH}`].join("\n") + "\n";

  // ── 자기 검사: **풀어서** 대조한다 ────────────────────────────────────────
  // "만들었다" 와 "풀리면서 그대로 나온다" 는 다른 사실이다.
  const problems = selfCheck(asset, manifest);
  if (problems.length) {
    throw new Error(`만든 배포물이 자기 매니페스트와 맞지 않습니다:\n  · ${problems.join("\n  · ")}\n이 상태로 배포하지 않습니다.`);
  }

  return {
    asset,
    manifest: manifestBytes,
    sums: Buffer.from(sums, "utf8"),
    stats: { files: files.length, skipped: all.length - rels.length, bytes: asset.length, build },
  };
}

function selfCheck(asset, manifest) {
  const problems = [];
  const inArchive = new Set(unpackEntries(asset).map((e) => e.name));
  const declared = new Set(manifest.files.map((f) => `${TREE_TOP}/${f.path}`));
  for (const name of inArchive) if (!declared.has(name)) problems.push(`아카이브에 매니페스트에 없는 파일: ${name}`);
  for (const d of declared) if (!inArchive.has(d)) problems.push(`매니페스트에 있는 파일이 아카이브에 없음: ${d}`);
  if (sha256(asset) !== manifest.asset.sha256) problems.push("자산 해시가 매니페스트 선언과 다릅니다");
  return problems;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//
// **직접 실행했을 때만** 아래를 돌린다. 다른 모듈이 이 파일을 `import` 하면
// (R-9 `verify-selfupdate.mjs` 가 규약을 재사용한다) 여기가 실행되어 `release/` 에
// 파일을 쓴다 — **import 한 쪽의 의도 밖의 부수효과**다. 조용히 배포물이
// 덮어써지는 사고로 이어진다.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cli(process.argv.slice(2));
}

async function cli(argv) {
  const has = (n) => argv.includes(n);

if (has("--require-clean")) {
  const d = gitDirty();
  if (d === true) {
    console.error("더티 트리입니다 — 릴리스하지 않습니다 (R-1.4). 커밋하거나 stash 하십시오.");
    process.exit(1);
  }
  if (d === null) {
    console.error("git 저장소를 찾지 못해 트리 상태를 알 수 없습니다 — 릴리스할 수 없습니다.");
    process.exit(1);
  }
}

if (has("--verify-repro")) {
  // 인수 조건 1: **연속 두 번** 만들어 해시가 **같은지** 본다.
  const a = build();
  const b = build();
  const ha = sha256(a.asset);
  const hb = sha256(b.asset);
  if (ha !== hb) {
    console.error(`재현 실패 — 두 번 만든 결과가 다릅니다:\n  1차 ${ha}\n  2차 ${hb}`);
    process.exit(1);
  }
  console.log(`재현 확인 — 두 번 모두 ${ha} (${a.stats.files}개 파일 · ${(a.stats.bytes / 1024).toFixed(1)} KiB)`);
  process.exit(0);
}

if (has("--check")) {
  const out = build();
  console.log(`배포물 유효 — ${out.stats.files}개 파일 · ${(out.stats.bytes / 1024).toFixed(1)} KiB · ${out.stats.build.date}-${out.stats.build.sha}`);
  process.exit(0);
}

const out = build();
const outDir = join(root, "release");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, ASSET_NAME), out.asset);
writeFileSync(join(outDir, MANIFEST_RELPATH), out.manifest);
writeFileSync(join(outDir, "SHA256SUMS"), out.sums);
console.log(
  `배포물 생성 — ${out.stats.files}개 파일 · ${(out.stats.bytes / 1024).toFixed(1)} KiB · ` +
    `제외 ${out.stats.skipped}개 · ${out.stats.build.date}-${out.stats.build.sha}${out.stats.build.dirty ? " (더티)" : ""}`
);
console.log(`  ${out.stats.build.sha}  ${ASSET_NAME}`);
console.log(`  ${sha256(out.manifest).slice(0, 12)}…  ${MANIFEST_RELPATH}`);
console.log("확인: cd release && sha256sum -c SHA256SUMS");}
