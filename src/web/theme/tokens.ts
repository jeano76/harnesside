/**
 * 디자인 토큰 — 상용 UX의 수치 정본 (PROMPT_UX_COMMERCIAL.md §3.10·§3.13).
 *
 * 왜 한 파일인가: 패널마다 `#161b22` `#30363d` 같은 매직값이 흩어져 있으면
 * 같은 회색이 두 곳에서 다르게 진화한다. 실제로 `DIM`이 `#8b949e`(Ide·Markdown)와
 * `#6e7681`(ToolBlock·CodeBlock) 두 가지로 갈라져 있었다. 토큰이 정본이다.
 *
 * 규칙:
 * - 새 UI는 여기서만 색·폰트·간격을 가져온다. 리터럴 색상 금지.
 * - 기존 패널은 값을 바꾸지 않고 선언만 여기로 옮긴다 (값 변경은 별도 커밋).
 * - `DIM`(#8b949e)이 기본 메타 색. `#6e7681`은 `DIM_SUBTLE`로만 쓴다.
 */

export const COLOR = {
  FG: "#c9d1d9",
  DIM: "#8b949e",
  /** 더 어두운 보조 — 본문 메타가 아닌 장식·플레이스홀더에만. */
  DIM_SUBTLE: "#6e7681",
  BORDER: "#30363d",
  HAIRLINE: "#30363d",
  CODE_BG: "#161b22",
  SURFACE_1: "#0d1117",
  SURFACE_2: "#161b22",
  SURFACE_3: "#21262d",
  BG_DEEP: "#010409",
  BLUE: "#79c0ff",
  LINK: "#58a6ff",
  GREEN: "#7ee787",
  GOOD: "#3fb950",
  RED: "#ff7b72",
  ERROR: "#f85149",
  YELLOW: "#d29922",
  PURPLE: "#d2a8ff",
  ACTIVE_BLUE: "#0078d4",
  INACTIVE: "#4d4d4c",
  LINE_NUM: "#484f58",
} as const;

export type ColorKey = keyof typeof COLOR;

/** 상태바·게이지 tone → 색. 색만으로 알리지 말고 값·기호와 함께 쓴다. */
export function toneColor(tone: "normal" | "warn" | "error" | "good" | undefined): string {
  if (tone === "error") return COLOR.ERROR;
  if (tone === "warn") return COLOR.YELLOW;
  if (tone === "good") return COLOR.GOOD;
  return COLOR.DIM;
}

/** 도구 블록 상태점 — 색+기호 병기용. */
export function statusGlyph(done: boolean): { glyph: string; color: string; label: string } {
  return done
    ? { glyph: "✓", color: COLOR.GOOD, label: "완료" }
    : { glyph: "▸", color: COLOR.YELLOW, label: "실행 중" };
}

export const FONT = {
  UI: '-apple-system, BlinkMacSystemFont, "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif',
  MONO: 'ui-monospace, "JetBrains Mono", "D2Coding", Consolas, monospace',
  BODY: 12,
  BODY_LARGE: 13,
  AUX: 11,
  META: 10,
  LINE_BODY: 1.6,
  LINE_CODE: 1.5,
  TAB_SIZE: 2,
} as const;

export const SPACE = {
  BLOCK_GAP: 8,
  BLOCK_PAD_Y: 6,
  BLOCK_PAD_X: 8,
  TURN_GAP: 16,
  HEADER_GAP: 2,
  NEST: 12,
  LIST_INDENT: 16,
  CODE_GUTTER: 8,
  MAX_NEST: 3,
} as const;

export const RADIUS = {
  XS: 2,
  S: 4,
  M: 6,
  /** 알약형(뱃지·칩) — 원형이 아니라 알약이다. 10/12 같은 중간값은 쓰지 않는다. */
  PILL: 999,
} as const;

export const LAYOUT = {
  /** 액티비티바 고정폭. Ide.tsx 기본값(40)과 일치시킨다. */
  ACTIVITY_WIDTH: 40,
  STATUS_HEIGHT: 20,
  TAB_MIN_HEIGHT: 30,
  TAB_MAX_WIDTH: 240,
  MONITOR_MIN: 300,
  /** 접기 버튼이 생기는 줄 수 (CodeBlock FIRST_COLLAPSED_LINES와 동일). */
  FOLD_AT_LINES: 24,
  CODE_MAX_HEIGHT: 260,
  FILE_MAX_HEIGHT: 320,
} as const;

export const BLOCK_KIND_META = {
  user: { glyph: "🧑", label: "나" },
  assistant: { glyph: "🤖", label: "답변" },
  think: { glyph: "💭", label: "생각 중" },
  shell: { glyph: "▸", label: "셸 실행" },
  file: { glyph: "📄", label: "열기" },
  edit: { glyph: "✏️", label: "수정" },
  search: { glyph: "🔍", label: "검색" },  files: { glyph: "📁", label: "빠른 이동" },
  settings: { glyph: "⚙️", label: "설정" },
  review: { glyph: "📝", label: "변경 검토" },
  approval: { glyph: "⚠️", label: "승인 필요" },
  notice: { glyph: "ℹ️", label: "알림" },
  tool: { glyph: "🔧", label: "도구" },
} as const;

export type BlockKindKey = keyof typeof BLOCK_KIND_META;
