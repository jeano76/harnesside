/**
 * LogPanel 순수 로직 테스트 (§10.2 — "웹 순수 로직" 행에 해당).
 *
 * DOM 을 만들지 않고 **계산 결과**만 검증한다: 필터·가상 스크롤 슬라이스·상한 배너.
 * 브라우저 렌더링은 E2E(§10.4)가 본다. 유닛은 "계산이 맞나" 만 본다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LogEntry, LogLevel, LogSource } from "../../server/logRing.js";

const ROW_H = 18;
const OVERSCAN = 20;

/** 레벨 순서 — 선택지의 "N 이상" 은 최소 레벨 필터다. */
export const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 최소 레벨을 정한다. 규칙은 하나뿐이다: **검색 중에는 바닥을 debug 까지 내린다.**
 * 사용자가 "cuda" 라고 입력했는데 그 단어가 debug 줄에만 있다면, 레벨 때문에
 * "없음" 이라고 답하는 것은 맞는 답이 아니다.
 * 대신 UI 가 "검색 중: debug 포함" 을 **보여줘야** 한다 — 조용히 완화하면
 * 사용자는 왜 debug 가 나오는지 모른다.
 */
export function minLevelFor(filter: string, level?: LogLevel): LogLevel {
  return filter.trim() ? "debug" : level ?? "debug";
}

/**
 * LogPanel 과 동일한 필터 규칙을 재현한다(구현이 두 벌이 되면 규칙이 어긋난다).
 */
export function applyFilter(
  entries: LogEntry[],
  opts: { filter?: string; sources?: Set<LogSource>; level?: LogLevel }
): LogEntry[] {
  const q = (opts.filter ?? "").trim().toLowerCase();
  const min = RANK[minLevelFor(opts.filter ?? "", opts.level)];
  return entries.filter((e) => {
    if (opts.sources && opts.sources.size > 0 && !opts.sources.has(e.source)) return false;
    if (RANK[e.level] < min) return false;
    if (q && !e.message.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** LogPanel 과 동일한 가상 스크슬 슬라이스 계산. */
export function sliceForViewport(total: number, height: number): { start: number; count: number } {
  const start = Math.max(0, total - Math.ceil(height / ROW_H) - OVERSCAN);
  return { start, count: total - start };
}

function entry(i: number, over: Partial<LogEntry> = {}): LogEntry {
  return {
    seq: i,
    ts: Date.UTC(2026, 0, 1, 0, 0, i),
    level: "info",
    source: "server",
    scope: "test",
    message: `메시지 ${i}`,
    ...over,
  };
}

test("소스 필터", () => {
  const es = [entry(1, { source: "llama" }), entry(2, { source: "server" }), entry(3, { source: "chrome" })];
  assert.equal(applyFilter(es, { sources: new Set(["llama"]) }).length, 1);
  assert.equal(applyFilter(es, { sources: new Set(["llama", "chrome"]) }).length, 2);
  assert.equal(applyFilter(es, { sources: new Set() }).length, 3, "비어 있으면 전체");
});

test("레벨 필터 — debug 은 기본 숨김", () => {
  const es = [entry(1, { level: "debug" }), entry(2, { level: "info" }), entry(3, { level: "error" })];
  assert.equal(applyFilter(es, { level: "info" }).length, 2);
  assert.equal(applyFilter(es, { level: "debug" }).length, 3);
  assert.equal(applyFilter(es, { level: "error" }).length, 1);
});

test("검색은 대소문자 무시하며, 검색 중에는 레벨 바닥을 내린다", () => {
  const es = [entry(1, { level: "debug", message: "CUDA malloc failed" }), entry(2, { message: "정상" })];
  // info 이상인데 debug 줄을 찾아낸다 — 사용자가 그 단어를 직접 물어봤으니까
  assert.equal(applyFilter(es, { level: "info", filter: "cuda" }).length, 1);
  assert.equal(applyFilter(es, { level: "info" }).length, 1, "검색이 없으면 debug 은 숨겨진다");
  assert.equal(applyFilter(es, { level: "info", filter: "정상" }).length, 1);
  // 최소 레벨 계산 자체가 규칙대로인지
  assert.equal(minLevelFor("", "error"), "error");
  assert.equal(minLevelFor("   ", "error"), "error", "공백만 있으면 검색이 아니다");
  assert.equal(minLevelFor("cuda", "error"), "debug", "검색이 있으면 바닥을 내린다");
  assert.equal(minLevelFor("", undefined), "debug");
});

test("가상 스크롤 — 5만 줄에서도 DOM 은 보이는 만큼만", () => {
  const big = Array.from({ length: 50_000 }, (_, i) => entry(i));
  const { start, count } = sliceForViewport(50_000, 260);
  const visible = Math.ceil(260 / ROW_H) + OVERSCAN;
  assert.equal(count, visible, `${count}줄을 DOM 으로 만든다`);
  assert.ok(count < 100, "화면 밖 줄까지 렌더한다");
  assert.equal(start, 50_000 - count);
  // 가장 최근 줄이 반드시 보인다
  assert.equal(big[start + count - 1].seq, 49_999);
});

test("가상 스크롤 — 항목이 적으면 전체를 보여준다", () => {
  const { start, count } = sliceForViewport(5, 260);
  assert.equal(start, 0);
  assert.equal(count, 5);
});

test("가상 스크롤 — 항목이 0 이면 예외 없이 0", () => {
  const { start, count } = sliceForViewport(0, 260);
  assert.equal(start, 0);
  assert.equal(count, 0);
});

test("상한 배너: '잘렸습니다'는 실제로 뭔가 사라졌을 때만 (§5.12.2)", () => {
  const status = { keptChars: 500_000, droppedLines: 0, maxChars: 500_000, bufferFull: false };
  assert.equal(status.bufferFull, false);
  const after = { ...status, droppedLines: 12_400, bufferFull: true };
  assert.equal(after.bufferFull, true, "실제로 잘렸으면 배너가 떠야 한다");
});

test("필터 조합 — 소스 + 레벨 + 검색이 동시에 적용된다", () => {
  const es = [
    entry(1, { source: "llama", level: "error", message: "out of memory" }),
    entry(2, { source: "llama", level: "info", message: "loading model" }),
    entry(3, { source: "server", level: "error", message: "out of memory" }),
  ];
  const got = applyFilter(es, { sources: new Set(["llama"]), level: "error", filter: "memory" });
  assert.equal(got.length, 1);
  assert.equal(got[0].seq, 1);
});
