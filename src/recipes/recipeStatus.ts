/**
 * 레시피 마지막 실행 상태 표시 — Node/YAML 의존성 없음 (웹 번들에서 읽는다).
 *
 * 실행한 적 없으면 "미실행"이지 "통과"가 아니다.
 * 시간 초과는 통과로 집계되지 않는다.
 */

export interface LastRun {
  at: number;
  ok: boolean;
  timedOut: boolean;
}

export function recipeStatusText(lastRun: LastRun | null): string {
  if (!lastRun) return "미실행";
  const when = new Date(lastRun.at).toLocaleString("ko-KR", { hour12: false });
  if (lastRun.timedOut) return `시간 초과 — ${when}`;
  return lastRun.ok ? `통과 — ${when}` : `실패 — ${when}`;
}
