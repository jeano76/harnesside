/**
 * 마지막으로 작업한 폴더를 기억하고, 시작할 때 거기로 돌아간다.
 *
 * `harnesside` 는 실행한 폴더(cwd)를 프로젝트로 삼는다. 그런데 다른 폴더에서 띄우면 그곳에는 설정·세션이
 * 없어 모델도 이전 작업도 못 찾는다(실측: 폴더를 바꿔 띄우자 "모델이 없습니다"). 그래서 마지막 작업 폴더를
 * 머신 전역(`~/.harnesside/last-workspace.json`)에 적어 두고, **어디서 실행하든 거기서 이어서 작업한다.**
 *
 * 예전에는 프로젝트 표지(.git, package.json …)가 있는 폴더에서 띄우면 옮기지 않았다(새 프로젝트를 이전
 * 프로젝트로 납치하지 않으려는 보수적 규칙). 그 결과 프로젝트 폴더에서 실행하면 "마지막 작업 폴더" 가
 * 무시돼 이어서 작업이 되지 않았다. 사용자가 항상 이어서 하는 쪽을 택했으므로 예외를 없앴다.
 * 현재 폴더에서 시작하려면 `--here`. 화면 상단 폴더 탐색기로도 언제든 옮길 수 있다.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function lastWorkspaceFile(home: string): string {
  return join(home, ".harnesside", "last-workspace.json");
}

export interface LastWorkspace {
  path: string;
  at: number;
}

/** 기록을 읽는다. 없거나 깨졌으면 null — 시작을 막지 않는다. */
export async function readLastWorkspace(home: string): Promise<LastWorkspace | null> {
  try {
    const j = JSON.parse(await readFile(lastWorkspaceFile(home), "utf8")) as Partial<LastWorkspace>;
    return typeof j.path === "string" && j.path !== "" ? { path: j.path, at: typeof j.at === "number" ? j.at : 0 } : null;
  } catch {
    return null;
  }
}

/** 기록한다. 실패해도 던지지 않는다(작업 폴더를 못 적는 것이 서버를 죽일 이유는 아니다). */
export async function rememberWorkspace(home: string, root: string, now = Date.now()): Promise<boolean> {
  try {
    const file = lastWorkspaceFile(home);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ path: root, at: now }), "utf8");
    await rename(tmp, file); // 반쯤 쓴 파일을 남기지 않는다
    return true;
  } catch {
    return false;
  }
}

export interface StartRootInput {
  cwd: string;
  /** 마지막 작업 폴더 기록. */
  last: string | null;
  /** `--here`: 현재 폴더를 쓴다. */
  here?: boolean;
  /** `last` 가 지금도 있는 디렉터리인가. */
  lastIsDir: boolean;
}

export interface StartRoot {
  root: string;
  moved: boolean;
  /** 사람이 읽는 근거 — 부팅 로그에 그대로 쓴다. */
  reason: string;
}

/** 시작 폴더를 정한다 — 순수 함수. */
export function decideStartRoot(i: StartRootInput): StartRoot {
  const stay = (reason: string): StartRoot => ({ root: i.cwd, moved: false, reason });
  if (i.here) return stay("--here: 현재 폴더에서 시작합니다");
  if (!i.last) return stay("마지막 작업 폴더 기록이 없습니다");
  if (i.last === i.cwd) return stay("현재 폴더가 마지막 작업 폴더입니다");
  if (!i.lastIsDir) return stay(`마지막 작업 폴더(${i.last})가 더 이상 없어 현재 폴더에서 시작합니다`);
  return {
    root: i.last,
    moved: true,
    reason: `continuing in the last workspace (use --here to work in ${i.cwd} instead)`,
  };
}

/** 실제 파일시스템으로 `StartRootInput` 의 사실을 채운다. */
export async function inspectStart(last: string | null): Promise<Pick<StartRootInput, "lastIsDir">> {
  const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;
  return { lastIsDir: last ? await isDir(last) : false };
}
