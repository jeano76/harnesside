/**
 * P0-1: 식별자 일괄 치환 (llamacli → harnesside)
 *
 * §1.2 의 경고: 정규식 `*` 를 주석 안에 쓰면 블록 주석이 조기 종료한다.
 * 그래서 이 스크립트는 문자열/주석을 **토큰 단위로 파싱**한 뒤 토큰만 치환한다.
 * 실행: node scripts/rename-identifiers.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DRY = process.argv.includes('--dry');
const TARGET_DIRS = ['src', 'scripts'];
const TARGET_FILES = ['package.json', 'tsconfig.json', 'README.md', '.gitignore', 'PROGRESS.md'];

// 순서 중요: 긴 것/대문자 변형부터. `llamacli` 를 먼저 바꾸면 `LLAMACLI_`·`LlamacliConfig` 가 남는다.
// (검출은 `grep -ni` 로 하므로 대소문자 변형을 빠뜨리면 통과로 오인된다)
const RULES = [
  ['LLAMACLI_', 'HARNESSIDE_'],
  ['Llamacli', 'Harnesside'],
  ['llamacli', 'harnesside'],
];

const SKIP = new Set(['node_modules', 'dist', '.git', '.harnesside', 'legacy-tui']);
/** 이 스크립트 자신과 진행 기록은 치환에서 제외한다(규칙 문자열/원본 프로젝트 참조 보존). */
const SKIP_FILES = new Set(['scripts/rename-identifiers.mjs', 'PROGRESS.md']);

/** 파일 내용을 (토큰, 종류) 로 분해한다. 종류: code | line-comment | block-comment | string */
function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let buf = '';
  let kind = 'code';
  const push = (text, k) => { if (text) out.push({ text, kind: k }); };
  const flush = () => { push(buf, kind); buf = ''; };

  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (kind === 'code') {
      if (c2 === '//') { flush(); kind = 'line-comment'; buf = '/'; i += 1; continue; }
      if (c2 === '/*') { flush(); kind = 'block-comment'; buf = '/'; i += 1; continue; }
      if (c === '"' || c === "'" || c === '`') {
        flush(); kind = 'string'; buf = c; i += 1; continue;
      }
      buf += c; i += 1; continue;
    }
    if (kind === 'line-comment') {
      buf += c; i += 1;
      if (c === '\n') { flush(); kind = 'code'; }
      continue;
    }
    if (kind === 'block-comment') {
      if (c2 === '*/') { buf += '*/'; i += 2; flush(); kind = 'code'; continue; }
      buf += c; i += 1; continue;
    }
    // string
    if (c === '\\') { buf += src.slice(i, i + 2); i += 2; continue; }
    buf += c; i += 1;
    if (c === '"' || c === "'" || c === '`') { flush(); kind = 'code'; }
  }
  flush();
  return out;
}

function renameInText(text) {
  let out = '';
  const stats = {};
  for (const t of tokenize(text)) {
    let v = t.text;
    for (const [from, to] of RULES) {
      if (v.includes(from)) {
        const count = v.split(from).length - 1;
        stats[from] = (stats[from] ?? 0) + count;
        v = v.split(from).join(to);
      }
    }
    out += v;
  }
  return { out, stats };
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.yaml', '.yml', '.html', '.css', '.py', '.sh'].includes(extname(p)) || entry === '.gitignore') {
      yield p;
    }
  }
}

const files = [];
for (const d of TARGET_DIRS) files.push(...walk(join(ROOT, d)));
for (const f of TARGET_FILES) {
  try { readFileSync(join(ROOT, f)); files.push(join(ROOT, f)); } catch { /* 없으면skip */ }
}

let changedFiles = 0;
const totals = {};
for (const file of files) {
  const rel = relative(ROOT, file);
  if (SKIP_FILES.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const { out, stats } = renameInText(text);
  if (out === text) continue;
  changedFiles++;
  for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] ?? 0) + v;
  if (!DRY) writeFileSync(file, out);
  console.log(`  ${DRY ? '[dry] ' : ''}${rel}  ${JSON.stringify(stats)}`);
}
console.log(`\n${DRY ? '[dry] ' : ''}변경 파일 ${changedFiles} / ${files.length}`);
console.log('치환 합계:', totals);
