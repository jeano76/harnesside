/**
 * 터미널 (M1 · §11.1).
 *
 * 셸 하나가 아니라 **탭 여러 개** 다. 그래서 여기는 셸이 아니라 **세션 관리자** 다:
 *  - `create` 가 탭을 열고, `write`/`resize` 로 건드리고, `close` 로 닫는다.
 *  - **종료한 탭은 즉시 지우지 않는다.** 지우면 사용자는 "셸이 죽었다" 와 "탭이
 *    없다" 를 구분할 수 없다. exit code 를 **보존**한다 — 0(정상 종료)과 exit code
 *    없음(강제 종료/signals)은 **다른 사실**이다(§5.10 store.list 와 같은 교훈).
 *  - 살아 있는 세션과 죽은 세션을 **같은 목록에 두되 상태로 구분**한다.
 *
 * cwd 는 워크스페이스 안으로 제한한다. `cd /` 를 허용하면 루트 권한으로 임의 실행된다 —
 * 에이전트가 승인 없이 그 셸을 쓴다.
 *
 * 창을 닫을 때 **살아 있는 탭은 전부 죽는다** — 사용자가 안 닫은 셸이 조용히 남으면
 * 다음 실행에서 리소스를 먹는다(§4.4 와 같은 논리).
 */

import { spawn as ptySpawn, type IPty } from "node-pty";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { realpathSync, statSync, accessSync, constants as fsConstants } from "node:fs";

/**
 * 셸 인자를 **하나의 인자**로 만든다.
 *
 * 경로에 공백이 있으면 `cd /내 공간` 이 두 인자로 쪼개져 엉뚱한 곳으로 간다. 사용자
 * 폴더명에 공백이 있는 것은 흔하고, 그때마다 "탐색이 고장났다" 고 보인다.
 * `'` 안의 모든 것을 이스케이프하는 것이 표준적인 방법이다.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 셸 후보를 **우선순위대로** 만든다.
 *
 * 순서: 사용자가 명시한 값 → `$SHELL` → 흔히 있는 순서. **존재하지 않는 경로는
 * 나중에 걸러진다** — 여기서 판정하려고 `access` 하지 않는다(TOCTOU: 확인한 뒤에
 * 사라질 수 있다). 실제로 띄워보고 살아 있는 것을 쓴다.
 */
export function shellCandidates(explicit: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  add(explicit);
  add(env.SHELL);
  // **가장 흔한 순서.** bash 는 마지막이다 — 없어도 되는 셸이라서(그리고 없는
  // 머신에서 첫 후보가 되어 전부 실패하게 만든다).
  for (const p of ["/bin/sh", "/usr/bin/sh", "/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/fish", "/usr/bin/fish"]) {
    add(p);
  }
  return out;
}

/** PTY 를 env 로 만든다. **UTF-8 을 강제**한다 — 그래야 셸에서 한글이 깨지지 않는다. */
export function ptyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // LC_ALL 은 **삭제**한다. 빈 문자열("")로 두면 glibc 가 UTF-8 로 보지 않아
  // `ls` 가 한글을 `$'\345\...' ` 8진 이스케이프로 찍는다(2026-10-04 실측:
  // LC_ALL="" → 깨짐, unset → 정상). `LANG` 을 UTF-8 로 맞춰도 이긴다.
  const { LC_ALL: _dropped, ...rest } = env;
  void _dropped;
  return {
    ...rest,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    // **사용자 로캘을 그대로 쓰지 않는다.** LANG 이 `C` 또는 `POSIX` 면 로케일 인식이
    // 꺼져서 **한글이 깨진다**(실측: LANG=C 인 컨테이너에서 PTY 출력의 UTF-8 이 깨진다).
    // 사용자가 `ko_KR.UTF-8` 을 골랐다면 그것을 우선하되, **UTF-8 이 아니면 물려받은다.**
    LANG: /UTF-?8$/i.test(env.LANG ?? "") ? env.LANG! : "ko_KR.UTF-8",
  };
}

/** 후보 하나를 **실제로 띄워봐서** 살았는지 확인한다. */
function trySpawn(shell: string, cwd: string, cols: number, rows: number): { pty: IPty } | null {
  try {
    const pty = ptySpawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env: ptyEnv(process.env) });
    // 즉시 죽으면 존재하지 않는 실행 파일이다. `node-pty` 는 없는 셸에 throw 하지 않고
    // PTY 를 연 뒤 `execvp(3) failed.` 로 죽는다(실측).
    const pid = pty.pid;
    if (typeof pid === "number" && pid <= 0) {
      pty.kill();
      return null;
    }
    return { pty };
  } catch {
    return null;
  }
}

export type SessionState = "running" | "exited";

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  state: SessionState;
  startedAt: number;
  /** 종료 시각. 살아 있으면 null — **0 이 아니다.** */
  exitedAt: number | null;
  /** 종료 코드. 강제 종료(signals)면 null — 0(성공)이 아니다. */
  exitCode: number | null;
  /** 종료 신호(예: SIGHUP). null 이면 정상 종료. */
  exitSignal: number | null;
  /**
   * **셸을 아예 띄우지 못했다** 면 이유. null 이면 "정상적으로 끝났다" 가 아니라
   * "애초에 실행되지 않았다" 다.
   *
   * 이 필드가 없으면 못 띄운 셸과 1초 뒤 죽은 셸이 화면에서 똑같다(실측: node-pty 는
   * 없는 셸에 대해 throw 하지 않고 PTY 를 열고 `execvp(3) failed` 를 찍고 exit 1 한다).
   * 사용자는 탭이 열렸다 사라지는 것만 보고 "터미널이 고장났다" 고 판단한다.
   */
  openError: string | null;
  /** 화면 크기. resize 로 바뀐다. */
  cols: number;
  rows: number;
  /** 실제로 뜬 셸 — 요청과 다를 수 있다(없으면 폴백). 모르면 빈 문자열이 아니라 null. */
  shell: string | null;
}

export interface TerminalEvents {
  /** 화면에 바쳐야 할 바이트. */
  onData: (id: string, data: string) => void;
  /** 세션 상태가 바뀜 — 탭 제목 옆에 "종료됨(exit 1)" 이 보인다. */
  onExit: (s: TerminalSession) => void;
  onWarn: (message: string) => void;
}

/**
 * `create` 의 결과. **성공/실패가 드러나야 한다.**
 *
 * 이전에는 실패했을 때 **이미 열린 다른 탭** 을 돌려줬다 — 화면은 그 탭이 방금 열린
 * 것으로 그려 "열렸는데 목록에 하나도 안 늘었다" 가 된다. 실패는 실패로 말해야 하고,
 * 그때 `session` 은 null 이다(목록에 없는 가짜 탭을 만들지 않는다).
 */
export type CreateResult =
  | { ok: true; session: TerminalSession; detail: string }
  | { ok: false; session: null; detail: string };

export interface TerminalManagerOptions {
  /** cwd 를 이 안에 가둔다. */
  root: string;
  /** 기본 셸. */
  shell?: string;
  now?: () => number;
  /** 최대 탭 수 — 무한정 열리면 프로세스가 무한정 생긴다. */
  maxTabs?: number;
  events: TerminalEvents;
}

interface Entry {
  session: TerminalSession;
  pty: IPty | null;
  /** 사용자가 입력 중인지 — AI 가 대신 입력하면 사용자와 섞인다(§5.2 M2). */
  busyInput: boolean;
}

export class TerminalManager {
  private tabs = new Map<string, Entry>();
  private order: string[] = [];
  /** 2026-10-01: 셸 탐색 막대가 바꾼 **공유 작업 경로**. */
  private workingDir: string | null = null;
  /** 최근 본 디렉터리(최신순). */
  private recent: string[] = [];

  constructor(private opts: TerminalManagerOptions) {
    // 시작점도 기억에 넣는다 — 처음 목록이 비어 있으면 "이 기능이 안 돈다" 고 읽힌다.
    this.recent = [this.opts.root];
  }

  list(): TerminalSession[] {
    // **순서를 정해 반환한다.** Map 은 삽입 순서지만 " guaranteeing" 아니라
    // "최근 쓴 탭이 먼저" 를 화면이 가정하면 언제든 틀린다.
    return this.order.map((id) => this.tabs.get(id)?.session).filter((s): s is TerminalSession => !!s);
  }

  get(id: string): TerminalSession | null {
    return this.tabs.get(id)?.session ?? null;
  }

  get busy(): boolean {
    return [...this.tabs.values()].some((e) => e.busyInput);
  }

  /**
   * **작업 경로(cwd)** — 2026-10-01.
   *
   * 셸 위쪽 탐색 막대에서 옮긴 디렉터리가 곧 이 값이고, **새로 여는 모든 탭의 시작점**이
   * 된다. 한 곳에 있어야 "탭마다 다른 곳에서 일한다" 는 상태가 생기지 않는다.
   *
   * 루트 밖으로는 못 간다 — 에이전트 승인 게이트를 무의미하게 만드는 것과 같으므로
   * `create` 와 **같은 규칙**을 쓴다(두 곳에 쓰면 나중에 한쪽이 빠진다).
   */
  get cwd(): string {
    return this.workingDir ?? this.opts.root;
  }

  /**
   * **경계** — 셸이 나갈 수 없는 루트. `cwd` 와 다르다(사용자가 옮길 수 있다).
   * 화면의 탐색 막대가 "위로" 를 어디까지 되돌릴 수 있는지 판단하려면 이 값이 필요하다.
   */
  get root(): string {
    return this.opts.root;
  }

  /**
   * 디렉터리를 바꾼다. **실제로 존재하고 루트 안일 때만** 받는다.
   *
   * 존재하지 않는 경로를 작업 경로로 삼으면 이후 모든 명령이 그 자리에서 실패하는데,
   * 화면은 "바뀜" 이라고 말하고 있다. 그래서 **한 번 실제로 확인**한다.
   */
  async setCwd(next: string): Promise<{ ok: boolean; cwd: string; detail: string }> {
    const root = resolve(this.opts.root);
    // **인자 순서가 곧 동작이다** (2026-10-01 실측). `resolve(next, this.cwd)` 로 쓰면
    // `path.resolve` 는 **오른쪽부터** 적용하므로 마지막의 절대경로가 이기고 `next` 는
    // **조용히 버려진다**. 결과는 항상 cwd === 그대로인데, 존재 검사를 통과하므로
    // `ok: true` 까지 반환된다 — **움직이지 않았는데 성공이라고 말한다.**
    //
    // 이게 "디렉터리를 선택해도 이동하지 않는다" 는 버그의 정체였다. 왼쪽이 기준,
    // 오른쪽이 대상이다.
    const target = resolve(this.cwd, next);
    if (target !== root && !target.startsWith(`${root}/`)) {
      // **루트 밖은 조용히 루트로 되돌리지 않는다.** 이유를 말한다 — 그래야
      // "왜 안 바뀌지" 를 사용자가 따로 찾아보지 않는다.
      return { ok: false, cwd: this.cwd, detail: `루트(${root}) 밖으로는 이동할 수 없습니다: ${next}` };
    }
    const st = await stat(target).catch(() => null);
    if (!st?.isDirectory()) return { ok: false, cwd: this.cwd, detail: `디렉터리가 아닙니다: ${next}` };
    this.workingDir = target;
    this.remember(target);
    // **열려 있는 모든 탭을 그 자리로 옮긴다.** 한 곳에서 일하게 하는 것이 목적이다.
    // `cd` 를 PTY 에 쓰는 게 아니라 세션 값을 바꾸는 방식인데, 셸의 실제 프롬프트는
    // 사용자가 직접 `cd` 로 바꿀 수 있다 — 그래서 화면은 **마지막으로 알고 있는 값**을
    // 보여준다고 명시한다(거짓말하지 않기 위해).
    for (const e of this.tabs.values()) {
      if (e.session.state !== "running" || !e.pty) continue;
      e.session.cwd = target;
      e.pty.write(`cd ${shellQuote(target)}\n`);
    }
    return { ok: true, cwd: target, detail: `작업 경로 변경: ${target}` };
  }

  /**
   * **최근 본 디렉터리.** 셸 위쪽 목록이 이것을 쓴다.
   *
   * 개수가 아니라 **목록**이라서 최근 순서를 그대로 노출한다. 같은 경로를 다시 고르면
   * 맨 위로 올라간다 — 사용자가 자주 가는 곳이 자주 가는 곳이 되게.
   */
  recentDirs(limit = 12): string[] {
    return this.recent.slice(0, limit);
  }

  private remember(dir: string): void {
    this.recent = [dir, ...this.recent.filter((d) => d !== dir)].slice(0, 20);
  }

  /**
   * 탭을 연다.
   *
   * 실패하면 **왜인지 말하고 아무것도 만들지 않는다.** 셸이 없는데 "탭 열림" 을
   * 말하면 사용자는 아무것도 안 보이는 탭을 붙잡게 된다.
   */
  create(
    opts: { cwd?: string; cols?: number; rows?: number; title?: string; shell?: string; init?: string } = {}
  ): CreateResult {
    const max = this.opts.maxTabs ?? 8;
    const live = this.order.filter((id) => this.tabs.get(id)?.session.state === "running").length;
    if (live >= max) {
      this.opts.events.onWarn(`탭이 ${max}개 열려 있습니다 — 하나를 닫고 여십시오.`);
      return { ok: false, session: null, detail: `탭이 ${max}개 열려 있습니다` };
    }

    const requested = resolve(opts.cwd ?? this.cwd);
    const root = resolve(this.opts.root);
    // **cwd 는 루트 안이어야 한다.** 밖이면 새지 않는다 — 에이전트 승인 없이
    // 임의 디렉터리에서 셸이 돌아간다면 승인 게이트가 무의미해진다.
    //
    // **문자열 비교만으로는 안전하지 않다** (2026-10-01). macOS 는 `/tmp` 이 실제로
    // `/private/tmp` 이고, Linux 도 `/var` → `/private/var` 처럼 심볼릭 링크가 있다.
    // 경계가 링크를 **따라가지 않으면** 루트 안의 경로가 "밖" 으로 판정되거나(택한 쪽),
    // 링크로 벗어난 경로가 "안" 으로 판정된다(**새어나가는 쪽** — 게이트가 뚫린다).
    // **동기로** 한다 — `ptySpawn` 도 동기이므로, 경계 확인만 비동기면 셸이 뜨기 전에
    // 판정이 뒤집힌다.
    //
    // **없는 경로는 그 문자열을 그대로 쓰면 안 된다**(2026-10-01 실측). 경계 판정은
    // 통과하지만 `ptySpawn` 는 `chdir(2) failed.: No such file or directory` 를 찍고
    // exit 1 한다 — 즉 **cwd 가 존재하지 않는 탭이 "성공" 으로 열린다.** 사용자는
    // 잠깐 열린 탭을 본 뒤 셸이 사라지는 걸 겪고, 아무도 이유를 모른다.
    // 그래서 링크를 따라간 뒤 **존재하고 디렉터리인지** 확인하고, 아니면 루트로 되돌린다.
    const rp = (p: string): string => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const realRoot = rp(root);
    // **요청된 경로가 실제로 존재하는 디렉터리인지** 확인한다. 링크를 따라간 결과가
    // 파일이거나 디렉터리가 아니면 PTY 의 `chdir(2) failed` 로 죽는다(실측).
    const usable = (p: string): boolean => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    };
    const realCwd = rp(requested);
    const inside = realCwd === realRoot || realCwd.startsWith(`${realRoot}/`);
    // 루트 밖이면 **밖으로 새지 않는다.** 존재하지 않으면 루트로 되돌린다 — 없는
    // 경로로 셸을 여는 것은 "열렸다가 죽는 탭" 이다.
    const cwd = inside && usable(realCwd) ? realCwd : realRoot;
    const cols = Math.max(20, Math.min(400, Math.floor(opts.cols ?? 80)));
    const rows = Math.max(5, Math.min(200, Math.floor(opts.rows ?? 24)));

    // ── 셸을 고른다: **존재하는 것** 중에서 ────────────────────────────────
    //
    // 예전엔 `process.env.SHELL ?? "/bin/bash"` 였다. 두 가지가 잘못이었다:
    //  1. `/bin/bash` 는 **없을 수 있다** — Alpine(busybox) 이미지, 최소 컨테이너,
    //     NixOS 는 기본에 bash 가 없다. 그러면 **모든 셸이 열리지 않는다.**
    //  2. `$SHELL` 이 **없을 수도 있는 경로**일 수 있다 — 사용자의 로그인 셸이
    //     `/usr/local/bin/fish` 인데 그 경로가 사라진 경우.
    //
    // 그래서 **열어보고** 고른다. 후보를 순서대로 시도하고, 실제로 뜬 것을 쓴다.
    // 실패를 **사용자에게 말하지 않으면** 안 되므로, 하나도 안 뜨면 첫 후보로 가고
    // PTY 안의 `execvp failed` 문구를 그대로 보여준다(아래 onData).
    // 명시 요청이 있으면 그 셸을 먼저 — 없으면 폴백(프로브 순서대로).
    // 요청 경로 검증은 shellCandidates 가 아니라 여기서 한다: 절대경로가 아니면
    // 요청 자체를 버리고 기본 순서로 간다(상대경로는 PATH 탐색이라 엉뚱한 것이 뜬다).
    let explicit = opts.shell && opts.shell.startsWith("/") ? opts.shell : undefined;
    // 명시 경로가 실행 불가면 여기서 버린다 — node-pty 는 없는 셸도 일단 열어
    // `execvp failed` 를 뒤늦게 찍으므로, 프로브 순서만으로는 폴백이 안 된다(실측).
    if (explicit) {
      try {
        accessSync(explicit, fsConstants.X_OK);
      } catch {
        explicit = undefined;
      }
    }
    const candidates = shellCandidates(explicit ?? this.opts.shell, process.env);
    let shell = candidates[0]!;
    for (const cand of candidates) {
      const probe = trySpawn(cand, cwd, cols, rows);
      if (probe) {
        shell = cand;
        probe.pty.kill();
        break;
      }
    }

    const id = randomUUID();
    const session: TerminalSession = {
      id,
      title: opts.title ?? `셸 ${this.order.length + 1}`,
      cwd,
      state: "running",
      startedAt: (this.opts.now ?? Date.now)(),
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
      openError: null,
      cols,
      rows,
      shell,
    };

    let pty: IPty;
    try {
      pty = ptySpawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        // **사용자 셸 환경** 을 물려받되 로컬 변수는 뺀다 — PATH 에 개발용 junk 가 섞이면
        // 사용자가 터미널에서 못 찾는 명령이 나온다(measured: 로컬 PATH 에 phantomjs).
        // 로캘은 `ptyEnv` 가 UTF-8 로 맞춘다.
        env: ptyEnv(process.env),
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.opts.events.onWarn(`셸을 열지 못했습니다: ${detail}`);
      return { ok: false, session: null, detail };
    }

    const entry: Entry = { session, pty, busyInput: false };
    this.tabs.set(id, entry);
    this.order.unshift(id);
    // 초기 명령 — 한 줄만, 200자까지. 여러 줄이면 첫 줄만(주입이 아니라 초기 표시다).
    // 셸이 뜨자마자 `ls` 가 돌아가 있으면 "빈 검은 화면" 이 아니다(사용자 요구).
    if (opts.init && opts.init.trim()) {
      const first = opts.init.split("\n")[0]!.slice(0, 200);
      try {
        pty.write(`${first}\n`);
      } catch {
        // 쓰기 실패는 onData/onExit 경로가 말한다 — 여기서 409 로 막지 않는다
      }
    }
    pty.onData((d) => {
      // **PTY 안에서 나는 실패도 잡는다.** `node-pty` 는 없는 셸에 대해 throw 하지
      // 않고 PTY 를 연 뒤 `execvp(3) failed.` 를 화면에 찍고 exit 1 한다(실측).
      // 그 문구를 사용자에게 그대로 보여주고 "애초에 실행되지 않았다" 고 표시한다 —
      // 안 하면 탭이 열렸다 사라지고 아무도 이유를 모른다.
      // `chdir(2) failed` 도 **같은 종류의 실패** 다: PTY 가 떴지만 그 안의 셸은
      // 시작할 수 없다. 둘 다 잡지 않으면 사용자는 "열렸다가 죽는" 탭을 붙잡는다.
      const m = /(?:execvp\(\d+\) failed|chdir\(\d+\) failed[^\r\n]*)/.exec(d);
      if (m && !entry.session.openError) {
        entry.session = { ...entry.session, openError: m[0].trim(), title: "셸 열기 실패" };
        this.opts.events.onWarn(`셸을 열지 못했습니다: ${m[0].trim()}`);
      }
      this.opts.events.onData(id, d);
    });
    pty.onExit(({ exitCode, signal }) => {
      // **exit code 와 signal 을 구분한다.** 0 과 "없음" 을 같은 칸에 두면
      // "정상 종료" 와 "강제 죽음" 이 같아 보인다.
      //
      // node-pty 은 **정상 종료에도 `signal: 0` 을 준다**(POSIX 의 "신호 없음" 관례).
      // 그걸 그대로 "신호로 종료 (0)" 로 말하면 "이름을 모르는 이유로 죽었다" 가 되고,
      // **진짜 신호**(1 이상)와 같은 칸에 놓인다. 그래서 0 은 없다로 바꾼다(실측).
      entry.pty = null;
      entry.session = {
        ...entry.session,
        state: "exited",
        exitedAt: (this.opts.now ?? Date.now)(),
        exitCode: typeof exitCode === "number" ? exitCode : null,
        exitSignal: typeof signal === "number" && signal > 0 ? signal : null,
      };
      this.opts.events.onExit(entry.session);
    });
    return { ok: true, session, detail: "" };
  }

  /**
   * 입력을 보낸다.
   *
   * 죽은 탭에 쓰면 **버리지 않고 말한다.** 조용히 버리면 사용자는 타이핑했는데
   * 아무 반응이 없는 상태를 "셸이 멈췄다" 고 해석한다.
   */
  write(id: string, data: string): { ok: boolean; detail: string } {
    const e = this.tabs.get(id);
    if (!e) return { ok: false, detail: "그런 탭이 없습니다" };
    if (!e.pty) return { ok: false, detail: "이미 끝난 셸입니다 — 새 탭을 여십시오" };
    try {
      e.pty.write(data);
      return { ok: true, detail: "" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 창 크기를 바꾼다 — 반영되지 않으면 줄이 깨진다(가로 scroll 로 남는다). */
  resize(id: string, cols: number, rows: number): { ok: boolean; detail: string } {
    const e = this.tabs.get(id);
    if (!e?.pty) return { ok: false, detail: "살아 있는 셸이 없습니다" };
    const c = Math.max(20, Math.min(400, Math.floor(cols)));
    const r = Math.max(5, Math.min(200, Math.floor(rows)));
    try {
      e.pty.resize(c, r);
      e.session = { ...e.session, cols: c, rows: r };
      return { ok: true, detail: "" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 탭을 닫는다. `kill = false` 면 **목록에서만 지운다**(셸은 산 채로 두고 숨긴다) —
   * 살아 있는 프로세스를 "닫았다" 고 말하면 사용자는 그 프로세스가 없는 줄 안다.
   */
  close(id: string, kill = true): { ok: boolean; detail: string } {
    const e = this.tabs.get(id);
    if (!e) return { ok: false, detail: "그런 탭이 없습니다" };
    this.order = this.order.filter((x) => x !== id);
    this.tabs.delete(id);
    if (kill && e.pty) {
      try {
        e.pty.kill();
      } catch {
        // 이미 죽었을 수 있다 — **목록에서 뺐으므로 사용자에게는 없는 탭**이다.
      }
    }
    return { ok: true, detail: e.pty ? "" : "이미 끝난 셸이었습니다" };
  }

  /** 창을 닫을 때: **살아 있는 탭을 전부 죽인다**(조용히 남기지 않는다). */
  shutdown(): number {
    let killed = 0;
    for (const e of this.tabs.values()) {
      if (!e.pty) continue;
      try {
        e.pty.kill();
        killed++;
      } catch {
        /* 이미 죽음 */
      }
    }
    this.tabs.clear();
    this.order = [];
    return killed;
  }

}

/** 종료 상태를 **사람 문장** 으로 — 탭 제목 옆에 붙는 것. */
export function exitLabel(s: TerminalSession): string | null {
  if (s.state !== "exited") return null;
  // **애초에 실행되지 않은 것** 은 "종료됨" 이 아니다. 둘을 같은 문장으로 말하면
  // 사용자는 터미널이 스스로 죽었다고 생각한다.
  if (s.openError) return `셸 열기 실패 — ${s.openError}`;
  if (s.exitSignal !== null) return `신호로 종료 (${s.exitSignal})`;
  if (s.exitCode === null) return "종료됨 (코드 없음)";
  return s.exitCode === 0 ? "종료됨 (0)" : `종료됨 (${s.exitCode})`;
}
