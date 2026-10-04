/**
 * 부팅 실패를 **"어느 단계에서 · 무엇이 · 왜 · 다음에 무엇을"** 네 가지로 말한다 (Q-5, 2026-10-04).
 *
 * 서버(부팅 로그 줄)와 웹(창의 배너)이 **같은 함수**로 만든다 — 두 곳이 따로 문장을 만들면 로그와 화면이 다른 말을 한다.
 * 원인을 모르면 그럴듯한 문장을 지어내지 않고 **"확인 못 함"** 이라고 쓴다(null 을 문장으로 바꾸지 않는다).
 * import 0개 — 서버·웹 어디서나 읽는다.
 */

export interface StepLike {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
  /** 아직 구현되지 않은 단계 — 실패가 아니다. */
  pending?: boolean;
  /** 원인을 보여 주는 **원본 로그 한 줄**. 모르면 null. */
  why?: string | null;
  /** 사용자가 할 수 있는 **다음 행동 하나**. 모르면 null. */
  next?: string | null;
}

export interface BootFailure {
  where: string;
  what: string;
  why: string;
  next: string;
}

export const UNKNOWN = "확인 못 함";

/** 여러 줄 출력에서 첫 의미 있는 줄 하나(최대 200자). 원본을 고치지 않는다 — 자르기만 한다. */
export function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** 실패한 단계면 네 가지를, 성공·미구현 단계면 null. */
export function describeBootFailure(s: StepLike): BootFailure | null {
  if (s.ok || s.pending) return null;
  return {
    where: `${s.n}/12 ${s.name}`,
    what: s.detail,
    why: firstLine(s.why) ?? UNKNOWN,
    next: firstLine(s.next) ?? `${UNKNOWN} — 서버 로그(harnesside logs)를 보세요`,
  };
}

/** 로그용 두 줄(무엇은 단계 줄이 이미 말한다). */
export function bootFailureLines(s: StepLike): string[] {
  const f = describeBootFailure(s);
  return f ? [`       · 왜: ${f.why}`, `       · 다음: ${f.next}`] : [];
}
