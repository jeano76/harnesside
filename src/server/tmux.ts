/**
 * tmux 래퍼 — 전부 `execFile` **배열 인자**다(셸 문자열 연결 없음, 쉘 인젝션 차단).
 *
 * 이 모듈은 harnesside 가 만든 세션(`hs-*`)만 건드린다. 사용자가 직접 만든 다른 세션
 * (`claude`, `opencode` …)은 목록에서 구분만 하고 종료·옵션 변경은 거절한다.
 *
 * 소켓: 기본은 **전용 소켓 `harnesside`** 다(`tmux -L harnesside …`). 사용자의 기본 tmux 서버에는
 * 이미 사람의 세션(`claude`, `opencode` …)이 떠 있고, `escape-time`·`focus-events`·
 * `set-clipboard` 는 **서버 전역 옵션**이라 기본 소켓에서 바꾸면 그 세션들까지 바뀐다.
 * 외부에서 붙으려면 `tmux -L harnesside attach -t hs-…`. 환경변수 `HARNESSIDE_TMUX_SOCKET` 로 바꾼다
 * (시험은 이것으로 분리).
 */

export const DEFAULT_TMUX_SOCKET = "harnesside";

import { execFile } from "node:child_process";
import { CLI_SESSION_NAME } from "../shared/cliProviders.js";

export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8", env: tmuxEnv(process.env) }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
      // 실행 파일이 없음(ENOENT)·시간 초과(killed)·비정상 종료는 서로 다른 사실이다 — 합치지 않는다.
      const code = e.code === "ENOENT" ? 127 : e.killed ? 124 : typeof e.code === "number" ? e.code : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr || e.message || "") });
    });
  });

/**
 * 서버가 이미 tmux 안에서 돌면 `TMUX` 가 새어 들어가 `tmux attach` 가
 * "sessions should be nested with care" 로 거부된다 — 자식에게는 지운다.
 */
export function tmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.TMUX;
  delete out.TMUX_PANE;
  return out;
}

export interface TmuxSessionInfo {
  name: string;
  createdAt: number;
  attachedClients: number;
  /** harnesside 가 만든 세션인가(`hs-` 규칙을 통과) — 아니면 읽기 전용이다. */
  managed: boolean;
  cwd: string;
  /** 첫 pane 의 프로세스가 끝났는가(`remain-on-exit` 로 남은 상태). */
  dead: boolean;
  exitCode: number | null;
}

export interface TmuxOptions {
  exec?: ExecFn;
  /** `-L <socket>` — 기본은 전용 소켓(`DEFAULT_TMUX_SOCKET`). */
  socket?: string;
}

export function isManagedName(name: string): boolean {
  return CLI_SESSION_NAME.test(name);
}

export class Tmux {
  private exec: ExecFn;
  readonly socket: string | undefined;
  constructor(opts: TmuxOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.socket = opts.socket ?? process.env.HARNESSIDE_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET;
  }

  /** attach PTY 가 실행할 인자(소켓 포함). */
  attachArgs(name: string): string[] {
    this.assertManaged(name);
    return [...this.base(), "attach-session", "-t", name];
  }

  private base(): string[] {
    return this.socket ? ["-L", this.socket] : [];
  }

  private assertManaged(name: string): void {
    if (!isManagedName(name)) throw new Error(`harnesside 가 만든 세션이 아닙니다(이름 규칙 위반): ${name}`);
  }

  private run(args: string[], timeoutMs = 5000) {
    return this.exec("tmux", [...this.base(), ...args], timeoutMs);
  }

  async version(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.exec("tmux", ["-V"], 3000);
    if (r.code !== 0) return { installed: false, version: null };
    return { installed: true, version: r.stdout.trim().replace(/^tmux\s+/, "") || null };
  }

  /** 서버가 아직 안 떠 있으면 `no server running` — 그건 "세션 없음" 이지 오류가 아니다. */
  async list(): Promise<TmuxSessionInfo[]> {
    const fmt = ["#{session_name}", "#{session_created}", "#{session_attached}", "#{pane_current_path}", "#{pane_dead}", "#{pane_dead_status}"].join("\t");
    const r = await this.run(["list-sessions", "-F", fmt]);
    if (r.code !== 0) {
      if (/no server running|no sessions|error connecting/i.test(r.stderr)) return [];
      throw new Error(`tmux list-sessions 실패: ${r.stderr.trim() || `code ${r.code}`}`);
    }
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, created, attached, cwd, dead, status] = line.split("\t");
        return {
          name: name ?? "",
          createdAt: Number(created) * 1000 || 0,
          attachedClients: Number(attached) || 0,
          managed: isManagedName(name ?? ""),
          cwd: cwd ?? "",
          dead: dead === "1",
          exitCode: dead === "1" && status !== undefined && status !== "" ? Number(status) : null,
        };
      });
  }

  /** 첫 pane 의 현재 화면 글자(읽기 전용). 자동 확인 응답기가 시작 대화상자를 알아보는 데만 쓴다. */
  async capture(name: string): Promise<string> {
    this.assertManaged(name);
    const r = await this.run(["capture-pane", "-p", "-t", name]);
    return r.code === 0 ? r.stdout : "";
  }

  async has(name: string): Promise<boolean> {
    this.assertManaged(name);
    return (await this.run(["has-session", "-t", `=${name}`])).code === 0;
  }

  /** 세션을 만든다. 명령은 **배열**이라 tmux 가 셸을 거치지 않고 exec 한다. */
  async newSession(o: { name: string; cwd: string; cols: number; rows: number; command: string[] }): Promise<void> {
    this.assertManaged(o.name);
    const args = ["new-session", "-d", "-s", o.name, "-c", o.cwd, "-x", String(o.cols), "-y", String(o.rows)];
    if (o.command.length) args.push("--", ...o.command);
    const r = await this.run(args, 10_000);
    if (r.code !== 0) throw new Error(`tmux 세션을 만들지 못했습니다: ${r.stderr.trim() || `code ${r.code}`}`);
  }

  /**
   * 웹 터미널답게 느껴지는 **세션 스코프** 옵션(사용자 `~/.tmux.conf` 는 건드리지 않는다).
   * 받아들여지지 않은 옵션은 **조용히 넘기지 않고** 돌려준다.
   */
  async applyWebOptions(name: string): Promise<{ rejected: string[] }> {
    this.assertManaged(name);
    const opts: [string, string][] = [
      ["status", "off"],
      ["mouse", "on"],
      ["escape-time", "10"],
      ["history-limit", "50000"],
      ["set-clipboard", "on"],
      ["focus-events", "on"],
      ["remain-on-exit", "on"],
      ["window-size", "latest"],
    ];
    const rejected: string[] = [];
    for (const [k, v] of opts) {
      // `escape-time`·`focus-events`·`set-clipboard` 는 서버(전역) 옵션이라 -g/-s 스코프가 다르다.
      const scope = k === "escape-time" || k === "focus-events" || k === "set-clipboard" ? ["-s"] : ["-t", name];
      const r = await this.run(["set-option", ...scope, k, v]);
      if (r.code !== 0) rejected.push(`${k}=${v}: ${r.stderr.trim()}`);
    }
    return { rejected };
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    this.assertManaged(name);
    await this.run(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
  }

  async kill(name: string): Promise<void> {
    this.assertManaged(name);
    const r = await this.run(["kill-session", "-t", `=${name}`]);
    if (r.code !== 0) throw new Error(`세션을 종료하지 못했습니다: ${r.stderr.trim() || `code ${r.code}`}`);
  }

  /** 첫 pane 을 되살린다(`remain-on-exit` 로 죽은 채 남은 CLI 의 "다시 시작"). */
  async respawn(name: string, cwd: string, command: string[]): Promise<void> {
    this.assertManaged(name);
    const args = ["respawn-pane", "-k", "-t", name, "-c", cwd];
    if (command.length) args.push("--", ...command);
    const r = await this.run(args, 10_000);
    if (r.code !== 0) throw new Error(`다시 시작하지 못했습니다: ${r.stderr.trim() || `code ${r.code}`}`);
  }
}
