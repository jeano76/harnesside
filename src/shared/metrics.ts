/**
 * 서버/웹이 **공유**하는 순수 로직 (§5.5).
 *
 * 왜 이 파일이 따로 있는가: 순수 계산(`severity`, `bucket`)은 웹 UI 도 서버도 쓴다.
 * 서버 모듈에 그대로 두면 웹 번들에 `node:child_process` 가 딸려 들어간다 —
 * 실제로 그렇게 났고, 번들이 깨졌다(빌드 실패). 공유 코드는 **양쪽 모두에 안전한**
 * 모듈에 두어야 한다. 여기가 그 자리다.
 *
 * 규칙: 이 파일에는 `import` 가 **없어야** 한다. 하나라도 들어가면 경계를 다시 검토한다.
 */

export interface CoreLoad {
  /** 코어별 사용률 %. 빈도 0(단일 코어 머신/컨테이너)이면 빈 배열 = "아직 모른다". */
  cores: number[];
  overall: number;
}

export interface GpuInfo {
  name: string;
  /**
   * [N/A] 는 계측 불가 — **`null` 이지 0 이 아니다** (2026-10-01).
   *
   * 예전엔 `number` 였다. 아래 `tempC` 가 그 이유를 이미 적어 둔 것과 같은 규칙인데
   * **이 하나만 예외**였고, 그래서 "GPU 를 안 쓰는 것" 과 "GPU 사용률을 못 잰 것" 이
   * 화면에서 같아졌다. `nvidia-smi` 가 `[N/A]` 를 주면 0 이 찍혔다 — 사용자는
   * "안 쓴다" 고 읽고, 실제로는 **몰랐다** 고 말해야 하는 자리를 **안다** 고 말했다.
   */
  utilPct: number | null;
  /** [N/A] 는 계측 불가 — null 이지 0 이 아니다. */
  tempC: number | null;
  powerW: number | null;
  memUsedMiB: number;
  memTotalMiB: number;
  memPct: number;
}

export interface MemInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPct: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

export interface DiskInfo {
  totalBytes: number;
  freeBytes: number;
  usedPct: number;
}

export interface ContextInfo {
  usedTokens: number;
  totalTokens: number;
  pct: number;
}

export interface Metrics {
  at: number;
  cpu: CoreLoad;
  mem: MemInfo;
  gpu: GpuInfo | null;
  disk: DiskInfo;
  llama: { rssBytes: number; threads: number } | null;
  context: ContextInfo | null;
  /** null 이면 "아직 측정 안 됨" — 0 이 아니다. */
  tokensPerSec: number | null;
}

/** §5.5: <70 정상, 70~90 주의, >90 경고. **색만** 바꾼다(점멸 금지). */
export type Severity = "ok" | "warn" | "crit";

export function severity(pct: number): Severity {
  if (pct > 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

export const SEVERITY_COLOR: Record<Severity | "unknown", string> = {
  ok: "#3fb950",
  warn: "#d29922",
  crit: "#f85149",
  // 계측 불가는 정상과 **다른** 색 — "쉬는 중" 과 "모름" 은 다르다.
  unknown: "#6e7681",
};

/**
 * 리렌더 버킷 (§5.5 "값의 버킷이 바뀔 때만 리렌더").
 * 1초마다 37.3% → 37.31% 로 흔들리는 DOM 을 다시 만들면 프레임 예산이 다 나간다.
 */
export function bucket(pct: number, step = 0.1): number {
  return Math.round(pct / step) * step;
}

/** §5.5: 컨텍스트 80% 초과 = 컴팩션 임박. 일반 임계(90)와 **다른** 신호다. */
export const COMPACTION_WARN_PCT = 80;

export function needsCompaction(ctx: ContextInfo | null): boolean {
  return ctx !== null && ctx.pct > COMPACTION_WARN_PCT;
}

export function formatBytes(n: number): string {
  if (n <= 0) return "크기 모름";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(1)} GiB`;
}
