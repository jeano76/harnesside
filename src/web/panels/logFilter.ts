/**
 * 로그/디버그 패널 (§5.12 · M11) — 데몬의 유일한 상태 창.
 *
 * 이 패널의 존재 이유: 서버가 **TTY 없이** 돈다(요구 4/§3.7). 사용자가 볼 수 있는
 * 유일한 창이 이것이다. 그래서:
 *  - **닫을 수 없다** (§5.12: 닫으면 "멈췄다" 로 오해된다)
 *  - **상한**을 넘으면 최신 줄만 남긴다 (500,000자)
 *  - `bufferFull` 은 "상한에 닿았다" 가 아니라 **"뭔가 실제로 유실됐다"** 다
 *
 * 필터에 "검색" 을 넣을 때는 **레벨 하한을 debug 으로 완화**한다 — 아니면
 * "이 단어가 있는 debug 로그가 있는데 안 보인다" 고 불만이 나온다.
 */

export const DEFAULT_MAX_CHARS = 500_000;
export const MAX_LINES = 50_000;
export const MAX_LINE_CHARS = 8 * 1024;

// **로그 항목의 정본은 `logRing` 이다.** 여기서 같은 인터페이스를 다시 정의하면
// 필터가 화면용 형태(`at`/`msg`)와 서버 형태(`ts`/`message`) 사이에서 어긋나고,
// 어느 쪽이 맞는지도 모르게 된다(실제로 그렇게 됐었다). 한 곳에서만 가져온다.
export type { LogEntry, LogLevel, LogSource } from "../../server/logRing.js";
export type LogStatus = {
  keptChars: number;
  droppedLines: number;
  maxChars: number;
  /** **실제로 뭔가 잃었을 때만** true. 상한에 닿는 것만으로는 아니다. */
  bufferFull: boolean;
};

import type { LogEntry, LogLevel } from "../../server/logRing.js";

export const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 30, warn: 40, error: 50 };

export const LEVEL_KO: Record<LogLevel, string> = {
  debug: "디버그",
  info: "정보",
  warn: "주의",
  error: "오류",
};

export interface Filter {
  level: LogLevel;
  /** 검색어. 있으면 레벨 하한이 `debug` 으로 완화된다. */
  search: string;
  sources: string[];
  follow: boolean;
}

export function defaultFilter(): Filter {
  return { level: "info", search: "", sources: [], follow: true };
}

/** 필터를 **명시적으로 완화**한다 — 사용자가 debug 를 끄고 검색하는 건 의도가 있다. */
export function relaxForSearch(f: Filter): Filter {
  if (!f.search.trim()) return f;
  // error 보다 낮은 수준이 아니면 debug 로 내린다.
  if (LEVEL_ORDER[f.level] > LEVEL_ORDER.debug) return { ...f, level: "debug" };
  return f;
}

export function matches(e: LogEntry, f: Filter): boolean {
  const eff = relaxForSearch(f);
  if (LEVEL_ORDER[e.level] < LEVEL_ORDER[eff.level]) return false;
  if (eff.sources.length && !eff.sources.includes(e.source)) return false;
  if (eff.search.trim()) {
    const q = eff.search.toLowerCase();
    // 메시지만 본다. 데이터 객체까지 훑으면 형식화 비용이 요청마다 든다.
    if (!e.message.toLowerCase().includes(q)) return false;
  }
  return true;
}

export function filterEntries(entries: LogEntry[], f: Filter): LogEntry[] {
  return entries.filter((e) => matches(e, f));
}

/** 헤더 라벨 — "검색 중: debug 포함" 처럼 **왜** 넓어졌는지 말해야 한다(§5.12). */
export function filterLabel(f: Filter): string {
  const base = `${LEVEL_KO[f.level]} 이상`;
  if (f.search.trim()) {
    const eff = relaxForSearch(f);
    if (eff.level !== f.level) return `검색 중: ${LEVEL_KO[eff.level]} 포함`;
    return `검색 중: "${f.search.trim()}"`;
  }
  if (f.sources.length) return `${base} · ${f.sources.join(", ")}`;
  return base;
}

/**
 * 상한 초과 한 줄. **잘라낸 사실과 이유** 를 알린다 — 조용히 자르면
 * 사용자는 로그가 빠졌다는 것도 모른다.
 */
export function clampLine(msg: string, max = MAX_LINE_CHARS): { text: string; truncated: boolean; dropped: number } {
  if (msg.length <= max) return { text: msg, truncated: false, dropped: 0 };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return {
    text: `${msg.slice(0, head)}\n… ${(msg.length - max).toLocaleString()}자 생략 …\n${msg.slice(-tail)}`,
    truncated: true,
    dropped: msg.length - max,
  };
}

export interface LineBudget {
  lines: number;
  chars: number;
  dropped: number;
}

/** 링에 넣을 형태. **상한은 서버가 진실**(logRing) 이고, 여기는 계산만 한다. */
export function budgetFor(entries: LogEntry[]): LineBudget {
  let chars = 0;
  for (const e of entries) chars += e.message.length + 1;
  return { lines: entries.length, chars, dropped: 0 };
}

/**
 * 화면에 보여줄 마지막 N줄. follow 가 켜져 있으면 **최신** 쪽을 자른다.
 * 로그에서 가장 중요한 정보는 보통 **맨 아래**(오류)에 있다.
 */
export function visibleTail(entries: LogEntry[], maxLines = 2000): LogEntry[] {
  return entries.length > maxLines ? entries.slice(entries.length - maxLines) : entries;
}

/** `bufferFull` 배지 문구 — 뭔가 잃었다는 사실과 방향을 말한다. */
export function bufferFullLabel(st: LogStatus | null): { text: string; color: string } | null {
  if (!st?.bufferFull) return null;
  return { text: `로그 상한 도달 — ${st.droppedLines.toLocaleString()}줄이 유실되었습니다 (최신 ${Math.round((st.keptChars / Math.max(1, st.maxChars)) * 100)}% 유지)`, color: "#d29922" };
}

/** "새 로그 있음" 표시 — follow 를 끈 경우에만. */
export function pendingIndicator(total: number, shown: number): string | null {
  if (shown >= total) return null;
  return `${(total - shown).toLocaleString()}줄 새 로그 — 아래로 따라가기`;
}
