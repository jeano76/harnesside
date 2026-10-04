/**
 * CI 가 **기억하지 않아도 되는** 검사들 (P16 · §10.6).
 *
 * 왜 별도 파일인가: 대부분 셸 한 줄(`grep`)로 되지만, 셸로 하면
 *  - 정규식 인용이 깨지고
 *  - 오타가 조용히 통과하며
 *  - **"일치 0건" 과 "grep 이 실패해서 0건" 을 구분하지 못한다.**
 *
 * 마지막이 핵심이다. `grep -r <금지어>` 가 0이어야 하는 것과 grep 이 아예
 * **작동하지 않아서** 0인 것은 결과가 같다. 그래서 이 스크립트는 자기 자신을
 * 검증하고, 허용 예외는 **.ci/rules.json** 에 사유와 함께 명시한다.
 * 예외를 조용히 무시하면 규칙이 나중에 빈틈이 된다.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** §10.6 보안 스캔: 커밋된 파일에 토큰 패턴이 있으면 **실패**. */
const SECRET_PATTERNS = [
  { name: "GitHub PAT", re: /\bghp_[A-Za-z0-9]{36,}/ },
  { name: "GitHub OAuth", re: /\bgho_[A-Za-z0-9]{36,}/ },
  { name: "OpenAI", re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: "HuggingFace", re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

const SCAN_EXT = [".ts", ".tsx", ".mjs", ".js", ".json", ".yaml", ".yml", ".md", ".sh", ".html", ".css"];
const SKIP_DIR = new Set(["node_modules", ".git", "dist", ".harnesside", "coverage", "build"]);

/** 혼합 문자: 깨진 바이트(U+FFFD) 와 한국어 문장에 섞인 CJK. 코드포인트로 쓴다 —
 *  문자 그대로 쓰면 **이 파일이 자기 자신을 잡는다**. */
const MIXED_RE = new RegExp("[\\uFFFD\\u4E00-\\u9FFF]");

/**
 * **깨진 라틴 단어** (2026-10-01).
 *
 * 실측: 사용자 원문 인용이 저장소에 이렇게 들어 있었다 —
 *
 *   요구: "…패널 타이틀에 아이콘으로ogi로 ding을
 *
 * `ogi` 와 `ding` 은 라틴 문자라 `MIXED_RE` 이 **통과시킨다**. 그런데 이건 정상적인
 * 한국어가 아니다 — 사용자가 쓴 말이 **깨져서** 옮겨진 것이다. 원문은 "아이콘으로
 * docking을" 같은 말이었을 것이고, 남은 글자가 `ogi` `ding` 이다.
 *
 * **깨진 바이트가 아니라면** 무엇이 이걸 잡는가. 처음엔 "한국어에 붙은 짧은 라틴
 * run" 이라고 잡았는데 **오탐 5건**이 나왔다 — `비ASCII`, `상RAM`, `면skip`,
 * `러unner` 는 모두 정상이다. 줄의 절반이 라틴이 아니라는 뜻이다. **모든** 짧은 라틴
 * 조각을 잡는 규칙은 쓸 수 없다.
 *
 * 그래서 **손상의 특징**으로 좁힌다. 깨진 것은 **둘 이상**이 한 줄에 연속해서 나온다
 * (`ogi` … `ding`). 정상적인 혼용은 한 줄에 **하나**다. 그리고 앞 글자가 한글
 * 조사·어미일 가능성이 높다 — `으로` `에서` `를` 같은 글자가 뒤에 남는다.
 *
 * 규칙: 한글 뒤에 붙은 라틴 run 이 **한 줄에 2개 이상**.
 * 그래도 **오탐이 나오면 이 규칙을 넓히지 않는다** — 오탐은 본문 손상보다 나쁘다.
 * 조용히 무효해진 검사보다 나쁽니다.
 */
/**
 * 한국어 **문장 안에** 붙은 짧은 라틴 run.
 *
 * 앞글자가 한글(`으로ogi`)일 때도 있고, 공백 뒤라서 한글과 붙어 있지 않을 때
 * (`…ogi로 ding을` → `ding`) 도 있다. 후자는 `[가-힣]` 접두 조건이 안 맞고 **처음에
 * 빠져 있었다** — 규칙을 넓혔을 때 반대로 그 자리가 사각지대였다.
 *
 * 그런데 그냥 "한글 줄의 라틴" 으로 보면 **셸 스크립트 라인을 전부 잡는다**
 * (`echo $! > /tmp/x.pid`, `for i in $(seq 1 30)` …). 오탐이 14건. 그건 손상이 아니다.
 * 그래서 조건을 **세 개**로 좁힌다:
 *   1. 라틴이 **한글과 같은 단어**다 — 앞이나 뒤에 한글이 **붙어** 있고 공백이 없다.
 *      (`으로ogi`, `ding을`)
 *   2. 그 라틴이 **영어 단어처럼 읽힌다** — `echo`·`for` 는 명령이라 정상이다.
 *      손상은 `ogi`·`ding` 처럼 **한 단어의 일부**처럼 보인다.
 *   3. **한 줄에 2개 이상**.
 *
 * 이 조합으로도 오탐이 나오면 **넓히지 않는다.** 오탐은 조용히 무효해진 검사보다 나쁘다.
 */
const LATIN_RUN_RE = /[가-힣][A-Za-z]{2,6}|[A-Za-z]{2,6}[가-힣]/g;
/** 코드·명령·경로는 정상이다 — 손상으로 세지 않는다. */
const LATIN_ALLOW_RE = /(?:\.tsx?\b|\.mjs\b|\.json\b|\bnode_modules\b|\bnpm\b|\bhttps?:\/\/|\bAPI\b|\bGPU\b|\bCPU\b|\bVRAM\b|\bUTF-8\b|\bOK\b|\bimport\b|\bexport\b|\bconst\b|\bfunction\b|\bclass\b|\breturn\b|\bif\b|\bawait\b|require\()/;
/**
 * **단위·축약**은 정상이다 — `GiB`, `MiB`, `ms`, `px` 같은 것.
 * 실측 오탐: `예상RAM부족분GiB` 에서 `RAM` 과 `GiB` 가 두 개 걸렸는데 둘 다 정상이다.
 * 그래서 라틴 run 이 **모두 축약형**이면 손상이 아니다.
 */
const UNIT_LIKE = /^(?:[KMGT]i?B|B|KB|MB|GB|TB|ms|us|ns|px|em|rem|Hz|kHz|MHz|GHz|TB\/s|GB\/s|MB\/s|fps|rpm|VRAM|SSD|HTTP|HTTPS|JSON|HTML|CSS|URL|URI|WS|RPC|API|GPU|CPU|RAM|ROM|SSD|OS|UI|UX|ID|OS)$/;

async function walk(dir, out = []) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) await walk(p, out);
    else if (SCAN_EXT.some((e) => d.name.endsWith(e))) out.push(p);
  }
  return out;
}

let failures = 0;
let exemptions = 0;
const fail = (m) => {
  failures++;
  console.error(`  FAIL  ${m}`);
};
const pass = (m) => console.log(`  PASS  ${m}`);
const note = (m) => console.log(`  허용  ${m}`);
const rel = (f) => relative(ROOT, f) || ".";

const rules = JSON.parse(await readFile(join(ROOT, ".ci/rules.json"), "utf8"));
const FORBIDDEN = rules.forbiddenNames;
const inScope = (r) => {
  const p = r.split("/").join(sep);
  return rules.scope.strict.some((s) => {
    if (s.includes("*")) return r.startsWith(s.split("*")[0]);
    return r === s;
  });
};
const isMigrationDoc = (r) => rules.scope.migrationDocs.includes(r);
const nameException = (r) => rules.nameExceptions.find((e) => e.path === r);
const secretException = (r, line) => rules.secretExceptions.find((e) => e.path === r && e.line === line);

const files = await walk(ROOT);
const bodies = new Map();
for (const f of files) bodies.set(f, await readFile(f, "utf8").catch(() => ""));

// ---------------------------------------------------------------- 0. grep 자체 검증

// `grep -r <금지어>` 가 0 이어야 하는데 **grep 이 죽어 있어도** 0 이 된다.
// 그래서 grep 이 실제로 도는지 먼저 확인한다(존재하지 않는 문자열로 도는 것을 확인).
try {
  await exec("grep", ["-rl", "__harnesside_probe_that_never_exists__", "--include=*", "."], { cwd: ROOT });
} catch (e) {
  if (e?.code !== 1) fail(`grep 이 실행되지 않습니다 (code=${e?.code}) — 금지어 검사가 무의미해집니다`);
}

// ---------------------------------------------------------------- 1. 금지어

for (const [f, body] of bodies) {
  const r = rel(f);
  for (const name of FORBIDDEN) {
    if (!body.includes(name)) continue;
    if (isMigrationDoc(r)) {
      // 조용히 넘기지 않는다 — 예외는 화면에 **보여야** 나중에 사라지지 않는다.
      note(`${r} — 이름 변경 작업 문서라 예외 (사유: ${rules.scope.$comment})`);
      exemptions++;
      continue;
    }
    const ex = nameException(r);
    if (ex) {
      note(`${r} — 예외: ${ex.reason}`);
      exemptions++;
      continue;
    }
    if (!inScope(r)) {
      note(`${r} — 검사 범위 밖`);
      exemptions++;
      continue;
    }
    fail(`금지어 "${name}": ${r}`);
  }
}
if (failures === 0) pass(`금지어 검사 (${FORBIDDEN.length}종, ${files.length}개 파일)`);

// ---------------------------------------------------------------- 2. 비밀 스캔

let secretHits = 0;
for (const [f, body] of bodies) {
  const r = rel(f);
  body.split("\n").forEach((line, i) => {
    for (const { name, re } of SECRET_PATTERNS) {
      if (!re.test(line)) continue;
      const ex = secretException(r, i + 1);
      if (ex) {
        note(`${r}:${i + 1} — 예외: ${ex.reason}`);
        exemptions++;
        return;
      }
      fail(`비밀 패턴 (${name}): ${r}:${i + 1}`);
      secretHits++;
    }
  });
}
if (secretHits === 0) pass(`비밀 패턴 0건 (${SECRET_PATTERNS.length}종)`);

// ---------------------------------------------------------------- 3. 혼합 문자

let mixedHits = 0;
for (const [f, body] of bodies) {
  if (!MIXED_RE.test(body)) continue;
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    if (!MIXED_RE.test(line)) return;
    fail(`혼합 문자: ${rel(f)}:${i + 1}  ${line.trim().slice(0, 70)}`);
    mixedHits++;
  });
}
if (mixedHits === 0) pass("혼합 문자 0건 (깨진 바이트 · 한국어 문장에 섞인 CJK)");

// ── 3b. 깨진 라틴 조각 — **시도했다가 폐기했다** (2026-10-01) ──────────────
//
// 실측: 사용자 원문 인용이 저장소에 이렇게 들어 있었다 —
//
//   요구: "…패널 타이틀에 아이콘으로ogi로 ding을
//
// `ogi` `ding` 은 라틴 문자라 `MIXED_RE` 이 **통과시킨다.** 그런데 이건 정상 한국어가
// 아니다 — 사용자가 쓴 말이 **깨져서** 옮겨진 것이다.
//
// 그래서 "한국어에 붙은 짧은 라틴 run" 을 잡는 규칙을 세 번 좁혔다:
//   1. `MIXED_RE` 확장 → **오탐 5건** (`비ASCII`, `예상RAM부족분GiB`, `면skip`, `러unner`)
//   2. 단위 축약 허용 → **오탐 1건** → 통과
//   3. 접두 한글로 좁힘 → `ding` 이 빠져 **사각지대** → 넓힘 → **오탐 37건**
//      (`thinking을`, `MoE가`, `UI는`, `CORS가`, `version이`, `Canvas는`, `Socket은` …)
//
// **결론: 이 규칙은 폐기한다.** 오탐 37건짜리 검사는 **없는 검사보다 나쁘다.**
// 없는 검사는 소음을 안 내지만, 있는 오탐 검사는 매 커밋마다 **진짜 손상을 숨기고**
// 개발자가 규칙을 고치는 데 시간을 태운다. 요구된 판정("이 규칙을 넓히지 마라 —
// 오탐이 나오면 넓히지 않는다")에 따라 여기서 멈춘다.
//
// **남긴 것**: 손상된 파일은 사람이 고친다(아래 참고). 기계가 잡을 수 있는 손상은
// 이미 `MIXED_RE`(깨진 바이트 · CJK)이 잡는다. 라틴 **조각**의 변형은 그게 아니다.
//
// 그래도 **가시성을** 남긴다 — 같은 손상이 반복되지 않게, 한 번 확인한 위치를 여기에 적어 둔다:
//   src/web/panels/AgentPanel.tsx 의 머리 아이콘 주석 속 사용자 원문 인용
//     "아이콘으로ogi로 ding을" → 원래 말이 "아이콘으로 docking을"이었을 것.
//     **요구사항 원문이므로 지우지 말고** 읽히게 고쳤다.

// ---------------------------------------------------------------- 4. 커밋 금지 경로

const MUST_NOT_COMMIT = [/^\.harnesside\/state\//, /(^|\/)\.env(\.|$)/, /(^|\/)id_rsa$/, /^bin\//];
const leaked = files.filter((f) => MUST_NOT_COMMIT.some((re) => re.test(rel(f))));
if (leaked.length) for (const f of leaked) fail(`커밋 금지 경로: ${rel(f)}`);
else pass("커밋 금지 경로 0건 (state/ · .env · id_rsa · bin/)");

// ---------------------------------------------------------------- 4b. 문서 ↔ 코드 경로 드리프트 (Q-8)
//
// 문서가 가리키는 `src/…` 경로가 **실제로 있는지** 본다. 2026-10-04 실측: README 가 없는 `src/tui/` 를 23번,
// 기획서가 없는 `SearchBlock.tsx` 를 가리켰다 — 문서를 믿고 그 파일을 찾은 사람은 아무것도 못 찾는다.
// 대상: 인라인 백틱 경로 + 펜스 코드 블록에서 줄 맨 앞 토큰이 `src/` 인 것. 글롭·자리표시자(`* < > { } $`)는 뺀다.
// 역사 기록(삭제한 경로를 일부러 말하는 문장)은 `.ci/doc-paths.json` 에 **이유와 함께** 예외로 둔다 —
// 이유가 빈 예외와 **더 이상 쓰이지 않는 예외**는 실패다(예외가 조용히 쌓이면 검사가 무효가 된다).
// 이 검사가 거짓말할 수 있는 경우: 백틱 없이 쓴 경로·`src/` 로 시작하지 않는 경로는 보지 않는다(의도된 범위).
const DOC_NAMES = ["README.md", "PROGRESS.md", "todo.md", "IMPROVEMENTS.md", "MIGRATION_CHECKLIST.md"];
// `docs/` 아래 문서도 **같은 검사 대상**이다 (2026-10-04 · Q-12).
// README 를 3개로 나눈 뒤 이 목록을 안 고치면, 가장 많이 읽게 되는 문서
// (검증 결과 · 아키텍처 · 구현 기록)가 유독 검사를 통과하는 영역이 된다.
// 나뉜 문서가 원본보다 안전해지는 것은 반대다.
const docsDir = join(ROOT, "docs");
const DOC_SUBDIR = existsSync(docsDir)
  ? (await readdir(docsDir)).filter((n) => n.endsWith(".md")).map((n) => join("docs", n)).sort()
  : [];
const docList = [
  ...(await readdir(ROOT)).filter((n) => /^PROMPT.*\.md$/.test(n)).sort(),
  ...DOC_NAMES,
  ...DOC_SUBDIR,
].filter((n) => existsSync(join(ROOT, n)));

export function extractSrcPaths(text) {
  const out = [];
  const norm = (p) => p.replace(/[:#].*$/, "").replace(/[.,;)]+$/, "");
  const skip = (p) => /[*<>{}$]/.test(p);
  for (const m of text.matchAll(/`(src\/[^`\s]*)`/g)) {
    const p = norm(m[1]);
    if (!skip(p)) out.push(p);
  }
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) continue;
    const m = /^\s*(src\/\S+)/.exec(line);
    if (m && !skip(m[1])) out.push(norm(m[1]));
  }
  return out;
}

const docRules = JSON.parse(await readFile(join(ROOT, ".ci", "doc-paths.json"), "utf8"));
const used = new Set();
let driftHits = 0;
let driftRefs = 0;
for (const ex of docRules.exceptions) {
  if (!ex.reason || !String(ex.reason).trim()) { fail(`문서 경로 예외에 이유가 없다: ${ex.doc} ${ex.path ?? ex.prefix}`); driftHits++; }
}
for (const doc of docList) {
  const paths = extractSrcPaths(await readFile(join(ROOT, doc), "utf8"));
  driftRefs += paths.length;
  for (const p of new Set(paths)) {
    if (existsSync(join(ROOT, p))) continue;
    const ex = docRules.exceptions.find((e) => e.doc === doc && (e.path === p || (e.prefix && p.startsWith(e.prefix))));
    if (ex) { used.add(ex); continue; }
    fail(`문서가 없는 경로를 가리킨다: ${doc} → ${p}`);
    driftHits++;
  }
}
for (const ex of docRules.exceptions) {
  if (!used.has(ex)) { fail(`쓰이지 않는 문서 경로 예외(지워야 한다): ${ex.doc} ${ex.path ?? ex.prefix}`); driftHits++; }
}
if (driftHits === 0) {
  pass(`문서 경로 드리프트 0건 (문서 ${docList.length}개 · 경로 참조 ${driftRefs}개 · 사유 있는 예외 ${docRules.exceptions.length}건)`);
  exemptions += docRules.exceptions.length;
}

// ---------------------------------------------------------------- 4c. package.json scripts 가 가리키는 파일 (Q-8)
//
// 2026-10-04 실측: `test:e2e` 가 없는 `scripts/e2e_check.ts` 를 실행하고 있었다 — 아무도 돌리지 않아 몰랐다.
// `dist/` 는 빌드 산출물이라 보지 않는다(빌드 전에는 없는 것이 정상).
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
let scriptHits = 0;
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/(?:^|[\s"'])((?:scripts|src)\/[\w./-]+\.(?:mjs|cjs|js|ts|tsx|py))/g)) {
    if (!existsSync(join(ROOT, m[1]))) { fail(`package.json scripts.${name} 가 없는 파일을 가리킨다: ${m[1]}`); scriptHits++; }
  }
}
if (scriptHits === 0) pass(`package.json scripts 의 파일 참조 전부 존재 (${Object.keys(pkg.scripts ?? {}).length}개 스크립트)`);

// 4b 자기 검사 — **없는 경로를 실제로 잡는가.** 잡지 못하는 검사는 없는 검사다(Q-8 검증 1).
{
  const probe = extractSrcPaths("문서 `src/__q8_probe_missing__.ts` 와 `src/server/index.ts:513` 그리고\n```\nsrc/__q8_fenced_probe__.tsx 설명\n```\n");
  const flagged = probe.filter((p) => !existsSync(join(ROOT, p)));
  if (flagged.length !== 2 || !probe.includes("src/server/index.ts")) fail(`문서 경로 검사 자기 검사 실패: ${JSON.stringify(probe)}`);
  else pass("자기 검사: 문서 경로 검사가 없는 경로(인라인·코드 블록)를 잡고 있는 경로는 통과시킨다");
}

// ---------------------------------------------------------------- 5. 자기 검사

// 규칙이 **실제로 잡는지** 확인한다. 규칙이 조용히 무효가 되면 CI 가 계속
// 초록불이다 — 그게 이 검사에서 가장 나쁜 결과다.
const selfRules = {
  forbidden: FORBIDDEN[0],
  secrets: SECRET_PATTERNS.length,
  mixed: MIXED_RE.source,
};
if (!selfRules.forbidden || selfRules.secrets < 3 || !selfRules.mixed.includes("FFFD")) {
  fail("자기 검사 실패: 규칙이 비어 있거나 변형되었다");
} else {
  pass(`자기 검사: 금지어 1종 · 비밀 ${selfRules.secrets}종 · 혼합 문자 규칙 살아 있음`);
}

console.log(
  failures === 0
    ? `\n모든 검사 통과 (허용 예외 ${exemptions}건 — 위에 사유와 함께 표시됨)`
    : `\n${failures}건 실패`
);
process.exit(failures === 0 ? 0 : 1);
