import type { ChatMessage, ToolDef } from "../backend/types.js";
import type { ModelBackend } from "../backend/types.js";
import { Checkpoint, readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { readNotes } from "./notes.js";
import { messagesToEntries, newArchivePath, writeArchive } from "./archive.js";

export interface CompactionThresholds {
  /** Fraction of the model's context window (0-1) that triggers auto-compaction. */
  autoTriggerRatio: number;
  contextWindowTokens: number;
  /** Generation budget for the summary. This is the compaction's latency
   *  almost exactly (prefill is served from the prompt cache). Optional so
   *  existing callers need no change; see DEFAULT_SUMMARY_MAX_TOKENS. */
  summaryMaxTokens?: number;
  /** Where a successful compaction lands, as a fraction of the trigger
   *  level. Lower = longer interval until the next compaction, at the cost
   *  of keeping less recent history verbatim. Defaults to 0.4 in loop.ts. */
  postCompactionTargetRatio?: number;
  /** Minimum growth since the last compaction (fraction of window) before
   *  another auto-compaction may fire. Guards against back-to-back
   *  compactions when the post-budget math leaves no room. Defaults to
   *  0.05 in loop.ts. Overflow-retry still calls compact() directly. */
  minGrowthFraction?: number;
  /** P3 조기 compaction (opt-in, 기본 off). 로컬 모델은 창이 차기 전
   *  (절반~2/3)부터 지시 무시·환각이 시작한다는 보고가 있어, 실패 턴이
   *  연속되면 0.7을 기다리지 않고 일찍 압축하는 옵션. 무조건 창 확대는
   *  금지(KV가 가중치 잠식)라 임계 자체는 건드리지 않는다. */
  /** 삭제될 구간이 이 토큰 수 미만이면 LLM 요약을 건너뛴다(기본 FAST_PATH_INPUT_TOKENS, 0 = 끔). */
  fastPathInputTokens?: number;
  /** 규칙 기반 1단계(오래된 도구 출력 마스킹). 기본 켜짐 — masking.ts 참고. */
  masking?: import("./masking.js").MaskingOptions;
  earlyCompaction?: {
    enabled: boolean;
    /** 이 비율(기본 0.5)을 넘고 실패 턴이 연속되면 조기 압축. */
    earlyRatio?: number;
    /** 몇 턴 연속 실패부터 (기본 2). */
    failTurns?: number;
  };
}

/** P3 순수 판정 — 테스트 가능하게 분리. 기본 off이므로 enabled가 아니면 false. */
export function shouldEarlyCompact(
  used: number,
  window: number,
  consecutiveFailTurns: number,
  thresholds: Pick<CompactionThresholds, "autoTriggerRatio" | "earlyCompaction">
): boolean {
  const cfg = thresholds.earlyCompaction;
  if (!cfg?.enabled) return false;
  const earlyRatio = cfg.earlyRatio ?? 0.5;
  const failTurns = cfg.failTurns ?? 2;
  if (consecutiveFailTurns < failTurns) return false;
  if (used < window * earlyRatio) return false;
  // 이미 일반 트리거를 넘었으면 조기 판정이 아니라 일반 경로가 처리한다.
  if (used >= window * thresholds.autoTriggerRatio) return false;
  return true;
}

/** What a compaction actually did to the conversation — requested directly
 *  so the TUI can show before/after instead of compaction being a black
 *  box ("어떤 내용들이 잊혀지고 어떤 내용들이 강조가 되게 되었는지"). */
export interface CompactionDetail {
  droppedCount: number;
  droppedTokens: number;
  /** One line per dropped message, "[role] first ~70 chars", capped —
   *  see DETAIL_PREVIEW_CAP. */
  droppedPreview: string[];
  keptCount: number;
  keptTokens: number;
  /** 요약 요청에 실제로 들어간 입력 토큰(추정). 컴팩션이 느릴 때 prefill 비용(입력 토큰에 비례)을
   *  가늠하는 근거 — 상태 줄에 같이 표시한다. 빠른 경로(LLM 호출 없음)에서는 0. */
  summaryInputTokens?: number;
  /** 요약으로 대체된 구간의 전문을 보관한 파일(쓰지 못했으면 없음). */
  archivePath?: string;
  /** What replaced the dropped messages — the same text written to the
   *  checkpoint and the system prompt. */
  summary: string;
}

export interface CompactionResult {
  messages: ChatMessage[];
  checkpoint: Checkpoint;
  detail: CompactionDetail;
}

const DETAIL_PREVIEW_CAP = 8;

function previewLine(m: ChatMessage): string {
  const text = messageText(m).trim().replace(/\s+/g, " ");
  const snippet = text.length > 70 ? `${text.slice(0, 70)}…` : text || "(empty)";
  return `[${m.role}] ${snippet}`;
}

/** The text that actually counts toward a message's size in the real
 *  request. An assistant message requesting tool calls has `content: null`
 *  — the real payload sent to the backend lives entirely in
 *  `tool_calls[].function.{name,arguments}` instead, which every estimator
 *  here previously ignored completely (treated as ""). In a tool-heavy
 *  session (this agent calls run_shell/read_file/etc. constantly) that's
 *  not a rounding error — it undercounts a large fraction of the real
 *  conversation, so `shouldCompact` kept saying "plenty of room" right up
 *  until the backend hard-rejected the request with `exceeds the available
 *  context size` (seen live: 65,636 real tokens against a 65,536 window,
 *  repeating on retry since nothing had actually shrunk). Include tool call
 *  name+arguments so the estimate reflects what's actually being sent. */
function messageText(m: ChatMessage): string {
  const content = typeof m.content === "string" ? m.content : "";
  const toolCalls = (m.tool_calls ?? [])
    .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
    .join("\n");
  return toolCalls ? `${content}\n${toolCalls}` : content;
}

/**
 * Estimates the token weight of text, accounting for CJK (Hangul, Hanzi, Kana)
 * characters which consume ~1.5 to 2.5 tokens per character rather than 0.25 (chars/4).
 *
 * **정본은 `src/shared/textTokens.ts`** — 이 함수는 **재-export** 다.
 *
 * 왜 옮겼나: 추론 예산(`web/agent/think.ts`)이 이 추정을 쓰려고 여기서 가져오면
 * **브라우저 번들에 `node:fs` 가 딸려 들어온다**(실측: vite 빌드가
 * `"join" is not exported by "__vite-browser-external"` 로 깨졌다). 서버 전용
 * 모듈에 웹이 의존하면 **경계가 뒤집힌다.**
 * 순수 계산이라 `shared/` 가 원래 자리가었고, 서버는 그걸 그대로 쓴다.
 */
export { estimateTextTokens } from "../shared/textTokens.js";
// 재-export 는 **로컬 스코프에 넣지 않는다** — 아래에서 직접 쓴다.
// 그래서 둘 다 필요하다: 쓰기 위한 import, 남은 호출자를 위한 re-export.
import { estimateTextTokens } from "../shared/textTokens.js";

function charBasedEstimate(messages: ChatMessage[], extraText: string): number {
  let cjk = 0;
  let totalLength = extraText.length;
  for (const m of messages) {
    const text = messageText(m);
    totalLength += text.length;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0x1100 && code <= 0x11ff) ||
        (code >= 0x3130 && code <= 0x318f) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3040 && code <= 0x30ff)
      ) {
        cjk++;
      }
    }
  }
  for (let i = 0; i < extraText.length; i++) {
    const code = extraText.charCodeAt(i);
    if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjk++;
    }
  }
  const nonCjk = totalLength - cjk;
  return Math.ceil(cjk * 1.5 + nonCjk * 0.25);
}

/** Fast path: pure local heuristic, no backend HTTP.
 *
 *  배치 내 도구 호출 사이에서는 exact(`/apply-template`+`/tokenize`, 2x HTTP)가
 *  턴당 수십 회까지 반복된다(P3-2 실측 41ms/회). 임계와 멀 때는 근사로 충분하고,
 *  임계 근처에서만 exact로 확정한다. 호출자는 반드시 safety margin으로 fallback
 *  여부를 판단할 것 — 근사는 template 오버헤드를 과소평가한다(~19% 실측). */
export function estimateTokensFast(messages: ChatMessage[], extraText = ""): number {
  return charBasedEstimate(messages, extraText);
}

/** Uses the backend's real tokenizer (llama.cpp `/tokenize`) when available;
 *  falls back to a chars/4 approximation when the backend has no tokenizer
 *  or the call fails (e.g. a generic OpenAI-compatible endpoint without it).
 *
 *  `extraText` covers request payload that isn't part of `messages` at all
 *  but is still sent, and still costs real tokens — specifically the tool
 *  definitions schema (`TOOL_DEFS` in loop.ts), sent on every main-loop
 *  request. Found live: real usage (per llama-server's own reported
 *  n_tokens) kept running measurably past this project's compaction
 *  threshold before a compaction ever fired. Measured directly: the tool
 *  schema JSON alone tokenizes to 626 real tokens — sent on every single
 *  request, and never counted here at all before this, silently
 *  undercounting every threshold check by that much. Callers that don't
 *  send tools (the compaction summary request itself) simply omit this. */
export async function estimateTokens(
  messages: ChatMessage[],
  backend?: ModelBackend,
  extraText = "",
  tools?: ToolDef[]
): Promise<number> {
  // Ask the backend what the prompt ACTUALLY costs (messages rendered
  // through its own chat template, tools section included) before falling
  // back to anything approximate. Measured: tokenizing concatenated
  // message text + the raw tools JSON — the previous best effort, and
  // still the fallback below — undercounts the real prompt by ~19% on a
  // modest conversation and by more as messages accumulate, because the
  // template wraps every message in role markers and injects a tool-use
  // instruction preamble that appears nowhere in the raw text. That
  // undercount is what sized max_tokens too generously and produced a run
  // of live "request (20,521 tokens) exceeds the available context size
  // (16,384 tokens)" rejections: prompt + max_tokens was computed against
  // a number thousands of tokens below reality.
  if (backend?.countPromptTokens) {
    try {
      return await backend.countPromptTokens(messages, tools);
    } catch {
      // no /apply-template (non-llama.cpp backend) — fall through
    }
  }
  if (backend?.tokenize) {
    try {
      const text = [...messages.map(messageText), extraText].join("\n");
      return await backend.tokenize(text);
    } catch {
      // tokenizer unavailable/errored — fall through to the approximation
    }
  }
  return charBasedEstimate(messages, extraText);
}

export async function shouldCompact(
  messages: ChatMessage[],
  thresholds: CompactionThresholds,
  backend?: ModelBackend,
  extraText = "",
  tools?: ToolDef[]
): Promise<boolean> {
  const used = await estimateTokens(messages, backend, extraText, tools);
  return used >= thresholds.contextWindowTokens * thresholds.autoTriggerRatio;
}

/** 요약 입력의 메시지 하나가 차지할 수 있는 토큰 상한.
 *
 *  실측(2026-10-14, 사용자 세션의 컴팩션 58.3초): 요약 요청이 8,103토큰을 **전부 다시 처리**했다
 *  (prefill 36.6초 + 생성 15.8초). 캐시를 재사용하지 못했다 — 요약 지시를 마지막 user 메시지로 붙이면
 *  채팅 템플릿이 앞의 assistant 메시지를 다르게 렌더링하고, tools 를 빼면 시스템 영역부터 달라진다
 *  (원문 그대로 + tools 포함으로 보내도 1,081토큰만 재사용). 그러니 prefill 은 공짜가 아니고 입력
 *  토큰에 비례한다(약 221 tok/s). 요약에 큰 도구 출력 전체는 필요 없다 — 머리와 꼬리면 충분하다. */
export const SUMMARY_MESSAGE_MAX_TOKENS = 300;

/** 길면 가운데를 잘라낸다(머리 60% + 꼬리 40%). 토큰은 estimateTextTokens 기준. */
export function shrinkMiddle(text: string, maxTokens: number): string {
  if (!Number.isFinite(maxTokens) || estimateTextTokens(text) <= maxTokens) return text;
  const fit = (from: "head" | "tail", budget: number): string => {
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const part = from === "head" ? text.slice(0, mid) : text.slice(text.length - mid);
      if (estimateTextTokens(part) <= budget) lo = mid;
      else hi = mid - 1;
    }
    return from === "head" ? text.slice(0, lo) : text.slice(text.length - lo);
  };
  const head = fit("head", Math.floor(maxTokens * 0.6));
  const tail = fit("tail", Math.floor(maxTokens * 0.4));
  const omitted = text.length - head.length - tail.length;
  return `${head.trimEnd()}\n[… ${omitted} chars omitted …]\n${tail.trimStart()}`;
}

/**
 * The summary request is a plain (non-tool) completion call, but
 * `toSummarize` is an arbitrary slice of the real conversation and can end
 * — or contain — an assistant message with `tool_calls` that isn't followed
 * by its matching `tool` role responses (those may have landed in the kept
 * tail instead). Sending that as-is gets rejected by at least one real
 * backend with "Cannot continue an assistant message that contains tool
 * calls" (400). Rather than trying to align the slice to turn boundaries
 * (fragile — the boundary depends on exact message-count patterns), strip
 * every tool_calls/tool-role message down to plain describable text so the
 * summary request never contains anything tool-related to validate.
 */
function sanitizeForSummary(messages: ChatMessage[], perMessageTokens = Infinity): ChatMessage[] {
  const cap = (text: string, tokens = perMessageTokens): string => shrinkMiddle(text, tokens);
  const converted = messages.map((m): ChatMessage => {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls
        .map((tc) => `[called tool ${tc.function.name} with ${cap(tc.function.arguments, Math.ceil(perMessageTokens / 2))}]`)
        .join(" ");
      return { role: "assistant", content: cap([m.content, calls].filter(Boolean).join(" ")) };
    }
    if (m.role === "tool") {
      return { role: "assistant", content: `[tool result] ${cap(m.content ?? "")}` };
    }
    // 사용자 발화는 요약의 핵심 재료라 다른 메시지보다 두 배까지 허용한다.
    if (m.role === "user" && typeof m.content === "string") return { ...m, content: cap(m.content, perMessageTokens * 2) };
    return typeof m.content === "string" ? { ...m, content: cap(m.content) } : m;
  });

  // Converting tool_calls/tool messages to role:"assistant" can leave
  // consecutive assistant messages where there weren't any before (e.g. a
  // plain assistant reply immediately followed by what used to be a
  // tool_calls message). At least one real backend also rejects "2 or more
  // assistant messages at the end of the list" — merge any run of
  // same-role messages into one so the request's role sequence is never
  // stricter-than-expected regardless of where in the slice this happens.
  const merged: ChatMessage[] = [];
  for (const m of converted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === "string" && typeof m.content === "string") {
      prev.content = [prev.content, m.content].filter(Boolean).join("\n");
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

/**
 * Picks how much of the recent conversation to keep verbatim (unsummarized)
 * based on an actual SIZE budget, not a fixed message count. A hardcoded
 * "keep the last 6 messages" (the previous approach) can itself already be
 * at or past the entire context window if those 6 happen to be large (a
 * tool-heavy turn with sizable tool_calls/results — routine, not an edge
 * case) — found via a scenario test simulating many long developer
 * sessions: compaction kept reporting "no progress" because the kept tail
 * alone didn't shrink no matter how aggressively older history got
 * summarized away, permanently failing turns that should have recovered.
 * Always keeps at least the single most recent message (there's no better
 * option if even that alone is oversized — the tool_calls-aware size cap
 * upstream in loop.ts is what actually bounds any one message).
 */
// The fraction of contextWindowTokens the kept tail is allowed to occupy.
// Exported so loop.ts's overflow-retry path can pass a SMALLER value on a
// retry (see runCompaction's tailBudgetFraction param below) instead of
// giving up the instant one compaction attempt fails to shrink anything.
export const DEFAULT_TAIL_BUDGET_FRACTION = 0.4;

/** Default generation budget for the summary, in tokens.
 *
 *  Measured on the real backend: decode runs at 38 tok/s, so this number IS the
 *  compaction latency (the prefill is served from the prompt cache and is
 *  negligible). 1,024 is ~27 s; the previous window-derived cap of 4,096 was
 *  ~107 s for the same work.
 *
 *  Override with `compaction.summaryMaxTokens` in config.yaml. Raise it if a
 *  summary is dropping detail you need; lower it for a faster, terser summary. */
export const DEFAULT_SUMMARY_MAX_TOKENS = 768;
/** Default trigger and post-compaction target, used when the window is large
 *  enough that fixed overhead is noise. See recommendThresholds(). */
export const DEFAULT_AUTO_TRIGGER_RATIO = 0.6;
export const DEFAULT_POST_COMPACTION_TARGET_RATIO = 0.4;
export const DEFAULT_MIN_GROWTH_FRACTION = 0.05;

/**
 * Adaptive compaction thresholds for a calibrated context size.
 *
 * The server used to hardcode `{ autoTriggerRatio: 0.6, contextWindowTokens:
 * 32768 }` no matter what the calibration actually launched — a 16384-token
 * server compacted against a 32768-token assumption (late, then overflowing),
 * and a 98304-token server compacted at a third of its real window (often,
 * for nothing). The trigger ratio, summary budget and post-compaction target
 * all scale with the window instead:
 *
 * - `autoTriggerRatio`: 0.6 while the window is large. On a small window the
 *   FIXED overhead (system prompt + tool schema, ~1-3k tokens) eats the room
 *   the next reply needs, so the trigger moves earlier — but never below 0.4,
 *   or sessions would compact almost immediately after every compaction.
 * - `summaryMaxTokens`: ~6% of the window in [256, 1024]. 1024 is the
 *   latency-measured default on large windows; a small window gets a smaller
 *   summary rather than one that barely fits the window itself.
 * - `postCompactionTargetRatio`: 0.4, tightened to 0.3 when the fixed overhead
 *   alone exceeds a quarter of the trigger-level room (the shape that used to
 *   re-compact on the very next step, every step, forever).
 * - `minGrowthFraction`: 0.05 — loop.ts's back-to-back guard baseline.
 *
 * Pure: no I/O, no backend, so calibration and tests can call it with
 * whatever the tuner measured. `overheadTokens` is the base-prompt + tool
 * schema cost when the caller measured it (loop.ts does, per request);
 * otherwise a documented approximation is used.
 */
export function recommendThresholds(
  contextWindowTokens: number,
  opts: { overheadTokens?: number } = {}
): CompactionThresholds {
  const window = Math.max(1024, Math.floor(contextWindowTokens));
  // Measured live on a 4096-token window: base prompt + tool schema alone =
  // 1,283 tokens. A real session carries a larger system prompt, so the
  // default errs upward; callers with the real number pass it in.
  const overhead = opts.overheadTokens ?? 1500;
  // The next reply needs the same headroom loop.ts's computeMaxTokens()
  // reserves before generating into the remaining space.
  const SAFETY_MARGIN_TOKENS = 2048;
  const autoTriggerRatio = Math.min(
    DEFAULT_AUTO_TRIGGER_RATIO,
    Math.max(0.4, 1 - (SAFETY_MARGIN_TOKENS + overhead) / window)
  );
  const summaryMaxTokens = Math.max(256, Math.min(DEFAULT_SUMMARY_MAX_TOKENS, Math.floor(window * 0.06)));
  const triggerRoom = window * autoTriggerRatio;
  const postCompactionTargetRatio =
    overhead > triggerRoom * 0.25 ? 0.3 : DEFAULT_POST_COMPACTION_TARGET_RATIO;
  return {
    autoTriggerRatio,
    contextWindowTokens: window,
    summaryMaxTokens,
    postCompactionTargetRatio,
    minGrowthFraction: DEFAULT_MIN_GROWTH_FRACTION,
  };
}
// Loop.ts's own main-turn request always reserves this fraction of the
// window for max_tokens (the reply about to be generated) — see loop.ts's
// `max_tokens: Math.max(512, Math.floor(...* 0.25))`. The kept tail and
// that reservation were previously computed completely independently, so
// a "successful" compaction could still leave (tail + reserved-reply) at
// or past the ENTIRE window on its own, before the system prompt or tool
// schema even entered the picture — found live: two compaction passes in
// a row both reported "no progress" and the turn failed outright, on a
// 16384-token window, because the 40%-of-window tail floor alone (6553
// tokens) plus the 25%-of-window reply reservation (4096 tokens) already
// summed past what was actually available once the (necessarily
// preserved, see the system-prompt-survival fix elsewhere in this file)
// system prompt and the ~626-token tool schema were added on top.
const NEXT_REPLY_RESERVED_FRACTION = 0.25;

export function selectKeptTail(
  messages: ChatMessage[],
  contextWindowTokens: number,
  tailBudgetFraction: number = DEFAULT_TAIL_BUDGET_FRACTION
): { keepTail: ChatMessage[]; toSummarize: ChatMessage[] } {
  // Only partition conversation messages (non-system), so messages[0] (system instructions)
  // is never included in toSummarize or duplicated into summaries.
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  if (nonSystemMessages.length === 0) {
    return { keepTail: [], toSummarize: [] };
  }

  const availableForTail = Math.max(
    1,
    Math.floor(contextWindowTokens * (1 - NEXT_REPLY_RESERVED_FRACTION))
  );
  const budgetTokens = Math.max(1, Math.floor(availableForTail * tailBudgetFraction));

  let usedTokens = 0;
  let cutIndex = nonSystemMessages.length;

  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    const tokens = estimateTextTokens(messageText(nonSystemMessages[i]));
    if (cutIndex < nonSystemMessages.length && usedTokens + tokens > budgetTokens) break;
    usedTokens += tokens;
    cutIndex = i;
  }

  // Align cutIndex to a natural turn boundary: prefer starting keepTail at a user message
  // so the conversation doesn't start with a dangling assistant response or orphaned tool call.
  let alignedCutIndex = cutIndex;
  if (alignedCutIndex > 0 && alignedCutIndex < nonSystemMessages.length) {
    // If cut lands on an assistant or tool message, see if advancing to the next user message still keeps a tail
    if (nonSystemMessages[alignedCutIndex].role !== "user") {
      const nextUser = nonSystemMessages.findIndex((m, idx) => idx > alignedCutIndex && m.role === "user");
      if (nextUser !== -1) {
        alignedCutIndex = nextUser;
      }
    }
  }

  // Ensure at least the last message is kept
  if (alignedCutIndex >= nonSystemMessages.length && nonSystemMessages.length > 0) {
    alignedCutIndex = nonSystemMessages.length - 1;
  }

  return {
    keepTail: nonSystemMessages.slice(alignedCutIndex),
    toSummarize: nonSystemMessages.slice(0, alignedCutIndex),
  };
}

/**
 * PROMPT.md §2: write the checkpoint FIRST (before summarizing anything), then
 * ask the model to summarize the older turns, keeping mustPreserve items intact.
 */
export async function runCompaction(
  projectRoot: string,
  messages: ChatMessage[],
  backend: ModelBackend,
  model: string,
  partialCheckpoint: Omit<Checkpoint, "version" | "timestamp">,
  contextWindowTokens: number,
  // Lets a caller retry with a tighter tail — see loop.ts's overflow-retry
  // loop, which halves this on each attempt that fails to shrink anything,
  // rather than giving up after just one non-improving compaction.
  tailBudgetFraction: number = DEFAULT_TAIL_BUDGET_FRACTION,
  // Lets the caller shrink the summary below its default cap so that
  // base prompt + summary + kept tail lands under the auto-trigger
  // threshold — see loop.ts compact().
  summaryMaxTokensCap?: number,
  // 이 토큰 수 미만의 삭제 구간은 LLM 요약을 건너뛴다(0 = 끔). 운영 경로(loop.ts)만
  // FAST_PATH_INPUT_TOKENS 를 넘긴다 — 기본을 끔으로 둬서 호출자 계약을 안 바꾼다.
  fastPathInputTokens = 0,
  // 같은 컴팩션에서 앞서(규칙 단계) 만든 보관 파일 — 요약의 보관 목록에 함께 올린다.
  extraArchiveRefs: string[] = []
): Promise<CompactionResult> {
  const checkpoint: Checkpoint = {
    version: 1,
    timestamp: new Date().toISOString(),
    ...partialCheckpoint,
  };
  await writeCheckpoint(projectRoot, checkpoint);

  const { keepTail, toSummarize } = selectKeptTail(messages, contextWindowTokens, tailBudgetFraction);

  // 무손실 보관: 요약으로 대체될 구간의 **전문** 을 먼저 파일로 남긴다(요약 요청보다 앞 — 요약이
  // 실패해도 원문은 남는다). 실패해도 컴팩션은 계속한다.
  const archivePath = newArchivePath(projectRoot, "compaction");
  const archived = toSummarize.length > 0 && (await writeArchive(projectRoot, archivePath, messagesToEntries(toSummarize)));

  // No caller currently populates mustPreserve (loop.ts always passes []) —
  // rather than silently referencing an always-empty list ("...and the
  // following must-preserve facts:\n" followed by nothing, which reads as
  // an incomplete/truncated instruction to the model), only mention it when
  // there's actually something there.
  const mustPreserveClause = checkpoint.mustPreserve.length
    ? ` and the following must-preserve facts:\n${checkpoint.mustPreserve.join("\n")}`
    : ".";
  // selectKeptTail() never puts the system message into toSummarize (so the
  // base prompt isn't summarized into the summary and re-appended to itself
  // on every pass). originalSystemText already carries any previous summary
  // forward (composeSystemMessage stacks base + [Summary] on every pass), so
  // it doesn't need to be re-injected separately here as long as the system
  // message below is kept verbatim — see the cache-prefix note below.
  const originalSystem = messages.find((m) => m.role === "system");
  const originalSystemText = typeof originalSystem?.content === "string" ? originalSystem.content : "";
  const summaryInput = sanitizeForSummary(toSummarize, SUMMARY_MESSAGE_MAX_TOKENS);

  // Reported directly: "컴팩션의 시간이 오래걸리는데" — compaction is slow.
  //
  // Measured against the real backend (2026-09-28, RTX 2070 8 GB, 35B-A3B Q4
  // with 30 MoE layers on the CPU) rather than guessed:
  //
  //     prefill   334 tok/s   decode  38 tok/s
  //     main turn     7,244 prompt tokens   75.9 s
  //     compaction       22 prompt tokens   40.8 s   <- prefill is ~free
  //
  // The 22 is the important number. The summary request's [system] + toSummarize
  // is a VERBATIM PREFIX of the turn that just ran, so llama-server's prompt
  // cache serves essentially all of it (that is why the original system message
  // is preserved verbatim rather than replaced with a "please summarize" one —
  // see the cache-prefix note below). Prefill is therefore ~0.3 s and is NOT
  // the problem.
  //
  // Generation is the entire cost: the cap below was up to 4,096 tokens, and at
  // 38 tok/s that is ~107 seconds of the ~110 second compaction. The cap was
  // sized from the CONTEXT WINDOW (25% of 24,576) with no regard for how much
  // history is actually being condensed, so a compaction of a 14k-token history
  // was allowed to spend minutes writing a summary.
  //
  // The default is now DEFAULT_SUMMARY_MAX_TOKENS (1,024 ≈ 27 s here). That is
  // a deliberate quality trade: a 1,024-token summary of a 14k-token history is
  // still a ~14x compression, which is what the summary is FOR, but it will
  // keep less detail than a 4,096-token one. It is a config field
  // (`compaction.summaryMaxTokens`) precisely because that trade is a judgement
  // call, not a fact — raise it if summaries are losing detail you need.
  const defaultSummaryMaxTokens = Math.max(
    256,
    Math.min(DEFAULT_SUMMARY_MAX_TOKENS, Math.floor(contextWindowTokens * 0.25))
  );
  const windowBasedCap = summaryMaxTokensCap
    ? Math.max(128, Math.min(defaultSummaryMaxTokens, summaryMaxTokensCap))
    : defaultSummaryMaxTokens;
  // Reported directly: "컴팩션을 전체를 하는게 아니라 실제 있는 데이터 만큼만
  // 하면 안될까" — windowBasedCap above is sized purely from the context
  // window, with zero regard for how much history is ACTUALLY being
  // summarized. A compaction firing early (a small autoTriggerRatio, or
  // just a quiet session with little to say) still got handed the full
  // window-sized budget, free to generate up to thousands of tokens
  // regardless of whether there were only a handful of short messages to
  // condense — wasting real generation time (and, worse, real turns at
  // the single inference slot other requests queue behind) on a summary
  // far longer than the source material could ever justify. A summary is
  // expected to meaningfully compress its input, so cap it at a fraction
  // of the ACTUAL input size too — whichever cap is tighter wins. Only
  // ever tightens windowBasedCap (a large `toSummarize` still falls back
  // to it via the outer Math.min), so the existing large-history behavior
  // is unchanged.
  const summaryInputTokens = summaryInput.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0);
  const SUMMARY_COMPRESSION_RATIO = 0.25;
  const summaryMaxTokens = Math.max(128, Math.min(windowBasedCap, Math.ceil(summaryInputTokens * SUMMARY_COMPRESSION_RATIO)));

  // The summary request is itself a request against the same window. On the
  // overflow-retry path the history being summarized can be close to the
  // whole window already, and prompt + summaryMaxTokens then overflows too,
  // so the compaction fails and nothing ever shrinks. Drop the oldest
  // messages (after the previous summary, which condenses them anyway)
  // until the input fits.
  const inputBudget = Math.max(256, contextWindowTokens - summaryMaxTokens - 512);
  while (
    summaryInput.length > 1 &&
    summaryInput.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0) > inputBudget
  ) {
    summaryInput.splice(0, 1);
  }

  // Reported directly: "컴팩션 하고나면 왜 다음 프롬프트시 시간이 소요가 되지?"
  // — the summary request used to open with a BRAND NEW system message
  // ("Summarize the following conversation...") instead of the real
  // originalSystemText the just-completed turn actually used. That made
  // this request's very first token diverge from everything llama-server
  // had cached, so it paid a full prefill of the entire toSummarize history
  // with zero cache reuse. Keeping originalSystemText verbatim as the
  // system message here means this request's prefix ([system] + toSummarize)
  // is byte-for-byte a PREFIX of the real turn that was just processed (that
  // turn's messages were [system, ...toSummarize, ...keepTail, ...]), so
  // llama-server's prompt cache can serve everything up through the end of
  // toSummarize from cache instead of recomputing it. The "please
  // summarize" instruction moves to a trailing user message instead of
  // living in the system role, since changing the system message is exactly
  // what would break that prefix match.
  const summaryRequest: ChatMessage[] = [
    { role: "system", content: originalSystemText },
    ...summaryInput,
  ];
  // The request must END with a user turn asking for the summary. When the
  // last message is an assistant one (usual here: sanitizeForSummary turns
  // tool calls and results into assistant text), llama-server treats it as
  // an assistant prefill and the model CONTINUES that message instead of
  // summarizing. Measured against the real backend: ending on the assistant
  // message returned an echo of the tool-call text; ending on a user
  // request returned an actual summary. Live, one compaction's summary
  // request generated a single token, so everything it replaced was lost.
  const previousSummary = splitSystemMessage(originalSystemText).summary;
  const SUMMARY_INSTRUCTION = buildSummaryInstruction(mustPreserveClause, previousSummary !== null, summaryMaxTokens);
  summaryRequest.push({ role: "user", content: SUMMARY_INSTRUCTION });

  // Never leave this unset — same reasoning, and the exact same failure
  // mode, as loop.ts's main-turn request: without max_tokens, llama-server
  // defaults to n_predict=-1 (unbounded), and if the model never emits a
  // natural stop token (a degenerate/repetition-loop generation, or simply
  // a model that likes to keep going), the summary request pins the single
  // inference slot indefinitely — blocking every other request, including
  // the very turn that triggered this compaction, with no visible error.
  // Caught live: GET /slots showed a summary request's n_decoded climbing
  // past 700 with max_tokens/n_predict both -1, `stream: false` (so
  // openaiClient.ts's own client-side streaming cap — added for exactly
  // this reason — never even applies here; this path bypasses it
  // entirely). Capped smaller than the main turn's own budget (a summary
  // should be concise by nature, not a full reply) but still scaled to the
  // real context window rather than a flat constant, same as loop.ts.
  // Same reason as loop.ts's own turn request (see its comment): with
  // chain-of-thought on, the budget can be spent entirely on invisible
  // reasoning before any summary text is produced — and a compaction that
  // returns no usable summary is worse than useless, since the history it
  // replaced is already gone.
  // 빠른 경로: 삭제될 분량이 작으면 생성(38 tok/s = 컴팩션 시간 전부)을 아예 건너뛴다.
  // 요약할 게 거의 없는데 모델을 부르면 수십 초를 써서 입력보다 긴 요약을 쓰기 쉽다.
  // 사용자 요청 원문 앵커 + 최근 행동 목록이 코드로 만들어지므로 정보 손실은 작다.
  const skipLlm = summaryInputTokens < fastPathInputTokens;
  let rawSummary = "";
  if (!skipLlm) {
    const res = await backend.chat({
      model,
      messages: summaryRequest,
      stream: false,
      max_tokens: summaryMaxTokens,
      chat_template_kwargs: { enable_thinking: false },
    });
    rawSummary = res.choices[0]?.message.content?.trim() ?? "";
  }
  // 요약이 없거나 사실상 비어 있으면(실측: 한 토큰짜리 요약이 나온 적 있다) 그걸로
  // 시스템 메시지의 기존 요약을 덮어쓰면 그 요약이 담고 있던 이전 작업까지 같이
  // 사라진다. 이전 요약이 있으면 그걸 유지한다 — 새 요약을 못 만든 것이지, 이전 것이
  // 틀린 건 아니다.
  const prevParts = splitAnchor(previousSummary ?? "");
  const modelPart = splitAnchor(rawSummary).body; // 모델이 앵커를 베껴 써도 중복되지 않게
  const summaryUsable = !skipLlm && modelPart.length >= MIN_USABLE_SUMMARY_CHARS;
  const body = summaryUsable
    ? modelPart
    : skipLlm
      ? [prevParts.body, recentActionsDigest(toSummarize)].filter(Boolean).join("\n\n")
      : prevParts.body || modelPart || "(summary unavailable)";
  // 문맥 유실 방지: 사용자 요청 원문은 LLM 이 요약하며 변형·누락하는 1순위 항목이다.
  // 코드가 직접 이어 붙이고(생성 비용 0), 컴팩션을 거듭해도 최초 요청과 최근 요청을 유지한다.
  const anchorItems = mergeAnchor(prevParts.items, extractUserRequests(toSummarize));
  const archiveRefs = mergeArchiveRefs(prevParts.archives, [...extraArchiveRefs, ...(archived ? [archivePath] : [])]);
  const summaryText = [body, renderAnchor(anchorItems), renderArchiveRefs(archiveRefs)].filter(Boolean).join("\n\n") || "(summary unavailable)";

  // Preserve the ORIGINAL system prompt (base prompt + injected .harnesside/rules),
  // not just the compaction summary. selectKeptTail() keeps only the size-budgeted
  // tail of `messages`, so the system prompt — always messages[0] — is otherwise
  // always pushed into `toSummarize` and replaced wholesale the moment a session
  // runs long enough to compact even once. Found live: after the first compaction,
  // the agent silently stopped following project rules injected at startup — no
  // error, just the rules being gone, since they'd been overwritten by the summary
  // text. Kept as ONE system message (not two): loop.ts already documents that a
  // second system-role message breaks chat-template-enforcing backends, so this
  // concatenates into the existing single system slot instead of adding another.
  const systemContent = composeSystemMessage(originalSystemText, summaryText);
  // Store the summary with the checkpoint too: a resume in a new process
  // (after /quit, a crash, a restart) has none of this conversation, and
  // without it the resumed model had only a goal line and a file list —
  // live, it answered "No response requested." and stopped.
  const finalCheckpoint: Checkpoint = summaryUsable || skipLlm ? { ...checkpoint, summary: summaryText } : checkpoint;
  if (finalCheckpoint !== checkpoint) await writeCheckpoint(projectRoot, finalCheckpoint);

  // keepTail's cut point is purely size-based and can land between a
  // `tool_calls`-bearing assistant message and its matching `tool` response,
  // leaving keepTail starting with a `tool` message that has no corresponding
  // tool_calls entry anywhere in the compacted result. At least one real
  // backend rejects that shape outright. sanitizeForSummary() already guards
  // against the equivalent problem for the summary REQUEST slice above; this
  // is the same fix applied to the slice that actually keeps being used
  // afterward. Reproduced directly: sweeping tool-result sizes from 100 to
  // 2000 chars found 1 case (out of 20) landing exactly on this boundary.
  //
  // Prefer pulling the matching assistant message (and any sibling tool
  // results of the same batch) back into the tail over dropping the tool
  // results: when the newest message is a tool result, it is exactly what
  // the model needs next. Dropping it made a live session loop — a failing
  // `npm test` whose output alone pushed usage past the trigger was
  // compacted away before the model ever saw it, so the model reran the
  // same command, every ~16s, indefinitely. Only fall back to dropping when
  // no owning assistant message exists in the summarized slice.
  let tail = keepTail;
  if (tail.length > 0 && tail[0].role === "tool") {
    let i = toSummarize.length - 1;
    while (i >= 0 && toSummarize[i].role === "tool") i--;
    const owner = i >= 0 ? toSummarize[i] : undefined;
    if (owner?.role === "assistant" && owner.tool_calls?.length) {
      tail = [...toSummarize.slice(i), ...tail];
    }
  }
  while (tail.length > 0 && tail[0].role === "tool") {
    tail = tail.slice(1);
  }

  // Some chat templates reject a conversation with no user message at all
  // ("No user query found in messages." — Ornith-1.5's does; Qwen3.6's
  // doesn't). A size-based tail can easily be nothing but a tool-call
  // chain, the user's request having gone into the summary, so give it a
  // user turn to hang off. Verified against the real server: the same
  // compacted shape is rejected without this and accepted with it.
  if (!tail.some((m) => m.role === "user")) {
    tail = [{ role: "user", content: CONTINUE_AFTER_COMPACTION }, ...tail];
  }

  const compactedMessages: ChatMessage[] = [{ role: "system", content: systemContent }, ...tail];

  const detail: CompactionDetail = {
    droppedCount: toSummarize.length,
    droppedTokens: toSummarize.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0),
    droppedPreview: toSummarize.slice(0, DETAIL_PREVIEW_CAP).map(previewLine),
    keptCount: tail.length,
    keptTokens: tail.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0),
    ...(archived ? { archivePath } : {}),
    summaryInputTokens: skipLlm ? 0 : summaryRequest.reduce((n, m) => n + estimateTextTokens(messageText(m)), 0),
    summary: summaryText,
  };
  if (toSummarize.length > DETAIL_PREVIEW_CAP) {
    detail.droppedPreview.push(`…and ${toSummarize.length - DETAIL_PREVIEW_CAP} more`);
  }

  return { messages: compactedMessages, checkpoint: finalCheckpoint, detail };
}

/** 요약 입력이 이 토큰 수 미만이면 LLM 호출을 건너뛴다(빠른 경로). */
export const FAST_PATH_INPUT_TOKENS = 300;

const ANCHOR_HEADER = "## User requests (verbatim, oldest first)";
/** 앵커 전체와 항목 하나의 토큰 상한 — 한글은 글자당 ~1.5토큰이라 글자 수가 아니라 토큰으로 자른다. */
const ANCHOR_TOTAL_TOKENS = 450;
const ANCHOR_ITEM_TOKENS = 120;
const ANCHOR_MAX_ITEMS = 8;

function clipToTokens(text: string, maxTokens: number): string {
  if (estimateTextTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()} …`;
}

/** 삭제될 구간의 진짜 사용자 발화(자동 주입된 재개/계속 안내 제외). */
export function extractUserRequests(dropped: ChatMessage[]): string[] {
  return dropped
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => (m.content as string).trim())
    .filter((t) => t && t !== CONTINUE_AFTER_COMPACTION && !t.startsWith("[resuming") && !t.startsWith("[Earlier conversation was compacted"))
    .map((t) => clipToTokens(t.replace(/\s+/g, " "), ANCHOR_ITEM_TOKENS));
}

/** 이전 앵커 + 새 발화를 합치되, 최초 요청(목표)은 항상 남기고 나머지는 최신 우선으로 예산 내에서 유지. */
export function mergeAnchor(prev: string[], added: string[]): string[] {
  const all = [...prev, ...added].filter((t, i, a) => a.indexOf(t) === i);
  if (all.length === 0) return [];
  const [first, ...rest] = all;
  const kept: string[] = [];
  let used = estimateTextTokens(first);
  for (let i = rest.length - 1; i >= 0 && kept.length < ANCHOR_MAX_ITEMS - 1; i--) {
    const t = estimateTextTokens(rest[i]);
    if (used + t > ANCHOR_TOTAL_TOKENS) break;
    used += t;
    kept.unshift(rest[i]);
  }
  return [first, ...kept];
}

export function renderAnchor(items: string[]): string {
  return items.length ? `${ANCHOR_HEADER}\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "";
}

const ARCHIVE_HEADER =
  "## Archived transcripts (the FULL text of what was compacted is saved in these files. If the user asks about anything not visible in this conversation, " +
  "grep -rn <keyword> or read_file these files BEFORE saying you do not know)";
/** 요약에 남기는 보관 파일 경로 수(최신 우선). 오래된 것은 디스크에는 남아 있지만 더는 가리키지 않는다. */
const MAX_ARCHIVE_REFS = 5;

export function renderArchiveRefs(paths: string[]): string {
  return paths.length ? `${ARCHIVE_HEADER}\n${paths.map((p) => `- ${p}`).join("\n")}` : "";
}

export function mergeArchiveRefs(prev: string[], added: string[]): string[] {
  const all = [...prev, ...added].filter((p, i, a) => a.indexOf(p) === i);
  return all.slice(Math.max(0, all.length - MAX_ARCHIVE_REFS));
}

/** 요약을 본문 / 사용자 요청 앵커 / 보관 경로로 분리한다. 앵커와 보관 블록은 항상 요약 끝에 이 순서로 붙는다. */
export function splitAnchor(summary: string): { body: string; items: string[]; archives: string[] } {
  const a = summary.indexOf(ANCHOR_HEADER);
  const z = summary.indexOf(ARCHIVE_HEADER);
  const starts = [a, z].filter((i) => i !== -1);
  if (starts.length === 0) return { body: summary.trim(), items: [], archives: [] };
  const bodyEnd = Math.min(...starts);
  const lines = (from: number, to: number, header: string) =>
    summary
      .slice(from + header.length, to)
      .split("\n")
      .map((l) => l.replace(/^(\d+\.|-)\s+/, "").trim())
      .filter(Boolean);
  const items = a === -1 ? [] : lines(a, z !== -1 && z > a ? z : summary.length, ANCHOR_HEADER);
  const archives = z === -1 ? [] : lines(z, a !== -1 && a > z ? a : summary.length, ARCHIVE_HEADER);
  return { body: summary.slice(0, bodyEnd).trim(), items, archives };
}

/** 빠른 경로용: LLM 없이 최근 도구 호출을 결정적으로 나열. */
function recentActionsDigest(dropped: ChatMessage[]): string {
  const calls = dropped.flatMap((m) => m.tool_calls ?? []).slice(-6);
  if (calls.length === 0) return "";
  return `## Recent actions\n${calls.map((c) => `- ${c.function.name}(${c.function.arguments.slice(0, 80)})`).join("\n")}`;
}

/** 이보다 짧은 요약은 실패로 본다(에코/한 토큰 출력 방어). */
const MIN_USABLE_SUMMARY_CHARS = 20;

/**
 * 요약 지시문. 연구 근거(2025~2026):
 * - 구조화된 고정 섹션 + 이전 요약을 **갱신**(anchored iterative summarization,
 *   Factory.ai 평가): 매번 처음부터 다시 쓰면 오래된 사실이 세대를 거치며 닳는다.
 * - 에이전트 컨텍스트 압축은 "다음 행동에 필요한 것"을 남기는 쪽이 중요하다
 *   (ACON, arXiv 2510.00615): 실패한 시도·결정 이유·정확한 식별자(경로, 명령, 오류).
 * - 의도적으로 **끝의 user 메시지에만** 둔다: system 을 바꾸면 llama-server 의
 *   프롬프트 캐시 접두사가 깨져 prefill 비용이 되살아난다(위 캐시 노트).
 */
export function buildSummaryInstruction(mustPreserveClause: string, hasPreviousSummary: boolean, maxTokens: number): string {
  const update = hasPreviousSummary
    ? "The system message already holds a [Compacted history summary] of earlier work. UPDATE it, do not start over: " +
      "carry forward everything still relevant, mark finished items as done, and drop what is obsolete.\n\n"
    : "";
  return (
    "Summarize the conversation above for context compaction so the work can continue with no other history. " +
    "Preserve verbatim any user-stated constraints and decisions" +
    mustPreserveClause +
    "\n\n" +
    update +
    "Use exactly these section headings, in this order (omit a section only if truly empty). " +
    "Write ONLY the heading text, never the explanation after the colon:\n" +
    "## Goal: what the user asked for, in their own words where they gave requirements\n" +
    "## Constraints & decisions: rules, preferences, choices made and WHY\n" +
    "## Next: the immediate next step\n" +
    "## State: exact file paths, commands, identifiers, error messages that matter next\n" +
    "## Dead ends: approaches that failed, so they are not retried\n" +
    "## Progress: what is done, what is in progress\n\n" +
    // 순서가 중요하다: 상한(max_tokens)에서 잘리면 뒤쪽이 사라진다. 길어지기 쉬운 Progress 를
    // 맨 뒤에 두어, 잘려도 다음 행동에 필요한 Goal/Constraints/Next/State 는 남게 한다.
    `Be dense and concrete; stay under about ${maxTokens} tokens.\n\nNow write the summary of the conversation above. Output only the summary.`
  );
}

const SUMMARY_HEADER = "[Compacted history summary]";
/** Placeholder user turn for a compacted conversation whose kept tail has
 *  no user message (see runCompaction). */
export const CONTINUE_AFTER_COMPACTION =
  "[Earlier conversation was compacted — see the summary in the system message. Continue the current task.]";

/**
 * Splits a system message into the original base prompt and the compaction
 * summary appended to it (if any). The summary block is always appended LAST
 * (see composeSystemMessage), so everything from the header to the end is
 * the summary. The previous version cut the block at the first blank line
 * after the header instead — but model-written summaries are routinely
 * multi-paragraph markdown, so paragraphs 2..N of every old summary were
 * treated as "content after the block" and kept, piling up a little more
 * duplicated text on every compaction.
 */
export function splitSystemMessage(content: string): { base: string; summary: string | null } {
  const idx = content.indexOf(SUMMARY_HEADER);
  if (idx === -1) return { base: content, summary: null };
  return {
    base: content.slice(0, idx).trimEnd(),
    summary: content.slice(idx + SUMMARY_HEADER.length).trim(),
  };
}

/**
 * Assemble the final system-role message after a compaction pass: the
 * original base prompt plus exactly one summary block, replacing any
 * summary block already there rather than appending a second one.
 */
export function composeSystemMessage(originalContent: string, newSummary: string): string {
  const { base } = splitSystemMessage(originalContent);
  return [base, `${SUMMARY_HEADER}\n${newSummary}`].filter(Boolean).join("\n\n");
}

/** Removes any number of leading "[resuming ...] previous goal: " prefixes.
 *  The goal recorded in a checkpoint used to be taken from the first user
 *  message in the conversation — which, after one compaction, IS the
 *  injected resume message — so each checkpoint's goal wrapped the previous
 *  resume text ("[resuming after compaction] previous goal: [resuming after
 *  compaction] previous goal: ..."), growing on every compaction. */
export function stripResumePrefix(goal: string): string {
  return goal.replace(/^(\s*\[resuming[^\]]*\]\s*previous goal:\s*)+/, "").split("\n\nremaining steps:")[0].trim() || "(unknown)";
}

/**
 * PROMPT.md §2.4: after compaction, read the checkpoint back and produce a
 * short resume announcement + the injected system reminder that drives the
 * agent to continue the interrupted work rather than wait for new input.
 */
/** Cap on how much of a stored summary goes into a resume message. */
const RESUME_SUMMARY_MAX_CHARS = 4000;

export async function buildResumePrompt(
  projectRoot: string,
  // False when the live conversation already carries the summary (a
  // mid-session resume right after compaction), so it isn't sent twice.
  opts: { includeSummary?: boolean } = {}
): Promise<string | null> {
  const checkpoint = await readCheckpoint(projectRoot);
  if (!checkpoint) return null;
  const includeSummary = opts.includeSummary ?? true;
  const notes = includeSummary ? await readNotes(projectRoot) : "";

  const remaining = checkpoint.steps.filter((s) => s.status !== "done");
  // A checkpoint can now exist without any compaction ever having run
  // (see checkpoint.ts's "plan-progress" reason) — saying "after
  // compaction" for that case would be actively misleading about why the
  // agent seems to be picking up mid-task.
  const resumeReasonText = checkpoint.reason === "plan-progress" ? "resuming previous session" : "resuming after compaction";
  const lines = [
    // 이 텍스트는 모델 입력であると 동시에 화면 출력이다: injectResumeContextIfPending()이
    // 그대로 onStatus → status 블록으로 흘린다. `label:\n내용` 평문이면 화면에서
    // 수천 자 벽으로 보인다(실측). 섹션 라벨만 **굵게**로 구조화한다. 첫 줄은
    // loop.test.ts 가 `startsWith("[resuming")`·`previous goal: ...` 원문으로
    // 고정하므로 손대지 않는다 — 화면에서는 Markdown 이 대괄호를 그대로 보여준다.
    `[${resumeReasonText}] previous goal: ${stripResumePrefix(checkpoint.goal)}`,
    remaining.length
      ? `**remaining steps:**\n${remaining.map((s) => `- (${s.status}) ${s.description}`).join("\n")}`
      : checkpoint.steps.length
        ? "All plan steps were already done — re-verifying before wrapping up."
        : // No plan was declared. Saying "all steps done" here (the tool
          // log used to be stored as done steps) told the model there was
          // nothing left to do.
          "No plan was recorded for this work.",
    includeSummary && checkpoint.summary
      ? `**summary of the previous session:**\n${
          checkpoint.summary.length > RESUME_SUMMARY_MAX_CHARS
            ? checkpoint.summary.slice(0, RESUME_SUMMARY_MAX_CHARS) + " …"
            : checkpoint.summary
        }`
      : "",
    includeSummary && notes ? `**working notes** (findings recorded before; trust these over re-deriving them):\n${notes}` : "",
    checkpoint.recentActions?.length ? `**recent actions:**\n${checkpoint.recentActions.map((a) => `- ${a}`).join("\n")}` : "",
    checkpoint.pendingToolCall
      ? `**interrupted tool call:** ${checkpoint.pendingToolCall.name} (${checkpoint.pendingToolCall.reason})`
      : "",
    checkpoint.files.length
      ? `**files touched:**\n${checkpoint.files.map((f) => `- (${f.status}) ${f.path}`).join("\n")}`
      : "",
    "*Continue the task from where it stopped. If it is already complete, verify that and report the result.*",
  ].filter(Boolean);

  return lines.join("\n\n");
}
