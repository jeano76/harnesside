#!/usr/bin/env node
/**
 * 포터블 설치 (npm 불필요) — 압축을 푼 자리에서 실행한다.
 *
 * 쓰는 법 (npm이 안 되는 머신):
 *   1. harnesside-portable-win-x64.zip 을 받아 압축 풀기 (탐색기 우클릭 → 모두 추출)
 *   2. Windows: Install-Portable.ps1 우클릭 → "PowerShell에서 실행"
 *      (또는 아래 명령)
 *   3. node install-portable.mjs
 *
 * 하는 일 (npm을 전혀 부르지 않는다):
 *   1. node >= 22 확인 (없으면 nodejs.org 안내 후 중단)
 *   2. dist/server/index.js 존재 확인 + portable-manifest.json 대조 (있으면)
 *   3. `node dist/server/index.js setup` 실행 — 모델·llama.cpp 서버·튜닝 확보
 *      (네트워크는 필요하다. npm 레지스트리는 쓰지 않는다)
 *   4. 바탕화면 바로가기 생성 (setup이 이미 하지만, 직접 해도 됨)
 *
 * 의존성 없음: node 내장(fs/path/url/child_process/os/crypto)만 쓴다.
 * dist/ 코드를 import하지 않는다 — 의존 모듈이 없어도 이 파일은 돌아야 한다.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const val = (n) => args.find((a) => a.startsWith(n + "="))?.slice(n.length + 1);
const installDir = val("--dir") ? resolve(val("--dir")) : here;

let failures = 0;
const ok = (cond, msg, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}${cond || !extra ? "" : `\n      ${extra}`}`);
  if (!cond) failures++;
};

/** node -v "v22.3.0" → [22,3] */
function nodeVer() {
  const m = /^v?(\d+)\.(\d+)/.exec(process.version);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

console.log(`포터블 설치 — ${installDir}`);

// 1) node 확인 (npm은 보지 않는다 — 이 경로의 존재 이유)
const v = nodeVer();
ok(!!v && v[0] >= 22, `Node 22 이상 (현재 ${process.version})`, "https://nodejs.org 에서 LTS를 받아 설치하세요 (npm은 필요 없음 — node만 있으면 됨)");

// 2) 트리 확인
const entry = join(installDir, "dist", "server", "index.js");
ok(existsSync(entry), `진입점이 있다: dist/server/index.js`);
const pkgPath = join(installDir, "package.json");
let version = "?";
try {
  version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "?";
  ok(true, `패키지 버전: ${version}`);
} catch {
  ok(false, "package.json을 읽지 못했다", pkgPath);
}

// 2b) 매니페스트 대조 (있으면 — 없으면 경고만, 설치를 막지 않음)
const manPath = join(installDir, "portable-manifest.json");
if (existsSync(manPath)) {
  try {
    const man = JSON.parse(readFileSync(manPath, "utf8"));
    let checked = 0;
    let bad = 0;
    for (const f of man.files ?? []) {
      const abs = join(installDir, ...String(f.path).split("/"));
      let data;
      try {
        const st = statSync(abs);
        if (!st.isFile()) throw new Error("not a file");
        data = readFileSync(abs);
      } catch {
        bad++;
        continue;
      }
      checked++;
      if (createHash("sha256").update(data).digest("hex") !== f.sha256) bad++;
    }
    ok(bad === 0, `매니페스트 대조: ${checked}개 파일 확인`, bad > 0 ? `${bad}개 불일치/누락 — 압축이 깨졌을 수 있음` : "");
  } catch (e) {
    ok(false, "매니페스트를 읽지 못했다", String(e));
  }
} else {
  console.log("  · portable-manifest.json 없음 — 대조 생략 ( Zip을 직접 묶은 경우 )");
}

// 2c) 의존 모듈 확인 (npm 없이 풀었으므로 node_modules가 통째로 있어야 함)
const nm = join(installDir, "node_modules");
const nmCount = (() => {
  try {
    return readdirSync(nm).length;
  } catch {
    return 0;
  }
})();
ok(nmCount > 0, `의존 모듈이 들어 있다: node_modules (${nmCount}개 최상위)`, "node_modules가 비어 있으면 npm 없이 실행 불가 — 플랫폼에 맞는 포터블 zip을 받으세요");

// 여기서 막힌다 — 뒤는 네트워크·디스크 작업이라 의미가 없다.
if (failures > 0 || has("--check-only")) {
  if (failures > 0) {
    console.error(`\n실패 — ${failures}건. 먼저 위 항목을 해결하세요.`);
    process.exit(1);
  }
  console.log("\n점검만 통과 (--check-only).");
  process.exit(0);
}

// 3) 모델·서버·튜닝 확보 — dist 안의 정본 코드로 (npm 불필요, 네트워크 필요)
if (!has("--no-setup")) {
  console.log("\n모델·서버·튜닝 확보 중 (수 분~수십 분 걸릴 수 있음)…");
  const setupArgs = ["dist/server/index.js", "setup"];
  if (has("--no-shortcut")) setupArgs.push("--no-shortcut");
  if (has("--offline")) setupArgs.push("--offline");
  const modelsDir = val("--models-dir");
  if (modelsDir) setupArgs.push(`--models-dir=${modelsDir}`);
  const r = spawnSync(process.execPath, setupArgs, { cwd: installDir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nsetup 실패 (종료 코드 ${r.status}). 네트워크·디스크를 확인하고 다시 실행하세요 — 멱등이라 이어서 됩니다.`);
    process.exit(r.status ?? 1);
  }
} else {
  console.log("\n--no-setup: 모델·서버 확보를 건너뜀 (나중에 `harnesside setup` 실행)");
}

// 4) 다음 행동
console.log("");
console.log("완료.");
console.log(`  실행:  ${(process.platform === "win32" ? "harnesside.cmd" : "./harnesside.sh")}  (이 디렉터리에서)`);
console.log("  또는:  node dist/server/index.js");
if (process.platform === "win32") {
  console.log("  바탕화면의 HarnessIDE 아이콘으로 더블클릭 실행도 가능");
}
try {
  const desktop = process.platform === "win32"
    ? execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" }).trim()
    : join(process.env.HOME ?? "~", "Desktop");
  console.log(`  바로가기 위치: ${desktop}`);
} catch { /* 부가 정보라 실패해도 됨 */ }
