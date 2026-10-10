/**
 * 마지막으로 작업한 폴더를 기억하고, 시작할 때 거기로 돌아간다.
 *
 * `harnesside` 는 실행한 폴더(cwd)를 프로젝트로 삼는다. 그런데 홈이나 처음 보는 폴더에서 띄우면 그곳에는
 * 설정·세션이 없어 모델도 이전 작업도 못 찾는다(실측: 폴더를 바꿔 띄우자 "모델이 없습니다"). 그래서
 * 마지막 작업 폴더를 머신 전역(`~/.harnesside/last-workspace.json`)에 적어 두고, **프로젝트로 보이지 않는
 * 폴더에서 시작했을 때만** 거기로 옮긴다.
 *
 * 일부러 보수적이다: 이미 harnesside 를 쓴 폴더이거나(.harnesside/) 프로젝트 표지(.git, package.json …)가
 * 있는 폴더에서 띄웠다면 그것은 "여기서 일하겠다" 는 뜻이므로 옮기지 않는다. 처음 쓰는 새 프로젝트를
 * 이전 프로젝트로 납치하면 안 된다. 강제는 `--here`(현재 폴더) · `--last`(마지막 폴더).
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 이 중 하나가 있으면 "이미 프로젝트인 폴더" 로 본다. */
export const PROJECT_MARKERS = [".harnesside", ".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"] as const;

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
  /** `--last`: 현재 폴더가 프로젝트여도 마지막 폴더로 간다. */
  forceLast?: boolean;
  /** `last` 가 지금도 있는 디렉터리인가. */
  lastIsDir: boolean;
  /** `cwd` 가 이미 프로젝트로 보이는가(표지 파일). */
  cwdIsProject: boolean;
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
  if (i.forceLast) return { root: i.last, moved: true, reason: "--last: 마지막 작업 폴더로 이동합니다" };
  if (i.cwdIsProject) return stay("현재 폴더가 프로젝트라 그대로 시작합니다(마지막 폴더로 가려면 --last)");
  return {
    root: i.last,
    moved: true,
    reason: `현재 폴더(${i.cwd})는 프로젝트로 쓴 적이 없어 마지막 작업 폴더로 이동합니다(현재 폴더에서 쓰려면 --here)`,
  };
}

/** 실제 파일시스템으로 `StartRootInput` 의 사실 두 가지를 채운다. */
export async function inspectStart(cwd: string, last: string | null): Promise<Pick<StartRootInput, "lastIsDir" | "cwdIsProject">> {
  const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;
  const exists = async (p: string) => (await stat(p).catch(() => null)) !== null;
  const markers = await Promise.all(PROJECT_MARKERS.map((m) => exists(join(cwd, m))));
  return { lastIsDir: last ? await isDir(last) : false, cwdIsProject: markers.some(Boolean) };
}
