/**
 * 웹에서 tmux 로 AI 코딩 CLI 를 쓴다 (`PROMPT_TMUX_CLI.md` D1~D4, T-1~T-4·T-8·T-10).
 *
 * 구조: CLI 는 **tmux 세션** 안에서 돈다(`hs-<provider>-<id>`). 웹 탭은 그 세션에 붙는
 * `tmux attach` 를 PTY 로 띄운 것이다. 탭을 닫아도(= attach 종료) CLI 는 산다.
 *
 * 하지 않는 것: `capture-pane` 폴링, `send-keys` 주입(입력 경로는 attach PTY 하나), API 키 처리,
 * 사람이 만든 tmux 세션 조작(`hs-` 규칙을 통과한 세션만 관리).
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CLI_PROVIDER_BY_ID, CLI_PROVIDERS, CLI_SESSION_NAME, isYoloSessionName, type CliProvider } from "../shared/cliProviders.js";
import { ptyEnv, type TerminalManager, type TerminalSession } from "./terminal.js";
import { listCliCommands, type CliCommandList } from "./cliCommands.js";
import { Tmux, tmuxEnv, isManagedName, type ExecFn, type TmuxSessionInfo } from "./tmux.js";

export interface ProviderStatus {
  id: string;
  label: string;
  /** `true`/`false` 는 확인한 결과, `null` 은 **확인하지 못함**(타임아웃 등) — 없음과 다르다. */
  installed: boolean | null;
  version: string | null;
  installHint: string;
  resumeSupported: boolean;
}

export type StartResult =
  | { ok: true; session: TerminalSession; sessionName: string; reused: boolean; attachCommand: string; notes: string[] }
  | { ok: false; status: number; detail: string };

export interface CliSessionsOptions {
  terminal: TerminalManager;
  /** 워크스페이스 루트 — cwd 는 이 안이어야 한다(`realpath` 비교). */
  root: () => string;
  tmux?: Tmux;
  exec?: ExecFn;
  warn?: (m: string) => void;
}

/** 폴더별로 같은 세션을 다시 찾을 수 있게 하는 짧은 id(결정적). */
export function sessionIdFor(provider: string, cwd: string): string {
  return createHash("sha1").update(`${provider}\0${cwd}`).digest("hex").slice(0, 6);
}

export function sessionNameFor(provider: string, cwd: string, suffix?: string): string {
  const id = sessionIdFor(provider, cwd);
  return `hs-${provider}-${suffix ? (id + suffix).slice(0, 8) : id}`;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export class CliSessions {
  readonly tmux: Tmux;
  private exec: ExecFn | undefined;
  private detectCache = new Map<string, { at: number; v: ProviderStatus }>();

  constructor(private opts: CliSessionsOptions) {
    this.tmux = opts.tmux ?? new Tmux({ exec: opts.exec });
    this.exec = opts.exec;
  }

  /** cwd 가 루트 안인 실제 디렉터리인가. 밖이거나 없으면 이유(문장)를 돌려준다. */
  checkCwd(requested: string | undefined): { ok: true; cwd: string } | { ok: false; detail: string } {
    const root = realOr(resolve(this.opts.root()));
    const target = realOr(resolve(requested ?? this.opts.terminal.cwd));
    if (target !== root && !target.startsWith(`${root}/`)) return { ok: false, detail: `루트(${root}) 밖에서는 열 수 없습니다: ${requested}` };
    try {
      if (!statSync(target).isDirectory()) return { ok: false, detail: `디렉터리가 아닙니다: ${requested}` };
    } catch {
      return { ok: false, detail: `폴더가 없습니다: ${requested}` };
    }
    return { ok: true, cwd: target };
  }

  async providers(): Promise<ProviderStatus[]> {
    return Promise.all(CLI_PROVIDERS.map((p) => this.detect(p)));
  }

  /** 설치 확인 — 3초 타임아웃, 결과는 30초 캐시. 실패와 타임아웃은 "확인 못 함"(null). */
  async detect(p: CliProvider): Promise<ProviderStatus> {
    const base = { id: p.id, label: p.label, installHint: p.installHint, resumeSupported: !!p.resumeArgs };
    if (p.detect.length === 0) return { ...base, installed: true, version: null };
    const hit = this.detectCache.get(p.id);
    if (hit && Date.now() - hit.at < 30_000) return hit.v;
    const run = this.exec ?? (await import("./tmux.js")).defaultExec;
    const r = await run(p.detect[0]!, p.detect.slice(1), 3000);
    let v: ProviderStatus;
    if (r.code === 0) v = { ...base, installed: true, version: r.stdout.trim().split("\n")[0]?.slice(0, 80) || null };
    else if (r.code === 127) v = { ...base, installed: false, version: null };
    else v = { ...base, installed: null, version: null };
    this.detectCache.set(p.id, { at: Date.now(), v });
    return v;
  }

  /** 이 CLI 의 슬래시 명령(내장 표 + 스캔한 사용자 정의). 모르는 CLI 면 null. */
  async commands(providerId: string, cwd?: string): Promise<CliCommandList | { error: string; status: number }> {
    const provider = CLI_PROVIDER_BY_ID[providerId];
    if (!provider) return { error: `알 수 없는 CLI 입니다: ${providerId}`, status: 400 };
    const c = this.checkCwd(cwd);
    if (!c.ok) return { error: c.detail, status: 403 };
    const st = await this.detect(provider);
    return (await listCliCommands(provider, { cwd: c.cwd, installedVersion: st.version }))!;
  }

  async status() {
    const t = await this.tmux.version();
    const sessions = t.installed ? (await this.sessions()).length : 0;
    return { tmux: { ...t, socket: this.tmux.socket }, providers: await this.providers(), sessions };
  }

  /** `hs-*` 세션만(서버 재시작 뒤에도 tmux 에서 되살린다). 사람이 만든 세션은 `readOnly` 로 따로. */
  async sessions(): Promise<TmuxSessionInfo[]> {
    return (await this.tmux.list()).filter((s) => s.managed);
  }

  async start(o: { provider: string; cwd?: string; forceNew?: boolean; resume?: boolean; yolo?: boolean; cols?: number; rows?: number }): Promise<StartResult> {
    const provider = CLI_PROVIDER_BY_ID[o.provider];
    if (!provider) return { ok: false, status: 400, detail: `알 수 없는 CLI 입니다: ${o.provider} (claude · gemini · codex · shell)` };
    const tm = await this.tmux.version();
    // tmux 가 없으면 **일반 PTY 로 대체하지 않는다** — 재접속 보장이 깨지는데 모르고 쓰게 된다.
    if (!tm.installed) return { ok: false, status: 409, detail: "tmux 가 없습니다 — `sudo apt install tmux` 로 설치한 뒤 다시 시도하세요." };
    const cwdCheck = this.checkCwd(o.cwd);
    if (!cwdCheck.ok) return { ok: false, status: 403, detail: cwdCheck.detail };
    const cwd = cwdCheck.cwd;

    const st = await this.detect(provider);
    if (st.installed === false) return { ok: false, status: 409, detail: `${provider.label} 이(가) 설치돼 있지 않습니다 — ${provider.installHint}` };
    if (o.resume && !provider.resumeArgs) {
      return { ok: false, status: 409, detail: `${provider.label} 의 이어가기 인자를 확인하지 못했습니다(미확인) — resume 없이 여세요.` };
    }

    // YOLO 는 그 CLI 의 **확인된 시작 인자**가 있을 때만 켠다(없으면 지어내지 않고 거절).
    if (o.yolo && !provider.yoloArgs) {
      return { ok: false, status: 409, detail: `${provider.label} 의 YOLO 인자를 확인하지 못했습니다(미확인) — YOLO 없이 여세요.` };
    }
    const yoloTag = o.yolo ? "y" : "";
    const notes: string[] = [];
    const cols = Math.max(20, Math.min(400, Math.floor(o.cols ?? 120)));
    const rows = Math.max(5, Math.min(200, Math.floor(o.rows ?? 30)));
    const existing = await this.sessions();
    let name = sessionNameFor(provider.id, cwd, yoloTag || undefined);
    let reused = false;
    const alive = existing.find((s) => s.name === name);
    if (alive && !o.forceNew) {
      reused = true;
    } else {
      if (alive) {
        // forceNew: 같은 폴더에 이미 있다 — 이름이 겹치지 않게 접미사를 붙인다.
        let n = 1;
        while (existing.some((s) => s.name === sessionNameFor(provider.id, cwd, `${yoloTag}${n}`))) n++;
        name = sessionNameFor(provider.id, cwd, `${yoloTag}${n}`);
      }
      const command = [...provider.command, ...(o.yolo ? (provider.yoloArgs ?? []) : []), ...(o.resume ? (provider.resumeArgs ?? []) : [])];
      try {
        await this.tmux.newSession({ name, cwd, cols, rows, command });
      } catch (e) {
        return { ok: false, status: 409, detail: e instanceof Error ? e.message : String(e) };
      }
      const { rejected } = await this.tmux.applyWebOptions(name);
      for (const r of rejected) notes.push(`tmux 옵션을 받아들이지 않았습니다 — ${r}`);
    }

    // 같은 세션을 가리키는 탭이 이미 열려 있으면 두 번째 attach 를 만들지 않는다(탭↔세션 1:1).
    const open = this.opts.terminal.list().find((t) => t.cli?.sessionName === name && t.state === "running");
    if (open) return { ok: true, session: open, sessionName: name, reused: true, attachCommand: this.attachCommand(name), notes };

    const r = this.opts.terminal.create({
      cwd,
      cols,
      rows,
      title: o.yolo ? `${provider.label} (YOLO)` : provider.label,
      command: { file: "tmux", args: this.tmux.attachArgs(name), env: tmuxEnv(ptyEnv(process.env)) },
      cli: { provider: provider.id, sessionName: name, ...(isYoloSessionName(name) ? { yolo: true } : {}) },
    });
    if (!r.ok) return { ok: false, status: 409, detail: r.detail };
    if (isYoloSessionName(name) && !reused) this.autoConfirmStartup(name, r.session.id, provider.id);
    if (isYoloSessionName(name)) notes.push("YOLO: 승인 요청을 자동 허용합니다 — 이 탭의 작업은 확인 없이 실행됩니다.");
    return { ok: true, session: r.session, sessionName: name, reused, attachCommand: this.attachCommand(name), notes };
  }

  /**
   * YOLO 세션의 **시작 대화상자**에 자동으로 yes 를 답한다(claude: 폴더 신뢰 확인 · 우회 모드 경고 수락).
   * 도구 승인은 시작 인자가 이미 처리하지만, 이 두 대화상자는 인자로는 안 넘어가고 기본 선택이 `No, exit` 라
   * 그냥 두면 CLI 가 꺼진다. **시작 후 90초 동안만**, 화면에 그 대화상자가 보일 때만, 키 한 번씩 보낸다 —
   * 입력 경로는 attach PTY 하나다(`terminal.write`). 한 일은 모두 로그에 남긴다.
   * agy 는 폴더 신뢰 질문만(기본 선택이 Yes 라 Enter). gemini 는 확인하지 못해 하지 않는다(미확인).
   */
  private autoConfirmStartup(name: string, terminalId: string, provider: string): void {
    if (provider !== "claude" && provider !== "agy") return;
    const started = Date.now();
    const tick = async (): Promise<void> => {
      if (Date.now() - started > 90_000) return;
      const text = await this.tmux.capture(name).catch(() => "");
      // claude: `❯ No, exit` 가 기본 선택 · agy: 폴더 신뢰 질문(`> Yes, I trust this folder` 이 기본 선택).
      const dialog = provider === "agy"
        ? /Do you trust the contents of this project/.test(text) && /enter Confirm/.test(text)
        : /Enter to confirm/.test(text) && /(trust this folder|Yes, I accept)/.test(text);
      if (dialog) {
        const onNo = provider === "agy" ? /^>\s*No, exit/m.test(text) : /❯\s*No, exit/.test(text);
        // 선택이 No 면 Yes 쪽으로 한 칸 옮긴다: claude 는 Yes 가 아래(↓), agy 는 Yes 가 위(↑).
        const w = this.opts.terminal.write(terminalId, onNo ? (provider === "agy" ? "\x1b[A" : "\x1b[B") : "\r");
        if (!w.ok) return; // 탭이 닫혔다
        this.opts.warn?.(`YOLO 자동 확인(${name}): ${onNo ? "↓ (No → Yes)" : "Enter (Yes)"}`);
      }
      setTimeout(() => void tick(), dialog ? 700 : 1000).unref?.();
    };
    setTimeout(() => void tick(), 1500).unref?.();
  }

  attachCommand(name: string): string {
    return `tmux${this.tmux.socket ? ` -L ${this.tmux.socket}` : ""} attach -t ${name}`;
  }

  /** 종료 미리보기·실행. `hs-` 가 아니면 403 — 사람의 세션은 건드리지 않는다. */
  async kill(name: string, confirm: boolean): Promise<{ ok: boolean; status: number; detail: string; preview?: TmuxSessionInfo }> {
    if (!CLI_SESSION_NAME.test(name) || !isManagedName(name)) {
      return { ok: false, status: 403, detail: `harnesside 가 만든 세션(hs-…)만 종료할 수 있습니다: ${name}` };
    }
    const found = (await this.sessions()).find((s) => s.name === name);
    if (!found) return { ok: false, status: 404, detail: `그런 세션이 없습니다: ${name}` };
    if (!confirm) {
      return { ok: false, status: 200, detail: `종료하면 ${name} 안에서 실행 중인 작업이 끝납니다 (폴더 ${found.cwd}, 붙은 창 ${found.attachedClients}개). 확정하려면 confirm 을 붙이세요.`, preview: found };
    }
    await this.tmux.kill(name);
    // 그 세션에 붙어 있던 웹 탭도 닫는다 — 죽은 attach 가 남지 않게.
    for (const t of this.opts.terminal.list()) if (t.cli?.sessionName === name) this.opts.terminal.close(t.id, true);
    return { ok: true, status: 200, detail: `${name} 을(를) 종료했습니다.` };
  }
}
