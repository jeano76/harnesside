/**
 * U-7 진단 — 순수 로직 (입출력 없음).
 *
 * - U-6 lint/build 레시피 결과를 파일·줄·심각도·규칙 id 로 구조화한다.
 * - 에이전트 턴이 파일을 수정하면 해당 턴 끝에만 새 문제를 블록으로 붙인다:
 *   "이번 턴이 만든 문제 N · 원래 있던 문제 M (숨김)".
 * - 새 문제가 있으면 루프에 한 번만 피드백한다 (무한 재시도 금지 — 상한 1).
 */

import type { ParsedFailure } from "./recipes.js";

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  rule: string | null;
  message: string;
  /** 어느 레시피가 냈는지 — 같은 문제를 낸 레시피가 바뀌어도 같은 문제로 본다. */
  source: string;
}

export function diagnosticsFromFailures(recipeName: string, failures: ParsedFailure[]): Diagnostic[] {
  return failures.map((f) => ({
    file: f.file,
    line: f.line,
    col: f.col,
    severity: f.severity,
    rule: f.rule,
    message: f.message,
    source: recipeName,
  }));
}

/** 같은 문제 판정 키 — source(어느 레시피)는 제외한다. */
export function diagnosticKey(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.col}:${d.rule ?? ""}:${d.message}`;
}

export interface DiagnosticsDiff {
  newProblems: Diagnostic[];
  preExisting: Diagnostic[];
}

/** baseline(턴 시작 전)에 없던 것만 새 문제. 모르면 "0개"로 채우지 않고 호출자가 baseline 없음을 말한다. */
export function diffDiagnostics(baseline: Diagnostic[], current: Diagnostic[]): DiagnosticsDiff {
  const before = new Set(baseline.map(diagnosticKey));
  const newProblems = current.filter((d) => !before.has(diagnosticKey(d)));
  const curKeys = new Set(current.map(diagnosticKey));
  const preExisting = current.filter((d) => before.has(diagnosticKey(d)) && curKeys.has(diagnosticKey(d)));
  return { newProblems, preExisting };
}

/** 피드백 재시도 상한 1 — 이미 보냈으면 다시 보내지 않는다. */
export function shouldSendDiagnosticFeedback(feedbacksSentThisTurn: number): boolean {
  return feedbacksSentThisTurn < 1;
}

export const DIAGNOSTICS_BLOCK_MAX_ITEMS = 10;

/** 턴 끝 블록 본문. 새 문제 0이면 null — 빈 블록을 붙이지 않는다. */
export function formatDiagnosticsBlock(newProblems: Diagnostic[], preExistingCount: number, maxItems = DIAGNOSTICS_BLOCK_MAX_ITEMS): string | null {
  if (newProblems.length === 0) return null;
  const lines = [
    `이번 턴이 만든 문제 ${newProblems.length} · 원래 있던 문제 ${preExistingCount} (숨김)`,
    ...newProblems.slice(0, maxItems).map((d) => {
      const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "(위치 모름)";
      const rule = d.rule ? ` [${d.rule}]` : "";
      return `- ${where}${rule} ${d.message}`;
    }),
  ];
  if (newProblems.length > maxItems) lines.push(`… 외 ${newProblems.length - maxItems}건`);
  return lines.join("\n");
}

/** 루프에 보내는 1회 피드백 본문. */
export function formatDiagnosticFeedback(newProblems: Diagnostic[], maxItems = DIAGNOSTICS_BLOCK_MAX_ITEMS): string {
  const lines = [
    `[diagnostics] 이번 턴의 편집으로 새 문제 ${newProblems.length}개가 생겼습니다. 한 번만 고쳐보세요 — 그래도 남으면 사람에게 넘깁니다:`,
    ...newProblems.slice(0, maxItems).map((d) => {
      const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "(위치 모름)";
      const rule = d.rule ? ` [${d.rule}]` : "";
      return `- ${where}${rule} ${d.message}`;
    }),
  ];
  return lines.join("\n");
}
