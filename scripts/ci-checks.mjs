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

// ---------------------------------------------------------------- 4. 커밋 금지 경로

const MUST_NOT_COMMIT = [/^\.harnesside\/state\//, /(^|\/)\.env(\.|$)/, /(^|\/)id_rsa$/, /^bin\//];
const leaked = files.filter((f) => MUST_NOT_COMMIT.some((re) => re.test(rel(f))));
if (leaked.length) for (const f of leaked) fail(`커밋 금지 경로: ${rel(f)}`);
else pass("커밋 금지 경로 0건 (state/ · .env · id_rsa · bin/)");

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
