/**
 * 모델 관리 도메인 (§7 · P11 · 요구 5).
 *
 * 요구 5 의 핵심은 세 단계다:
 *  1. **검색** (HF)
 *  2. **추천** — **Ornith 계열이 점수와 무관하게 1순위 고정** (P11 명시)
 *  3. **멀티 다운로드(중단/재개) → 교체 → llama 재기동 → 새 모델 응답 확인**
 *
 * 여기서 판단이 틀리면 **사용자 파일이 손상**된다: 교체 전에 현재 모델 경로가 사라지면
 * 되돌아갈 곳이 없다. 그래서 "교체" 는 **원자적**이어야 하고, 실패하면 반드시
 * 원래 경로로 돌아간다.
 */

import { basename, extname } from "node:path";

export type DownloadState = "queued" | "downloading" | "paused" | "verifying" | "done" | "failed" | "canceled";

export interface DownloadItem {
  id: string;
  file: string;
  /** 총 바이트. 알 수 없으면 0 — "모름" 을 0 으로 말하지 않는다. */
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  /** 0~100. totalBytes 가 0 이면 **0** (진행률을 지어내지 않는다). */
  progress: number;
  bytesPerSec: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ModelEntry {
  id: string;
  repo: string;
  file: string;
  /** 전체 경로. 로컬 설치 경로. */
  path: string;
  bytes: number;
  /** 사용자가 붙인 이름. null 이면 파일명으로. */
  label: string | null;
  family: string;
  quant: string | null;
  installedAt: number;
  lastUsedAt: number | null;
  /** 현재 활성 모델인가. */
  active: boolean;
}

const GGUF = /\.gguf$/i;
const NOISE = [/mmproj/i, /-vocab\.gguf$/i, /\.part$/i, /incomplete/i, /\.tmp$/i];

export function isUsableModel(file: string): boolean {
  if (!GGUF.test(file)) return false;
  return !NOISE.some((re) => re.test(file));
}

const QUANT_ORDER = ["IQ3_M", "IQ4_XS", "Q3_K_XL", "Q4_K_S", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "F16"];

function quantIndex(q: string | null): number {
  if (!q) return -1;
  const i = QUANT_ORDER.findIndex((x) => q.toUpperCase().includes(x));
  return i;
}

export function parseModelFile(file: string): { family: string; quant: string | null } {
  const name = basename(file).replace(GGUF, "");
  const quant = name.match(/[IQF]\d+[_A-Z0-9]*/i)?.[0]?.toUpperCase() ?? null;
  const family = name
    .replace(/[IQF]\d+[_A-Z0-9]*$/i, "")
    .replace(/[-_.]+$/, "")
    .trim();
  return { family: family || name, quant };
}

/** §7 / P11: **Ornith 계열이 점수와 무관하게 1순위 고정**. */
export const PINNED_FAMILY = "Ornith";

export function isPinned(family: string): boolean {
  return family.toLowerCase().startsWith(PINNED_FAMILY.toLowerCase());
}

export interface ListView {
  /** 화면에 보여줄 순서. */
  ordered: ModelEntry[];
  pinned: ModelEntry[];
  others: ModelEntry[];
  totalBytes: number;
}

/**
 * 모델 목록을 **요구 순서**로 정렬한다.
 *  1. Ornith 계열 고정 (점수 무관)
 *  2. 활성 모델
 *  3. 양자화 품질순 (큰 것이 빠르다)
 *  4. 이름순 (결정적)
 */
export function listModels(entries: ModelEntry[]): ListView {
  const usable = entries.filter((e) => isUsableModel(e.file));
  const pinned = usable.filter((e) => isPinned(e.family));
  const others = usable.filter((e) => !isPinned(e.family));
  const cmp = (a: ModelEntry, b: ModelEntry) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const q = quantIndex(b.quant) - quantIndex(a.quant);
    if (q !== 0) return q;
    if (b.lastUsedAt !== a.lastUsedAt) return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
    return a.file.localeCompare(b.file);
  };
  const ps = [...pinned].sort(cmp);
  const os = [...others].sort(cmp);
  return {
    ordered: [...ps, ...os],
    pinned: ps,
    others: os,
    totalBytes: usable.reduce((a, e) => a + e.bytes, 0),
  };
}

/** 활성 모델은 정확히 하나여야 한다. */
export function withActive(entries: ModelEntry[], id: string): ModelEntry[] {
  return entries.map((e) => ({ ...e, active: e.id === id }));
}

export function activeModel(entries: ModelEntry[]): ModelEntry | null {
  return entries.find((e) => e.active) ?? null;
}

export function activate(entries: ModelEntry[], id: string): { entries: ModelEntry[]; changed: boolean; reason: string } {
  const target = entries.find((e) => e.id === id);
  if (!target) return { entries, changed: false, reason: "모델을 찾을 수 없습니다" };
  if (!isUsableModel(target.file)) return { entries, changed: false, reason: `사용할 수 없는 파일입니다: ${target.file}` };
  if (target.active) return { entries, changed: false, reason: "이미 활성 모델입니다" };
  return { entries: withActive(entries, id), changed: true, reason: `${target.label ?? target.file} 로 전환합니다` };
}

// ---------------------------------------------------------------- 다운로드

export function newDownload(id: string, file: string, totalBytes: number, now = Date.now()): DownloadItem {
  return {
    id,
    file,
    totalBytes,
    receivedBytes: 0,
    state: "queued",
    // **모르는 진행률은 0 이 아니라 null 로 말해야 하는데**, UI 는 숫자를 요구한다.
    // 그래서 totalBytes 0 은 "크기 모름" 을 뜻하고 진행률을 0 으로 두되, 표시를 다르게 한다.
    progress: 0,
    bytesPerSec: 0,
    error: null,
    startedAt: now,
    finishedAt: null,
  };
}

export function startDownload(d: DownloadItem, now = Date.now()): DownloadItem {
  if (d.state === "done") return d;
  return { ...d, state: "downloading", error: null, startedAt: d.startedAt ?? now };
}

/** 중단. **삭제하지 않는다** — 재개해야 한다. */
export function pauseDownload(d: DownloadItem): DownloadItem {
  if (d.state !== "downloading") return d;
  return { ...d, state: "paused", bytesPerSec: 0 };
}

export function resumeDownload(d: DownloadItem): DownloadItem {
  if (d.state !== "paused" && d.state !== "failed") return d;
  return { ...d, state: "downloading", error: null };
}

export function cancelDownload(d: DownloadItem, now = Date.now()): DownloadItem {
  if (d.state === "done") return d; // 이미 끝난 건 취소가 아니라 그대로
  return { ...d, state: "canceled", bytesPerSec: 0, finishedAt: now };
}

export function advanceDownload(d: DownloadItem, chunk: number, now = Date.now()): DownloadItem {
  if (d.state !== "downloading") return d;
  const received = d.receivedBytes + Math.max(0, chunk);
  // **받은 만큼을 총 크기로 덮어쓰면 안 된다** — 그러면 0 바이트를 받은 순간
  // "100바이트 수신" 이 되어 재개 지점이 사라지고 진행률이 100% 로 뛴다(실제 버그).
  const cap = d.totalBytes > 0 ? Math.min(received, d.totalBytes) : received;
  const state: DownloadState = d.totalBytes > 0 && received >= d.totalBytes ? "verifying" : "downloading";
  const elapsed = d.startedAt ? (now - d.startedAt) / 1000 : 0;
  return {
    ...d,
    receivedBytes: cap,
    state,
    progress: d.totalBytes > 0 ? Math.min(100, (100 * received) / d.totalBytes) : 0,
    bytesPerSec: elapsed > 0 ? cap / elapsed : 0,
  };
}

export function failDownload(d: DownloadItem, error: string, now = Date.now()): DownloadItem {
  return { ...d, state: "failed", error, bytesPerSec: 0, finishedAt: now };
}

export function completeDownload(d: DownloadItem, now = Date.now()): DownloadItem {
  // **취소/실패한 항목을 "완료" 로 되돌리면 안 된다.** 늦게 도착한 마지막 조각이
  // 취소한 8 GiB 다운로드를 "완료" 로 만들면, 사용자가 취소한 파일이 조용히 설치된다.
  if (d.state === "canceled" || d.state === "failed" || d.state === "paused") return d;
  return { ...d, state: "done", progress: 100, bytesPerSec: 0, finishedAt: now };
}

export interface QueueView {
  active: DownloadItem[];
  paused: DownloadItem[];
  done: DownloadItem[];
  failed: DownloadItem[];
  /** 동시 다운로드 개수. */
  concurrency: number;
  /** 전체 바이트 대비 완료 바이트. 총합이 0 이면 0 (아무것도 하지 않았다). */
  overallPct: number;
  totalBytes: number;
  receivedBytes: number;
}

/** 멀티 다운로드(중단/재개). 동시성 제한이 있어야 대역폭과 디스크를 지킨다. */
export function queueView(items: DownloadItem[]): QueueView {
  const active = items.filter((i) => i.state === "downloading");
  const totalBytes = items.reduce((a, i) => a + i.totalBytes, 0);
  const receivedBytes = items.reduce((a, i) => a + i.receivedBytes, 0);
  return {
    active,
    paused: items.filter((i) => i.state === "paused"),
    done: items.filter((i) => i.state === "done"),
    failed: items.filter((i) => i.state === "failed"),
    concurrency: active.length,
    overallPct: totalBytes > 0 ? (100 * receivedBytes) / totalBytes : 0,
    totalBytes,
    receivedBytes,
  };
}

/** 동시성을 지키며 다음에 시작할 항목을 고른다(대용량 우선 — 하나를 오래 붙잡지 않는다). */
export function nextToStart(items: DownloadItem[], maxConcurrent = 2): DownloadItem | null {
  const running = items.filter((i) => i.state === "downloading" || i.state === "verifying").length;
  if (running >= maxConcurrent) return null;
  const candidates = items.filter((i) => i.state === "queued" || i.state === "failed");
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => b.totalBytes - a.totalBytes)[0];
}

export function formatBytes(n: number): string {
  if (n <= 0) return "크기 모름";
  if (n < 1024) return `${n} B`;
  // KiB 부터는 **항상 소수 1자리** — "512 KiB" 와 "2.0 KiB" 가 섞이면
  // 목록에서 폭이 들쭉날쭉해진다(같은 단위를 같은 모양으로 보여야 비교된다).
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(1)} GiB`;
}

// ---------------------------------------------------------------- 교체

export type SwapStep = "check" | "stop-llama" | "switch" | "restart" | "verify" | "done" | "rollback";

export interface SwapPlan {
  steps: SwapStep[];
  /** 되돌릴 수 있는가. false 면 **시도 자체를 막는다**. */
  canRollback: boolean;
  warnings: string[];
}

export interface SwapContext {
  from: ModelEntry | null;
  to: ModelEntry;
  /** 기존 경로를 보존하는가. */
  preserveOld: boolean;
  /** llama 재기동을 시도할 수 있는가. */
  canRestartLlama: boolean;
}

/**
 * 교체 계획. **기존 파일을 지우지 않는다** — 되돌릴 곳이 사라지면 실패 시 회복이
 * 불가능해진다. `preserveOld: false` 라고 경고만 내고 진행하는 게 아니라 막는다.
 */
export function planSwap(ctx: SwapContext): SwapPlan {
  const warnings: string[] = [];
  const steps: SwapStep[] = ["check"];
  let canRollback = ctx.from !== null;

  if (ctx.to.bytes === 0) warnings.push("대상 모델 크기가 0 입니다 — 다운로드가 덜 된 파일일 수 있습니다.");
  if (ctx.from && ctx.from.id === ctx.to.id) {
    warnings.push("현재 활성 모델과 같습니다.");
  }
  if (!ctx.preserveOld && ctx.from) {
    // 기존 경로를 지우면 **되돌릴 곳이 없다.**
    warnings.push("기존 모델 파일을 삭제하면 되돌릴 수 없습니다. '이전 모델 유지'를 켜십시오.");
    canRollback = false;
  }
  if (!ctx.canRestartLlama) {
    warnings.push("llama 재기동을 시도할 수 없습니다. 교체 후 수동으로 서버를 재시작해야 합니다.");
  }

  steps.push("stop-llama", "switch", "restart");
  // **응답 확인이 없다면 교체 성공을 알 수 없다** — "설치 성공 = 성공" 함정(§5.13.1).
  if (ctx.canRestartLlama) steps.push("verify");
  steps.push("done");
  return { steps, canRollback, warnings };
}

export interface SwapResult {
  ok: boolean;
  step: SwapStep;
  /** 실패 시 왜 — 사람 문장(§11.3). */
  reason: string;
  /** 되돌렸는가. */
  rolledBack: boolean;
  activeId: string;
}

/** 교체 실행 결과 판정 — 단계별로 "설치됨" 과 "동작함" 을 구분한다(§5.13.1 원칙). */
export function judgeSwap(r: { step: SwapStep; error?: string | null; probed?: boolean; responseOk?: boolean }, targetId: string): SwapResult {
  if (r.error) {
    return {
      ok: false,
      step: r.step,
      reason: `${stepLabel(r.step)} 실패: ${r.error}`,
      // 되돌렸는지는 호출자가 정한다. 여기서는 "실패" 만 말한다.
      rolledBack: false,
      activeId: targetId,
    };
  }
  if (r.step === "verify" && !r.probed) {
    return { ok: false, step: "verify", reason: "교체는 끝났지만 새 모델의 응답을 확인하지 못했습니다. 아직 동작한다고 볼 수 없습니다.", rolledBack: false, activeId: targetId };
  }
  if (r.step === "verify" && r.responseOk === false) {
    return { ok: false, step: "verify", reason: "새 모델이 응답하지 않습니다. 이전 모델로 되돌렸습니다.", rolledBack: true, activeId: targetId };
  }
  return { ok: true, step: r.step, reason: "교체 완료", rolledBack: false, activeId: targetId };
}

export function stepLabel(s: SwapStep): string {
  const m: Record<SwapStep, string> = {
    check: "대상 확인",
    "stop-llama": "llama-server 정지",
    switch: "모델 교체",
    restart: "llama-server 재기동",
    verify: "새 모델 응답 확인",
    done: "완료",
    rollback: "이전 모델로 복원",
  };
  return m[s];
}

/** 첫 실행 가이드(§11.3): 모델 준비 → 워크스페이스 선택 → 시작. */
export function firstRunSteps(hasModel: boolean, hasWorkspace: boolean): { n: number; text: string; done: boolean }[] {
  return [
    { n: 1, text: hasModel ? "모델 준비됨" : "모델을 선택하거나 받아 오세요", done: hasModel },
    { n: 2, text: hasWorkspace ? "워크스페이스 선택됨" : "작업할 폴더를 선택하세요", done: hasWorkspace },
    { n: 3, text: "준비 완료 — 아래 입력창에서 시작하세요", done: hasModel && hasWorkspace },
  ];
}
