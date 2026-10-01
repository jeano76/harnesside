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
// **정본은 shared** 다. 웹 UI 도 이 타입/순수 함수를 쓰는데, 서버 모듈에서 가져가면
// 번들에 node:child_process 가 딸려 들어간다(실제로 웹 빌드가 실패했다).
import {
  severity,
  bucket,
  type CoreLoad,
  type GpuInfo,
  type MemInfo,
  type DiskInfo,
  type ContextInfo,
  type Metrics,
} from "../shared/metrics.js";

export { severity, bucket, SEVERITY_COLOR } from "../shared/metrics.js";
export type { CoreLoad, GpuInfo, MemInfo, DiskInfo, ContextInfo, Metrics } from "../shared/metrics.js";

export const SAMPLE_MS = 1000;
/** 스파크라인용 링 크기 — §5.5 "최근 60초(120샘플)" 의 1Hz 기준 60 샘플 + 여유. */
export const RING_SIZE = 120;

const STAT_FS = "/proc/stat";

/** 코어의 누적 시간 스냅샷. 두 스냅샷의 **차이**로만 사용률을 낸다. */
export interface CpuSnapshot {
  total: number;
  idle: number;
  cores: { total: number; idle: number }[];
  count: number;
}

export function readCpuSnapshot(): CpuSnapshot {
  const list = cpus();
  if (list.length === 0) {
    // 컨테이너처럼 cpu 목록이 비어 있으면 스냅샷도 없다 — 0 이 아니라 "없음" 다.
    return { total: 0, idle: 0, cores: [], count: 0 };
  }
  const cores = list.map((c) => ({
    total: Object.values(c.times).reduce((a, b) => a + b, 0),
    // iowait 도 유휴다 — 빼지 않으면 "디스크 대기" 가 "이 코어 100% 부하" 로 보인다.
    idle: c.times.idle + ((c.times as { iowait?: number }).iowait ?? 0),
  }));
  return {
    total: cores.reduce((a, c) => a + c.total, 0),
    idle: cores.reduce((a, c) => a + c.idle, 0),
    cores,
    count: cores.length,
  };
}

/**
 * 직전 스냅샷 대비 사용률 %.
 *
 * **누적값을 그대로 비율내면 부팅 이후의 평균이 나온다** — 조용한 서버가 "CPU 0%" 로
 * 보이고, 3초 전 버스트가 사라진다. 부하가 "안 되는" 것처럼 보인다. 반드시 두
 * 스냅샷의 차이를 써야 "지금" 이 나온다(요구 11).
 */
export function cpuUsageBetween(prev: CpuSnapshot | null, next: CpuSnapshot): CoreLoad {
  if (!prev || prev.count !== next.count || next.count === 0) {
    // 첫 샘플은 기준이 없다. **0 이 아니라 빈 배열**을 돌려 "아직 모른다" 를 알린다.
    return { cores: [], overall: 0 };
  }
  const pct = (dTotal: number, dIdle: number) => (dTotal <= 0 ? 0 : Math.max(0, Math.min(100, (100 * (dTotal - dIdle)) / dTotal)));
  const cores = next.cores.map((c, i) => pct(c.total - prev.cores[i].total, c.idle - prev.cores[i].idle));
  return { cores, overall: pct(next.total - prev.total, next.idle - prev.idle) };
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
    // **`0` 으로 채우지 않는다** (2026-10-01) — 바로 아래 `tempC` 가 그 이유를
    // 이미 적어 둔 것과 같은 규칙이다. `nvidia-smi` 가 `[N/A]` 를 주면(드라이버가
    // 샘플러를 못 잡는 경우) 0 은 **"안 쓴다"** 라고 읽힌다 — 실제로 안 쓰는 것과
    // **측정 못 한 것** 은 다르다. 0 로 두면 게이지가 "정상" 으로 보이므로
    // **모르는 것이 알았다고 말하는 셈**이 되고, 그게 조용히 실패다.
    // 미확인은 `null` 이고, 화면은 사유를 말한다(§`MonitorPanel` 의 `why`).
    utilPct: num(util),
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
  private prevCpu: CpuSnapshot | null = null;
  private inFlight = false;
  private hooks: ((m: Metrics) => void)[] = [];

  constructor(
    public readonly ring = new MetricsRing(),
    private deps: SamplerDeps = {},
  ) {}

  /** 새 샘플이 나올 때마다 한 번 — WS 브로드캐스트용(§2.3 · §5.5). */
  onSample(fn: (m: Metrics) => void): void {
    this.hooks.push(fn);
  }

  /**
   * 한 번만 계측한다. 라우트는 이것을 부르지 않고 `ring.latest` 를 읽는다.
   *
   * **한 프로브가 죽어도 나머지 계측은 산다.** nvidia-smi 가 예외를 던져(드라이버
   * 재설치 중 등) 전체 샘플이 사라지면 모니터 패널이 통째로 멈춘다 — 사용자는
   * "무슨 일이 있어?" 을 알 수 없다. 죽은 프로브만 null 이 되고 나머지는 값이 온다.
   */
  async sample(): Promise<Metrics> {
    const snap = readCpuSnapshot();
    const cpu = cpuUsageBetween(this.prevCpu, snap);
    this.prevCpu = snap;
    const safely = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch {
        return fallback;
      }
    };
    const total = totalmem();
    const free = freemem();
    const swap = await readSwap();
    const gpu = await safely(() => (this.deps.readGpu ?? readGpu)(), null);
    const disk = await safely(() => readDisk(this.deps.diskPath ?? "/"), { totalBytes: 0, freeBytes: 0, usedPct: 0 });
    const llama = await safely(() => (this.deps.readLlamaRss ?? readLlamaRss)(), null);
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
    // 훅이 예외를 던져도 샘플은 이미 링에 있다 — WS 팬아웃 실패가 계측을 죽이면 안 된다.
    for (const h of this.hooks) {
      try {
        h(m);
      } catch {
        /* 한 구독자의 실패가 계측을 멈추게 두지 않는다 */
      }
    }
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
