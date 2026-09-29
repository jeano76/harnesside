/**
 * Chrome 창 기동 + GPU 정책 **검증** (§4.1 · §4.7).
 *
 * 이 파일의 핵심은 스폰이 아니라 **검증**이다. `--disable-gpu` 를 넣었다고 GPU 가 꺼진
 * 게 아니다 — 드라이버가 무시할 수 있다(§4.7.5). 그래서 붙은 다음 CDP 로 상태를 읽어
 * "설정됨" 과 "동작함" 을 분리해 보고한다. 검증에 실패하면 조용히 넘어가지 않는다.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { launchFlags, profileDir, CDP_DEFAULT_PORT, type LaunchOptions } from "./browserFlags.js";
import type { GpuMode } from "../setup/gpuPolicy.js";

/** 브라우저 바이너리 탐지 순서 (§4.1). */
export const CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

export interface LaunchDeps {
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  exists?: (p: string) => Promise<boolean>;
  run?: (file: string, args: string[]) => Promise<void>;
  home?: string;
  logger?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
  onLine?: (line: string) => void;
  /**
   * §4.4 S4 용 CDP 소켓을 만든다. 주입하는 이유: **소켓이 죽는 상황은 이렇게만 재현된다.**
   * 실 서버에 붙어 있는 동안은 아무 일도 없고, 붙지 않은 상태를 만들려면 가짜가 필요하다.
   */
  wsFactory?: (url: string) => CdpSocketLike;
  /** 재연결 시도 사이 지연(기본 1000ms). */
  cdpRetryDelayMs?: number;
  /** 재연달 시도 횟수(기본 2 — §4.4 표). */
  cdpRetryAttempts?: number;
}

/** CDP 소켓에 필요한 최소 표면. WebSocket 이 이 모양을 만족한다. */
export interface CdpSocketLike {
  on(event: "close", fn: () => void): void;
  on(event: "error", fn: (err?: unknown) => void): void;
  on(event: "open", fn: () => void): void;
  send(data: string): void;
  close(): void;
}

export interface GpuVerification {
  ok: boolean;
  glRenderer?: string;
  webgl?: string;
  detail: string;
}

/**
 * 실제 CDP 소켓.
 *
 * `ws` 는 **정적 import** 다. "소켓이 필요 없는 경로에서는 로드하지 말자" 는 생각은
 * 옳지만 이 모듈은 이미 서버 쪽 전용이고(웹 번들에 들어가지 않는다), 동적 로드를
 * 섞으면 ESM 에서 `require` 가 없어지거나 비동기 초기화가 끼어든다 — **판단이 복잡해지는
 * 대신 이득이 없다.**
 */
function defaultWsFactory(url: string): CdpSocketLike {
  return new WebSocket(url) as unknown as CdpSocketLike;
}

export interface LaunchResult {
  pid?: number;
  cdpPort: number;
  mode: GpuMode;
  flags: string[];
  rationale: string[];
  verification: GpuVerification | null;
  attached: boolean;
}

export class BrowserLauncher {
  private proc: ChildProcess | null = null;
  /** §4.4 S4 — **길게 붙어 있는** CDP 소켓. */
  private cdpWatch: CdpSocketLike | null = null;
  private cdpState: "connected" | "lost" | "none" = "none";
  private cdpLostNotified = false;

  constructor(
    private opts: Omit<LaunchOptions, "userDataDir"> & { userDataDir?: string },
    private deps: LaunchDeps = {}
  ) {}

  /** 살아 있으면 PID. 워치독(§4.4 S1) 이 이걸 본다. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /**
   * CDP 연결 상태(§4.4 S4).
   *
   * `none` 은 **판정 대상이 아니다** — 아직 감시를 켜지 않았다는 뜻이다.
   * `lost` 는 "재연결 2회 실패" 다. 한 번 닫혔다고 곧바로 lost 가 아니다:
   * 그 한회는 프로필 잠금 같은 일시적 거부를 잡을 것이고, §4.4 는 **2회 실패** 를 기준으로 한다.
   */
  get cdp(): "connected" | "lost" | "none" {
    return this.cdpState;
  }

  /**
   * CDP 소켓을 **끊지 않고** 붙여 둔다(§4.4 S4).
   *
   * GPU 판정은 소켓을 열었다 닫는다 — 장시간 유지하면 리소스를 붙잡는다는 이유로.
   * 그 선택이 S4 를 불가능하게 만들었다: **"소켓이 죽었다" 는 신호가 아예 없었다.**
   * 감시용 소코트은 따로 동고, 닫하면 재연을 두 번 시도합니다.
   */
  async watchCdp(cdpPort: number, onLost: (detail: { attempts: number }) => void): Promise<boolean> {
    const f = this.deps.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const info = await f(`http://127.0.0.1:${cdpPort}/json/version`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    clearTimeout(t);
    const url = (info as { webSocketDebuggerUrl?: string } | null)?.webSocketDebuggerUrl;
    if (!url) return false;
    return this.attachCdpWatch(url, onLost);
  }

  private attachCdpWatch(url: string, onLost: (detail: { attempts: number }) => void): Promise<boolean> {
    const factory = this.deps.wsFactory ?? defaultWsFactory;
    const attempts = this.deps.cdpRetryAttempts ?? 2;
    const delay = this.deps.cdpRetryDelayMs ?? 1000;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const open = (tryIndex: number) => {
        let ws: CdpSocketLike;
        try {
          ws = factory(url);
        } catch (e) {
          this.scheduleRetry(open, resolve, tryIndex, attempts, delay, onLost, e);
          return;
        }
        ws.on("open", () => {
          this.cdpWatch = ws;
          this.cdpState = "connected";
          this.cdpLostNotified = false;
          this.log("info", "CDP 감시 소켓 연결됨", { url });
          if (!settled) {
            settled = true;
            resolve(true);
          }
        });
        const lost = (why: unknown) => {
          if (this.cdpWatch !== ws) return; // 이미 다른 소켓으로 넘어갔다
          this.cdpWatch = null;
          this.log("warn", "CDP 감시 소켓 끊김", { tryIndex, why: String(why ?? "") });
          this.scheduleRetry(open, resolve, tryIndex, attempts, delay, onLost, why);
        };
        ws.on("close", () => lost("close"));
        ws.on("error", (e) => lost(e));
      };
      open(0);
    });
  }

  private scheduleRetry(
    open: (tryIndex: number) => void,
    resolve: (v: boolean) => void,
    tryIndex: number,
    attempts: number,
    delay: number,
    onLost: (detail: { attempts: number }) => void,
    why: unknown,
  ): void {
    // §4.4: **재연결 2회 실패** 가 신호다. 한 번의 실패는 프로필 잠금일 수 있다.
    if (tryIndex + 1 > attempts) {
      this.cdpState = "lost";
      this.log("error", "CDP 재연결 실패 — 연결이 소실된 것으로 봅니다", { attempts, why: String(why ?? "") });
      onLost({ attempts });
      return;
    }
    const timer = setTimeout(() => open(tryIndex + 1), delay);
    timer.unref?.();
  }

  /** 감시 소켓을 닫는다(종료 경로). */
  stopCdpWatch(): void {
    try {
      this.cdpWatch?.close();
    } catch {
      /* 이미 닫힘 */
    }
    this.cdpWatch = null;
  }

  private get log() {
    return this.deps.logger ?? (() => {});
  }

  private async exists(p: string): Promise<boolean> {
    // 주의: `access()` 는 성공하면 **undefined 로 resolve** 한다. `!!(await access(p))` 로
    // 쓰면 성공이 곧 "없음" 이 된다 — 실제로 Chrome 이 설치돼 있는데 "바이너리를 찾지
    // 못했습니다" 가 났다(실측). 성공/실패를 반드시 분기로 표현한다.
    if (this.deps.exists) return this.deps.exists(p);
    return access(p).then(
      () => true,
      () => false
    );
  }

  async resolveBinary(): Promise<string | null> {
    const envBin = process.env.CHROME_BIN;
    if (envBin && (await this.exists(envBin))) return envBin;
    for (const c of CHROME_CANDIDATES) {
      if (await this.exists(`/usr/bin/${c}`)) return `/usr/bin/${c}`;
      if (await this.exists(`/usr/local/bin/${c}`)) return `/usr/local/bin/${c}`;
    }
    return null;
  }

  /**
   * 창을 띄운다. **브라우저가 없으면 예외를 던지지 않고 ok:false 를 돌려준다** —
   * 데몬은 사람이 보지 않는다(§3.7.1) 창 없이도 API/로그는 살아 있어야 한다.
   */
  async launch(): Promise<LaunchResult> {
    const cdpPort = this.opts.cdpPort ?? CDP_DEFAULT_PORT;
    const bin = await this.resolveBinary();
    if (!bin) {
      return {
        cdpPort,
        mode: this.opts.mode,
        flags: [],
        rationale: [],
        verification: null,
        attached: false,
      };
    }

    const userDataDir = this.opts.userDataDir ?? profileDir(this.deps.home ?? homedir());
    await mkdir(userDataDir, { recursive: true }).catch(() => {});

    const built = launchFlags({ ...this.opts, userDataDir, cdpPort });
    this.log("info", `Chrome 기동: ${bin} (GPU ${built.mode})`, { flags: built.args.length });

    const spawnFn = this.deps.spawnImpl ?? spawn;
    this.proc = spawnFn(bin, built.args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // 자식 로그를 받아 §5.12 패널로 넘긴다(창이 GPU 문제로 죽는 경우가 실제로 있다).
    //
    // **한 줄을 두 경로로 보내지 않는다.** `onLine` 과 `logger` 에 동시에 넣으면
    // 같은 줄이 두 번 보인다(실제로 그랬다 — "왜 로그가 두 번 나오지" 라는 질문은
    // 사용자가 아니라 우리가 만들어 낸 것). `onLine` 이 데이터 경로, `logger` 는
    // 수명주기(스폰/종료) 전용이다.
    const pipe = (idx: 1 | 2) => {
      const src = this.proc?.stdio?.[idx];
      if (!src) return;
      createInterface({ input: src as NodeJS.ReadableStream }).on("line", (line) => {
        this.deps.onLine?.(line);
      });
    };
    pipe(1);
    pipe(2);
    this.proc.on("exit", (code, signal) => {
      this.log("warn", `Chrome 종료됨 code=${code} signal=${signal}`);
      this.proc = null;
    });

    // CDP 가 붙을 때까지 기다린다 — 붙기 전에 상태를 재면 "미확인" 으로 남는다.
    const attached = await this.waitForCdp(cdpPort, 15_000);
    const verification = attached ? await this.verifyGpu(cdpPort) : null;

    if (verification && !verification.ok) {
      // §4.7.5: 조용히 넘어가지 않는다. 사용자에게 선택지를 제시해야 한다.
      this.log("error", `GPU 비활성 확인 실패: ${verification.detail}`, verification);
    }

    return {
      pid: this.proc?.pid,
      cdpPort,
      mode: built.mode,
      flags: built.args,
      rationale: built.rationale,
      verification,
      attached,
    };
  }

  private async waitForCdp(port: number, timeoutMs: number): Promise<boolean> {
    const f = this.deps.fetchImpl ?? fetch;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 800);
        const res = await f(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) return true;
      } catch {
        // 아직 안 뜬 것
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /**
   * §4.7.5 표의 1·2번: CDP 로 GPU 상태를 읽는다.
   * `glRenderer === "Disabled"` 면 통과.
   *
   * **재시도가 필요한 이유**: GPU 정보는 브라우저가 초기화 중에는 **빈 값**으로 온다.
   * 한 번만 읽고 "Disabled 가 아니다" 라고 결론내리면, 실제로는 GPU 가 꺼졌는데
   * "플래그가 무시되었다" 고 잘못 보고한다(실제로 그렇게 났다). "아직 판정 불가" 와
   * "GPU 가 켜졌다" 는 전혀 다른 상태이므로 재시도하고, 그래도 못 읽으면 그 사실대로
   * "판정 불가" 로 남긴다.
   */
  async verifyGpu(port: number, opts: { attempts?: number; intervalMs?: number } = {}): Promise<GpuVerification> {
    const attempts = opts.attempts ?? 6;
    const intervalMs = opts.intervalMs ?? 700;
    let last: GpuVerification = { ok: false, detail: "GPU 상태를 읽지 못했습니다" };

    for (let i = 0; i < attempts; i++) {
      const v = await this.readGpuOnce(port);
      if (!v) {
        last = { ok: false, detail: "CDP 에 접속할 수 없습니다" };
      } else {
        const glRenderer = (v.auxAttributes as { glRenderer?: string } | undefined)?.glRenderer;
        const glVendor = (v.auxAttributes as { glVendor?: string } | undefined)?.glVendor;
        const parts = (v.auxAttributes as { glImplementationParts?: string } | undefined)?.glImplementationParts;
        const fs = v.featureStatus as Record<string, string> | undefined;
        // 이 Chrome 빌드에는 `webgl` 키가 없을 수 있다(실측). 그래서 `opengl` 과
        // `glImplementationParts` 를 보조 근거로 함께 본다.
        const opengl = fs?.opengl;
        const webgl = fs?.webgl;

        if (!glRenderer) {
          last = { ok: false, glRenderer, webgl, detail: "GPU 정보가 아직 채워지지 않았습니다 (초기화 중)" };
        } else if (this.opts.mode === "off") {
          const ok = glRenderer === "Disabled";
          const evidence = [
            `glRenderer=${glRenderer}`,
            glVendor ? `glVendor=${glVendor}` : null,
            parts ? `parts=${parts}` : null,
            opengl ? `opengl=${opengl}` : null,
            webgl ? `webgl=${webgl}` : null,
          ]
            .filter(Boolean)
            .join(", ");
          return {
            ok,
            glRenderer,
            webgl,
            detail: ok
              ? `GPU 비활성 확인됨 (${evidence})`
              : `GPU 비활성이 확인되지 않았습니다 (${evidence}) — 플래그가 드라이버에 무시되었을 수 있습니다`,
          };
        } else {
          return { ok: true, glRenderer, webgl, detail: `GPU ${this.opts.mode} 모드 (${glRenderer})` };
        }
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
  }

  /** CDP 로 GPU 정보 한 번 읽기. 소켓은 열었다 닫는다(장시간 유지하면 리소스를 붙잡는다). */  private async readGpuOnce(port: number): Promise<Record<string, unknown> | null> {
    const f = this.deps.fetchImpl ?? fetch;
    const v = await f(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (!v || !v.ok) return null;
    const info = (await v.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) return null;
    return this.systemInfo(info.webSocketDebuggerUrl);
  }

  /** CDP 소켓으로 SystemInfo.getInfo 를 한 번 읽는다. 소켓은 열었다 닫는다. */
  private async systemInfo(wsUrl: string): Promise<Record<string, unknown> | null> {
    const { default: WS } = await import("ws").then((m) => ({ default: m.WebSocket }));
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // 이미 닫힘
        }
        resolve(v);
      };
      let ws: InstanceType<typeof WS>;
      try {
        ws = new WS(wsUrl, { handshakeTimeout: 3000 });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => done(null), 5000);
      ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "SystemInfo.getInfo" })));
      ws.on("message", (data: Buffer | string) => {
        try {
          const m = JSON.parse(String(data)) as { id?: number; result?: { gpu?: Record<string, unknown> } };
          if (m.id === 1) {
            clearTimeout(timer);
            done(m.result?.gpu ?? null);
          }
        } catch {
          // 파싱 실패는 무시하고 다음 메시지를 본다
        }
      });
      ws.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
    });
  }

  async stop(graceMs = 3000): Promise<void> {
    const p = this.proc;
    if (!p?.pid) return;
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      return;
    }
    const start = Date.now();
    while (Date.now() - start < graceMs) {
      if (!this.proc) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      if (p.pid) process.kill(p.pid, "SIGKILL");
    } catch {
      // 이미 죽음
    }
  }
}

/** 임시 프로필 디렉터리(테스트/샌드박스용). */
export async function tempProfileDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harnesside-profile-"));
}
