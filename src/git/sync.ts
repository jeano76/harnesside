/**
 * GitHub 연동 (§9.3 · P14 · 요구 16).
 *
 * 요구: **clone → 파일 열기 → 커밋 → pull**, 그리고 "충돌 시 자동병합 없이 중단".
 *
 * 마지막 부분이 이 모듈의 존재 이유다. 자동 병합은 **사용자가 쓰지 않은 코드를
 * 사용자의 파일에 섞어 넣는다** — 그리고 그 사실을 사용자는 아무 데서도 듣지 못한다.
 * 이 프로그램이 검토(review) 문화를 핵심으로 삼고 있으므로(§5.2 가로 diff, M2 변경 검토)
 * 여기서 자동 병합은 특히 중독이다. 그래서 **pull 은 한 번에 하나**,
 * 충돌하면 **그 상태로 멈추고** 사용자에게 넘긴다.
 *
 * 모든 git 호출은 **인자 배열** 로 한다(쉼 인젝션 방지, §10.2 `git/*` 행).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, resolve } from "node:path";

const run = promisify(execFile);

const ENV = {
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
} as const;

export type GitError = "not-a-repo" | "git-missing" | "timeout" | "not-authenticated" | "conflict" | "nothing-to-commit" | "rejected" | "outside-path" | "failed";

export type GitResult<T> = { ok: true; value: T } | { ok: false; reason: GitError; detail: string };

async function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<GitResult<string>> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], {
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
    if (/could not read Username|Authentication failed|could not resolve host/i.test(msg)) {
      return { ok: false, reason: "not-authenticated", detail: "GitHub 인증이 필요합니다. gh auth login 또는 원격을 설정하십시오." };
    }
    // 충돌은 **여기서 판별하지 않는다.** git 메시지는 로케일마다 바뀌고(실측: 이
    // 머신은 한국어), 영문 문자열을 찾는 방식은 **모든 충돌을 일반 오류** 로 만든다.
    // 병합 충돌 여부는 `unmergedPaths()` 가 미해결 경로로 판별한다.
    if (/non-fast-forward|rejected|fetch first/i.test(msg)) {
      return { ok: false, reason: "rejected", detail: "원격이 로컬보다 앞서 있습니다" };
    }
    if (/nothing to commit|no changes added/i.test(msg)) {
      return { ok: false, reason: "nothing-to-commit", detail: "커밋할 변경이 없습니다" };
    }
    return { ok: false, reason: "failed", detail: msg || "git 호출이 실패했습니다" };
  }
}

/** URL 에 자격증명이 들어가 있으면 **가려서** 돌려준다 — 로그에 남으면 안 된다. */
export function redactUrl(u: string): string {
  return u.replace(/\/\/[^/@]*@/, "//***@").replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
}

export type AuthKind = "https" | "ssh" | "none";

export function authOf(remote: string): AuthKind {
  // **순서가 중요하다.** `https://host/org/repo.git` 에도 콜론(`https:`)이 있고
  // `.git` 으로 끝나므로, scp 형태 검사를 먼저 두면 **https URL 을 ssh 로 오인**한다
  // — 실제 그렇게 났고, 그 결과 인증 방식을 잘못 안내했다.
  if (/^https?:\/\//i.test(remote)) return "https";
  // scp 형태 `user@host:path`: 콜론 앞에 `@host` 가 있어야 하고 스킴이 없어야 한다.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(remote)) return "ssh";
  if (/^(ssh|git):\/\//i.test(remote)) return "ssh";
  return "none";
}

export interface ClonePlan {
  url: string;
  dir: string;
  branch: string | null;
  depth: number | null;
}

/**
 * clone 계획. **인자 배열로** — URL 에 공백/따옴표가 있어도 그대로 전달된다.
 *
 * 얕은 복사가 기본이다: 20 GB 저장소를 통째로 받지 않는다.
 * 단, **로컬 경로는 예외** 다 — git 은 `--depth` 를 로컬 clone 에서 무시한다
 * ("--depth is ignored in local clones; use file:// instead"). 이 사실을 모르면
 * 얕게 받을 줄 알았는데 20 GB 를 통째로 받는다. 그래서 스킴이 필요한지 알려준다.
 */
export function planClone(o: { url: string; dir: string; branch?: string; depth?: number }): ClonePlan {
  return {
    url: o.url,
    dir: o.dir,
    branch: o.branch ?? null,
    depth: o.depth ?? 1,
  };
}

/**
 * **로컬 경로**인가 — 즉 `--depth` 가 무시되는 대상인가.
 *
 * git 2.53.0 실측: 로컬 경로 clone 에 `--depth` 를 주면 "옵션은 로컬 복제에서 무시됩니다"
 * 경고와 함께 **완전 복사**가 된다. 얕게 받을 줄 알고 20 GB 를 통째로 받는 경로다.
 * 얕게 받으려면 `file://` 스킴이 필요하다.
 *
 * **scp 형태(`git@host:org/repo`)는 로컬 경로가 아니다** — `://` 가 없어도 원격이다.
 * 이걸 로컬로 오인하면 실제 원격 저장소 이름 앞에 `file://` 이 붙고 아무 일도 안 일어난다.
 */
export function needsFileScheme(url: string): boolean {
  if (/^(ssh|git|https?):\/\//i.test(url)) return false;
  // scp 형태: `user@host:path`
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(url)) return false;
  // 절대/상대 경로, 물결표, Windows 드라이브
  return /^[/.~]/.test(url) || /^[A-Za-z]:[\\/]/.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

export function cloneArgs(p: ClonePlan): string[] {
  const args = ["clone"];
  if (p.depth !== null) args.push("--depth", String(p.depth));
  if (p.branch) args.push("--branch", p.branch);
  // `--` 로 경로와 옵션을 분리한다. 디렉터리 이름이 `-` 로 시작하면 옵션으로 읽힌다.
  args.push("--", p.url, p.dir);
  return args;
}

export interface CommitPlan {
  message: string;
  paths: string[];
  all: boolean;
  /** 빈 커밋 허용? 기본 false — "아무것도 안 한 커밋" 은 이력의 노이즈다. */
  allowEmpty: boolean;
}

export type CommitDecision =
  | { ok: true; args: string[]; message: string }
  | { ok: false; reason: "empty-message" | "no-paths" | "too-long"; detail: string };

/**
 * 커밋 계획. **사전 검사가 핵심**:
 *  - 메시지가 비면 브라우저/에이전트가 빈 커밋을 반복한다(히스토리 오염)
 *  - 경로가 없으면 `git commit -a` 로 **모두** 커밋된다 — 사용자가 고른 것만 커밋해야 한다
 *  - 메시지가 너무 길면 첫 줄만 제목이 되고 나머지는 잘린다(사용자는 모른다)
 */
export function planCommit(plan: CommitPlan): CommitDecision {
  const msg = plan.message.trim();
  if (!msg) return { ok: false, reason: "empty-message", detail: "커밋 메시지가 비어 있습니다" };
  if (msg.length > 500) return { ok: false, reason: "too-long", detail: `메시지가 ${msg.length}자로 너무 깁니다 (500자 이내)` };
  if (!plan.all && plan.paths.length === 0) {
    return { ok: false, reason: "no-paths", detail: "커밋할 파일을 선택하십시오" };
  }
  const args = ["commit", "-m", msg];
  if (plan.all) args.push("-a");
  else {
    args.push("--");
    for (const p of plan.paths) args.push(p);
  }
  return { ok: true, args, message: msg.split("\n")[0].slice(0, 72) };
}

/**
 * 병합 실패가 **충돌** 인가.
 *
 * **에러 메시지 문자열로 판별하지 않는다.** git 의 메시지는 로케일 따라 바뀐다 —
 * 이 머신의 git 은 한국어로 "충돌 (내용): a.txt에 병합 충돌" 이라고 말한다(실측).
 * 영문 "CONFLICT" 를 찾으면 **모든 충돌이 일반 오류로 분류**되고, 사용자는
 * "해결하면 되는 문제" 를 "모르는 문제" 로 받는다.
 *
 * 판별은 **기계가 읽을 수 있는 사실** 로 한다: 병합이 실패한 뒤 **미해결 경로가
 * 남아 있으면** 충돌이다. `git status` 의 상태 코드이지 사람이 쓴 문장이 아니다.
 */
async function unmergedPaths(cwd: string): Promise<string[]> {
  const r = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  return r.ok ? r.value.split("\n").filter(Boolean) : [];
}

export type PullOutcome = "up-to-date" | "merged" | "conflict" | "rejected" | "error";

export interface PullResult {
  ok: boolean;
  /** 무엇이 있었는지 — 사용자가 "왜 안 됐지" 를 추측하지 않게. */
  outcome: PullOutcome;
  filesChanged: string[];
  detail: string;
  /** 충돌이므로 **사용자가 해결해야** 하는가. */
  needsUser: boolean;
}

/**
 * pull.
 *
 * `--no-edit` 로 머지 메시지 자동 생성을 막고, **충돌하면 그 자리에서 멈춘다.**
 * `-X ours`/`-X theirs` 같은 자동 해결 옵션을 **어절로도 넣지 않는다** — 넣는 순간
 * "자동병합 없이 중단" 이라는 요구가 깨진다.
 */
/**
 * clone 실행.
 *
 * ENV(터미널 프롬프트 차단·페이지러 무음 등)는 **이 모듈의 것이며** 밖에서 다시 만들지
 * 않는다. 두 벌의 git 환경이 있으면 "이쪽에서는 동작하고 저쪽에서는 안 된다" 가 된다.
 *
 * 실패는 **원인 문장 그대로** 돌려준다. "clone 실패" 만으로는 사용자가 아무것도 못
 * 고친다 — 키가 없다든가, 주소가 틀렸다든가 말해야 한다.
 */
export async function clone(plan: ClonePlan): Promise<GitResult<{ dir: string; tail: string[] }>> {
  try {
    // **cwd 는 목적지의 부모** 다 — `git clone` 이 그 디렉터리를 **만든다.**
    // 존재하지 않는 디렉터리로 cwd 를 잡으면 spawn 자체가 실패하고 원인이 빈 문자열이 된다
    // (실측: "알 수 없는 오류" 만 남고 진짜 이유를 잃었다).
    const { stdout, stderr } = await run("git", cloneArgs(plan), {
      cwd: dirname(plan.dir),
      env: { ...process.env, ...ENV },
      timeout: 600_000,
    });
    return { ok: true, value: { dir: plan.dir, tail: `${stdout}${stderr}`.trim().split("\n").slice(-8) } };
  } catch (e) {
    return { ok: false, reason: "failed", detail: describeGitError(e) };
  }
}

/** git 실패에서 사람이 읽을 수 있는 원인을 꺼낸다(내부 스택은 노출하지 않는다). */
export function describeGitError(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string; code?: string } | undefined;
  const raw = [String(err?.stderr ?? ""), String(err?.stdout ?? ""), String(err?.message ?? "")].filter(Boolean).join("\n");
  // **spawn 자체가 실패한 경우**엔 stderr 도 message 도 비어 있을 수 있다. 그때
  // "알 수 없는 오류" 만 남으면 사용자가 아무것도 못 고친다(실측).
  if (err?.code === "ENOENT") return "git 실행 파일을 찾을 수 없습니다 — git 이 설치되어 있는지 확인하십시오.";
  // git 은 잡음과 원인을 함께 찍는다. `fatal:`/`error:` 를 먼저 찾고, 없으면 마지막 줄.
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("fatal:") || l.startsWith("error:")) ?? lines[lines.length - 1] ?? "";
  if (/Permission denied|publickey|Could not read from remote repository/i.test(raw)) {
    return `${line} — SSH 키가 없거나 등록되지 않았습니다. https 로 시도하거나 키를 등록하십시오.`;
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled/i.test(raw)) {
    return `${line} — 인증에 실패했습니다. 개인 접근 토큰이 필요합니다.`;
  }
  if (/not a git repository/i.test(raw)) return "저장소가 아닙니다 — .git 이 없습니다.";
  return line;
}

/**
 * 저장소의 **현재 브랜치**.
 *
 * "main" 을 기본값으로 박아두면 `master` 저장소에서 pull 이 "원격에 새 변경이 없습니다"
 * 라고 **거짓말** 한다(실측: 다른 브랜치를 물어봤는데 없는 브랜치라 조용히 통과했다).
 * 없는 브랜치를 조용히 통과시키는 것이 pull 에서 가장 나쁜 실패다 — 사용자는
 * "받았다"고 믿고 코드를 잃는다.
 */
export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const name = r.ok ? r.value.trim() : "";
  return name && name !== "HEAD" ? name : "main";
}

/**
 * 커밋 실행.
 *
 * `planCommit` 은 **판단만** 한다("커밋할 수 있는가"). 여기가 실행한다.
 *
 * 두 가지 를 여기서 지킨다:
 *  1. **경로 검증** — 클라이언트가 보낸 파일 목록은 그대로 `git commit` 에 들어간다.
 *     인자 배열이라 쉼 인젝션은 막히지만, **저장소 밖 경로** 를 넘기면 커밋의 범위가
 *     사용자가 고른 것과 달라진다. 그래서 루트 안인지 먼저 확인하고, 아니라면 **경로 이름과
 *     함께** 거부한다.
 *  2. **결과는 커밋 해시로** 돌려준다. "성공" 만 돌려주면 화면이 무엇이 바뀌었는지
 *     모른다 — 변경 검토 흐름에서 커밋 해시는 나중에 다시 필요해진다.
 */
export async function commit(cwd: string, plan: CommitPlan): Promise<GitResult<{ hash: string; message: string; files: string[] }>> {
  const decision = planCommit(plan);
  if (!decision.ok) return { ok: false, reason: decision.reason === "empty-message" ? "nothing-to-commit" : "failed", detail: decision.detail };

  // **루트 밖 경로를 거른다.** git 은 조용히 무시하는 경우가 아니라, 저장소 밖
  // 경로면 "pathspec" 오류를 낸다 — 어느 쪽이든 사용자가 고른 파일만 커밋돼야 한다.
  const root = resolve(cwd);
  const outside = plan.all ? [] : plan.paths.filter((p) => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
    return abs !== root && !abs.startsWith(`${root}/`);
  });
  if (outside.length > 0) {
    // **별도 사유** 다. "failed" 로 뭉개면 라우트가 500 을 내고, 사용자에게는
    // 서버가 고장난 것처럼 보인다 — 실제로 틀린 경로는 400(사용자 입력) 이다.
    return { ok: false, reason: "outside-path", detail: `저장소 밖의 경로는 커밋할 수 없습니다: ${outside.join(", ")}` };
  }

  // **선택한 경로를 먼저 스테이징한다.**
  //
  // `git commit -- <경로>` 는 **이미 추적된** 파일만 커밋한다. 새로 만든 파일을
  // 지정하면 `pathspec ... did not match any file(s) known to git` 로 실패한다
  // (실측) — 즉 **새 파일 커밋이 한 번도 동작하지 않았다.** AI 가 만든 새 파일이
  // 가장 흔한 경우라, 화면에서 파일을 고르고 커밋하면 늘 이 오류였다.
  // "선택" 이라는 뜻에 스테이징이 포함된다.
  if (!plan.all && plan.paths.length > 0) {
    const add = await git(["add", "--", ...plan.paths], cwd, 30_000);
    if (!add.ok) return { ok: false, reason: add.reason, detail: `스테이징 실패: ${add.detail}` };
  }

  const r = await git(decision.args, cwd, 60_000);
  if (!r.ok) {
    // 스테이징은 이미 됐다. **그 사실을 말하지 않으면** 사용자는 "커밋이 안 됐다" 는
    // 메시지만 보고 `git status` 에는 파일이 올라가 있는 의아한 상태에 놓인다.
    return {
      ok: false,
      reason: r.reason,
      detail: `${r.detail}${plan.all || plan.paths.length === 0 ? "" : " (선택한 파일은 스테이징된 상태로 남았습니다)"}`,
    };
  }
  // 해시는 **커밋 뒤에** 읽는다 — 미리 읽으면 직전 커밋의 해시를 말한다(옛 사실).
  const head = await git(["rev-parse", "HEAD"], cwd, 10_000);
  return {
    ok: true,
    value: {
      hash: head.ok ? head.value.trim() : "",
      message: decision.message,
      files: plan.all ? [] : [...plan.paths],
    },
  };
}

export async function pull(cwd: string, branch = "main"): Promise<PullResult> {
  // **`--` 를 넣으면 안 된다.** `--` 는 *경로(pathspec)* 구분자다. `git fetch -- origin main`
  // 은 "origin 과 main 을 경로로.fetch 하라" 가 되고 실제론 `does not appear to be a
  // git repository` 로 실패한다(실제로 그랬다). 원격/브랜치 이름은 경로가 아니라
  // **인자** 다. 인자 배열로 넘기면 공백·쉼·따옴표가 있어도 안전하므로 주입 방지도 된다.
  const fetch = await git(["fetch", "origin", branch], cwd, 120_000);
  if (!fetch.ok) {
    return {
      ok: false,
      outcome: fetch.reason === "rejected" ? "rejected" : "error",
      filesChanged: [],
      detail: fetch.detail,
      needsUser: false,
    };
  }
  // 병합 **전** HEAD. 무엇이 실제로 바뀌었는지 말하려면 "전" 이 있어야 한다.
  const headBefore = await git(["rev-parse", "HEAD"], cwd).then((r) => (r.ok ? r.value.trim() : ""));
  const merge = await git(["merge", "--no-edit", "--", "FETCH_HEAD"], cwd, 60_000);

  // 병합이 **실패했을 때** 얕은 복사 여부를 본다.
  // 얕은 복사에는 공통 조상(merge base)이 없어 git 이 병합을 거부한다. 그 메시지를
  // 그대로 돌려주면 사용자는 **충돌**(해결 가능)과 **설정 문제**(복구 필요)를
  // 구분하지 못한다. 그래서 **행동 지침** 을 붙인다.
  if (!merge.ok) {
    const shallowRes = await git(["rev-parse", "--is-shallow-repository"], cwd);
    if (shallowRes.ok && shallowRes.value.trim() === "true") {
      return {
        ok: false,
        outcome: "error",
        filesChanged: [],
        detail: `얕은 복사(--depth)에서는 병합할 수 없습니다 (${merge.detail}). 전체 이력이 필요합니다: git fetch --unshallow`,
        needsUser: false,
      };
    }
  }

  if (!merge.ok) {
    // **충돌 여부는 메시지가 아니라 미해결 경로로 판별한다.** 이 머신의 git 은
    // 한국어로 말하고(실측), 영문 "CONFLICT" 를 찾으면 **모든 충돌이 일반 오류** 가 된다.
    const unmerged = await unmergedPaths(cwd);
    if (unmerged.length > 0) {
      // 여기서 **멈춘다.** 되돌리지도 자동 해결하지도 않는다.
      // 사용자가 diff 를 보고 결정해야 한다(§5.2 가로 diff, M2 변경 검토).
      return {
        ok: false,
        outcome: "conflict",
        filesChanged: unmerged,
        detail: `충돌이 있어 중단했습니다 (${unmerged.length}개 파일: ${unmerged.slice(0, 3).join(", ")}). 자동 병합하지 않았습니다 — 변경 검토에서 해결하십시오.`,
        needsUser: true,
      };
    }
    // 충돌이 아닌 실패. 얕은 복사에는 **공통 조상(merge base) 이 없어** 병합이
    // 실패할 수 있다(git 2.53.0 실측: fast-forward 는 되고, 갈라진 병합은 조용히
    // 되돌아가지 않는다). 실패했을 때 그 가능성을 **먼저** 말해준다 — 사용자가
    // 해결할 충돌(needsUser)과 복구할 설정 문제가 다르게 다루어져야 하기 때문이다.
    const shallowRes = await git(["rev-parse", "--is-shallow-repository"], cwd);
    if (shallowRes.ok && shallowRes.value.trim() === "true") {
      return {
        ok: false,
        outcome: "error",
        filesChanged: [],
        detail: `얕은 복사(--depth)에서는 병합할 수 없습니다 (${merge.detail}). 전체 이력이 필요합니다: git fetch --unshallow`,
        needsUser: false,
      };
    }
    return { ok: false, outcome: "error", filesChanged: [], detail: merge.detail, needsUser: false };
  }

  // HEAD 를 **병합 후** 에 읽어 "실제로 뭐가 바뀌었는지" 를 말한다.
  // 실패하면 **빈 목록** 으로 진행한다 — rev-parse 실패로 pull 전체를 실패시키면
  // 병합은 이미 끝난 뒤인데 "실패" 라고 보고된다(사용자는 실제로 반영된 걸 실패로 믿는다).
  // rev-parse 실패는 **빈 문자열** 이다. 병합은 이미 끝났는데 여기서 실패를 던지면
  // "실제로 반영된 변경" 을 사용자가 실패로 믿는다.
  const headAfter = await git(["rev-parse", "HEAD"], cwd).then((r) => (r.ok ? r.value.trim() : ""));

  if (headBefore && headAfter && headBefore === headAfter) {
    return { ok: true, outcome: "up-to-date", filesChanged: [], detail: "원격에 새 변경이 없습니다", needsUser: false };
  }
  let files: string[] = [];
  if (headBefore && headAfter) {
    const changed = await git(["diff", "--name-only", `${headBefore}..${headAfter}`], cwd);
    if (changed.ok) files = changed.value.split("\n").filter(Boolean);
  }
  return { ok: true, outcome: "merged", filesChanged: files, detail: `${files.length}개 파일을 병합했습니다`, needsUser: false };
}

export interface PushResult {
  ok: boolean;
  outcome: "pushed" | "up-to-date" | "rejected" | "error";
  detail: string;
  /** 거절됐으면 pull 해야 하는가. */
  needsPull: boolean;
}

export async function push(cwd: string, branch = "main", setUpstream = false): Promise<PushResult> {
  const args = ["push"];
  if (setUpstream) args.push("--set-upstream", "origin", branch);
  else args.push("origin", `HEAD:${branch}`);
  const r = await git(args, cwd, 120_000);
  if (r.ok) {
    return { ok: true, outcome: "pushed", detail: "원격에 반영했습니다", needsPull: false };
  }
  if (r.reason === "rejected") {
    return {
      ok: false,
      outcome: "rejected",
      detail: "원격이 로컬보다 앞섭니다. pull(충돌 시 중단) 후 다시 시도하십시오.",
      needsPull: true,
    };
  }
  return { ok: false, outcome: "error", detail: r.detail, needsPull: false };
}

export interface StatusSummary {
  branch: string | null;
  ahead: number;
  behind: number;
  /**
   * 얕은 복사(`--depth 1`)인가.
   *
   * 얕은 저장소는 **ahead/behind 를 계산할 수 없다.** 그런데 0 을 돌려주면
   * "동기화되어 있습니다" 라고 말하는 셈이 되고, 실제로는 원격에 100커밋이
   * 쌓여 있을 수 있다. **0 과 모름을 구분한다.**
   */
  shallow: boolean;
  files: { path: string; code: string; staged: boolean; status: string }[];
  clean: boolean;
}

/** 상태 요약. **ahead/behind** 를 숫자로 — "동기화 안 됨" 만 말하면 무엇을 할지 모른다. */
export async function summarize(cwd: string): Promise<GitResult<StatusSummary>> {
  const s = await git(["status", "--porcelain=v1", "-b", "--ahead-behind"], cwd);
  if (!s.ok) return s;
  const shallowRes = await git(["rev-parse", "--is-shallow-repository"], cwd);
  const shallow = shallowRes.ok && shallowRes.value.trim() === "true";
  let ahead = 0;
  let behind = 0;
  let branch: string | null = null;
  const files: StatusSummary["files"] = [];
  for (const line of s.value.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("## ")) {
      const rest = line.slice(3);
      const [name, counts] = rest.split("...");
      branch = name.replace(/^[^ ]* /, "") || null;
      if (counts) {
        const a = counts.match(/ahead (\d+)/);
        const b = counts.match(/behind (\d+)/);
        ahead = a ? Number(a[1]) : 0;
        behind = b ? Number(b[1]) : 0;
      }
      continue;
    }
    const code = line.slice(0, 2);
    const path = line.slice(3);
    const kind = code === "??" ? "untracked" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : code.includes("M") ? "modified" : "unknown";
    files.push({ path, code, staged: code[0] !== " " && code[0] !== "?", status: kind });
  }
  return { ok: true, value: { branch, ahead, behind, shallow, files, clean: files.length === 0 } };
}

/** 사람이 읽을 한 줄. */
export function summaryLabel(s: StatusSummary): string {
  const parts: string[] = [];
  if (s.files.length) parts.push(`변경 ${s.files.length}개`);
  if (s.ahead) parts.push(`로컬에 ${s.ahead}커밋 미전송`);
  // **behind 는 "마지막 fetch 이후" 기준이다.** fetch 하지 않았는데 0 이라고 말하면
  // "동기화되어 있습니다" 라는 뜻이 되지만 실제로는 원격에 100커밋이 있을 수 있다.
  // 그래서 기준을 **항상 함께** 말한다(실제로 이 오독이 있었다).
  if (s.behind) parts.push(`원격에 ${s.behind}커밋 미반영 (마지막 fetch 기준)`);
  // 얕은 복사에서는 앞/behind 자체를 계산할 수 없다. **0 과 모름을 구분한다.**
  if (s.shallow) parts.push("얕은 복사 — 원격과의 차이를 계산할 수 없습니다 (fetch --unshallow 필요)");
  if (!parts.length) return `${s.branch ?? "?"} — 깨끗하고 동기화됨 (마지막 fetch 기준)`;
  return `${s.branch ?? "?"} — ${parts.join(" · ")}`;
}

/** force push 는 **거부**한다. 실수로 원격 이력을 지우는 경로를 만들지 않는다. */
export function rejectForce(args: string[]): { ok: boolean; reason?: string } {
  if (args.includes("--force") || args.includes("-f") || args.includes("--force-with-lease")) {
    return { ok: false, reason: "force push 는 허용되지 않습니다" };
  }
  return { ok: true };
}
