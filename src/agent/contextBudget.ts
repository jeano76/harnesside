/**
 * X-2 컨텍스트 예산 게이트 — 도구 결과가 로컬 컨텍스트로 들어가는 **단일 지점**의 크기 제한.
 *
 * 예전 `capToolResult` 는 앞부분만 남기고 잘랐다. 그러면 출력 끝에 나오는 실패 요약
 * (`npm test` 의 `not ok`·스택)이 통째로 사라진다. 여기서는 앞 N줄 + 실패·에러 줄 + 뒤 M줄을 남기고,
 * 잘렸다는 사실과 전체 원문 경로를 **항상** 결과에 적는다(잘렸는데 안 잘린 척하지 않는다).
 *
 * 이 검사가 거짓말할 수 있는 경우: ① 에러 패턴에 안 걸리는 실패 문구는 중간에서 사라진다 —
 * 그래서 원문 경로를 항상 붙인다. ② 한 줄이 상한보다 길면 줄 단위로 못 자른다 — 문자 단위로 자른다.
 */

/** 중간 구간에서 우선 보존하는 줄(실패·에러). 흔한 러너·컴파일러 표기를 포괄한다. */
const IMPORTANT_LINE = /\b(error|fail(?:ed|ure|ing)?|exception|panic|fatal|traceback|assert(?:ion)?)\b|not ok|✖|✗|ERR!|TS\d{4}/i;

/** 경계 문장이 차지할 여유(문자). 상한 안에 문장까지 들어가야 "상한 이하" 가 참이다. */
const NOTE_RESERVE = 220;
const HEAD_SHARE = 0.4;
const TAIL_SHARE = 0.3;

export interface BudgetResult {
  text: string;
  /** 잘렸는가. false 면 `text` 는 원문 그대로다. */
  truncated: boolean;
  omittedLines: number;
}

function clipLine(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/**
 * `content` 가 `cap` 문자를 넘으면 앞·뒤·실패 줄만 남긴다.
 * `fullPath` 는 원문을 저장한 경로(있으면 안내에 적는다).
 */
export function budgetToolOutput(content: string, cap: number, fullPath?: string | null): BudgetResult {
  if (content.length <= cap) return { text: content, truncated: false, omittedLines: 0 };
  const room = Math.max(200, cap - NOTE_RESERVE);
  const lineMax = Math.max(80, Math.floor(room / 4));
  const lines = content.split("\n");

  const headBudget = Math.floor(room * HEAD_SHARE);
  const tailBudget = Math.floor(room * TAIL_SHARE);
  const midBudget = room - headBudget - tailBudget;

  const head: string[] = [];
  let used = 0;
  let h = 0;
  for (; h < lines.length; h++) {
    const l = clipLine(lines[h]!, lineMax);
    if (used + l.length + 1 > headBudget) break;
    head.push(l);
    used += l.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  let t = lines.length - 1;
  for (; t >= h; t--) {
    const l = clipLine(lines[t]!, lineMax);
    if (used + l.length + 1 > tailBudget) break;
    tail.unshift(l);
    used += l.length + 1;
  }
  const mid: string[] = [];
  used = 0;
  for (let i = h; i <= t; i++) {
    if (!IMPORTANT_LINE.test(lines[i]!)) continue;
    const l = clipLine(lines[i]!, lineMax);
    if (used + l.length + 1 > midBudget) break;
    mid.push(l);
    used += l.length + 1;
  }
  const kept = head.length + mid.length + tail.length;
  const omittedLines = Math.max(0, lines.length - kept);
  const where = fullPath ? `전체: ${fullPath} — read_file 로 범위를 지정해 읽는다` : "전체 원문은 저장하지 못했다";
  const note = `… (${omittedLines}줄 생략, ${where})`;
  const parts = [...head, note];
  if (mid.length > 0) parts.push("[생략 구간의 에러·실패 줄]", ...mid, "[이어서 끝부분]");
  parts.push(...tail);
  return { text: parts.join("\n"), truncated: true, omittedLines };
}

/**
 * 도구 결과 한 건의 상한(문자). 기준(`baseCap`)은 창 크기에 비례하고(`loop.ts`),
 * **남은 여유가 적을수록 더 엄격**하게 줄인다: 남은 토큰의 8% 를 넘지 못한다.
 * 측정 전(`usedTokens` 없음)에는 기준을 그대로 쓴다. 바닥 1,000자 — 이보다 작으면 쓸모가 없다.
 */
export function effectiveCap(baseCap: number, contextWindowTokens: number, usedTokens: number | null): number {
  if (usedTokens === null) return baseCap;
  const remaining = Math.max(0, contextWindowTokens - usedTokens);
  return Math.max(1_000, Math.min(baseCap, Math.floor(remaining * 4 * 0.08)));
}
