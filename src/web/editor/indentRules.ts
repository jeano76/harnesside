/**
 * 인덴트 가이드 — **세로선 위치를 계산하는 순수 함수** (2026-10-05 · ③).
 *
 * ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
 * 이 저장소에는 인덴트 가이드가 **아예 없었다**(`grep` 결과가 장식용
 * `LIST_INDENT` 하나뿐이었다). Monaco 를 넣으면 저절로 따라오지만 번들 5MB 다 —
 * 이 프로그램은 **로컬 전용**이고, 색칠기조차 221줄짜리 정규식 토크나이저로 직접
 * 썼다. 줄 하나 그은다고 5MB 를 붙일 근거가 없다.
 *
 * ── 왜 측정을 하지 않는가 ───────────────────────────────────────────────────
 * 흔한 구현은 글자 폭을 DOM 으로 측정한다(스팬을 하나 만들고 `getBoundingClientRect`).
 * 여기서 그 측정 대신 CSS 의 **`ch` 단위**를 쓴다. 고정폭 글꼴에서 `1ch` 는 정확히
 * "0" 한 글자의 폭이라 **측정 없이** 줄마다 같은 폭이 나온다.
 *
 * 측정하는 구현이 위험한 이유가 있다: 폰트가 로드되기 **전에** 측정하면 0 이거나
 * 임시값이 나오고, 그 값으로 세로선을 그리면 **선이 코드 사이에 삐져나온다.**
 * `ch` 는 그런 상태가 없다 — 폰트가 늦으면 늦은 만큼 늦게 그려질 뿐, 틀린 값이
 * 화면에 남지 않는다. 그래서 여기에도 **측정 경로가 없다** (되돌릴 것도 없다).
 *
 * ── 무엇을 그릴지 (정의) ────────────────────────────────────────────────────
 * 줄의 들여쓰기가 `n` 열이면, **자기보다 바깥인 블록 시작 열**마다 선을 하나 그린다.
 * 탭 폭이 2 면 0·2·4… 열이 블록의 시작이다.
 *
 *   function f() {        ← 들여쓰기 0 → 선 없음
 *     if (x) {            ← 들여쓰기 2 → 0열에 선 하나
 *       return 1;         ← 들여쓰기 4 → 0열 · 2열
 *     }
 *   }
 *
 * **닫는 줄**(`}` `)` `]` 로 시작하거나 `end` · `else` · `catch` 로 시작하는 줄)은
 * 한 단계 안쪽에서 시작하므로
 * **자기 단계의 선을 그리지 않는다.** 그 선이 닫는 괄호를 그대로 관통하는 것이
 * 사용자가 가장 많이 보는 시끄러움이다. 이것도 정의로 명시한다 — 근사라는 사실을
 * 문서로 남기지 않으면 "왜 마지막 줄만 선이 없다" 는 질문이 남는다.
 */

/** 탭 폭. 정본은 `theme/tokens.ts` 의 `FONT.TAB_SIZE`(2). */
export const GUIDE_TAB_SIZE = 2;

/** 기본 들여쓰기 간격(탭 폭). 파라미터로 받아 **다른 탭 설정에도 재사용**되게 한다. */
export interface GuideOptions {
  tabSize?: number;
  /**
   * 한 단계가 몇 열인지 기본은 탭 폭. **2칸 들여쓰기 흔(tabSize=4) 에서 4칸을 쓰고
   * 싶으면** `step` 을 4로 준다 — 탭 폭(글자가 몇 칸 차지하는지)과 들여쓰기
   * 한 단계(선이 그어질 간격)는 **다른 값**이라서 두 개로 나눴다.
   */
  step?: number;
}

export interface IndentInfo {
  /** 들여쓰기 열 수. 탭은 탭 폭만큼 센다. */
  indentColumns: number;
  /** 그릴 가이드의 열(0-based). 오름차순. */
  guides: number[];
  /** 닫는 괄호·키워드로 시작하는 줄인가. */
  closing: boolean;
  /** 공백뿐인 줄. */
  blank: boolean;
  /** 알려진 닫는 토큰 — 여기 적는 것만 "닫는 줄" 이다. 추측으로 넓히지 않는다. */
  closingKind?: "brace" | "bracket" | "keyword";
}

const CLOSERS: Array<[RegExp, IndentInfo["closingKind"]]> = [
  [/^\s*[}\])]/, "brace"],
  [/^\s*end\b/, "keyword"],
  [/^\s*(else|elif|catch|finally|except)\b/, "keyword"],
  // **YAML 의 `key:` 는 판정에서 제외한다** — 실측 오탐(2026-10-05):
  // `:` 로 끝나는 줄은 YAML 에선 블록을 닫는 키지만, Python·JS 에선 **블록을 여는**
  // 줄이다(`try:` `if x:` `case:` `default:`). 언어 정보 없이 구분할 수 없다.
  // 잘못 판정하면 **가장 흔한 코드**에서 자기 단계의 선이 사라진다 — 그 손해가
  // YAML 키 줄의 선 하나보다 크다. 그래서 **닫는 줄로 보지 않는다.**
  // (YAML 은 `guides` 가 한 단계 깊게 보일 수 있다 — 감추지 않고 여기 적는다.)
];

/**
 * 줄의 들여쓰기를 **열**로 센다.
 *
 * 탭은 "다음 탭 정지 위치" 만큼 간다(가변 폭 정렬의 관례): 0 열에서 탭은 2,
 * 1 열에서 탭은 1. 이걸 안 하고 탭을 1로 세면 탭으로 들여쓴 파일의 가이드가
 * 어긋난다 — 실제 탭 들여쓰기 파일이][]=에서 그런 파일이다.
 */
export function indentColumnsFor(line: string, opts: GuideOptions = {}): number {
  const tabSize = opts.tabSize ?? GUIDE_TAB_SIZE;
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

export function indentInfoFor(line: string, opts: GuideOptions = {}): IndentInfo {
  const tabSize = opts.tabSize ?? GUIDE_TAB_SIZE;
  const step = opts.step ?? tabSize;
  const indentColumns = indentColumnsFor(line, { tabSize });
  const blank = line.trim().length === 0;
  const closingKind = CLOSERS.find(([re]) => re.test(line))?.[1];
  const closing = closingKind !== undefined;
  if (blank || indentColumns === 0) {
    return { indentColumns, guides: [], closing, blank, closingKind };
  }
  // 닫는 줄은 자기 단계의 선을 그리지 않는다 — 괄호를 관통하는 선이 가장 시끄럽다.
  const effective = closing ? Math.max(0, indentColumns - step) : indentColumns;
  const guides: number[] = [];
  for (let c = 0; c < effective; c += step) guides.push(c);
  return { indentColumns, guides, closing, blank, closingKind };
}

/**
 * 가이드 하나의 `left` CSS — **`ch` 단위**.
 *
 * 왜 `px` 로 변환하지 않는가: 글자 폭을 재야 하고, 그 값이 틀리면 선이 코드
 * 사이에 삐져나온다(§ 왜 측정을 하지 않는가). `ch` 는 폰트가 정본을 갖고,
 * 폰트가 없으면 아무것도 그리지 않을 뿐 틀린 값을 그리지 않는다.
 *
 * `offsetCh` 는 거터(줄 번호) 너비까지 포함한 글자 시작 열. 거터는 `em` 으로
 * 주어진다(거터는 항상 글자 폭 단위가 아니라 픽셀 고정이라 호출부가 안다).
 */
export function guideLeftCss(opts: { column: number; offsetCh: number }): string {
  const ch = opts.offsetCh + opts.column;
  // 소수점 픽셀로 나뉘면 흐리게 보이므로 3자리까지. 반올림해서 정렬이 흔들리는 것도
  // 눈에 보인다(줄마다 0.5px 씩 다르면 선이 계단처럼 보인다).
  return `calc(${(Math.round(ch * 1000) / 1000).toFixed(3)}ch)`;
}

/** 가이드 선 색·두께. 정본은 `theme/tokens.ts` 의 토큰 값을 **여기서 복사하지 않는다**. */
export const GUIDE_VISUAL = {
  width: "1px",
  /** 세로선이 본문보다 약해야 코드가 살아 있다. 본문보다 강하면 화면이 선으로 가득 찬다. */
  opacity: 0.28,
} as const;
