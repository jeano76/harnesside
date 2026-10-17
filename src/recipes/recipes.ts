/**
 * U-6 검증 레시피 — 순수 로직 (Node 전용: `yaml` import. 웹 번들에서 읽지 않는다).
 *
 * 레시피 = "어떻게 검증하나"를 프로젝트에 한 번 적어 사람·에이전트·커밋 검사가
 * 같은 것을 쓰게 하는 이름 붙은 실행 설정. 정본 파일: `.harnesside/recipes.yaml`.
 *
 * - 파일이 없으면 첫 실행 시 감지 제안 → 사용자가 승인해야 생성 (조용히 만들지 않음).
 * - 실행한 적 없으면 "미실행"이지 "통과"가 아니다. 시간 초과는 통과가 아니다.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { recipeStatusText, type LastRun } from "./recipeStatus.js";
export { recipeStatusText, type LastRun };

export type RecipeKind = "test" | "build" | "lint" | "run";
export type RecipeParser = "tsc" | "eslint" | "jest" | "pytest" | "go" | "cargo" | "plain";

export const RECIPE_FILE = ".harnesside/recipes.yaml";
export const DEFAULT_RECIPE_TIMEOUT_MS = 120_000;
export const MAX_RECIPE_TIMEOUT_MS = 600_000;

const KINDS: RecipeKind[] = ["test", "build", "lint", "run"];
const PARSERS: RecipeParser[] = ["tsc", "eslint", "jest", "pytest", "go", "cargo", "plain"];

export interface RecipeDef {
  name: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  kind: RecipeKind;
  parse: RecipeParser;
}

export interface RecipeFile {
  recipes: RecipeDef[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 레시피 파일 파싱+검증. 읽기 전용 — 파일이 없으면 null (없음은 오류가 아니다). */
export function loadRecipesFile(text: string): { recipes: RecipeDef[]; errors: string[] } {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { recipes: [], errors: [`YAML 파싱 실패: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!isRecord(doc) || !Array.isArray(doc.recipes)) {
    return { recipes: [], errors: ["최상위에 `recipes:` 배열이 필요합니다"] };
  }
  const recipes: RecipeDef[] = [];
  const seen = new Set<string>();
  doc.recipes.forEach((r, i) => {
    const where = `recipes[${i}]`;
    if (!isRecord(r)) {
      errors.push(`${where}: 객체가 아닙니다`);
      return;
    }
    const name = r.name;
    const cmd = r.cmd;
    const kind = r.kind;
    const parse = r.parse;
    if (typeof name !== "string" || !name.trim()) {
      errors.push(`${where}: name 이 필요합니다`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`${where}: 이름 "${name}" 이 중복됩니다`);
      return;
    }
    seen.add(name);
    if (typeof cmd !== "string" || !cmd.trim()) {
      errors.push(`${where}(${name}): cmd 가 필요합니다`);
      return;
    }
    if (typeof kind !== "string" || !(KINDS as string[]).includes(kind)) {
      errors.push(`${where}(${name}): kind 는 ${KINDS.join("|")} 중 하나여야 합니다`);
      return;
    }
    if (typeof parse !== "string" || !(PARSERS as string[]).includes(parse)) {
      errors.push(`${where}(${name}): parse 는 ${PARSERS.join("|")} 중 하나여야 합니다`);
      return;
    }
    const def: RecipeDef = { name, cmd, kind: kind as RecipeKind, parse: parse as RecipeParser };
    if (r.cwd !== undefined) {
      if (typeof r.cwd !== "string") errors.push(`${where}(${name}): cwd 는 문자열이어야 합니다`);
      else def.cwd = r.cwd;
    }
    if (r.env !== undefined) {
      if (!isRecord(r.env) || !Object.values(r.env).every((v) => typeof v === "string")) {
        errors.push(`${where}(${name}): env 는 문자열 값의 객체여야 합니다`);
      } else def.env = r.env as Record<string, string>;
    }
    if (r.timeoutMs !== undefined) {
      if (typeof r.timeoutMs !== "number" || !Number.isFinite(r.timeoutMs) || r.timeoutMs <= 0) {
        errors.push(`${where}(${name}): timeoutMs 는 양수여야 합니다`);
        return;
      } else if (r.timeoutMs > MAX_RECIPE_TIMEOUT_MS) {
        errors.push(`${where}(${name}): timeoutMs 상한 초과 (최대 ${MAX_RECIPE_TIMEOUT_MS}ms)`);
        return;
      } else {
        def.timeoutMs = Math.floor(r.timeoutMs);
      }
    }
    recipes.push(def);
  });
  return { recipes, errors };
}

export function serializeRecipes(recipes: RecipeDef[]): string {
  return stringifyYaml({ recipes });
}

/** 감지 제안 입력 — 파일 내용은 호출자가 읽어 넘긴다 (이 함수는 FS를 만지지 않는다). */
export interface DetectInputs {
  packageJson?: string;
  pyproject?: string;
  goMod?: string;
  cargoToml?: string;
}

function parserForCommand(cmd: string): RecipeParser {
  const c = cmd.toLowerCase();
  if (/\btsc\b|typecheck/.test(c)) return "tsc";
  if (/\beslint\b/.test(c)) return "eslint";
  if (/\bjest\b/.test(c)) return "jest";
  if (/pytest/.test(c)) return "pytest";
  if (/\bgo\s+test\b/.test(c)) return "go";
  if (/\bcargo\s+(test|clippy|check|build)\b/.test(c)) return "cargo";
  return "plain";
}

function kindForScriptName(name: string): RecipeKind {
  const n = name.toLowerCase();
  if (/lint|typecheck|check/.test(n)) return "lint";
  if (/build/.test(n)) return "build";
  if (/test/.test(n)) return "test";
  return "run";
}

/**
 * 레시피 감지 제안. 추측이 아니라 파일에 실제로 있는 것만 제안한다.
 * package.json scripts · pyproject · go.mod · Cargo.toml 순서. 없으면 빈 배열
 * (빈 제안을 "감지됨"으로 말하지 않는다).
 */
export function detectRecipes(inputs: DetectInputs): RecipeDef[] {
  const out: RecipeDef[] = [];
  if (inputs.packageJson) {
    try {
      const pkg = JSON.parse(inputs.packageJson) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts;
      if (scripts && typeof scripts === "object") {
        for (const [name, cmd] of Object.entries(scripts)) {
          if (typeof cmd !== "string" || !cmd.trim()) continue;
          // 검증 성격의 스크립트만 제안한다 — dev/start 같은 상주 명령을
          // 레시피로 제안하면 실행이 끝나지 않는다.
          if (!/test|build|lint|typecheck|check/i.test(name)) continue;
          out.push({
            name,
            cmd: `npm run ${name}`,
            kind: kindForScriptName(name),
            parse: parserForCommand(cmd),
          });
        }
      }
    } catch {
      // 깨진 package.json 은 제안 근거가 아니다 — 조용히 건너뛴다 (감지 실패를
      // "레시피 없음"과 구분하기 위해 호출자가 원문을 함께 보여준다).
    }
  }
  if (inputs.pyproject !== undefined) {
    out.push({ name: "pytest", cmd: "python3 -m pytest -q", kind: "test", parse: "pytest" });
  }
  if (inputs.goMod !== undefined) {
    out.push({ name: "go-test", cmd: "go test ./...", kind: "test", parse: "go" });
  }
  if (inputs.cargoToml !== undefined) {
    out.push({ name: "cargo-test", cmd: "cargo test", kind: "test", parse: "cargo" });
  }
  return out;
}

/* ------------------------------------------------------------------ 출력 파서 */

export interface ParsedFailure {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  rule: string | null;
  message: string;
}

export interface ParsedOutput {
  passed: number | null;
  failed: number;
  failures: ParsedFailure[];
}

function fail(file: string, line: number, col: number, severity: "error" | "warning", rule: string | null, message: string): ParsedFailure {
  return { file, line: Number.isFinite(line) && line > 0 ? Math.floor(line) : 0, col: Number.isFinite(col) && col > 0 ? Math.floor(col) : 0, severity, rule, message: message.trim().slice(0, 500) };
}

function parseTsc(output: string): ParsedOutput {
  const failures: ParsedFailure[] = [];
  for (const ln of output.split("\n")) {
    // src/a.ts(12,3): error TS2322: Type '...' is not assignable ...
    // src/a.ts:12:3 - error TS2322: ... (신형)
    let m = ln.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s*(.*)$/);
    if (!m) m = ln.match(/^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+([A-Z]+\d+):\s*(.*)$/);
    if (m) failures.push(fail(m[1], Number(m[2]), Number(m[3]), m[4] === "warning" ? "warning" : "error", m[5], m[6]));
  }
  return { passed: null, failed: failures.length, failures };
}

function parseEslint(output: string): ParsedOutput {
  const failures: ParsedFailure[] = [];
  let currentFile = "";
  for (const ln of output.split("\n")) {
    if (/^\S/.test(ln) && !/^\s/.test(ln) && ln.trim() !== "" && !/problem|warning|error/i.test(ln.slice(0, 40))) {
      // stylish 포맷의 파일 헤더 줄 (앞에 공백 없음)
      if (/^\/|^[A-Za-z]:\\|^\./.test(ln.trim()) || /\.(ts|tsx|js|jsx|mjs|cjs)\s*$/.test(ln.trim())) {
        currentFile = ln.trim();
        continue;
      }
    }
    const m = ln.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@/-]+))?\s*$/);
    if (m && currentFile) {
      failures.push(fail(currentFile, Number(m[1]), Number(m[2]), m[3] as "error" | "warning", m[5] ?? null, m[4]));
    }
  }
  return { passed: null, failed: failures.length, failures };
}

function parseJest(output: string): ParsedOutput {
  let passed: number | null = null;
  let failed = 0;
  const m = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed)?/);
  if (m) {
    failed = m[1] ? Number(m[1]) : 0;
    passed = m[2] ? Number(m[2]) : null;
  }
  const failures: ParsedFailure[] = [];
  // ● Suite › test name — 다음 "at" 프레임에서 파일:줄을 찾는다
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*●/.test(lines[i]) && !/Console|Snapshot/.test(lines[i])) {
      const title = lines[i].replace(/^\s*●\s*/, "").trim();
      let file = "";
      let line = 0;
      let col = 0;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const at = lines[j].match(/at\s+.*\((.+?):(\d+):(\d+)\)/) ?? lines[j].match(/at\s+(.+?):(\d+):(\d+)/);
        if (at && !/node_modules/.test(at[1])) {
          file = at[1];
          line = Number(at[2]);
          col = Number(at[3]);
          break;
        }
      }
      failures.push(fail(file, line, col, "error", "jest", title));
    }
  }
  if (!m) failed = failures.length;
  return { passed, failed, failures };
}

function parsePytest(output: string): ParsedOutput {
  const failures: ParsedFailure[] = [];
  for (const ln of output.split("\n")) {
    // FAILED tests/test_x.py::Test::test_y - assert ...
    const m = ln.match(/^FAILED\s+(\S+?)(?:::\S+)?\s+-\s+(.*)$/);
    if (m) {
      failures.push(fail(m[1], 0, 0, "error", "pytest", m[2]));
      continue;
    }
    // path/to/test_x.py:12: in test_y / E   assert ...
    const t = ln.match(/^(.+?\.py):(\d+):\s*(?:in\s+\S+\s*)?(.*)$/);
    if (t && /^(E\s|assert|Error)/.test(t[3].trim())) {
      failures.push(fail(t[1], Number(t[2]), 0, "error", "pytest", t[3]));
    }
  }
  const sum = output.match(/(\d+)\s+failed(?:,\s+(\d+)\s+passed)?/);
  const passedM = output.match(/(\d+)\s+passed/);
  return {
    passed: passedM ? Number(passedM[1]) : null,
    failed: sum ? Number(sum[1]) : failures.length,
    failures,
  };
}

function parseGo(output: string): ParsedOutput {
  const failures: ParsedFailure[] = [];
  let failed = 0;
  for (const ln of output.split("\n")) {
    if (/^--- FAIL|^FAIL\s|^ok\s/.test(ln) && /^--- FAIL/.test(ln)) failed++;
    // src/x_test.go:12: message
    const m = ln.match(/^\s*(.+\.go):(\d+):\s*(.*)$/);
    if (m && !/^\s*(=== RUN|--- (PASS|FAIL)|PASS|FAIL|ok\s)/.test(ln)) {
      failures.push(fail(m[1], Number(m[2]), 0, "error", "go-test", m[3]));
    }
  }
  const pkgFail = (output.match(/^FAIL\s/gm) ?? []).length;
  return { passed: null, failed: Math.max(failed, failures.length, pkgFail), failures };
}

function parseCargo(output: string): ParsedOutput {
  const failures: ParsedFailure[] = [];
  let inFailures = false;
  for (const ln of output.split("\n")) {
    if (/^failures:$/.test(ln.trim())) {
      inFailures = true;
      continue;
    }
    if (inFailures && /^\s{4}\S/.test(ln)) {
      failures.push(fail("", 0, 0, "error", "cargo-test", ln.trim()));
      continue;
    }
    if (inFailures && ln.trim() === "") {
      // 빈 줄 뒤 test result 줄이 오면 목록 끝
      continue;
    }
    const loc = ln.match(/^\s*-->\s*(.+?):(\d+):(\d+)/);
    if (loc) {
      failures.push(fail(loc[1], Number(loc[2]), Number(loc[3]), "error", "cargo", ln.trim().slice(0, 300)));
    }
  }
  const m = output.match(/test result:\s+FAILED\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/);
  return { passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : failures.length, failures };
}

/**
 * 출력 파서. exitCode 를 함께 받는다 — plain 은 구조가 없어 종료 코드로만
 * 판정한다. 파싱 실패(모르는 형식)는 빈 failures 로 돌려주고 실패로 속이지 않는다.
 */
export function parseOutput(parser: RecipeParser, output: string, exitCode: number | null): ParsedOutput {
  switch (parser) {
    case "tsc":
      return parseTsc(output);
    case "eslint":
      return parseEslint(output);
    case "jest":
      return parseJest(output);
    case "pytest":
      return parsePytest(output);
    case "go":
      return parseGo(output);
    case "cargo":
      return parseCargo(output);
    case "plain": {
      if (exitCode === 0) return { passed: null, failed: 0, failures: [] };
      const tail = output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-5)
        .join("\n");
      return {
        passed: null,
        failed: 1,
        failures: tail ? [fail("", 0, 0, "error", null, tail)] : [],
      };
    }
  }
}


