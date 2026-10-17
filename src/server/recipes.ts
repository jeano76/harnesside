/**
 * U-6 검증 레시피 — 서버 측 (파일 읽기·실행·마지막 결과 보관).
 *
 * - 레시피 파일이 없으면 found:false (없음은 오류가 아니다 — 감지 제안을 띄운다).
 * - 실행은 tools/index.ts runShell 과 같은 함수 (두 벌 금지). 시간 초과는
 *   통과가 아니다. 실행한 적 없으면 lastRuns 에 없어 "미실행"으로 보인다.
 * - 마지막 결과는 프로세스 메모리에만 둔다. 로컬 우선, 전송 없음. 재시작하면
 *   "미실행"으로 돌아가는 것이 정직하다 (모르는 값을 통과로 채우지 않음).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { runShell } from "../tools/index.js";
import {
  RECIPE_FILE,
  DEFAULT_RECIPE_TIMEOUT_MS,
  loadRecipesFile,
  parseOutput,
  type RecipeDef,
  type ParsedOutput,
  type LastRun,
} from "../recipes/recipes.js";

export interface RecipeRunResult {
  name: string;
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  raw: string;
  parsed: ParsedOutput;
}

/** 셸 실행 주입점 — 테스트는 가짜를 넘긴다. */
export type ShellFn = typeof runShell;

function recipeRoot(projectRoot: string, def: RecipeDef): string {
  const base = resolve(projectRoot);
  if (!def.cwd) return base;
  // cwd 탈출 방지 — 프로젝트 밖이면 거부한다 (조용히 실행하지 않음).
  const target = resolve(base, def.cwd);
  if (target !== base && !target.startsWith(base + "/")) {
    throw new Error(`recipe "${def.name}": cwd 가 프로젝트 밖입니다 (${def.cwd})`);
  }
  return target;
}

export async function runRecipeDef(
  def: RecipeDef,
  projectRoot: string,
  shell: ShellFn = runShell,
): Promise<RecipeRunResult> {
  const started = Date.now();
  const timeoutMs = def.timeoutMs ?? DEFAULT_RECIPE_TIMEOUT_MS;
  const r = await shell(def.cmd, recipeRoot(projectRoot, def), timeoutMs, def.env);
  const raw = [r.stdout, r.stderr].filter(Boolean).join("\n");
  const timedOut = r.timedOut;
  const ok = !timedOut && r.code === 0;
  return {
    name: def.name,
    ok,
    timedOut,
    exitCode: r.code,
    durationMs: Date.now() - started,
    raw: raw || (ok ? "(exit 0, no output)" : "(no output)"),
    parsed: parseOutput(def.parse, raw, r.code),
  };
}

export interface ProjectRecipes {
  found: boolean;
  recipes: RecipeDef[];
  errors: string[];
}

export async function readProjectRecipes(projectRoot: string): Promise<ProjectRecipes> {
  const path = join(projectRoot, RECIPE_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { found: false, recipes: [], errors: [] };
  }
  const { recipes, errors } = loadRecipesFile(text);
  return { found: true, recipes, errors };
}

/** 마지막 실행 결과 보관 — 프로세스 메모리. */
export function createLastRunStore() {
  const map = new Map<string, LastRun>();
  return {
    record(name: string, run: { ok: boolean; timedOut: boolean }, at = Date.now()): void {
      map.set(name, { at, ok: run.ok, timedOut: run.timedOut });
    },
    get(name: string): LastRun | null {
      return map.get(name) ?? null;
    },
    all(): Record<string, LastRun> {
      return Object.fromEntries(map);
    },
  };
}

export type LastRunStore = ReturnType<typeof createLastRunStore>;

/**
 * 레시피 파일 생성 — PUT /api/recipes 전용. 사용자가 제안 화면에서 승인
 * 버튼을 눌렀을 때만 호출된다. 내용을 먼저 검증하고, 오류가 있으면 쓰지 않고
 * 400 사유로 돌려준다 (추측으로 조용히 만들지 않는다).
 */
export async function writeProjectRecipes(projectRoot: string, text: string): Promise<{ errors: string[] }> {
  const { errors } = loadRecipesFile(text);
  if (errors.length > 0) return { errors };
  const path = join(projectRoot, RECIPE_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text.endsWith("\n") ? text : text + "\n", "utf8");
  return { errors: [] };
}
