/**
 * 사고(reasoning) 예산 초과를 **생성 도중에** 끊고 복구하는 데 쓰는 순수 조각들.
 *
 * 배경(실측, 2026-10-11): 같은 코딩 과제 8개를 Ornith-1.5-35B-A3B 로 풀게 했다. 8,000 토큰 한도에서
 * 2개가 코드 없이 끝났다 — 생각이 한도를 다 먹었다. 생각을 4,000 토큰에서 끊고, 그때까지의 생각을 넘겨
 * "생각을 끈 채 지금 답하라" 고 하자 8/8 이 통과했고 시간은 25% 줄었다(2,000 토큰은 어려운 과제를 해쳐 6/8).
 *
 * 기존 `agentService` 의 사고 상한은 넘으면 thinking 표시를 끄고 플래그만 세웠을 뿐 **진행 중인 생성은
 * 끊지 못했다.** 그래서 폭주한 생성은 끝까지 갔다. 여기서는 끊는 쪽을 맡는다.
 */

/** 끊을 때 다음 요청에 실어 보내는 "지금까지의 생각" 의 최대 글자 수 (뒤쪽을 남긴다 — 결론이 뒤에 있다). */
export const REASONING_EXCERPT_CHARS = 6000;

/** 생각 전체가 아니라 끝부분만 남긴다. */
export function reasoningExcerpt(reasoning: string, maxChars = REASONING_EXCERPT_CHARS): string {
  const text = reasoning.trim();
  if (text.length <= maxChars) return text;
  return "…" + text.slice(text.length - maxChars);
}

/** 한 턴에서 예산으로 끊는 최대 횟수. 넘으면 그 턴은 예산을 끈다(기존 동작) — 끊고 도구 하나 부르고 다시 폭주하는 순환을 막는다. */
export const MAX_BUDGET_CUTS_PER_TURN = 3;

/** 끊을 때마다 다음 라운드의 예산을 2배로 키운다 — 어려운 문제일수록 생각할 여유를 더 준다. 상한 횟수를 넘으면 0(끔). */
export function effectiveBudget(base: number, cutsSoFar: number): number {
  if (!(base > 0) || cutsSoFar >= MAX_BUDGET_CUTS_PER_TURN) return 0;
  return base * 2 ** cutsSoFar;
}

/** 예산이 켜져 있고(양수) 이번 라운드에서 아직 보이는 출력이 없으며 이미 넘었는가. */
export function overBudget(opts: { spent: number; budget: number; sawOutput: boolean }): boolean {
  return opts.budget > 0 && !opts.sawOutput && opts.spent > opts.budget;
}

export function thinkingBudgetNudge(excerpt: string): string {
  const head =
    "Your reasoning ran past the thinking budget, so it was stopped and thinking is turned off for this step. " +
    "Stop deliberating and act now: call the next tool, or if the task is done, give the final answer in plain text.";
  if (!excerpt) return head;
  return `${head}\n\nYour reasoning so far (the tail of it), for you to build on:\n${excerpt}`;
}
