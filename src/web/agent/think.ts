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

import { estimateTextTokens } from "../../shared/textTokens.js";
import { DEFAULT_MAX_REASONING, clampReasoningBudget } from "../../shared/reasoning.js";

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

// 정본은 `src/shared/reasoning.ts` 다. 여기서 다시 적으면 **값이 두 벌**이 되고,
// 하나만 고치면 화면과 서버가 어긋난다(실측: 1024 가 세 곳에 따로 적혀 있었다).
export { DEFAULT_MAX_REASONING };

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
 *
 * `needsWarning` 은 두 경우에 켠다: 이미 넘었거나(초과), 80%에 들어섰거나(곧
 * 초과). 80% 선행 경고가 없으면 "곧 초과" 분기는 도달 불가능한 죽은 코드가 된다 —
 * `ingest` 가 초과와 동시에 `enabled` 까지 끄기 때문이다.
 */
export function ingest(s: ThinkState, d: ThinkDeltas): ThinkState {
  if (!d.reasoning) return s;
  // **언어별 추정**(`estimateTextTokens`). 예전의 `길이 / 3.4` 은 영문 기준이라
  // 한글 사고의 실제 토큰을 절반밖에 못 셌다 — 표시된 숫자가 거짓말이 된다.
  const used = s.usedTokens + estimateTextTokens(d.reasoning);
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
  return {
    ...s,
    usedTokens: used,
    startedAt: s.startedAt ?? Date.now(),
    // 아직 Enabled인데 상한의 80%를 넘었으면 "곧 초과"를 알린다 — 초과後に
    // 말하면 이미 전환된 뒤라 예보가 아니다.
    needsWarning: s.needsWarning || (s.enabled && !s.forcedToolChoice && used >= s.maxReasoningTokens * 0.8),
  };
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
  // 턴이 끝나면 **이번 턴의 계량기를 비운다.** 서버는 매 턴 reasoningTokens 를
  // 0부터 다시 세는데 웹은 누적만 했다 — 그래서 한 번 초과했거나 여러 턴에 걸쳐
  // 사고가 쌓이면, 다음 턴에서 쓰지도 않은 예산으로 "곧 초과/초과"가 떴다(실측).
  // 정책(enabled·style·cap)은 턴 경계를 넘나들지만 계량기는 넘지 않는다.
  return {
    ...s,
    startedAt: null,
    usedTokens: 0,
    needsWarning: false,
    forcedToolChoice: false,
    reason: null,
  };
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

/**
 * 추론 예산 초과로 **무엇이 달라졌는지** 한 줄로 말한다 (2026-10-05).
 *
 * ── 예전 문구가 틀렸던 이유 ──────────────────────────────────────────────────
 *
 * 화면에는 `Thinking 꺼짐 (예산 초과)` 라고 적혀 있었다. 사용자가 지목한 그대로다 — **thinking 은 상시 동작한다.** 그럼 무엇이 "꺼졌" 는 말인가?
 *
 * 실제로 일어나는 일(서버 코드 기준):
 *   1. 추론 토큰이 상한을 넘어서면 `forcedToolChoice = true` 로 전환한다
 *   2. `enabled` 는 그 **사유로** `false` 가 된다
 *   3. 그런데 **추론 스트림 자체는 끊기지 않는다** — 계속 들어오고 계속 쌓인다
 *   4. 다음 요청에서 **도구 호출을 강제**한다
 *
 * 즉 "꺼짐" 은 ①~④ 어디와도 맞지 않는다. 설정이 바뀐 것도 아니고, 사고가 멈춘
 * 것도 아니다. **생각하는 대신 "직접 움직이도록" 전환한 것**이고, 그 전환은
 * 이 턴이 끝나면 원래대로 돌아간다(툴팁은 이 사실을 말하고 라벨은 반대로 말해
 * 서로 모순이었다).
 *
 * 게다가 표시되는 숫자는 **추정치**다. 서버 로그는 스스로
 * "추정치 … 실제 토큰 카운터가 아니다" 고 적어 놓고, 화면은 정확한 한계처럼
 * "예산 초과" 를 단정했다. 추정의 추정을 한계와 비교한다는 것을 말해야 한다.
 *
 * 그래서 문구를 바꾼다: **무엇이 일어났는지 · 다음에 무엇을 할 것인지 · 이 값이
 * 추정치라는 사실**을 함께 말한다.
 */
export interface ThinkNotice {
  /** 상태 줄에 보이는 짧은 말. */
  text: string;
  /** Thinking 표시줄에 붙는 한 줄 꼬리표 — 숫자는 표시줄에 이미 있으므로 반복하지 않는다. */
  short: string;
  /** 마우스를 올렸을 때의 설명. */
  title: string;
  /** 이 값이 추정치인가 — 화면이 "확실한 수치" 처럼 말하지 않게 하는 근거. */
  estimated: boolean;
}

/**
 * 지금 뭐라고 해야 하는가. **아무것도 말하지 않을 조건도 함께 정의한다.**
 *
 * `null` 이면 아무 말도 하지 않는다 — 조용한 것은 **정당한** 경우다. 추론이 켜져 있고
 *예산 안에 있으면 경고할 이유가 없다.
 */
export function thinkNotice(s: ThinkState, running: boolean): ThinkNotice | null {
  if (!running) return null;
  // **경고 조건은 needsWarning 하나다.** 꺼져 있는 것 자체는 경고가 아니다 —
  // 예전 코드는 `enabled === false` 면 무조건 "초과"를 띄워서, thinking 을 설정에서
  // 끈 세션도 매 턴 "예산 초과"를 봤다. needsWarning 은 초과·임박을 이번 턴에 실제로
  // 관측했을 때만 켜지고(ingest), 턴이 끝나면 꺼진다(finish/adoptServerThink).
  if (!s.needsWarning) return null;
  const cap = s.maxReasoningTokens.toLocaleString("ko-KR");
  const used = s.usedTokens.toLocaleString("ko-KR");
  if (s.enabled) {
    // 켜져 있지만 위험 — 곧 전환된다는 뜻. 아직 "꺼졌다"고 말할 단계가 아니다.
    return {
      text: `추론 예산 곧 초과 (${used}/${cap}·추정)`,
      short: "곧 초과",
      title: `추론이 예산에 가까워졌습니다. 상한(${cap})을 넘으면 이번 턴은 도구 호출로 전환합니다. 숫자는 길이에서 추정한 값이라 실제 토큰 수와 다릅니다.`,
      estimated: true,
    };
  }
  return {
    text: `추론 예산 초과 → 도구 호출로 전환 (${used}/${cap}·추정)`,
    short: "초과 → 도구 호출로 전환",
    title:
      `추정 ${used} 토큰이 상한 ${cap}을 넘어서, 이번 턴은 "더 생각하기" 대신 "직접 도구를 호출하기" 로 전환했습니다. ` +
      `thinking 설정이 꺼진 것이 아니며 이 턴이 끝나면 원래대로 돌아갑니다. 숫자는 길이에서 추정한 값이라 실제 토큰 수와 다릅니다.`,
    estimated: true,
  };
}

/**
 * 서버가 알려 준 추론 정책을 **그대로 따른다.**
 *
 * ── 왜 필요한가 (실측) ──────────────────────────────────────────────────────
 *
 * 웹은 상한을 `initialThink()` 의 기본값(=4,096)으로 계산했다. 서버는 설정을 따라
 * 64 로 좁혔는데, 웹은 계속 4096 으로 셌다. 결과:
 *
 *   - 서버는 조용히 도구 호출을 강제한다
 *   - 화면은 **아무 설명도 하지 않는다** (클라이언트가 임계값에 못 미쳤으므로)
 *
 * **규칙이 어긋난 쪽은 반드시 고쳐야 한다.** 서버가 정본이므로 웹이 따라간다.
 *
 * 조용히 따라가지 않는다: 켜짐/끄짐까지 함께 적용한다. 서버가 thinking 을 껐다고
 * 알려줬는데 웹이 "켜짐" 을 계속 표시하면 그것도 거짓말이다.
 */
export function adoptServerThink(
  s: ThinkState,
  server: { enabled?: unknown; maxReasoningTokens?: unknown },
): ThinkState {
  // 턴 시작 신호이기도 하다 — 이전 턴의 계량기가 `finish` 를 거치지 않고 남았어도
  // (취소·재연결·자동재개) 여기서 비운다. 정책만 따르고 계량은 이번 턴부터다.
  const next: ThinkState = {
    ...s,
    usedTokens: 0,
    needsWarning: false,
    forcedToolChoice: false,
    reason: null,
  };
  if (typeof server.enabled === "boolean") next.enabled = server.enabled;
  // **값이 실제로 왔을 때만** 따른다. 못 받았는데 기본값으로 덮으면, 이미 맞춰 둔
  // 상한이 조용히 **기본값으로 되돌아가며** 임계 비교가 또 어긋난다(테스트가 잡았다).
  // "안 보냈다" 는 "기본값이다" 가 아니다 — 이 둘을 구분하는 것이 여기서 중요하다.
  const raw = server.maxReasoningTokens;
  if (raw !== undefined && raw !== null && !(typeof raw === "string" && raw.trim() === "")) {
    // **범위는 정본이 좁힌다.** 웹이 또 다른 규칙을 두면 어긋난다.
    next.maxReasoningTokens = clampReasoningBudget(raw);
  }
  // 서버가 이미 껐다면 그 사실도 따른다 — 웹이 아직 기준을 모르는 상태로 "켜짐" 을
  // 보여주면 사용자가 숫자를 믿고 판단한다.
  if (next.enabled === false) next.forcedToolChoice = true;
  return next;
}
