/**
 * 문자 단위 인라인 차이 (§5.2 "문자 단위 인라인 차이").
 *
 * 줄 단위 diff 는 "이 줄이 바뀌었다" 만 알려준다. 사용자가 검토할 때 실제로 궁금한 것은
 * **어디가** 바뀌었는지다. 같은 줄 안의 두 단어를 고치는 데 300줄 diff 를 스크롤하게
 * 만들면 그 기능은 없는 셈이다.
 *
 * 여기서 만드는 것은 **강조 구간 목록**이고, 렌더링은 `<mark>` 가 한다.
 */

export interface Span {
  /** 강조 구간 안의 문자열. */
  text: string;
  /** false 면 변경되지 않은 부분. */
  changed: boolean;
}

export interface CharRange {
  start: number;
  end: number;
}

/** 공통 접두/접미를 제외한 가운데 구간을 찾는다 — 가장 싸고 가장 자주 맞는 경우. */
export function inlineRanges(a: string, b: string): { a: CharRange; b: CharRange } | null {
  if (a === b) return null;
  const min = Math.min(a.length, b.length);
  let start = 0;
  while (start < min && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return null;
  return { a: { start, end: endA }, b: { start, end: endB } };
}

/**
 * 라틴어 단어 경계 + 한글 자모 단위로 자른 공통 부분어(LCS) — 여러 단어가 흩어진
 * 수정("const a = 1" → "let a = 2, b = 3")에서 접두/접미만 보는 것보다 정확하다.
 * 상한을 넘어면 접두/접미 결과로 물러난다(오래 걸리면 검토가 늦어지는 게 더 나쁘다).
 */
const MAX_CELLS = 250_000;

function tokens(s: string): string[] {
  // 공백은 문자 그대로 두되, 라틴어/숫자/한글 을 각각 한 덩어리로 묶는다.
  return s.match(/[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/gu) ?? [s];
}

/** 여러 개의 강조 구간을 [일반, 강조, 일반, 강조, ...] 순서의 Span 배열로 만든다. */
export function toSpans(text: string, ranges: CharRange[]): Span[] {
  if (ranges.length === 0) return text ? [{ text, changed: false }] : [];
  const merged = [...ranges].sort((x, y) => x.start - y.start);
  const out: Span[] = [];
  let cur = 0;
  for (const r of merged) {
    const s = Math.max(cur, Math.min(r.start, text.length));
    const e = Math.max(s, Math.min(r.end, text.length));
    if (s > cur) out.push({ text: text.slice(cur, s), changed: false });
    if (e > s) out.push({ text: text.slice(s, e), changed: true });
    cur = Math.max(cur, e);
  }
  if (cur < text.length) out.push({ text: text.slice(cur), changed: false });
  return out;
}

/**
 * 한 줄 교체에서 양쪽의 강조 구간을 구한다. **항상** 어떤 형태로든 구간을 낸다
 * (단어 LCS 가 실패하면 접두/접미로 물러난다) — 강조가 전혀 없는 diff 는
 * "무엇을 검토해야 하나" 를 알려주지 못한다.
 */
export function inlineSpans(a: string, b: string): { left: Span[]; right: Span[] } {
  const tokA = tokens(a);
  const tokB = tokens(b);
  if (tokA.length * tokB.length <= MAX_CELLS) {
    const n = tokA.length;
    const m = tokB.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = tokA[i] === tokB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ra: CharRange[] = [];
    const rb: CharRange[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (tokA[i] === tokB[j]) {
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ra.push({ start: offsetOf(a, tokA, i), end: offsetOf(a, tokA, i) + tokA[i].length });
        i++;
      } else {
        rb.push({ start: offsetOf(b, tokB, j), end: offsetOf(b, tokB, j) + tokB[j].length });
        j++;
      }
    }
    while (i < n) {
      ra.push({ start: offsetOf(a, tokA, i), end: offsetOf(a, tokA, i) + tokA[i].length });
      i++;
    }
    while (j < m) {
      rb.push({ start: offsetOf(b, tokB, j), end: offsetOf(b, tokB, j) + tokB[j].length });
      j++;
    }
    if (ra.length || rb.length) {
      return { left: toSpans(a, ra), right: toSpans(b, rb) };
    }
  }
  const r = inlineRanges(a, b);
  if (!r) return { left: toSpans(a, []), right: toSpans(b, []) };
  return { left: toSpans(a, [r.a]), right: toSpans(b, [r.b]) };
}

/** 토큰 i 의 문자열 내 시작 오프셋. */
function offsetOf(s: string, tok: string[], i: number): number {
  let off = 0;
  for (let k = 0; k < i; k++) off += tok[k].length;
  return off;
}

/** 헤더용 통계 문자열 — "수정 2 · 추가 1 · 삭제 1" (§5.2). */
export function statLabel(stat: { added: number; removed: number; modified: number; unchanged: number }): string {
  const parts: string[] = [];
  if (stat.modified) parts.push(`수정 ${stat.modified}`);
  if (stat.added) parts.push(`추가 ${stat.added}`);
  if (stat.removed) parts.push(`삭제 ${stat.removed}`);
  if (!parts.length) return "변경 없음";
  return parts.join(" · ");
}

/** diff 소스 3종 (§5.2 표) — 어느 두 텍스트를 비교하는지 사용자가 알아야 한다. */
export type DiffSource = "file" | "git" | "tool";

export interface DiffViewState {
  source: DiffSource;
  path: string;
  leftLabel: string;
  rightLabel: string;
  layout: "side" | "inline";
  fullScreen: boolean;
}

export function initialView(source: DiffSource, path: string, pref: "auto" | "side" | "inline" = "auto", width = 1200): DiffViewState {
  const labels: Record<DiffSource, [string, string]> = {
    file: ["디스크", "버퍼"],
    git: ["HEAD", "워킹트리"],
    tool: ["실행 전", "실행 후"],
  };
  const [l, r] = labels[source];
  return {
    source,
    path,
    leftLabel: source === "git" ? `HEAD · ${path}` : l,
    rightLabel: source === "git" ? `워킹트리 · ${path}` : r,
    layout: pref === "auto" ? (width < 900 ? "inline" : "side") : pref,
    fullScreen: false,
  };
}
