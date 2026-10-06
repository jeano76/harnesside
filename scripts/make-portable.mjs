#!/usr/bin/env node
/**
 * 포터블 압축 만들기 — **유일한 배포물**. 설치도 셀프업데이트도 이 zip 을 쓴다.
 *
 *   node scripts/make-portable.mjs                 # release/harnesside-portable-<plat>-<arch>.zip
 *   node scripts/make-portable.mjs --check         # 만들지 않고 포함 목록만
 *   node scripts/make-portable.mjs --require-clean # 더티면 실패
 *   node scripts/make-portable.mjs --verify-repro  # 두 번 만들어 바이트가 같은지 (재현성)
 *
 * 산출물 세 개:
 *   <zip>                 배포물. 안에 `harnesside/portable-manifest.json`(파일 목록·해시)
 *   <zip>.manifest.json   위 매니페스트 + **zip 자신의 해시**(`asset`). 셀프업데이트가
 *                         이것으로 zip 을 대조한다 — zip 안의 매니페스트는 자기 zip 의
 *                         해시를 담을 수 없다(닭과 달걀).
 *   <zip>.SHA256SUMS      `sha256sum -c` 용 (zip + 외부 매니페스트)
 *
 * ── 왜 zip에 node_modules가 통째로 들어가나 ──────────────────────────────
 * 받는 쪽에는 npm이 없을 수 있다. `npm install`을 다시 돌릴 수 없으므로,
 * 실행에 필요한 의존성(프로덕션)을 **이쪽에서** 넣어 보낸다. 네이티브 모듈
 * (node-pty)은 플랫폼 종속이라 압축은 플랫폼별로 만든다 — 파일명에 plat-arch를
 * 박는 이유다. Linux에서 만든 zip을 Windows에 풀면 node-pty가 안 맞는다.
 *
 * ── zip도 직접 쓴다 (make-release.mjs와 같은 이유) ───────────────────────
 * 재현성(고정 시간·정렬·버전 필드 고정) + 외부 zip 바이너리 불필요.
 * 의존성은 node 내장(crypto/zlib/fs)만.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const TOP = "harnesside";
/** `process.platform`-`process.arch` 그대로 — `updateService.portableAssetName` 과 같은 규칙. */
export function portableZipName(platform = process.platform, arch = process.arch) {
  return `harnesside-portable-${platform}-${arch}.zip`;
}
const zipName = portableZipName();

/** zip에 넣지 않는 것. */
const EXCLUDE = [
  /\.map$/,
  /\.harnesside-tmp$/,
  /(^|\/)node_modules\/\.bin(\/|$)/, // 심볼릭 링크 모음 — 실행에 불필요
  /(^|\/)\.git(\/|$)/,
];

function excluded(rel) {
  return EXCLUDE.some((re) => re.test(rel));
}

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const abs = join(dir, name);
    const rel = relative(base, abs).split(sep).join("/");
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // 링크는 따라가지도 담지도 않는다
    if (st.isDirectory()) walk(abs, base, out);
    else if (st.isFile()) out.push({ rel, abs, mode: st.mode & 0o777 });
  }
  return out;
}

/** Windows에서는 npm이 npm.cmd다. shell 없이 execFile로 "npm"을 부르면 ENOENT,
 *  "npm.cmd"로 부르면 EINVAL — .cmd는 cmd.exe 안에서만 실행된다
 *  (릴리스 windows job 실측). 그래서 win32에서만 shell 경유. */
export const NPM_BIN = "npm";
export const NPM_SHELL = process.platform === "win32";

/** 프로덕션 의존 디렉터리 목록 — `npm ls --omit=dev --all`이 정본.
 *
 *  `--all`이 없으면 최상위 13개만 나온다. strip-ansi가 import하는 ansi-regex
 *  같은 전이 의존이 빠지면 받는 쪽에서 ERR_MODULE_NOT_FOUND로 죽는다 (실측).
 *  그래서 전체 트리를 묻는다. */
function productionRoots() {
  let out;
  try {
    out = execFileSync(NPM_BIN, ["ls", "--omit=dev", "--all", "--parseable"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      ...(NPM_SHELL ? { shell: true } : {}),
    });
  } catch (e) {
    throw new Error(`프로덕션 의존 목록을 못 구했습니다 (만드는 쪽에 npm 필요): ${e.stdout ?? e.message}`);
  }
  const nmRoot = join(root, "node_modules");
  const dirs = new Set();
  for (const line of out.split("\n")) {
    const p = line.trim();
    if (!p || resolve(p) === root) continue;
    const rel = relative(root, resolve(p)).split(sep).join("/");
    if (rel.startsWith("node_modules/")) dirs.add(rel);
  }
  // npm ls가 빈 줄만 줄 때(=의존 없음)는 비어 있게 둔다 — 조용히 전체를 넣지 않는다.
  return { nmRoot, dirs };
}

function collectFiles() {
  const files = [];
  // 1) dist (빌드 산출물 — .map 제외)
  const dist = join(root, "dist");
  if (!existsSync(dist)) throw new Error("dist/가 없습니다 — 먼저 `npm run build` 하십시오.");
  for (const f of walk(dist, root)) {
    if (!excluded(f.rel)) files.push(f);
  }
  // 2) 메타
  for (const n of ["package.json", "LICENSE", "README.md"]) {
    const abs = join(root, n);
    if (existsSync(abs)) files.push({ rel: n, abs, mode: 0o644 });
  }
  // 3) 설치 진입점 (이 저장소의 정본을 그대로 담는다)
  const launchers = [
    ["scripts/install-portable.mjs", "install-portable.mjs", 0o644],
    ["scripts/Install-Portable.ps1", "Install-Portable.ps1", 0o644],
    ["scripts/harnesside.cmd", "harnesside.cmd", 0o644],
    ["scripts/harnesside.sh", "harnesside.sh", 0o755],
    ["scripts/install.sh", "install.sh", 0o755],
  ];
  for (const [src, dest, mode] of launchers) {
    const abs = join(root, src);
    if (!existsSync(abs)) throw new Error(`설치 파일이 없습니다: ${src}`);
    files.push({ rel: dest, abs, mode });
  }
  // 4) 프로덕션 node_modules
  const { dirs } = productionRoots();
  if (dirs.size === 0) throw new Error("프로덕션 의존이 0개 — `npm ls --omit=dev` 결과를 확인하세요.");
  const seen = new Set(files.map((f) => f.rel));
  for (const d of [...dirs].sort()) {
    for (const f of walk(join(root, ...d.split("/")), root)) {
      if (excluded(f.rel) || seen.has(f.rel)) continue;
      seen.add(f.rel);
      files.push(f);
    }
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// ── 최소 zip 쓰기 (deflate, UTF-8, 고정 시간) ─────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS 시간 고정 (재현성): 2020-01-01 00:00:00
const DOS_TIME = ((0 << 11) | (0 << 5) | 0) | ((1 << 21) | (1 << 16));
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

export function packZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const comp = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const useComp = comp.length < e.data.length;
    const method = useComp ? 8 : 0;
    const body = useComp ? comp : e.data;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(DOS_TIME & 0xffff, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    chunks.push(head, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(DOS_TIME & 0xffff, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    for (let i = 30; i < 46; i++) c[i] = 0;
    c.writeUInt32LE((e.mode & 0o777) << 16, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + body.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

/** central directory만 읽어 이름·crc·크기를 대조한다. */
function verifyZip(buf, expect) {
  const problems = [];
  if (buf.readUInt32LE(buf.length - 22) !== 0x06054b50) {
    return ["끝 레코드(EOCD)가 없습니다"];
  }
  const count = buf.readUInt16LE(buf.length - 12);
  if (count !== expect.length) problems.push(`파일 수 불일치: zip ${count} / 기대 ${expect.length}`);
  let pos = buf.readUInt32LE(buf.length - 6);
  const seen = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      problems.push(`${i}번째 central 헤더 파손`);
      break;
    }
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const rawSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const off = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    seen.set(name, { crc, compSize, rawSize, off });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  for (const e of expect) {
    const g = seen.get(e.name);
    if (!g) {
      problems.push(`zip에 없음: ${e.name}`);
      continue;
    }
    if (g.crc !== e.crc) problems.push(`crc 불일치: ${e.name}`);
    if (g.rawSize !== e.data.length) problems.push(`크기 불일치: ${e.name}`);
  }
  return problems;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 경로순 `path sha` 줄로 만든 트리 해시 — `src/server/update/manifest.ts` 의 `computeTreeSha` 와 같은 규칙. */
export function treeSha(files) {
  return sha256(files.map((f) => `${f.path} ${f.sha256}`).sort().join("\n") + "\n");
}

/** 빌드 신원 — `gen-build-info.mjs` 가 구운 값. 없으면 null 로 둔다(지어내지 않는다). */
function readBuild() {
  try {
    const bi = JSON.parse(readFileSync(join(root, "dist", "server", "buildInfo.json"), "utf8"));
    return { version: pkg.version, date: bi.date ?? null, sha: bi.sha ?? null, dirty: typeof bi.dirty === "boolean" ? bi.dirty : null, builtAt: bi.builtAt ?? null };
  } catch {
    return { version: pkg.version, date: null, sha: null, dirty: null, builtAt: null };
  }
}

/**
 * 파일 목록 → 배포물 세 개. `verify-selfupdate.mjs` 도 이 함수로 zip 을 만든다 —
 * 패킹 규칙이 두 벌이면 한쪽이 조용히 달라진다.
 *
 * @param files  [{ rel, data: Buffer, mode }]  — `rel` 은 설치 루트 기준 `/` 경로
 * @param meta   { name, version, platform, arch, node, build }
 */
export function packPortable(files, meta) {
  const entries = [];
  const manifestFiles = [];
  for (const f of files) {
    entries.push({ name: `${TOP}/${f.rel}`, data: f.data, mode: f.mode || 0o644, crc: crc32(f.data) });
    manifestFiles.push({ path: f.rel, sha256: sha256(f.data), bytes: f.data.length, mode: f.mode || 0o644 });
  }
  manifestFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    manifestVersion: 1,
    kind: "portable",
    version: meta.version,
    platform: meta.platform,
    arch: meta.arch,
    node: meta.node,
    build: meta.build,
    files: manifestFiles,
    treeSha256: treeSha(manifestFiles),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  entries.push({ name: `${TOP}/portable-manifest.json`, data: manifestBytes, mode: 0o644, crc: crc32(manifestBytes) });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const asset = packZip(entries);
  const problems = verifyZip(asset, entries);
  if (problems.length) {
    throw new Error(`만든 zip이 자기 목록과 맞지 않습니다:\n  · ${problems.join("\n  · ")}`);
  }
  const external = { ...manifest, asset: { name: meta.name, sha256: sha256(asset), bytes: asset.length } };
  const externalBytes = Buffer.from(JSON.stringify(external, null, 2) + "\n", "utf8");
  const sums = [`${sha256(asset)}  ${meta.name}`, `${sha256(externalBytes)}  ${meta.name}.manifest.json`].join("\n") + "\n";
  return { asset, manifest: manifestBytes, externalManifest: externalBytes, sums: Buffer.from(sums, "utf8"), stats: { files: entries.length, bytes: asset.length } };
}

export function build() {
  const files = collectFiles().map((f) => ({ rel: f.rel, data: readFileSync(f.abs), mode: f.mode || 0o644 }));
  return packPortable(files, {
    name: zipName,
    version: pkg.version,
    platform: process.platform,
    arch: process.arch,
    node: pkg.engines?.node ?? ">=22",
    build: readBuild(),
  });
}

function gitDirty() {
  try {
    const s = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return s !== "";
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cli(process.argv.slice(2));
}

async function cli(argv) {
  const has = (n) => argv.includes(n);
  if (has("--require-clean")) {
    const d = gitDirty();
    if (d === true) {
      console.error("더티 트리입니다 — 포터블을 만들지 않습니다. 커밋하거나 stash 하십시오.");
      process.exit(1);
    }
    if (d === null) {
      console.error("git 저장소를 찾지 못해 트리 상태를 알 수 없습니다.");
      process.exit(1);
    }
  }
  if (has("--verify-repro")) {
    // 재현성: 같은 트리에서 두 번 만들어 **바이트가 같아야** 한다. 다르면 "이 해시가
    // 이 커밋에 대응한다" 는 말이 거짓이 된다.
    const a = build();
    const b = build();
    const same = sha256(a.asset) === sha256(b.asset) && sha256(a.externalManifest) === sha256(b.externalManifest);
    console.log(`${same ? "재현 가능" : "재현 불가"} — ${zipName} ${sha256(a.asset).slice(0, 12)}… / ${sha256(b.asset).slice(0, 12)}…`);
    process.exit(same ? 0 : 1);
  }
  if (has("--check")) {
    const files = collectFiles();
    const bytes = files.reduce((a, f) => a + statSync(f.abs).size, 0);
    console.log(`포터블 유효 — ${files.length}개 파일 · ${(bytes / 1024 / 1024).toFixed(1)} MiB(압축 전) · ${zipName}`);
    process.exit(0);
  }
  const out = build();
  const outDir = join(root, "release");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, zipName), out.asset);
  writeFileSync(join(outDir, `${zipName}.manifest.json`), out.externalManifest);
  writeFileSync(join(outDir, `${zipName}.SHA256SUMS`), out.sums);
  console.log(`포터블 생성 — ${out.stats.files}개 파일 · ${(out.stats.bytes / 1024 / 1024).toFixed(1)} MiB · ${zipName}`);
  console.log(`  확인: certutil -hashfile ${zipName} SHA256  (Windows) / sha256sum -c ${zipName}.SHA256SUMS`);
}
