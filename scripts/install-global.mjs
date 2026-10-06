#!/usr/bin/env node
/**
 * 전역 설치 **후** 검사 — 조용히 낡은 설치본을 통과시키지 않는다.
 *
 * ── 왜 이 파일이 있나 (계측으로 판단했다) ──────────────────────────────────
 *
 * 전역 설치를 이렇게 하면 **기존 `dist/` 를 그대로 싣는다**:
 *
 *     npm install -g .
 *
 * 왜냐하면 이 저장소의 패키지에는 `prepublishOnly` 가 있고 **이것은 `npm publish`
 * 전용**이라서, 로컬 폴더를 `npm install -g .` 하는 경로에서는 **돌지 않는다.**
 * (계측: 별도 실험 패키지에 세 훅을 심어 `npm install -g .` → **`prepare` 만** 실행됨.
 * `npm pack` → `prepack` + `prepare`.)
 *
 * 그러면 **소스를 고치고 설치하면 옛 코드가 전역에 남는다.** 그리고 그 옛 코드가
 * `harnesside version` 으로 **정상 동작**한다 — 아무도 모른다.
 *
 * `prepare` 훅을 쓰는 방법도 있다. 하지만 그 훅은 **저장소 안의 `npm install`/`npm ci`
 * 에서도** 돌아서, TypeScript 오류가 **설치 실패**로 보인다(타입 오류 메시지가 사라진다).
 * 그래서 **명시적 스크립트 + 이 검사**를 택했다.
 *
 * ── 이 검사가 확인하는 것 ───────────────────────────────────────────────────
 *
 *  1. `bin` 이 심볼릭 링크로 만들어졌는가 (npm 의 기본 동작)
 *  2. 그 링크가 **패키지 안**을 가리키는가 — 밖이면 `installRoot` 이 잘못된다
 *  3. 설치된 `dist` 가 방금 만든 것과 **같은가** (해시로)
 *  4. `import.meta.url` 기준 `installRoot` 가 실제로 `dist/` 인가
 *
 * 하나라도 어긋나면 **실패한다.** 조용히 통과시키지 않는다.
 *
 * 사용법: `npm run install:g` (= `npm run build` 후 이 스크립트 + `npm install -g .`)
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const binName = Object.keys(pkg.bin ?? {})[0];

let failures = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}${extra ? `\n      ${extra}` : ""}`);
  }
  return !!cond;
};

/** 트리 전체의 대표값 — 설치본과 로컬 `dist` 가 같은지 보기 위한 **비교용 지표**. */
function treeDigest(dir) {
  const h = createHash("sha256");
  const files = [];
  const walk = (d, prefix) => {
    for (const n of readdirSync(d).sort()) {
      const abs = join(d, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) files.push([rel, st.size, st.mtimeMs]);
    }
  };
  walk(dir, "");
  // **경로와 크기만** 본다. 전역 설치는 경로를 바꾸므로 해시는 비교용이라 충분하다.
  // (mtime 은 전역 설치에서 재작성되므로 제외한다.)
  for (const [rel, size] of files.sort((a, b) => (a[0] < b[0] ? -1 : 1))) h.update(`${rel} ${size}\n`);
  return { digest: h.digest("hex"), count: files.length };
}

console.log(`전역 설치 검사 — ${pkg.name}@${pkg.version}`);

if (!binName) {
  console.error("package.json 에 bin 이 없습니다 — 설치해도 실행할 수 없습니다.");
  process.exit(1);
}

// ── 0) 로컬 dist 가 있나 ────────────────────────────────────────────────────
const localDist = join(root, "dist");
if (!existsSync(localDist)) {
  console.error("로컬 dist/ 가 없습니다 — 먼저 `npm run build` 하십시오. 이 스크립트는 빌드를 대신하지 않습니다.");
  process.exit(1);
}

// ── 1) 전역 bin 이 어디를 가리키나 ───────────────────────────────────────────
// Windows: npm은 심볼릭 링크가 아니라 `.cmd` shim을 만들며 레이아웃도 다르다
// (prefix/node_modules/<pkg>/dist). readlink -f는 Windows에 없다.
const isWin = process.platform === "win32";
let prefix = "";
// Windows의 npm은 .cmd라 shell 경유로만 실행된다 (ENOENT→EINVAL 실측).
// GitHub run 단계는 셸이 찾아주지만 node 자식은 직접 못 찾는다.
const NPM_SHELL = process.platform === "win32";
const npmExec = (args) => execFileSync("npm", args, { encoding: "utf8", ...(NPM_SHELL ? { shell: true } : {}) }).trim();
try {
  prefix = npmExec(["prefix", "-g"]);
} catch {
  console.error("npm 전역 prefix 를 알 수 없습니다.");
  process.exit(1);
}
let npmRoot = "";
if (isWin) {
  try {
    npmRoot = npmExec(["root", "-g"]);
  } catch {
    npmRoot = join(prefix, "node_modules");
  }
}
const binPath = isWin ? join(prefix, `${binName}.cmd`) : join(prefix, "bin", binName);
const binAlt = isWin ? join(prefix, binName) : null;
const binExists = existsSync(binPath) || (binAlt && existsSync(binAlt));
ok(binExists, `전역 실행 파일이 생겼다: ${binPath}`);

let real = "";
if (!isWin) {
  try {
    real = execFileSync("readlink", ["-f", binPath], { encoding: "utf8" }).trim();
  } catch {
    /* 심볼릭 링크가 아닐 수 있다 — 그건 확인한다 */
  }
} else {
  // shim 파일 안의 패키지 경로를 읽어 실제 설치 위치를 찾는다.
  try {
    const shim = readFileSync(binPath, "utf8");
    const m = /node_modules[\\/][^"'\r\n]*?harnesside[\\/]dist[\\/]server[\\/]index\.js/i.exec(shim)
      ?? /([A-Za-z]:\\[^"'\r\n]*?node_modules\\[^"'\r\n]*)/.exec(shim);
    if (m) real = m[1].replace(/\\server\\index\.js$/i, "").replace(/[\\/]dist$/i, "") || "";
  } catch { /* shim 파싱 실패 — 아래 npm root로 대체 */ }
}
const isLink = isWin ? true : real !== "" && resolve(real) !== resolve(binPath);
if (!isWin) {
  ok(isLink, `bin 이 **심볼릭 링크**다 (npm 의 기본 동작) — ${real || binPath}`);
} else {
  console.log(`  ✓ Windows shim 확인 (심볼릭 링크 검사는 생략): ${binPath}`);
}

// ── 2) 링크가 패키지 안을 가리키나 — 이게 installRoot 의 정본 ────────────────
const installedDist = isWin
  ? resolve(npmRoot, pkg.name, "dist")
  : resolve(real || binPath, "..", "..");
const expectedInside = isWin
  ? resolve(npmRoot, pkg.name, "dist")
  : resolve(prefix, "lib", "node_modules", pkg.name, "dist");
ok(
  isWin
    ? existsSync(installedDist)
    : installedDist === expectedInside || installedDist.startsWith(resolve(prefix, "lib", "node_modules") + sep),
  `링크가 패키지 **안**의 dist 를 가리킨다: ${installedDist}`,
  `기대: ${expectedInside}`,
);

// ── 3) 전역 installRoot 는 npm 전역 prefix 가 아니어야 한다 ──────────────────
// 이게 틀리면 셀프업데이트가 **전역 폴더 전체**를 교체하려 한다(실측 118,347 파일).
ok(
  installedDist !== resolve(prefix),
  `installRoot 가 npm 전역 prefix 전체가 **아니다**: ${installedDist} ≠ ${resolve(prefix)}`,
);

// ── 4) 설치된 dist 가 방금 만든 것과 같은가 ─────────────────────────────────
const a = treeDigest(localDist);
const b = treeDigest(installedDist);
ok(a.count === b.count, `파일 수가 같다 — 로컬 ${a.count} / 설치 ${b.count}`);
ok(a.digest === b.digest, `설치된 dist 가 **방금 만든 것**과 같다`, `로컬 ${a.digest.slice(0, 12)}… / 설치 ${b.digest.slice(0, 12)}…`);
ok(b.count > 0, "설치된 dist 에 파일이 있다");

// ── 5) 빌드 신원이 실렸나 — 없으면 R-1 이 조용히 실패한다 ───────────────────
const biPath = join(installedDist, "server", "buildInfo.json");
if (ok(existsSync(biPath), "설치된 dist 에 빌드 신원이 있다 (R-1)")) {
  try {
    const bi = JSON.parse(readFileSync(biPath, "utf8"));
    ok(/^\d{8}$/.test(bi.date ?? ""), `빌드 날짜가 있다: ${bi.date}`);
    ok(typeof bi.sha === "string" && bi.sha.length >= 7, `커밋 해시가 있다: ${bi.sha}`);
    console.log(`    → 전역에서 실행되는 코드: ${bi.version} · ${bi.date}-${bi.sha}${bi.dirty ? " (더티 — 릴리스 금지)" : ""}`);
  } catch (e) {
    ok(false, "빌드 신원 파일을 읽지 못했다", String(e));
  }
} else {
  console.error("      이게 없으면 설치본이 '개발 실행' 으로 떨어지고 날짜·해시를 말하지 못한다.");
}

// ── 6) 실제 실행이 되나 ─────────────────────────────────────────────────────
try {
  // Windows shim(.cmd)은 execFile로 직접 실행이 안 될 수 있어 node로 dist를 실행한다.
  const out = isWin
    ? execFileSync("node", [join(installedDist, "server", "index.js"), "--version"], { encoding: "utf8", timeout: 30_000 }).trim()
    : execFileSync(binPath, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
  ok(out === pkg.version, `\`${binName} --version\` 이 ${pkg.version} 를 출력한다`, `받은 값: ${out}`);
} catch (e) {
  ok(false, `${binName} --version 이 실패했다`, String(e.stderr ?? e));
}

console.log("");
if (failures > 0) {
  console.error(`실패 — ${failures}건. 전역 설치를 신뢰하지 마십시오.`);
  process.exit(1);
}
console.log(`통과 — ${binName} (${binPath})`);
console.log(`설치된 dist: ${installedDist}`);
console.log(`프로젝트 경로와 무관하게 이 디렉터리가 셀프업데이트의 대상이다.`);