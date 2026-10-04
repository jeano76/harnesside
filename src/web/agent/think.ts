/**
 * Think(추론) 상태 머신 (§5.3 · 요구 6).
 *
 * 패널 개선 정상 기본값(2026-10-01): **기본 ON.** 사고 표시는 꺼져 있으면
 * 화면에 사고가 안 보이는 것을 사용자가 "기능이 없다" 고 읽는다.
 *
 * 예전 OFF 기본값의 근거(실측 함정)는 그대로 방어한다:
 *   420토큰 예산에서 thinking 을 켜면 사고에 예산을 전부 써서 **tool_call 이 하나도
 *   나오지 않았다.** 즉 "생각만 하다가 아무것도 안 하는" 상태.
 *
 * 그래서 켜더라도 **상한**을 강제하고, 초과하면
 * 자동으로 끄고 **강제 도구 호출 모드**(`tool_choice: "required"`)로 전환한다.
 * 무한 재시도는 금물 — 2회 재시도 후 명확한 오류로 끝낸다.
 */

export type ThinkStyle = "dots" | "pulse" | "orbit" | "shimmer" | "bar";

export interface ThinkState {
  enabled: boolean;
  style: ThinkStyle;
  /** 사고 토큰 예산 상한. 초과하면 강제 전환한다. */
  maxReasoningTokens: number;
  /** 경고를 표시해야 하는가(모델이 예산을 통째로 씀에 위험). */
  needsWarning: boolean;
  /** 지금까지 본 사고 토큰. */
  usedTokens: number;
  startedAt: number | null;
  /** 강제 도구 호출 모드인가. */
  forcedToolChoice: boolean;
  /** 전환 사유 — 사용자에게 **왜** 바뀌었는지 말해야 한다. */
  reason: string | null;
}

export const DEFAULT_MAX_REASONING = 1024;

export function initialThink(opts: Partial<Pick<ThinkState, "enabled" | "style" | "maxReasoningTokens">> = {}): ThinkState {
  // 2026-10-01: **기본 ON.** 사고 표시는 기본이 꺼져 있었다 — 요구 6 은 "Think UI" 라는
  // 이름으로 "켜야 하는 기능" 이 아니라 **보이는 것** 으로 읽힌다. 꺼져 있으면 화면에
  // 사고가 안 보이는 것을 사용자가 "기능이 없다" 고 읽는다.
  //
  // **그래도 예전의 함정은 그대로 방어한다.** 켜졌다고 무해해지는 게 아니다 —
  // 예산을 사고가 다 쓰면 tool_call 이 안 나온다. 그래서 두 가지를 **유지**한다:
  //   1. 예산 상한(`maxReasoningTokens`)
  //   2. 초과 시 강제 전환(`ingest` → `forcedToolChoice: "required"`)
  //
  // 그리고 `needsWarning` 은 **기본 false** 다. 예전에는 `enabled` 를 그대로 따랐는데,
  // 기본을 켜면 **모든 세션이 시작하자마자 경고를 띄운다** — 경고가 상시 보이면 경고가
  // 아니다. 실제로 위험해지는 순간(초과)에만 켠다.
  const enabled = opts.enabled ?? true;
  return {
    enabled,
    style: opts.style ?? "dots",
    maxReasoningTokens: opts.maxReasoningTokens ?? DEFAULT_MAX_REASONING,
    needsWarning: false,
    usedTokens: 0,
    startedAt: null,
    forcedToolChoice: false,
    reason: null,
  };
}

/** 요청에 실을 `tool_choice`. 강제 모드에서만 "required" 가 된다. */
export function toolChoiceFor(s: ThinkState): "auto" | "required" {
  return s.forcedToolChoice ? "required" : "auto";
}

export interface ThinkDeltas {
  /** reasoning_content 델타. */
  reasoning?: string;
  /** 일반 답변 델타. */
  text?: string;
}

/**
 * 델타를 먹인다. **사고 예산이 초과되면 강제 전환이 일어난다** — 그리고 그 사실이
 * `state.forcedToolChoice` 로 드러나야 한다. 드러나지 않으면 사용자는 "도구가 왜
 * 안 불리지?" 하고 기다린다.
 */
export function ingest(s: ThinkState, d: ThinkDeltas): ThinkState {
  if (!d.reasoning) return s;
  const used = s.usedTokens + Math.max(1, Math.ceil(d.reasoning.length / 3.4)); // 휴리스틱 토큰 수
  if (s.enabled && used > s.maxReasoningTokens && !s.forcedToolChoice) {
    return {
      ...s,
      usedTokens: used,
      // §5.3: 초과하면 thinking 을 끄고 강제 도구 호출 모드로 전환한다.
      forcedToolChoice: true,
      enabled: false,
      // **위험해진 순간에만** 경고를 켠다. 켜져 있는 것과 위험한 것은 다르다.
      needsWarning: true,
      reason: `사고 토큰이 상한(${s.maxReasoningTokens.toLocaleString("ko-KR")})을 넘어 thinking 을 끄고 도구 호출을 강제합니다.`,
    };
  }
  return { ...s, usedTokens: used, startedAt: s.startedAt ?? Date.now() };
}

/** 경과 초. 0 이 아니라 "시작 전" 을 구분한다. */
export function elapsedSec(s: ThinkState, now = Date.now()): number | null {
  if (s.startedAt === null) return null;
  return Math.max(0, (now - s.startedAt) / 1000);
}

/** tok/s. 시간이 0 이면 **무한대나 0 이 아니라 null** — 0 은 "속도가 0" 이라는 거짓말. */
export function speed(s: ThinkState, now = Date.now()): number | null {
  const e = elapsedSec(s, now);
  if (e === null || e <= 0 || s.usedTokens === 0) return null;
  return s.usedTokens / e;
}

export function finish(s: ThinkState): ThinkState {
  return { ...s, startedAt: null };
}

/** `prefers-reduced-motion` 일 때 애니메이션을 멈추고 텍스트만 보여줄지. */
export function shouldAnimate(style: ThinkStyle, reducedMotion: boolean): boolean {
  void style;
  return !reducedMotion;
}

/** 스타일별 CSS 클래스/키프레임 이름 — 마크업과 로직이 어긋나지 않게 한 곳에서. */
export function animationFor(style: ThinkStyle): { dots: number; durationMs: number } {
  switch (style) {
    case "dots":
      return { dots: 3, durationMs: 1200 }; // §5.3 기본: 3개 파동 도트, 1.2s 주기
    case "pulse":
      return { dots: 1, durationMs: 1000 };
    case "orbit":
      return { dots: 1, durationMs: 1400 };
    case "shimmer":
      return { dots: 0, durationMs: 1600 };
    case "bar":
      return { dots: 0, durationMs: 0 };
  }
}

export interface RetryState {
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  exhausted: boolean;
}

/**
 * 도구를 고르지 않은 응답에 대한 재시도. **무한 재시도는 금물** (§5.3).
 * 2회 재시도 후 명확한 오류로 끝낸다.
 */
export function retryAfterNoTool(s: RetryState, err: string): RetryState & { shouldRetry: boolean } {
  const attempts = s.attempts + 1;
  const exhausted = attempts >= s.maxAttempts;
  return { attempts, maxAttempts: s.maxAttempts, lastError: err, exhausted, shouldRetry: !exhausted };
}

export function initialRetry(maxAttempts = 2): RetryState {
  return { attempts: 0, maxAttempts, lastError: null, exhausted: false };
}

/** 최종 오류 문구 — 사용자에게 무엇이 왜 실패했는지 말해야 한다(§11.3). */
export function exhaustedMessage(s: RetryState): string {
  return `모델이 ${s.maxAttempts}회 재시도 후에도 도구를 선택하지 않았습니다 (마지막 오류: ${s.lastError ?? "알 수 없음"}). reasoning 예산을 줄이거나 max_tokens 를 늘린 뒤 다시 시도하십시오.`;
}
