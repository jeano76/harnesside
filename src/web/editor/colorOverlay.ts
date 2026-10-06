/**
 * **편집창** 신택스 하이라이트 — 겹침(overlay) 기법의 규칙 쪽 (2026-10-05).
 *
 * ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
 * 파일 미리보기 · 코드 블록 · 대화 속 코드펜스는 `editor/highlight.ts` 로 색이
 * 칠해졌다. **편집창만 평문 `<textarea>` 였다.** 읽을 때는 IDE 같고, 고치는
 * 순간 IDE 가 아니었다 — 그리고 "고치는" 쪽이 더 자주 보는 화면이다.
 *
 * `<textarea>` 안의 글자에는 색을 줄 수 없다(브라우저가 렌더한다). 그래서 쓰는
 * 방법이 하나뿐이다:
 *
 *     ┌ 투명한 글자를 가진 textarea  ← 입력·선택·커서가 여기 있다 (z 위)
 *     └ 색칠된 <pre> 를 정확히 같은 자리에 덧댄다 (z 아래)
 *
 * 겹침이 어긋나면 **색이 한 칸씩 밀린다.** 그래서 이 기법의 진짜 위험은
 * 하이라이터가 아니라 **두 층의 글자_metrics 가 같은지** 다. 그래서 두 층이
 * **같은 객체를 공유**하게 만들었고(`EDITOR_TEXT_METRICS`), 그것을 쓰는 곳이
 * 둘인지를 테스트가 지킨다.
 *
 * ── 이 기법이 어긋나는 경우 (감추지 않는다) ─────────────────────────────────
 *  1. **폰트 치환**: 시스템에 `ui-monospace` 가 없고 대체 폰트로 내려가면 줄바꿈
 *     지점이 달라질 수 있다. 두 층이 같은 폰트 스택을 쓰므로 **같아질 확률이 높다**가,
 *     같음은 보장되지 않는다. 실측은 브라우저에서 해야 한다(아래 "미측정").
 *  2. **드래그 선택 색**: 글자를 투명하게 만들면 선택 영역의 배경은 남는다(보이는 게
 *     맞다) — 다만 일부 브라우저는 선택 텍스트를 연회색으로 칠해 버린다.
 *     커서는 `caretColor` 로 되살린다.
 *  3. **접은 상태의 미니맵**: 없다. 만들지 않았다.
 *  4. **RTL·한자 폭**: 고정폭 폰트에서 한자는 두 칸을 차지한다. 두 층이 같은
 *     폰트·같은 `tabSize` 이므로 같은 수로 계산된다.
 *
 * ── 왜 여기까지 하는가 (경계) ────────────────────────────────────────────────
 * 이 모듈은 **텍스트를 고쳐 쓰지 않는다.** 편집창은 여전히 textarea 다 — 자동 저장 ·
 * 충돌 해결 · 이전 세션 초안 복구는 전부 그 값에 붙어 있다. 글자를 투명하게 만드는 것은
 * **보여주기만** 바꾼다. 편집 경로를 `<div contentEditable>` 로 바꾸는 것은
 * "되돌릴 수 없는 편집 경로 교체"이고, 그건 이 요구(가독성)의 값어치를 넘는다.
 */

import { tokenizeLine, colorFor, LANGUAGE_LABEL, type Language, type Token } from "./highlight.js";
import { COLOR, FONT } from "../theme/tokens.js";
import { indentInfoFor, type IndentInfo } from "./indentRules.js";

/**
 * 두 층이 **공유해야 하는** 글자 모양·여백.
 *
 * 왜 객체 하나인가: 패딩을 1px만 다르게 줘도 색이 어긋난다. 두 곳에 리터럴로 적으면
 * 언젠가 한쪽만 바뀐다 — 실제로 이 저장소에서 `DIM` 이 두 값으로 갈라졌던 전례가 있다
 * (`theme/tokens.ts` 머리말). 그래서 **한 곳에서 만들고 두 곳이 import** 한다.
 *
 * `font`/`padding`/`tabSize`/`whiteSpace`/`lineHeight`/`letterSpacing`/`wordBreak` 가
 * 어긋나는 항목이다. 새 항목을 추가할 때 **양쪽에 함께 적용되는지** 테스트가 본다.
 */
export const EDITOR_TEXT_METRICS = {
  // **폰트·탭 폭은 `theme/tokens.ts` 정본에서 만든다.** 여기서 문자열을 새로 적으면
  // 토큰 값과 이 값이 따로 진화한다 — 실제로 이 저장소에서 `DIM` 이 두 값으로
  // 갈라졌던 일이 있었다(`tokens.ts` 머리말).
  font: `${FONT.AUX}px/${FONT.LINE_CODE} ${FONT.MONO}`,
  padding: "6px 8px",
  tabSize: FONT.TAB_SIZE,
  whiteSpace: "pre-wrap",
  wordBreak: "normal",
  overflowWrap: "normal",
  lineHeight: FONT.LINE_CODE,
  letterSpacing: "normal",
  textIndent: "0",
} as const;

/** textarea 전용 — 글자를 **투명하게** 만들어 아래 층이 보이게 한다. */
export const EDITOR_CARET_LAYER = {
  color: "transparent",
  // WebkitTextFillColor 를 안 주면 Safari 계열에서 글자가 **보인다** — 아래 층과
  // 겹쳐 "두 번 출력" 된다. 한쪽만 보이는 것보다 나쁜 실패라 반드시 함께 건다.
  WebkitTextFillColor: "transparent",
  caretColor: COLOR.FG,
  background: "transparent",
} as const;

/**
 * 편집창이 색칠할 줄 수 상한.
 *
 * 왜 `highlight.ts` 의 `MAX_HIGHLIGHT_LINES`(3000) 보다 작은가: **키 입력마다**
 * 다시 그려야 한다. 읽는 화면은 파일을 열 때 한 번 그리는 것이고, 편집창은
 * 입력 한 줄마다 전체를 다시 토크나이즈한다. 상한을 높이면 타이핑이 무거워진다.
 * 잘라냈을 때는 **화면에 그 사실을 말한다**(아래 `note`).
 */
export const EDITOR_OVERLAY_MAX_LINES = 2000;

export interface OverlayLine {
  /** 화면에 그릴 1-based 줄 번호. */
  n: number;
  tokens: Token[];
  /** 인덴트 가이드 — **규칙은 `indentRules.ts`** (2026-10-05). 계산은 거기서 한다. */
  indent: IndentInfo;
}

export interface EditorOverlayPlan {
  lang: Language;
  /** 색을 칠할 수 있는가. `text`(미지원 형식) 면 false. */
  colorable: boolean;
  lines: OverlayLine[];
  /** 전체 줄 수 — 잘랐을 때 "N줄 중 M줄" 을 말하기 위해 따로 들고 있다. */
  totalLines: number;
  truncated: boolean;
  /** 사용자에게 말할 문장. **비어 있으면 화면에 아무 말도 하지 않는다.** */
  note?: string;
}

/**
 * textarea 의 값과 **글자가 같도록** 정규화한다.
 *
 * 왜 필요하나: 브라우저는 `<textarea>` 의 `value` 에 들어 있는 `\r\n` 을 **줄바꿈 1개로
 * 정규화해 그린다**(LF 로). 그래서 원본 그대로 색칠하면 Windows 줄바꿈 파일은
 * **첫 줄부터 한 칸씩 밀려서** 색이 어긋난다. 이것이 실제로 Windows 에서 나는
 * 대표적 결함이라 여기서 막는다.
 *
 * `\r` 혼자(옛 Mac 줄바꿈)도 같이 정규화한다 — 같은 이유로.
 */
export function normalizeForOverlay(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 화면에 말할 "색칠하지 않는다" 문장 — 조용히 칠하지 않는 것이 이 저장소의 규칙. */
export function unsupportedNote(path: string): string {
  const ext = path.includes(".") ? `.${path.split(".").pop()}` : "(확장자 없음)";
  return `이 형식은 색칠하지 않습니다 (미지원: ${ext}) — 내용은 그대로 보입니다.`;
}

/**
 * 편집창이 그릴 겹침 층을 **계산한다**. 순수 함수 — DOM 이 없다.
 *
 * 순수 함수로 둔다 이유는 검사가 브라우저를 띄우지 않기 위해서다. 이 저장소에서
 * "사람이 보는 것은 실제 창에서 본다" 는 규칙이 있지만, **규칙 자체의 정확성**은
 * 브라우저 없이 검사할 수 있어야 하고 — 그게 가능해야 창을 못 여는 환경에서도
 * 회귀를 막는다.
 */
export function editorOverlayPlan(opts: {
  text: string;
  lang: Language;
  path?: string;
  maxLines?: number;
  /** 들여쓰기 한 단계(선이 그어질 간격). 기본은 탭 폭(2). */
  indentStep?: number;
}): EditorOverlayPlan {
  const maxLines = opts.maxLines ?? EDITOR_OVERLAY_MAX_LINES;
  const normalized = normalizeForOverlay(opts.text);
  // **끝의 빈 줄을 유지한다.** "a\n" 은 2줄이다 — 1줄로 세면 마지막 줄이 사라진
  // 것처럼 보이고, 실제로는 한 줄이 밀린다.
  const all = normalized.split("\n");
  const colorable = opts.lang !== "text";
  const shown = all.slice(0, maxLines);
  return {
    lang: opts.lang,
    colorable,
    totalLines: all.length,
    truncated: all.length > shown.length,
    lines: shown.map((line, i) => ({
      n: i + 1,
      tokens: colorable ? tokenizeLine(line, opts.lang) : [{ kind: "plain" as const, text: line }],
      // 가이드는 **색칠 여부와 무관**하게 계산한다 — 미지원 형식이라도 들여쓰기는 보인다.
      indent: indentInfoFor(line, { tabSize: FONT.TAB_SIZE, step: opts.indentStep }),
    })),
    note: buildNote({ colorable, path: opts.path, total: all.length, shown: shown.length, lang: opts.lang }),
  };
}

function buildNote(o: { colorable: boolean; path?: string; total: number; shown: number; lang: Language }): string | undefined {
  const parts: string[] = [];
  if (!o.colorable) parts.push(unsupportedNote(o.path ?? "파일"));
  if (o.total > o.shown) {
    // **자른 사실을 말한다.** 조용히 자르면 사용자는 "파일에 없던 줄"을 찾는다.
    parts.push(`${o.total.toLocaleString("ko-KR")}줄 중 ${o.shown.toLocaleString("ko-KR")}줄만 색칠했습니다 — 나머지는 아래에 그대로 있습니다(자르지 않았습니다).`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

/** 헤더에 이미 보이는 언어 이름과, 여기서 쓰는 이름이 **같은 말**인지 확인하기 위한 것. */
export { LANGUAGE_LABEL, colorFor };
