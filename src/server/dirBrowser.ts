/**
 * 상단 폴더 탐색기용 디렉터리 목록.
 *
 * 워크스페이스 전환(`/api/workspace/plan|switch`)은 이미 임의의 절대 경로를 받는다. 탐색기는 그 경로를
 * **고르기 위한** 읽기 전용 조회일 뿐이라 파일 내용·크기는 주지 않고 하위 **폴더 이름만** 준다.
 * 루트 안으로 제한하지 않는다 — 다른 프로젝트로 옮기는 것이 이 기능의 목적이다. 실제 전환은 여전히
 * 미리보기와 확인을 거친다.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, dirname, resolve } from "node:path";

export const MAX_DIR_ENTRIES = 500;

export interface DirEntryInfo {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  /** 최상위(`/`)면 null. */
  parent: string | null;
  home: string;
  entries: DirEntryInfo[];
  /** MAX_DIR_ENTRIES 를 넘어 잘렸는가. */
  truncated: boolean;
  /** 숨김 폴더라 가린 개수. */
  hiddenCount: number;
}

export type DirResult =
  | { ok: true; value: DirListing }
  | { ok: false; reason: "invalid" | "not-found" | "denied"; detail: string };

export async function listDirs(
  input: string,
  opts: { fallback: string; home: string; showHidden?: boolean }
): Promise<DirResult> {
  let raw = input.trim() || opts.fallback;
  if (raw === "~") raw = opts.home;
  else if (raw.startsWith("~/")) raw = join(opts.home, raw.slice(2));
  if (!isAbsolute(raw)) return { ok: false, reason: "invalid", detail: `Path must be absolute: ${input}` };
  if (raw.includes("\0")) return { ok: false, reason: "invalid", detail: "Path contains a NUL character" };
  const path = resolve(raw);

  const st = await stat(path).catch(() => null);
  if (!st?.isDirectory()) return { ok: false, reason: "not-found", detail: `Not a folder: ${path}` };

  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM"
      ? { ok: false, reason: "denied", detail: `Permission denied: ${path}` }
      : { ok: false, reason: "not-found", detail: `Could not read folder: ${path}` };
  }

  let hiddenCount = 0;
  const dirs: DirEntryInfo[] = [];
  for (const d of dirents) {
    const isDir = d.isDirectory() || (d.isSymbolicLink() && (await stat(join(path, d.name)).catch(() => null))?.isDirectory());
    if (!isDir) continue;
    if (!opts.showHidden && d.name.startsWith(".")) {
      hiddenCount++;
      continue;
    }
    dirs.push({ name: d.name, path: join(path, d.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return {
    ok: true,
    value: {
      path,
      parent: parent === path ? null : parent,
      home: opts.home,
      entries: dirs.slice(0, MAX_DIR_ENTRIES),
      truncated: dirs.length > MAX_DIR_ENTRIES,
      hiddenCount,
    },
  };
}

export type MkdirResult =
  | { ok: true; path: string }
  | { ok: false; reason: "invalid" | "not-found" | "exists" | "denied"; detail: string };

/** Create one folder named `name` directly inside `parent`. No nesting, no `..`: the explorer creates a single level at a time. */
export async function createDir(parent: string, name: string): Promise<MkdirResult> {
  const n = name.trim();
  if (!n || n === "." || n === ".." || /[\\/\0]/.test(n) || Buffer.byteLength(n) > 255) {
    return { ok: false, reason: "invalid", detail: `Invalid folder name: ${name}` };
  }
  if (!isAbsolute(parent) || parent.includes("\0")) return { ok: false, reason: "invalid", detail: `Path must be absolute: ${parent}` };
  const base = resolve(parent);
  if (!(await stat(base).catch(() => null))?.isDirectory()) return { ok: false, reason: "not-found", detail: `Not a folder: ${base}` };
  const path = join(base, n);
  try {
    await mkdir(path);
    return { ok: true, path };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { ok: false, reason: "exists", detail: `Already exists: ${path}` };
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { ok: false, reason: "denied", detail: `Permission denied: ${path}` };
    return { ok: false, reason: "invalid", detail: `Could not create folder: ${path}` };
  }
}
