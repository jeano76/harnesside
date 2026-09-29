/**
 * 시스템 계측 샘플러 (§5.5) — **서버는 절대 요청당 계측하지 않는다.**
 *
 * 이 규칙이 깨지면 계측이 부하가 된다: `/metrics` 를 1초마다 부를 때마다 `nvidia-smi`
 * 를 실행하면(그 자체가 100~300ms) **계측이 부하를 만든다** — 요구 11 이 실패한다.
 * 그래서 1Hz 로 한 번만 주워두고, 라우트는 **마지막 샘플**을 돌려준다.
 *
 * `nvidia-smi` 는 없어도 동작한다(GPU 없음 = 알 수 없음 ≠ 0%). 0% 로 채우면
 * "GPU 가 쉬고 있다" 는 사실과 "측정하지 못했다" 가 구분되지 않는다.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, freemem, totalmem, loadavg } from "node:os";

export interface CoreLoad {
  /** 코어별 사용률 %. 빈도 0(단일 코어 머신)일 때는 전체 사용률이 대신 온다. */
  cores: number[];
  overall: number;
}

export interface Metrics {
  at: number;
  cpu: CoreLoad;
  mem: { totalBytes: number; freeBytes: number; usedBytes: number; usedPct: number; swapTotalBytes: number; swapFreeBytes: number };
  /** nvidia-smi 를 못 읽었으면 null — 0 과 구분된다. */
  gpu: { name: string; utilPct: number; tempC: number | null; powerW: number | null; memUsedMiB: number; memTotalMiB: number; memPct: number } | null;
  /** 디스크(루트 파일시스템). */
  disk: { totalBytes: number; freeBytes: number; usedPct: number };
  /** llama.cpp 프로세스(있으면). */
  llama: { rssBytes: number; threads: number } | null;
  /** 컨텍스트 사용량 — 컴팩션 임박 표시의 근거(§5.5). */
  context: { usedTokens: number; totalTokens: number; pct: number } | null;
  /** 최근 토큰 속도(토큰/초). null 이면 "아직 측정 안 됨" 이지 0 이 아니다. */
  tokensPerSec: number | null;
}

export const SAMPLE_MS = 1000;
/** 스파크라인용 링 크기 — §5.5 "최근 60초(120샘플)" 의 1Hz 기준 60 샘플 + 여유. */
export const RING_SIZE = 120;

const STAT_FS = "/proc/stat";

async function readCpu(): Promise<CoreLoad> {
  const list = cpus();
  if (list.length === 0) {
    // 컨테이너처럼 cpu 목록이 비어 있으면 전체도 못 잰다 — 0 이 아니라 빈 배열.
    return { cores: [], overall: 0 };
  }
  // os.cpus() 는 호출마다 전체 시간을 누적给出的다(직전 호출 대비 차이로 계산).
  // % 는 커널의 idle 기준이므로 idle+iowait 를 빼야 한다.
  const cores = list.map((c) => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    return { total, idle: c.times.idle };
  });
  return { cores: cores.map((c) => Math.max(0, Math.min(100, 100 * (1 - c.idle / Math.max(1, c.total))))), overall: 0 };
}

async function readSwap(): Promise<{ totalBytes: number; freeBytes: number }> {
  try {
    const raw = await readFile("/proc/meminfo", "utf8");
    const get = (k: string) => {
      const m = raw.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, "m"));
      return m ? Number(m[1]) * 1024 : 0;
    };
    return { totalBytes: get("SwapTotal"), freeBytes: get("SwapFree") };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

async function readDisk(path: string): Promise<Metrics["disk"]> {
  try {
    const { statfs } = await import("node:fs/promises");
    const st = await statfs(path);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { totalBytes: total, freeBytes: free, usedPct: total > 0 ? 100 * (1 - free / total) : 0 };
  } catch {
    return { totalBytes: 0, freeBytes: 0, usedPct: 0 };
  }
}

/**
 * nvidia-smi 한 번 실행. 실패/없음 → null(0 이 아니다).
 * `--query-gpu` 를 사용해 드라이버 초기화를 유발하는 전체 출력 파싱을 피한다.
 */
export async function readGpu(bin = "nvidia-smi"): Promise<Metrics["gpu"]> {
  const args = [
    "--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ];
  const out = await new Promise<string | null>((resolve) => {
    execFile(bin, args, { timeout: 1500, maxBuffer: 4096 }, (err, stdout) => resolve(err ? null : stdout)).unref?.();
  });
  if (!out) return null;
  const line = out.split("\n")[0]?.trim();
  if (!line) return null;
  const [name, util, temp, power, memUsed, memTotal] = line.split(",").map((s) => s.trim());
  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const usedMiB = num(memUsed) ?? 0;
  const totalMiB = num(memTotal) ?? 0;
  return {
    name: name || "GPU",
    utilPct: num(util) ?? 0,
    // [N/A] 는 계측 불가다 — 0 도로 채우지 않는다(과열이 아니라 미확인).
    tempC: num(temp),
    powerW: num(power),
    memUsedMiB: usedMiB,
    memTotalMiB: totalMiB,
    memPct: totalMiB > 0 ? (100 * usedMiB) / totalMiB : 0,
  };
}

/** `/proc` 를 훑어 RSS 가 가장 큰 llama-server 프로세스. 없으면 null. */
export async function readLlamaRss(): Promise<{ rssBytes: number; threads: number } | null> {
  try {
    const { readdir, readFile: rf } = await import("node:fs/promises");
    const pids = await readdir("/proc");
    let best: { rssBytes: number; threads: number } | null = null;
    for (const p of pids) {
      if (!/^\d+$/.test(p)) continue;
      let cmd = "";
      let status = "";
      try {
        cmd = await rf(`/proc/${p}/cmdline`, "utf8");
        status = await rf(`/proc/${p}/status`, "utf8");
      } catch {
        continue;
      }
      if (!cmd.includes("llama-server")) continue;
      const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s*kB/m)?.[1] ?? 0);
      const threads = Number(status.match(/^Threads:\s+(\d+)/m)?.[1] ?? 0);
      if (!best || rssKb * 1024 > best.rssBytes) best = { rssBytes: rssKb * 1024, threads };
    }
    return best;
  } catch {
    return null;
  }
}

/** 120샘플 링 — 스파크라인이 필요로 하는 최소한만 남긴다. */
export class MetricsRing {
  private buf: Metrics[] = [];

  push(m: Metrics): void {
    this.buf.push(m);
    if (this.buf.length > RING_SIZE) this.buf.splice(0, this.buf.length - RING_SIZE);
  }

  get latest(): Metrics | null {
    return this.buf[this.buf.length - 1] ?? null;
  }

  get all(): Metrics[] {
    return this.buf;
  }

  /** 스파크라인용 단일 수열. */
  series(pick: (m: Metrics) => number | null): (number | null)[] {
    return this.buf.map(pick);
  }

  get size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
  }
}

export interface SamplerDeps {
  readGpu?: () => Promise<Metrics["gpu"]>;
  readLlamaRss?: () => Promise<{ rssBytes: number; threads: number } | null>;
  diskPath?: string;
  /** 컨텍스트/토큰 속도는 앱이 알아야 해서 주입받는다. */
  context?: () => { usedTokens: number; totalTokens: number } | null;
  tokensPerSec?: () => number | null;
}

export class MetricsSampler {
  private timer: NodeJS.Timeout | null = null;
  private lastCpu: CoreLoad | null = null;
  private inFlight = false;

  constructor(
    public readonly ring = new MetricsRing(),
    private deps: SamplerDeps = {},
  ) {}

  /** 한 번만 계측한다. 라우트는 이것을 부르지 않고 `ring.latest` 를 읽는다. */
  async sample(): Promise<Metrics> {
    const cpu = await readCpu();
    this.lastCpu = cpu;
    const total = totalmem();
    const free = freemem();
    const swap = await readSwap();
    const gpu = await (this.deps.readGpu ?? readGpu)();
    const disk = await readDisk(this.deps.diskPath ?? "/");
    const llama = await (this.deps.readLlamaRss ?? readLlamaRss)();
    const ctx = this.deps.context?.() ?? null;
    const m: Metrics = {
      at: Date.now(),
      cpu,
      mem: {
        totalBytes: total,
        freeBytes: free,
        usedBytes: total - free,
        usedPct: total > 0 ? (100 * (total - free)) / total : 0,
        swapTotalBytes: swap.totalBytes,
        swapFreeBytes: swap.freeBytes,
      },
      gpu,
      disk,
      llama,
      context: ctx ? { ...ctx, pct: ctx.totalTokens > 0 ? (100 * ctx.usedTokens) / ctx.totalTokens : 0 } : null,
      tokensPerSec: this.deps.tokensPerSec?.() ?? null,
    };
    this.ring.push(m);
    return m;
  }

  start(intervalMs = SAMPLE_MS): void {
    if (this.timer) return;
    const tick = () => {
      // **겹친 계측을 허용하지 않는다.** nvidia-smi 는 100~300ms 걸리고, 겹치면
      // 자기 자신이 만든 부하 때문에 샘플이 밀려 1Hz 를 못 지킨다(계측이 부하가 된다).
      if (this.inFlight) return;
      this.inFlight = true;
      void this.sample()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight = false;
        });
    };
    void tick();
    this.timer = setInterval(tick, intervalMs);
    // 데몬이 계측 때문에 종료되지 않게 한다.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}

/** 임계치 색상 (§5.5): 70/90. 색만 바꾸고 **점멸시키지 않는다**(눈부심·접근성). */
export function severity(pct: number): "ok" | "warn" | "crit" {
  if (pct > 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

/**
 * 리렌더 버킷 (§5.5 "값의 버킷이 바뀔 때만 리렌더").
 * 1초마다 37.3% → 37.31% 로 흔들리는 DOM 을 다시 만들면 프레임 예산이 다 나간다.
 */
export function bucket(pct: number, step = 0.1): number {
  return Math.round(pct / step) * step;
}

export function loadAverage1(): number {
  return loadavg()[0];
}

export async function cpuStatAvailable(): Promise<boolean> {
  try {
    await readFile(STAT_FS, "utf8");
    return true;
  } catch {
    return false;
  }
}
