/**
 * U-12 에이전트 생산성 계측 — 순수 로직 (Phase 1 최소).
 *
 * Phase 1 부터 이벤트를 기록해 둬야 나중에 F-1~F-7 을 판정할 표본이 있다.
 * 전부 로컬. 전송 없음. 계측 불가 시 null + 사유 ("미측정").
 * 빈 데이터에서 그럴듯한 숫자를 채우지 않고 "판정 불가"를 낸다.
 */

export interface ProductivityEvent {
  kind: "palette.open" | "palette.select" | "keymap.change" | "task.accept" | "recipe.run";
  at: number;
  detail?: string;
}

export interface ProductivitySummary {
  sampleN: number;
  verdict: "insufficient" | "available";
  /** 데이터 부족 시 사람이 볼 문장. 숫자를 채우지 않는다. */
  message: string;
  byKind: Record<string, number>;
}

export const MIN_SAMPLE_N = 5;

export function summarizeProductivity(events: ProductivityEvent[]): ProductivitySummary {
  const byKind: Record<string, number> = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  if (events.length < MIN_SAMPLE_N) {
    return {
      sampleN: events.length,
      verdict: "insufficient",
      message: `판정 불가 — 표본 ${events.length}건 (최소 ${MIN_SAMPLE_N}건 필요)`,
      byKind,
    };
  }
  return { sampleN: events.length, verdict: "available", message: `표본 ${events.length}건`, byKind };
}

/** 로컬 저장 키 — `.harnesside/state/metrics/` 서버 저장이 오기 전 임시 버퍼. */
export const PRODUCTIVITY_STORAGE_KEY = "harnesside.metrics.events.v1";
export const PRODUCTIVITY_CAP = 500;
