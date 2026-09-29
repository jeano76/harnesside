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
}

export interface GpuVerification {
  ok: boolean;
  glRenderer?: string;
  webgl?: string;
  detail: string;
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

  constructor(
    private opts: Omit<LaunchOptions, "userDataDir"> & { userDataDir?: string },
    private deps: LaunchDeps = {}
  ) {}

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
    const pipe = (idx: 1 | 2) => {
      const src = this.proc?.stdio?.[idx];
      if (!src) return;
      createInterface({ input: src as NodeJS.ReadableStream }).on("line", (line) => {
        this.deps.onLine?.(line);
        this.log("info", `[chrome] ${line}`);
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

  /** CDP 로 GPU 정보 한 번 읽기. 소켓은 열었다 닫는다(장시간 유지하면 리소스를 붙잡는다). */
  private async readGpuOnce(port: number): Promise<Record<string, unknown> | null> {
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
