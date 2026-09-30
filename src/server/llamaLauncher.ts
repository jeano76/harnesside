/**
 * llama-server 스폰 (단계 [7]·[8], §6.3)
 *
 * `LlamaServerManager` 는 플래그 5개짜리 얇은 껍데기라 이 구조의 요구를 담지 못한다:
 * 튜닝 전체를 전달하지 않고, 자식 로그를 남기지 않으며, 우아한 종료도 없다.
 * 여기서는 **두 가지를 분리**한다:
 *   - `buildLlamaArgs()` — 순수 함수. 튜닝 → 실행 인자. 유닛 테스트의 대상이며,
 *     "무슨 플래그가 왜 붙는지"를 설명할 수 있는 유일한 자리.
 *   - `LlamaLauncher` — 프로세스 수명(스폰/로그 tee/헬스체크/우아한 종료).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { LlamaTuning } from "../setup/tuning.js";

export interface LlamaLaunchOptions {
  binPath: string;
  modelPath: string;
  host: string;
  port: number;
  tuning: LlamaTuning;
  /** §4.6 — 브라우저가 예약한 VRAM MiB. rationale 에 남고 로그로도 보인다. */
  browserReserveMiB?: number;
  gpuMode?: string;
}

export interface BuiltArgs {
  args: string[];
  /** 사람이 읽는 근거. 설정 화면의 "무엇이 왜 붙었나" 에 그대로 쓴다. */
  rationale: string[];
}

/**
 * 튜닝값을 llama-server 인자로 옮긴다 (§6.3 표).
 *
 * 주의: `-ngl 0` 을 하드코딩하지 않는다. GPU 가 있으면 GPU 우선이 원본 원칙이고,
 * 고정 상수는 그 원칙을 뒤집는다(원본 tuning.ts 가 실제로 겪은 버그).
 */
export function buildLlamaArgs(o: LlamaLaunchOptions): BuiltArgs {
  const t = o.tuning;
  const args: string[] = [];
  const rationale: string[] = [];

  args.push("-m", o.modelPath);
  args.push("--host", o.host);
  args.push("--port", String(o.port));

  // -ngl: 999 = 전체 오프로드(llama.cpp 가 모델의 실제 층수로 클램프)
  args.push("-ngl", String(t.gpuLayers));
  rationale.push(
    t.gpuLayers >= 999
      ? `GPU 오프로드: 전체(999) — GPU 가 있으면 GPU 우선(고정 -ngl 0 은 금지)`
      : `GPU 오프로드: ${t.gpuLayers}층 (VRAM 예산 부족분만 CPU 로)`
  );

  // -c: 컨텍스트. 서버 진실이 클라이언트 임계치를 결정한다(§6.3).
  args.push("-c", String(t.contextSize));
  rationale.push(`컨텍스트: ${t.contextSize} 토큰 (VRAM 예산 표 기준)`);

  // 스레드. 1코어 머신에서 코어 수를 넘는 값이 나오면 안 된다(원본 실측 버그).
  args.push("-t", String(t.threads));
  args.push("-tb", String(t.threadsBatch));
  rationale.push(`스레드: 생성 ${t.threads} / 프롬프트 ${t.threadsBatch} (코어 수를 넘지 않음)`);

  args.push("-b", String(t.batchSize));
  args.push("-ub", String(t.ubatchSize));

  // KV 캐시 양자화 — VRAM 이 가장 크게 줄어드는 항목이라 근거를 남긴다.
  args.push("--cache-type-k", t.cacheTypeK);
  args.push("--cache-type-v", t.cacheTypeV);
  rationale.push(`KV 캐시: k=${t.cacheTypeK} v=${t.cacheTypeV} (VRAM 절약)`);

  if (t.flashAttn) {
    args.push("--flash-attn", "on");
    rationale.push("flash attention: on (메모리 대역폭 절약)");
  }

  // -np 1: 에이전트는 세션 1개. 늘리면 KV 캐시만 낭비한다.
  args.push("-np", String(t.parallel));
  if (t.parallel === 1) rationale.push("병렬 슬롯 1 — 세션 1개이므로 늘릴 이유가 없습니다.");

  // --n-cpu-moe: 소형 카드에서 MoE 를 살리는 핵심 플래그
  if (t.cpuMoeLayers > 0) {
    args.push("--n-cpu-moe", String(t.cpuMoeLayers));
    rationale.push(`CPU MoE 오프로드 ${t.cpuMoeLayers}층 — VRAM 이 모자라 expert 를 내려보냅니다.`);
  }

  if (o.browserReserveMiB && o.browserReserveMiB > 0) {
    rationale.push(
      `브라우저 VRAM 예약 ${o.browserReserveMiB}MiB(GPU 모드 ${o.gpuMode ?? "?"})를 위 계산에서 제외했습니다.`
    );
  } else if (o.gpuMode === "off") {
    rationale.push("브라우저 GPU off — 추가 VRAM 차감 없음(모델이 그만큼 더 쓸 수 있습니다).");
  }

  return { args, rationale };
}

export interface LauncherLogger {
  info(o: unknown, m: string): void;
  warn(o: unknown, m: string): void;
  error(o: unknown, m: string): void;
}

export interface LlamaLauncherEvents {
  /** 자식 프로세스의 한 줄 로그(§5.12 의 `source: "llama"`). */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** 스폰 자체가 실패했을 때(바이너리 없음·권한 없음). 조용히 넘기면 사용자가 모른다. */
  onSpawnError?: (err: Error) => void;
}

export class LlamaLauncher {
  private proc: ChildProcess | null = null;
  private stopping = false;
  /**
   * 스폰 자체가 실패한 원인(ENOENT 등).
   *
   * **null 과 구분해야 한다**: 스폰을 안 한 것("아직 시도 안 함")과 시도했지만
   * 실행 파일이 없었던 것("binPath 가 틀렸다")은 사용자에게 **완전히 다른** 사실이다.
   * 하나의 null 로 합치면 헬스체크가 "기다리는 중" 이라 말하다 조용히 시간이 끝나고,
   * 사용자는 "모델이 느린 줄 알았다" 고 오해한다.
   */
  private spawnError: Error | null = null;

  constructor(
    private opts: LlamaLaunchOptions,
    private deps: { logger?: LauncherLogger; events?: LlamaLauncherEvents; fetchImpl?: typeof fetch } = {}
  ) {}

  get baseUrl(): string {
    return `http://${this.opts.host}:${this.opts.port}`;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  build(): BuiltArgs {
    return buildLlamaArgs(this.opts);
  }

  /** 스폰만 한다. 헬스체크는 호출자가 제어한다(단계 [7] 과 [8] 를 분리하기 위함). */
  spawn(): BuiltArgs {
    if (this.proc) return this.build();
    const { args } = this.build();
    // stdio 는 파이프: 자식 로그를 줄 단위로 로그 패널에 tee 한다(§5.12).
    this.proc = spawn(this.opts.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false, // 부모 종료 시 함께 정리된다(§2.2)
    });

    const pipe = (stream: "stdout" | "stderr") => {
      const src = this.proc?.stdio?.[stream === "stdout" ? 1 : 2];
      if (!src) return;
      const rl = createInterface({ input: src as NodeJS.ReadableStream });
      rl.on("line", (line) => {
        // 파싱 실패를 조용히 버리지 않는다. 모델이 죽는 원인의 99%가 이 줄들이다.
        this.deps.events?.onLine?.(line, stream);
        if (stream === "stderr" || /error|fail|oom|abort|cuda/i.test(line)) {
          this.deps.logger?.error({ line, stream }, "llama-server");
        } else {
          this.deps.logger?.info({ line, stream }, "llama-server");
        }
      });
    };
    pipe("stdout");
    pipe("stderr");

    // **'error' 리스너가 없으면 프로세스가 죽는다**(실측: llama-server 바이너리가 없으면
    // `spawn()` 이 예외 없이 끝난 뒤 1초쯤 지나서 uncaughtException 으로 서버 전체가
    // 죽는다 — llama 만 못 뜨는 게 아니라 **창도 함께 사라진다**).
    //
    // Node 는 ENOENT(EACCES 등) 를 동기 throw 가 아니라 비동기 'error' 로 보낸다.
    // 그러므로 여기서 반드시 받아야 하고, **원인을 그대로 남겨야** 사용자가
    // "모델이 없다" 와 "llama-server 가 없다" 를 구분할 수 있다(§5.13.1).
    this.proc.on("error", (err: NodeJS.ErrnoException) => {
      this.spawnError = err;
      this.deps.logger?.error({ code: err.code, message: err.message }, "llama-server 실행 실패");
      this.deps.events?.onSpawnError?.(err);
      this.proc = null;
    });
    this.proc.on("exit", (code, signal) => {
      this.deps.events?.onExit?.(code, signal);
      this.deps.logger?.info({ code, signal, stopping: this.stopping }, "llama-server 종료됨");
      this.proc = null;
    });
    this.deps.logger?.info({ bin: this.opts.binPath, args }, "llama-server 스폰");
    return this.build();
  }

  /** 스폰이 실패했으면 그 원인. 없으면 null — "실패하지 않았다" 와 "시도 안 했다" 를 구분한다. */
  get error(): Error | null {
    return this.spawnError;
  }

  /** `/v1/models` 폴링. 실패해도 예외를 던지지 않고 false 를 돌려준다 —
   *  요구 9 의 degrade 원칙(모델이 죽어도 창은 떠야 한다). */
  async waitUntilReady(timeoutMs = 120_000, intervalMs = 500): Promise<boolean> {
    const f = this.deps.fetchImpl ?? fetch;
    const start = Date.now();
    let lastErr = "";
    // **스폰 실패는 기다릴 필요가 없다.** 120초를 다 기다린 뒤 "안 떴다" 고 말하면
    // 사용자는 원인을 알 수 없다. 즉시 false + 원인을 남긴다.
    if (this.spawnError) {
      this.deps.logger?.error({ code: (this.spawnError as NodeJS.ErrnoException).code }, "llama-server 실행 파일 없음 — 헬스체크 생략");
      return false;
    }
    while (Date.now() - start < timeoutMs) {
      if (this.proc === null && !this.stopping) {
        // 프로세스가 이미 죽었다 — 더 기다려도 소용없다.
        this.deps.logger?.error({ lastErr }, "llama-server 가 헬스체크 전에 종료됨");
        return false;
      }
      try {
        const res = await f(`${this.baseUrl}/v1/models`);
        if (res.ok) {
          this.deps.logger?.info({ ms: Date.now() - start }, "llama-server 준비 완료(/v1/models 200)");
          return true;
        }
        lastErr = `HTTP ${res.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    this.deps.logger?.error({ lastErr, timeoutMs }, "llama-server 헬스체크 시간 초과");
    return false;
  }

  /** SIGTERM → 5초 대기 → SIGKILL (§4.4). */
  async stop(graceMs = 5000): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.stopping = true;
    const pid = p.pid;
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }
    const start = Date.now();
    while (Date.now() - start < graceMs) {
      if (this.proc === null) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // 이미 죽음
    }
  }
}
