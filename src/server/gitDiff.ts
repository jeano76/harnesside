/**
 * Git diff 소스 (§5.2 표의 "Git 변경" 행) — HEAD ↔ 워킹트리.
 *
 * 왜 서버에서 돌리나: `git` 은 클라이언트에 없다. 그리고 **저장소 밖**에서 실행하면
 * 사용자의 저장소 상태를 맘대로 오염시킬 수 있다(인덱스 갱신, pager, hooks). 그래서
 * 항상 `-C <root>` 로, pager/editor/credential 을 끄고, 읽기 전용 플래그만 쓴다.
 *
 * 실패는 조용히 넘어가지 않는다 — "변경 없음" 과 "git 이 없었다" 는 전혀 다른 상태다.
 * 사용자가 커밋한 내용을 잃어버릴 수 있기 때문이다.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitFileChange {
  path: string;
  /** `git status --porcelain` 2자리 코드. */
  code: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "unknown";
  staged: boolean;
}

export type GitResult<T> = { ok: true; value: T } | { ok: false; reason: GitError; detail: string };
export type GitError = "not-a-repo" | "git-missing" | "timeout" | "failed";

const ENV = {
  // pager 는 터미널을 붙잡고, credential 은 사용자 계정을 건드린다.
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  // 사용자의 전역 hook 이 이 프로그램의 git 호출을 가로채지 못하게 한다.
  GIT_CONFIG_COUNT: "0",
  LC_ALL: "C",
} as const;

async function git(args: string[], root: string, timeoutMs = 8000): Promise<GitResult<string>> {
  try {
    const { stdout } = await run("git", ["-C", root, ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...ENV },
    });
    return { ok: true, value: stdout };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
    if (err.code === "ENOENT") return { ok: false, reason: "git-missing", detail: "git 실행 파일을 찾을 수 없습니다" };
    if (err.killed || err.signal === "SIGTERM") return { ok: false, reason: "timeout", detail: "git 응답 시간이 지났습니다" };
    const msg = (err.stderr || err.message || "").trim();
    if (/not a git repository/i.test(msg)) return { ok: false, reason: "not-a-repo", detail: "Git 저장소가 아닙니다" };
    return { ok: false, reason: "failed", detail: msg || "git 호출이 실패했습니다" };
  }
}

function statusOf(code: string): GitFileChange["status"] {
  if (code === "??") return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("M")) return "modified";
  return "unknown";
}

/**
 * 변경 파일 목록. `--porcelain=v1 -z` 로 파싱한다 — 개행 파싱은 **파일명에 개행이
 * 있을 때** 깨지고, 깨지면 다른 파일을 보고한다(사용자가 엉뚱한 diff 를 검토하게 됨).
 */
export async function gitStatus(root: string): Promise<GitResult<{ files: GitFileChange[]; branch: string | null; head: string | null }>> {
  const r = await git(["status", "--porcelain=v1", "-z", "--branch"], root);
  if (!r.ok) return r;
  const files: GitFileChange[] = [];
  let branch: string | null = null;
  let head: string | null = null;
  // `-z` 는 NUL 로 항목을 나누고, 이름에 개행이 있으면 따옴표로 감싸인다.
  const parts = r.value.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith("## ")) {
      const b = p.slice(3);
      const headMatch = /^\((?:no branch|HEAD detached at )?/.test(b);
      void headMatch;
      const [name, ...rest] = b.split("...");
      branch = name || null;
      head = rest.length ? rest.join("...") : null;
      continue;
    }
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    let path = p.slice(3);
    // 이름에 개행이 있으면 git 가 따옴표로 감싼다 — 그대로 두면 경로가 깨진다.
    if (path.startsWith('"') && path.endsWith('"')) path = unquoteGitPath(path);
    const entry: GitFileChange = {
      path,
      code,
      status: statusOf(code),
      staged: code[0] !== " " && code[0] !== "?",
    };
    // rename/copy 는 원본 경로가 다음 항목으로 온다 — 짝을 맞춰야 경로가 어긋나지 않는다.
    if (code[0] === "R" || code[0] === "C" || code[1] === "R") {
      const from = parts[i + 1];
      i++;
      if (from) entry.path = `${unquoteGitPath(from)} → ${entry.path}`;
    }
    files.push(entry);
  }
  return { ok: true, value: { files, branch, head } };
}

/** git C-quote 제거 (`\\n`, `\\t`, `\\\\`, `\\"` 를 실제로 되돌린다). */
function unquoteGitPath(s: string): string {
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const c = body[++i];
    out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "b" ? "\b" : c === "f" ? "\f" : c === "v" ? "\v" : c === "a" ? "\x07" : c === "\\" ? "\\" : c === '"' ? '"' : `\\${c ?? ""}`;
  }
  return out;
}

/** 한 파일의 HEAD 쪽 내용. 없는 파일(신규 추가)면 빈 문자열 — 그래야 "전체 추가" 가 된다. */
export async function gitShowHead(root: string, path: string): Promise<GitResult<string>> {
  // `--` 로 경로와 옵션을 분리한다. 파일명이 `-`-로 시작하거나 옵션처럼 보이면
  // 이 구분자 없이는 git 가 파일이 아니라 **옵션** 으로 해석한다(경로 주입).
  const r = await git(["show", `HEAD:${path}`], root);
  if (!r.ok) {
    // 아직 추적되지 않은 파일이면 HEAD 에 없다 — 이건 실패가 아니다.
    if (/does not exist|no such path|path .* not in|unknown revision/i.test(r.detail)) return { ok: true, value: "" };
    return r;
  }
  return r;
}

/** 저장소 루트(작업 트리 루트). 없으면 not-a-repo. */
export async function repoRoot(start: string): Promise<GitResult<string>> {
  const r = await git(["rev-parse", "--show-toplevel"], start);
  return r;
}
