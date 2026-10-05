#!/usr/bin/env node
/**
 * 빌드 신원 주입 (R-1) — `dist/server/buildInfo.json` 을 **굽는다**.
 *
 * 왜 코드가 아니라 데이터 파일인가: **설치된 배포물에는 git 저장소가 없다.**
 * 런타임에 `git rev-parse` 를 하면 그 순간 `sha` 는 "확인 못 함" 이 되고,
 * "이게 어느 커밋에서 나왔는지" 라는 질문이 **답을 잃는다.** 파일에 구워 두면
 * 질문이 계속 답을 갖는다.
 *
 * 어디에 쓰나: `buildInfo.ts` 가 `import.meta.url` 옆을 본다.
 *   빌드 → `dist/server/buildInfo.json`
 *   개발 → `src/server/buildInfo.json` (없음 → `stamped:false` → "개발 실행")
 * `src/` 는 **건드리지 않는다.** 건드리면 트리가 더티해져 `dirty:true` 가 되고,
 * 그 값이 **자기가 만든 것**이 된다(측정 불가 — R-1 인수 조건 1).
 *
 * 사용법:
 *   node scripts/gen-build-info.mjs                 # 빌드 시 자동 호출
 *   node scripts/gen-build-info.mjs --out 경로      # 다른 곳 (테스트)
 *   node scripts/gen-build-info.mjs --check         # 파일을 만들지 않고 유효성만
 *   node scripts/gen-build-info.mjs --require-clean # 더티면 실패 (릴리스 워크플로)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DEFAULT = join(root, "dist", "server", "buildInfo.json");

/** git 을 물어본다. 실패하면 **throw 하지 않고 null** — git 이 없는 빌드가 정상이다(소스 배포). */
function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * 커밋 해시. **dirty 트리에서도 해시 자체는 여전히 커밋의 해시다.**
 * 다만 그 커밋에서 **소스가 더러웠다** 고 말해야 하고 — 그래서 `dirty` 가 별도 필드다.
 *
 * 이 분리가 없으면 "해시가 08c4467 이다" 라는 문장이 거짓말이 된다.
 */
function readGit() {
  const sha = git("rev-parse", "--short=7", "HEAD");
  if (!sha) return { sha: null, dirty: null, inRepo: false };
  const status = git("status", "--porcelain");
  // 추적 **되지 않은** 파일도 dirty 다 — 새 소스 파일 하나가 배포물을 바꾼다.
  // `.gitignore` 대상(`dist/`·`.harnesside/state/`·`*.log`·`release/`)은 porcelain 에
  // 뜨지 않으므로, 빌드가 만드는 산출물은 이 판정에 영향 주지 않는다.
  const lines = status === null ? null : status.split("\n").filter((l) => l.length > 0);
  return { sha, dirty: lines === null ? null : lines.length > 0, inRepo: true };
}

/** SemVer 정본 — `package.json` 이 정본이다(§0.1). 여기서 다시 만들지 않는다. */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version)) return pkg.version;
    return null;
  } catch {
    return null;
  }
}

/**
 * UTC `YYYYMMDD`.
 *
 * **UTC 다.** 로컬 타임존으로 만들면 같은 커밋을 태국/한국 시간대 머신과 UTC 머신이
 * 서로 다른 날짜로 찍고, "이 빌드가 저 빌드보다 뒤냐" 가 시계 설정에 달린다.
 * 날짜의 역할은 사람이 읽는 것이고, **비교는 SemVer 가 한다.**
 */
function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function collect(now = new Date(), env = process.env) {
  const g = readGit();
  // CI 는 커밋이 이미 체크아웃되어 있으므로 env 로 **재확인**한다.
  // `git` 이 없는 러너에서도 값은 살아야 한다(없으면 0건이 아니라 "모름"이 된다).
  const sha = g.sha ?? (typeof env.GITHUB_SHA === "string" ? env.GITHUB_SHA.slice(0, 7) : null);
  return {
    version: readPackageVersion(),
    date: utcDate(now),
    sha,
    dirty: g.dirty,
    builtAt: now.getTime(),
    // provenance: 이 값을 어디서 얻었는지. 나중에 "왜 이 값이냐"에 답해야 한다.
    source: g.inRepo ? "git" : typeof env.GITHUB_SHA === "string" ? "env" : "none",
  };
}

/** 자기 출력을 검증한다 — **써놓고 안 읽어보면 아무도 모른다**(R-1.3 검증). */
export function validate(bi) {
  const errs = [];
  if (!bi.version) errs.push("version 이 없다 — package.json 을 못 읽었거나 SemVer 가 아니다");
  if (!/^\d{8}$/.test(bi.date ?? "")) errs.push(`date 형식이 아니다: ${bi.date}`);
  if (bi.sha !== null && !/^[0-9a-f]{7,40}$/.test(bi.sha)) errs.push(`sha 형식이 아니다: ${bi.sha}`);
  if (typeof bi.dirty !== "boolean") errs.push(`dirty 가 boolean 이 아니다: ${bi.dirty} — "모름" 은 null 이지 false 가 아니다`);
  if (!Number.isFinite(bi.builtAt)) errs.push(`builtAt 이 숫자가 아니다: ${bi.builtAt}`);
  return errs;
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const bi = collect();
const errs = validate(bi);

if (errs.length) {
  console.error("빌드 신원을 만들지 못했습니다:");
  for (const e of errs) console.error(`  · ${e}`);
  process.exit(1);
}

const label = `${bi.version} · ${bi.date}-${bi.sha ?? "해시 모름"}${bi.dirty ? " (더티)" : ""}`;

// ── 릴리스 가드 (R-1.4): 사람이 이 규칙을 지키게 하지 말고 파이프라인이 막는다 ──
if (flag("--require-clean") && bi.dirty === true) {
  console.error("더티 트리입니다 — 릴리스 태그를 붙이지 않습니다. 커밋하거나 stash 하십시오.");
  process.exit(1);
}
if (flag("--require-clean") && bi.dirty === null) {
  // **모르는 것을 깨끗함으로 통과시키지 않는다.** 여기서 0건이 아니라 실패다.
  console.error("git 저장소를 찾지 못해 트리 상태를 알 수 없습니다 — 릴리스할 수 없습니다.");
  process.exit(1);
}

if (flag("--check")) {
  console.log(`빌드 신원 유효 — ${label} (출처: ${bi.source})`);
  process.exit(0);
}

const out = val("--out") ? resolve(root, val("--out")) : OUT_DEFAULT;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bi, null, 2) + "\n", "utf8");

// ── 쓴 다음 **다시 읽는다.** ────────────────────────────────────────────────
// 방금 쓴 파일이 우리가 아는 형식인지 확인한다. 이 확인이 없으면 깨진 주입 파일이
// 배포되어 "개발 실행" 으로 보인다 — 사용자는 그게 뭔지 모른다.
const back = JSON.parse(readFileSync(out, "utf8"));
if (validate(back).length) {
  console.error("쓴 파일을 다시 읽는데 실패했습니다 — 값을 고치지 않습니다.");
  process.exit(1);
}
if (!existsSync(out)) {
  console.error(`파일을 만들지 못했습니다: ${out}`);
  process.exit(1);
}
console.log(`빌드 신원 주입 — ${label} → ${out.replace(root + "/", "")}`);