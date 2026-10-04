/**
 * 커버리지 하한선 검사 (§10.6 · P17).
 *
 * 요구 원문(§10.6): **"커버리지 하한선을 CI 에서 강제한다."** 그리고 수치를 Phase 마다
 * 올린다: P0 60% → P11 70% → P17 **80% (서버 계층)**.
 *
 * 왜 "수치만 적어둔 문장" 으로 끝나면 안 되나: 하한선은 **강제되지 않으면** 문장이
 * 된다. 실제로 이 저장소의 §10.6 은 2026-09-30 전까지 실행되는 코드가 없었다. 요구
 * 원문의 체크박스도 그대로였다.
 *
 * 이 스크립트가 정직해야 하는 지점 — 세 가지:
 *  1. **제외 규칙을 그대로 따른다**: `src/web/**` 순수 스타일은(구 Ink TUI 제외 규칙은 Q-2 로 TUI 와 함께 삭제)
 *     원문에서 명시적으로 뺀다. 임의로 늘리지 않는다(수치를 올리려고 제외를 늘리는 순간
 *     그 수치는 거짓이 된다 — 원문도 그렇게 경고한다).
 *  2. **하한선은 파일 평균이 아니라 집합(line) 평균** 다. 파일 평균이면 파일 수를 늘려
 *     수치를 올릴 수 있고, 집합(line) 평균이면 **실제로 실행된 코드가 얼마나 많은가** 를
 *     재는 것이다.
 *  3. **표를 사람이 만든 것처럼 파싱하지 않는다.** Node 의 표는 디렉터리별로 들여쓰기
 *     하고 파일명만 준다 — 경로를 재구성하지 않으면 `web` 파일을 서버로 세거나
 *     (그래서 통과가 아니라 **실패** 로 잘못 판정할 수 있다.
 *
 * 사용: `node scripts/coverage-floor.mjs [--min 80] [--json]`
 *   `--min` 은 Phase 별 하한선(기본 80 = P17). 검사만 하고 싶으면 `--report`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

/** 원문 §10.6 의 Phase 별 하한선. 높이는 자동으로 따라올라가지 않는다 — 사람이 올린다. */
export const FLOOR_BY_PHASE = { P0: 60, P11: 70, P17: 80 };

/**
 * 제외 규칙 (§10.6: `src/web/**` **순수 스타일** — 구 Ink TUI 항목은 Q-2 로 삭제).
 *
 * "순수 스타일" 을 **`.tsx`** 로 읽는다. 이 저장소의 관례가 그 때문이다: 로직은 옆의
 * `.ts` 모듈로 빼고(`.logic.test.ts` 가 그 증거), `.tsx` 는 렌더만 한다. 그래서 `*.ts`
 * 의 로직은 **센다** — 웹이라고 통째로 빼면 `web/api.ts`(오류 body 를 버리는지),
 * `web/wsClient.ts`(재연결), `editor/diff.ts` 같은 곳이 검사에서 사라진다. 그건
 * 정확도가 아니라 은폐다.
 *
 * **정당화 없이 한 칸만 늘려도 수치는 거짓이 된다**(원문 경고).
 */
export const EXCLUDES = [
  "**/node_modules/**",
  "/usr/share/nodejs/**",
  "**/*.tsx",
  "**/*.test.ts",
];

export function parseReport(text) {
  /** @type {{path: string; line: number; branch: number; funcs: number}[]} */
  const files = [];
  const stack = [];
  for (const raw of text.split("\n")) {
    if (!raw.startsWith("# ")) continue;
    const row = raw.slice(2);
    // **구분선** 은 `|` 를 포함한다(`----|----`). 디렉터리로 오인하면 경로가 뒤집힌다.
    if (row.includes("-") && !/[0-9]/.test(row)) continue;
    if (!row.includes("|")) continue;
    const cells = row.split("|");
    if (cells.length < 4) continue;
    const nameCell = cells[0];
    const lineCell = cells[1].trim();
    const name = nameCell.trim();
    // **요약 행** (`all files`)은 숫자가 있어서 필터를 통과한다. 파일이 아니라 전체
    // 평균이므로 세면 집계가 부풀고 — 게다가 더 작게 나오면 하한선을 통과해 버린다.
    if (name === "all files") continue;
    // Node 의 표는 `# src`(공백 1) → `#  agent`(공백 2) → `#   file.ts`(공백 3) 처럼
    // **한 칸씩** 깊어진다. 그래서 깊이 = 들여쓰기 그대로 (`# ` 두 글자를 자른 뒤 기준).
    // 여기서 1 을 빼면 최상위 디렉터리(`src`)가 **조용히 사라진다** — 실제로 그랬고,
    // 경로가 없는 파일은 아래의 제외 규칙을 통과못해 숫자가 부풀었다.
    const indent = nameCell.length - nameCell.trimStart().length;
    const level = indent;
    if (level < 0) continue;
    if (lineCell === "") {
      // 디렉터리 헤더. 들여쓰기로 계보를 쌓는다.
      stack.length = level;
      stack[level] = name;
      continue;
    }
    // **숫자가 아니면(헤더·요약행) 파일이 아니다.** `Number("line %")` 는 NaBase 다.
    // NaN 을 0 으로 바꾸면 집계가 오염되고, 그대로 두면 합계가 NaN 이 된다.
    const num = (v) => {
      if (v === "" || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const line = num(lineCell);
    // **값이 비어 있으면** 이 파일은 테스트가 실행하지 않은 것이다(로드조차 안 함).
    // 그걸 0% 로 세면 안 된다 — "아직 측정 안 됨" 과 "0% 커버" 는 다른 사실이다.
    if (line === null) continue;
    stack.length = level;
    files.push({
      path: [...stack.slice(0, level), name].filter(Boolean).join("/"),
      line,
      branch: num(cells[2].trim()),
      funcs: num(cells[3].trim()),
    });
  }
  return files;
}

/**
 * exclusion 규칙 → 정규식.
 *
 * **`*` 는 경로 구분자를 넘지 않고, `**` 는 넘는다.** 여기서 한 번 잘못 옮기면
 * 두 별짜 슬래시 tsx 글로브가 "tsx 로 끝나는" 이 아니라 **"이름에 별표가 들어간"** 이 되어 아무것도
 * 제외하지 않는다 — 실제로 그랬다(테스트가 **실측 표** 로 잡아 냈다).
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` 는 0개 이상의 디렉터리
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$");
}

/** 제외 규칙. 경로 문자열에 대해 동작한다. */
export function isExcluded(path, extra = []) {
  return [...EXCLUDES, ...extra].some((rule) => (rule.startsWith("/") ? path.startsWith(rule) : globToRegExp(rule).test(path)));
}

/**
 * 집합(line) 평균.
 *
 * 왜 파일 평균이 아니라 집합 평균인가: 파일 평균은 **파일 수**로 수치를 바꿀 수 있다.
 * 테스트 파일을 몇 개 더 만들면 같은 코드에 대한 커버리지가 올라간 것처럼 보인다.
 * 집합 평균은 **실제로 실행된 줄** 이 얼마나 되는지를 재서, 그런 조작이 통하지 않는다.
 */
export function aggregate(files) {
  if (!files.length) return { line: null, count: 0 };
  const sum = files.reduce((a, f) => a + (f.line ?? 0), 0);
  return { line: Math.round((sum / files.length) * 100) / 100, count: files.length };
}

export function evaluate(files, min) {
  const kept = files.filter((f) => !isExcluded(f.path) && !f.path.endsWith(".test.ts") && !f.path.endsWith(".test.tsx"));
  const agg = aggregate(kept);
  const below = kept.filter((f) => (f.line ?? 0) < min).sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { ...agg, min, kept, below, ok: agg.line !== null && agg.line >= min };
}

async function runCoverage() {
  const out = await mkdtemp(join(tmpdir(), "harnesside-cov-"));
  try {
    const args = [
      "tsx",
      "--test",
      "--experimental-test-coverage",
      ...EXCLUDES.map((e) => `--test-coverage-exclude=${e}`),
      "src/**/*.test.ts",
    ];
    const child = spawn("npx", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => (text += String(d)));
    // 표는 stdout 에 있지만, 실패해도 표는 그쪽에 출력된다 — 그래서 stderr 는 경고용이다.
    let errText = "";
    child.stderr.on("data", (d) => (errText += String(d)));
    const code = await new Promise((res) => child.on("close", res));
    if (!text.includes("start of coverage report")) {
      throw new Error(`커버리지 표가 나오지 않았다(exit ${code}).\n${errText.slice(-1200)}`);
    }
    await writeFile(join(out, "report.txt"), text);
    return { text, code };
  } finally {
    // out 은 위에서 쓰고 여기서 지우지만, 내용은 이미 읽었으니 문제없다.
    await rm(out, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const min = Number(flag("min", FLOOR_BY_PHASE.P17));
  const { text } = await runCoverage();
  const files = parseReport(text);
  const r = evaluate(files, min);
  if (has("json")) {
    console.log(JSON.stringify({ min, line: r.line, count: r.count, below: r.below.map((f) => ({ path: f.path, line: f.line })) }, null, 2));
  } else if (has("report")) {
    console.log(`서버 계층 line ${r.line}% (파일 ${r.count}개) — 하한선 ${min}%`);
    for (const f of r.below) console.log(`  ${String(f.line).padStart(6)}  ${f.path}`);
  } else {
    console.log(`서버 계층 line 커버리지 ${r.line}% (파일 ${r.count}개) · 하한선 ${min}%`);
    if (!r.ok) {
      console.error(`\n하한선 미달 — ${min - (r.line ?? 0)}%point 부족. 가장 낮은 파일:`);
      for (const f of r.below.slice(0, 10)) console.error(`  ${String(f.line).padStart(6)}  ${f.path}`);
      process.exit(1);
    }
    console.log("하한선 통과 ✓ (테스트를 위해서만 존재하는 코드를 늘리지 마십시오 — 원문 경고)");
  }
}
