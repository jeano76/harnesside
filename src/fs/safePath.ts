/**
 * 경로 안전 (§3.4) — 웹 서버가 임의 파일을 읽고 쓸 수 있다는 전제 위의 방어선.
 *
 * 위협: 에이전트가 웹 UI 를 통해 파일을 읽고 쓸 수 있다. 경로 검증이 없으면 곧
 * **원격 파일 읽기 취약점**이다 — `..`, 심볼릭 링크, 인코딩된 경로가 모두 통로가 된다.
 *
 * 규칙은 하나다: **resolve 후의 최종 경로가 루트 안에 있을 때만** 허용한다.
 * 문자열 검사(`includes("..")`)는 우회된다 — 그래서 쓰지 않는다.
 */

import { realpath, stat } from "node:fs/promises";
import { resolve, sep, relative, isAbsolute, join, normalize } from "node:path";

export type DenyReason =
  | "empty"
  | "outside-root"
  | "symlink-escape"
  | "not-found"
  | "not-a-file"
  | "too-large"
  | "binary";

export type SafeResult<T> = { ok: true; value: T } | { ok: false; reason: DenyReason; detail: string };

export interface SafePathOptions {
  /** 워크스페이스 루트. */
  root: string;
  /** 심볼릭 링크를 허용할지(기본 거부). */
  allowSymlinks?: boolean;
  /** 최대 바이트(기본 2 MiB — §3.4). */
  maxBytes?: number;
  exists?: (p: string) => Promise<boolean>;
}

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 경로를 안전하게 만든다. **존재하지 않아도** 루트 안인지 판정한다(저장 전 검증에도 쓰인다).
 */
export async function safeResolve(input: string, opts: SafePathOptions): Promise<SafeResult<string>> {
  if (!input || input.trim() === "") return { ok: false, reason: "empty", detail: "경로가 비어 있습니다" };
  const root = resolve(opts.root);
  const abs = isAbsolute(input) ? resolve(input) : resolve(join(root, input));
  const norm = normalize(abs);

  // 1) 루트 안인지 (문자열이 아니라 경로 연산으로 판정한다)
  if (norm !== root && !norm.startsWith(root + sep)) {
    return { ok: false, reason: "outside-root", detail: `워크스페이스 밖입니다: ${input}` };
  }

  // 2) 심볼릭 링크로 빠져나가는지 (realpath 로 **실제** 위치를 본다)
  if (!opts.allowSymlinks) {
    const real = await realpath(norm).catch(() => null);
    if (real) {
      const realRoot = await realpath(root).catch(() => root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        return { ok: false, reason: "symlink-escape", detail: "심볼릭 링크가 워크스페이스 밖을 가리킵니다" };
      }
    }
  }
  return { ok: true, value: norm };
}

/** 읽기용 전체 검사(크기·파일 여부·바이너리까지). */
export async function safeReadFile(
  input: string,
  opts: SafePathOptions
): Promise<SafeResult<{ path: string; content: string; version: number; size: number }>> {
  const r = await safeResolve(input, opts);
  if (!r.ok) return r;
  const path = r.value;

  const st = await stat(path).catch(() => null);
  if (!st) return { ok: false, reason: "not-found", detail: `파일이 없습니다: ${input}` };
  if (!st.isFile()) return { ok: false, reason: "not-a-file", detail: `파일이 아닙니다: ${input}` };
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (st.size > max) {
    return {
      ok: false,
      reason: "too-large",
      // 잘라서 주지 않는다 — 조용히 잘라진 내용을 쓰면 사용자가 원본을 잃는다.
      detail: `${st.size.toLocaleString("ko-KR")} 바이트로 상한(${max.toLocaleString("ko-KR")})을 넘습니다`,
    };
  }
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  if (buf.includes(0)) {
    return { ok: false, reason: "binary", detail: "바이너리 파일입니다" };
  }
  const content = buf.toString("utf8");
  return {
    ok: true,
    value: {
      path,
      content,
      // 버전 = mtime+size. 충돌 감지의 기준이며, 이 값이 없으면 무음 덮어쓰기가 된다.
      version: Math.floor(st.mtimeMs),
      size: st.size,
    },
  };
}

/** 저장 전 검사. 충돌은 **거부**가 아니라 명시적 결과로 돌려준다(§3.4). */
export async function safeWriteFile(
  input: string,
  content: string,
  opts: SafePathOptions & { baseVersion?: number; readOnlyPaths?: string[] }
): Promise<SafeResult<{ path: string; version: number }> | { ok: false; reason: "conflict" | "read-only"; detail: string; current?: { content: string; version: number } }> {
  const r = await safeResolve(input, opts);
  if (!r.ok) return r;
  const path = r.value;

  // 읽기 전용 판정은 **경로 자체**로 한다. 호출자가 절대 경로를 주면 그대로 쓴다.
  //
  // 이전 코드는 `resolve(join(root, p))` 로 **무조건** 루트 밑에 붙였다. 절대 경로를
  // 넣으면 `/root` + `/root/.harnesside` = `/root/root/.harnesside` 이 되어 **어떤 경로와도
  // 일치하지 않았다** — 즉 보호가 조용히 실패했다(실측: 토큰 파일 쓰기가 409 를 냈다.
  // "읽기 전용" 이라는 말은 한 번도 나오지 않았다).
  const readOnlyHit = (opts.readOnlyPaths ?? []).some((p) => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(join(resolve(opts.root), p));
    return path === abs || path.startsWith(abs.endsWith("/") ? abs : `${abs}/`);
  });
  if (readOnlyHit) return { ok: false, reason: "read-only", detail: "읽기 전용 경로입니다" };

  const st = await stat(path).catch(() => null);
  if (st && typeof opts.baseVersion === "number" && Math.floor(st.mtimeMs) !== opts.baseVersion) {
    const { readFile } = await import("node:fs/promises");
    return {
      ok: false,
      reason: "conflict",
      detail: "디스크에서 변경되었습니다",
      current: { content: (await readFile(path)).toString("utf8"), version: Math.floor(st.mtimeMs) },
    };
  }

  const { writeFile, rename, mkdir } = await import("node:fs/promises");
  await mkdir(resolve(path, ".."), { recursive: true });
  // 원자적: 임시 → rename. 전원 차단으로 파일이 반만 남으면 사용자는 편집을 잃는다.
  const tmp = `${path}.harnesside-tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  const after = await stat(path);
  return { ok: true, value: { path, version: Math.floor(after.mtimeMs) } };
}

/** 디렉토리 목록(깊이 1 고정 — 재귀는 순회 공격이 된다). */
export async function safeListDir(
  input: string,
  opts: SafePathOptions
): Promise<SafeResult<{ path: string; entries: { name: string; kind: "dir" | "file"; size: number }[] }>> {
  const r = await safeResolve(input || ".", opts);
  if (!r.ok) return r;
  const path = r.value;
  const { readdir } = await import("node:fs/promises");
  const raw = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!raw) return { ok: false, reason: "not-found", detail: `디렉터리가 아닙니다: ${input}` };
  const entries = await Promise.all(
    raw.slice(0, 5000).map(async (d) => {
      const size = d.isFile() ? (await stat(join(path, d.name)).catch(() => ({ size: 0 }))).size : 0;
      return { name: d.name, kind: (d.isDirectory() ? "dir" : "file") as "dir" | "file", size };
    })
  );
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { ok: true, value: { path, entries } };
}

/** 워크스페이스 루트 밖 경로인가(테스트·표시용). */
export function isOutside(root: string, p: string): boolean {
  const r = resolve(root);
  const a = resolve(p);
  return a !== r && !a.startsWith(r + sep) && relative(r, a).startsWith("..");
}
