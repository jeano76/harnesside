/**
 * 백그라운드 프로세스 + PTY 터미널 로직 (M1 · §5.11 신규 도구).
 *
 * 셸은 **PTY 없이** 만들면 대부분의 명령이 이상하게 동작한다(색 없음, 진행바 없음,
 * `isatty` 를 보는 프로그램이 이상모드로 빠짐). 그래서 PTY 를 쓴다.
 *
 * 여기서 순수 로직만 다룬다:
 *  - 프로세스 **수명주기**와 종료 코드 해석
 *  - **오프셋 이어읽기** (`read_process_output` — 긴 출력을 끊지 않고 계속 읽는다)
 *  - **취소** (M3 실행 취소와 짝을 이룬다)
 *
 * 실제 PTY spawn 은 플랫폼에 묶이므로 그 경계는 주입으로 받는다.
 */

export type ProcState = "starting" | "running" | "exited" | "killed" | "failed";

export interface Proc {
  id: string;
  /** 사람이 읽는 이름. UI 의 블록 제목이 된다. */
  title: string;
  command: string;
  cwd: string;
  state: ProcState;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
  /** 다음 읽기 오프셋. */
  cursor: number;
  /** 총 출력 바이트. */
  bytes: number;
  /** 잘려 나간 바이트(상한 초과분). 0 이 아니면 조용히 잘린 것이다. */
  dropped: number;
}

export interface ExitVerdict {
  ok: boolean;
  state: ProcState;
  /** 사람 문장 — 코드를 그대로 노출하지 않는다(§11.3). */
  message: string;
  /** 도구 호출이 실패를 알아야 하는가. */
  isError: boolean;
}

/**
 * 종료 해석.
 *
 * `0` 이 아니면 **실패**지만, "exit 1" 만 말하면 사용자는 모른다. 그리고
 * **시그널로 죽은 것**은 코드가 없는데 성공으로 오인하면 안 된다 — "OOM 로 죽었다" 는
 * 다른 원인이고, 재시도 정책이 다르다.
 */
export function judgeExit(p: Pick<Proc, "state" | "exitCode" | "signal" | "command">): ExitVerdict {
  if (p.state === "killed") {
    return { ok: false, state: "killed", message: `${p.command} 을(를) 사용자가 중단했습니다`, isError: false };
  }
  if (p.state === "failed") {
    return { ok: false, state: "failed", message: `${p.command} 을(를) 시작하지 못했습니다`, isError: true };
  }
  if (p.state !== "exited") {
    return { ok: false, state: p.state, message: `${p.command} 이(가) 아직 실행 중입니다`, isError: false };
  }
  if (p.signal) {
    return {
      ok: false,
      state: "exited",
      // 시그널 이름이 곧 원인이자 조언이다 (OOMKILL/SIGKILL 은 메모리).
      message: `${p.command} 이(가) ${p.signal} 로 종료되었습니다${p.signal === "SIGKILL" ? " — 메모리 부족일 수 있습니다" : ""}`,
      isError: true,
    };
  }
  if (p.exitCode === 0) {
    return { ok: false, state: "exited", message: `${p.command} 이(가) 정상 종료했습니다`, isError: false };
  }
  const code = p.exitCode;
  return {
    ok: false,
    state: "exited",
    message: `${p.command} 이(가) 종료 코드 ${code} 로 실패했습니다${code === 127 ? " — 명령을 찾을 수 없습니다" : code === 126 ? " — 실행 권한이 없습니다" : code === 130 ? " (Ctrl+C)" : ""}`,
    isError: true,
  };
}

export function isRunning(p: Proc): boolean {
  return p.state === "running" || p.state === "starting";
}

// ------------------------------------------------------------------ 출력 읽기

/** `read_process_output` 상한(한 번에 주는 바이트). */
export const READ_CHUNK = 32 * 1024;
export const MAX_KEPT = 2 * 1024 * 1024;

export interface ReadResult {
  text: string;
  /** 다음에 이 오프셋부터 읽으면 된다. */
  nextCursor: number;
  /** 더 남았는가. */
  more: boolean;
  /** 잘려 나간 총 바이트. */
  dropped: number;
}

/**
 * 오프셋 이어읽기.
 *
 * `cursor` 로 **이어서** 읽는 것이 요점이다 — 매번 처음부터 주면 긴 출력이
 * 잘려 나가므로, 사용자는 출력이 어디서 잘렸는지 알 수 없다.
 */
export function readFrom(all: string, cursor: number, max = READ_CHUNK): ReadResult {
  const start = Math.max(0, Math.min(cursor, all.length));
  const end = Math.min(all.length, start + max);
  return {
    text: all.slice(start, end),
    nextCursor: end,
    more: end < all.length,
    dropped: 0,
  };
}

export interface RingOutput {
  text: string;
  dropped: number;
}

/**
 * 출력 상한. **앞부분을 버리고 최신을 남긴다** — 로그/블록과 같은 원칙.
 * 앞부분(헤더)이 사라지는 것은 최악이지만, 상한을 넘겨 OOM 나면 그보다 나쁘다.
 * 어느 쪽이 잘렸는지는 반드시 말해야 한다.
 */
export function appendOutput(prev: RingOutput, chunk: string, max = MAX_KEPT): RingOutput {
  const next = prev.text + chunk;
  if (next.length <= max) return { text: next, dropped: prev.dropped };
  const keep = next.length - max;
  return { text: next.slice(keep), dropped: prev.dropped + keep };
}

export function outputDroppedLabel(r: RingOutput): string | null {
  if (r.dropped <= 0) return null;
  return `… 앞쪽 ${r.dropped.toLocaleString()}자가 상한(${MAX_KEPT.toLocaleString()}) 때문에 잘렸습니다`;
}

// ------------------------------------------------------------------ PTY 설정

export interface PtyOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** PTY 기본값. 크기가 0 이면 프로그램이 이상모드로 빠진다. */
export function defaultPty(cwd: string, env: Record<string, string>, cols = 120, rows = 30): PtyOptions {
  return {
    cols: Math.max(20, cols),
    rows: Math.max(5, rows),
    cwd,
    // **TERM 을 넣는다.** 없으면 ncurses/less 같은 프로그램이 색과 줄바꿈을 포기한다.
    env: { TERM: "xterm-256color", ...env },
  };
}

// ------------------------------------------------------------------ M3 취소

export interface TurnState {
  id: string;
  state: "running" | "cancelling" | "cancelled" | "done" | "failed";
  /** 진행 중 도구/프로세스 id. 중단 시 이것들에 중단 신호를 간다. */
  running: string[];
  /** 취소는 **항상 가능**해야 한다. */
  cancellable: boolean;
  at: number;
  note: string | null;
}

export function newTurn(id: string, now = Date.now()): TurnState {
  return { id, state: "running", running: [], cancellable: true, at: now, note: null };
}

/**
 * 취소. **진행 중인 것들을 전부 멈춘다** — 취소했는데 도구가 계속 돌면
 * 사용자는 "취소 눌렀는데 왜 계속 되지?" 하고 버튼을 여러 번 누른다.
 */
export function cancelTurn(t: TurnState, now = Date.now()): { turn: TurnState; toAbort: string[] } {
  if (!t.cancellable) return { turn: t, toAbort: [] };
  return {
    turn: { ...t, state: "cancelled", running: [], note: t.running.length ? `${t.running.length}개 작업 중단` : null, at: now },
    toAbort: [...t.running],
  };
}

export function completeTurn(t: TurnState, ok: boolean, now = Date.now()): TurnState {
  return { ...t, state: ok ? "done" : "failed", running: [], at: now };
}

/** 이미 끝난 턴은 취소할 수 없다 — "취소됨" 이 중복으로 쌓이면 안 된다. */
export function canCancel(t: TurnState): boolean {
  return t.cancellable && (t.state === "running" || t.state === "cancelling");
}

export function turnLabel(t: TurnState): string {
  switch (t.state) {
    case "running":
      return `실행 중${t.running.length ? ` (${t.running.length}개 작업)` : ""}`;
    case "cancelling":
      return "중단 중…";
    case "cancelled":
      return t.note ? `중단됨 — ${t.note}` : "중단됨";
    case "done":
      return "완료";
    case "failed":
      return "실패";
  }
}

// ------------------------------------------------------------------ M2 리뷰 연동

export interface ProcFileTouch {
  path: string;
  /** 이 프로세스가 만든 것인가. 사람이 만든 것과 구분해야 한다. */
  byProcess: string | null;
}

/**
 * 프로세스가 만든 파일은 **기본적으로 검토 대상**이다(M2). 사람이 만든 파일과
 * 같은 취급하면 "누가 이걸 바꿨지" 알 수 없다.
 */
export function reviewTargets(touched: ProcFileTouch[]): ProcFileTouch[] {
  return touched.filter((t) => t.byProcess !== null);
}

export function humanTouched(touched: ProcFileTouch[]): ProcFileTouch[] {
  return touched.filter((t) => t.byProcess === null);
}
