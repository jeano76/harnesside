/**
 * U-1 팔레트 접두어 파서 — 순수 로직 (React 없음).
 *
 * 접두어: `>` 명령 · `@` 심볼 · `#` 내용 · `:` 줄 이동 · `!` 레시피 · 없음 = 전체.
 * 팔레트를 두 개 만들지 않기 위해 파서는 하나만 있다.
 * U-2/U-5/U-6/U-8/U-9 범위가 와도 이 파서는 그대로 쓴다.
 */

export type PaletteScope =
  | "all"
  | "commands"
  | "files"
  | "search"
  | "symbols"
  | "turns"
  | "tasks"
  | "settings"
  | "recipes"
  | "history";

export const PALETTE_PREFIXES = [">", "@", "#", ":", "!"] as const;

export interface ParsedPaletteQuery {
  /** 접두어가 가리키는 범위. 없으면 "all". */
  scope: PaletteScope;
  /** 접두어를 뗀 실제 검색어 (trim 아님 — 표시는 호출자가). */
  query: string;
  /** 접두어가 있었는가. */
  explicit: boolean;
}

/** 접두어 → 범위. `:` 는 파일:줄 이동이므로 files 로 취급하지 않고 별도 scope 없이 search 계열로 두지 않는다. */
const PREFIX_SCOPE: Record<string, PaletteScope> = {
  ">": "commands",
  "@": "symbols",
  "#": "search",
  ":": "files",
  "!": "recipes",
};

export function parsePaletteQuery(input: string): ParsedPaletteQuery {
  if (!input) return { scope: "all", query: "", explicit: false };
  const first = input[0];
  const scope = PREFIX_SCOPE[first];
  if (!scope) return { scope: "all", query: input, explicit: false };
  return { scope, query: input.slice(1), explicit: true };
}

/** 팔레트 하단에 항상 보이는 접두어 도움말 — 문서 없이 발견되게 한다. */
export const PREFIX_HELP: { prefix: string; scope: PaletteScope; labelKey: string }[] = [
  { prefix: ">", scope: "commands", labelKey: "palette.scopeCommands" },
  { prefix: "@", scope: "symbols", labelKey: "palette.scopeSymbols" },
  { prefix: "#", scope: "search", labelKey: "palette.scopeSearch" },
  { prefix: ":", scope: "files", labelKey: "palette.scopeGotoLine" },
  { prefix: "!", scope: "recipes", labelKey: "palette.scopeRecipes" },
];

/**
 * 결과 행 범주 표시 — 색만 쓰지 않는다. 글자 + 모양 둘 다.
 * 모양은 텍스트 글리프라 폰트·테마와 무관하게 읽힌다.
 */
export const SCOPE_BADGE: Record<PaletteScope, { letter: string; glyph: string }> = {
  all: { letter: "A", glyph: "✳" },
  commands: { letter: "C", glyph: "⌘" },
  files: { letter: "F", glyph: "▤" },
  search: { letter: "S", glyph: "#" },
  symbols: { letter: "Y", glyph: "@" },
  turns: { letter: "T", glyph: "↩" },
  tasks: { letter: "K", glyph: "☰" },
  settings: { letter: "G", glyph: "⚙" },
  recipes: { letter: "R", glyph: "▶" },
  history: { letter: "H", glyph: "◷" },
};

export interface Truncation {
  shown: number;
  total: number;
  truncated: boolean;
}

export function truncateInfo(total: number, shown: number): Truncation {
  return { shown: Math.min(shown, total), total, truncated: total > shown };
}

/**
 * 파일:줄 이동 파서 (`:` 범위용).
 * "src/a.ts:12:3" → { path, line, col }. 아니면 null — 지어내지 않는다.
 */
export function parseGotoLine(query: string): { path: string; line: number; col: number } | null {
  const q = query.trim();
  const m = q.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  const path = m[1].trim();
  if (!path) return null;
  const line = Number(m[2]);
  if (!Number.isFinite(line) || line < 1) return null;
  const col = m[3] == null ? 1 : Number(m[3]);
  if (!Number.isFinite(col) || col < 1) return null;
  return { path, line, col };
}

/**
 * "에이전트에게 이걸로 …" 보조 동작용 맥락 칩 텍스트.
 * 입력창에 그대로 붙여 에이전트에 넘긴다 — Tab 으로 첨부.
 */
export function formatAgentContext(
  item: { kind: string; label: string; path?: string; line?: number },
): string {
  if (item.kind === "file" || item.kind === "search-hit") {
    return item.line != null ? `[${item.path}:${item.line}]` : `[${item.path ?? item.label}]`;
  }
  if (item.kind === "symbol") return `[symbol:${item.label}]`;
  if (item.kind === "command") return `[cmd:${item.label}]`;
  if (item.kind === "recipe") return `[recipe:${item.label}]`;
  return `[${item.label}]`;
}
