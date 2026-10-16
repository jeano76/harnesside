import type { ChatMessage } from "../backend/types.js";
import { estimateTextTokens } from "../shared/textTokens.js";

/**
 * 규칙 기반 1단계 컴팩션 — observation masking (OpenHands `ObservationMaskingCondenser`,
 * JetBrains "The Complexity Trap", Anthropic `clear_tool_uses` 와 같은 계열).
 *
 * 오래된 **도구 출력**만 자리표시자로 바꾼다. 모델이 쓴 문장·결정·도구 호출 기록은 그대로
 * 둔다. 컨텍스트 대부분이 run_shell/read_file 출력이고 그건 다시 실행하면 복원되는 정보라
 * LLM 요약(생성 38 tok/s = 컴팩션 시간 전부) 없이 0초로 크게 줄일 수 있다.
 *
 * 순수 함수: I/O 없음, 입력 배열을 바꾸지 않는다. 멱등 — 이미 마스킹된 메시지는 건드리지 않는다.
 */
export interface MaskingOptions {
  /** 켜기/끄기 (기본 true). */
  enabled?: boolean;
  /** 가장 최근 도구 결과 N개는 절대 마스킹하지 않는다(기본 4). 방금 본 출력이 사라져
   *  같은 명령을 재실행하는 루프(실측: 실패하는 npm test)를 막는다. */
  keepRecentToolResults?: number;
  /** 이보다 짧은 출력은 마스킹해도 이득이 없어 둔다(기본 400자). */
  minChars?: number;
  /** 마스킹 후에도 남기는 앞부분 길이(기본 200자). 오류처럼 보이면 3배. */
  keepChars?: number;
  /** 원문을 보관한 파일. 있으면 자리표시자가 그 경로와 항목 id 를 알려준다(호출자가 쓰기를 보장한다). */
  archivePath?: string;
  /** 이만큼 줄이면 멈춘다 — **오래된 것부터** 필요한 만큼만 마스킹하고 나머지는 원문 그대로 둔다.
   *  없으면 보호 대상을 뺀 전부를 마스킹한다. */
  needTokens?: number;
}

export const DEFAULT_MASKING = {
  enabled: true,
  keepRecentToolResults: 4,
  minChars: 400,
  keepChars: 200,
} as const;

export const MASK_MARKER = "[tool output omitted by compaction";

const ERROR_RE = /\b(error|fail(ed|ure)?|exception|traceback|panic|denied|ENOENT|ECONN\w*)\b|✗|FAIL/i;

export interface MaskResult {
  /** 마스킹된 도구 출력의 원문 — 보관 파일에 쓸 항목. */
  archived: { id: string; label: string; text: string }[];
  messages: ChatMessage[];
  maskedCount: number;
  /** 추정 절감 토큰. */
  savedTokens: number;
  /** 화면용: 마스킹된 항목 최대 몇 줄. */
  preview: string[];
}

export function maskObservations(messages: ChatMessage[], opts: MaskingOptions = {}): MaskResult {
  const o = { ...DEFAULT_MASKING, ...opts };
  const none: MaskResult = { archived: [], messages, maskedCount: 0, savedTokens: 0, preview: [] };
  if (!o.enabled) return none;

  // tool_call_id → "name(args…)" 라벨. 나중에 모델이 "무엇의 출력이었나"를 알 수 있게 한다.
  const labels = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      labels.set(tc.id, `${tc.function.name}(${tc.function.arguments.replace(/\s+/g, " ").slice(0, 80)})`);
    }
  }

  const toolIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") toolIdx.push(i);
  });
  const protect = new Set(toolIdx.slice(Math.max(0, toolIdx.length - o.keepRecentToolResults)));

  let maskedCount = 0;
  let savedTokens = 0;
  const preview: string[] = [];
  const archived: MaskResult["archived"] = [];
  const out = messages.slice();

  // X-3: 스킬 본문은 **영구 상주하지 않는다.** 다시 불러올 수 있으므로 압축 때 가장 먼저 내린다 —
  // 최근 N개 보호 대상에서도 빼고(가장 마지막 도구 결과 1개만 보호), 순서도 맨 앞이다.
  const isSkill = (i: number): boolean => {
    const m = messages[i]!;
    return m.role === "tool" && !!m.tool_call_id && (labels.get(m.tool_call_id) ?? "").startsWith("load_skill(");
  };
  const lastTool = toolIdx[toolIdx.length - 1];
  const skillFirst = toolIdx.filter((i) => isSkill(i) && i !== lastTool);
  const order = [...skillFirst, ...messages.map((_, i) => i).filter((i) => !skillFirst.includes(i))];

  for (const i of order) {
    const m = messages[i]!;
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    if (protect.has(i) && !skillFirst.includes(i)) continue;
    if (o.needTokens !== undefined && savedTokens >= o.needTokens) continue; // 필요한 만큼 줄였다 — 나머지는 원문 유지
    const text = m.content;
    if (text.length < o.minChars || text.startsWith(MASK_MARKER)) continue;

    const keep = ERROR_RE.test(text) ? o.keepChars * 3 : o.keepChars;
    const head = text.slice(0, keep).trimEnd();
    const label = (m.tool_call_id && labels.get(m.tool_call_id)) || "tool";
    const id = m.tool_call_id || `m${i}`;
    // 명령형으로 쓴다: "보관돼 있다" 는 서술만으로는 모델이 읽으러 가지 않고 "그 정보는 없다" 고 답했다(실측).
    const where = o.archivePath
      ? `the FULL text is saved — to see it, read_file ${o.archivePath} and look for "entry ${id}"; or re-run the tool`
      : "re-run the tool if you need it again";
    const replaced =
      `${MASK_MARKER}: ${label} — ${text.length} chars; ${where}]\n${head}` +
      (head.length < text.length ? " …" : "");
    if (replaced.length >= text.length) continue;
    maskedCount++;
    savedTokens += Math.max(0, estimateTextTokens(text) - estimateTextTokens(replaced));
    archived.push({ id, label, text });
    if (preview.length < 8) preview.push(`[tool] ${label.slice(0, 70)} — ${text.length}자`);
    out[i] = { ...m, content: replaced };
  }
  return maskedCount === 0 ? none : { archived, messages: out, maskedCount, savedTokens, preview };
}
