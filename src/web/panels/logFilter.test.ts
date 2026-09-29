/**
 * 로그 필터 테스트 (§5.12 · M11 · §10.2).
 *
 * 특히 두 가지를 검증한다:
 *  1. 검색이 레벨을 **의도적으로 완화**한다 (그래야 debug 로그를 찾을 수 있다)
 *  2. `bufferFull` 은 **상한 접촉이 아니라 유실** 을 뜻한다 — 경보가 거짓이면 무시한다
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LEVEL_ORDER,
  LEVEL_KO,
  defaultFilter,
  relaxForSearch,
  matches,
  filterEntries,
  filterLabel,
  clampLine,
  budgetFor,
  visibleTail,
  bufferFullLabel,
  pendingIndicator,
  DEFAULT_MAX_CHARS,
  MAX_LINES,
  MAX_LINE_CHARS,
  type LogEntry,
  type LogLevel,
} from "./logFilter.js";

const e = (over: Partial<LogEntry> = {}): LogEntry => ({
  seq: 1,
  ts: 0,
  level: "info",
  source: "server",
  scope: "test",
  message: "메시지",
  ...over,
});

test("레벨 순서가 정의되어 있다 — 문자열 비교는 틀린다", () => {
  assert.ok(LEVEL_ORDER.error > LEVEL_ORDER.warn);
  assert.ok(LEVEL_ORDER.warn > LEVEL_ORDER.info);
  assert.ok(LEVEL_ORDER.info > LEVEL_ORDER.debug);
  // 문자열 정렬은 debug < error < info < warn 가 된다(완전히 반대).
  const keys = Object.keys(LEVEL_ORDER) as LogLevel[];
  assert.equal([...keys].sort().join(","), "debug,error,info,warn");
  assert.notEqual(
    [...keys].sort().join(","),
    [...keys].sort((a, b) => LEVEL_ORDER[a] - LEVEL_ORDER[b]).join(","),
    "레벨 순서를 정의하지 않았거나 문자열 정렬과 같다",
  );
  // **logRing 의 네 레벨과 정확히 일치**해야 한다 — 새 레벨이 추가되면 여기서 드러난다.
  assert.deepEqual(Object.keys(LEVEL_ORDER).sort(), ["debug", "error", "info", "warn"]);
  for (const k of keys) assert.ok(LEVEL_KO[k], `${k} 에 한국어 라벨이 없다`);
});

test("기본은 info 이상 — 디버그 폭탄을 기본으로 보여주지 않는다", () => {
  const f = defaultFilter();
  assert.equal(f.level, "info");
  assert.equal(f.follow, true);
  assert.equal(matches(e({ level: "debug" }), f), false);
  assert.equal(matches(e({ level: "info" }), f), true);
  assert.equal(matches(e({ level: "error" }), f), true);
});

test("**검색은 레벨을 debug 로 완화**한다 — 아니면 debug 로그를 못 찾는다", () => {
  const f = { ...defaultFilter(), level: "error" as const, search: "oom" };
  assert.equal(relaxForSearch(f).level, "debug");
  const dbg = e({ level: "debug", message: "gpu: cudaMalloc failed (oom) — 1476 MiB 요청, 321 MiB free" });
  assert.equal(matches(dbg, f), true, "검색해도 debug 로그가 안 보인다");
  // 검색어가 실제로 메시지에 있는 경우만 매칭 (추측 매칭이 아니다)
  assert.equal(matches(e({ level: "debug", message: "관련 없는 로그" }), f), false);
  // trace 도 필요하다면 편하게 켠다
  assert.equal(relaxForSearch({ ...f, level: "error" }).level, "debug");
});

test("이미 debug 면 더 낮추지 않는다", () => {
  const f = { ...defaultFilter(), level: "debug" as const, search: "x" };
  assert.equal(relaxForSearch(f).level, "debug");
});

test("검색이 없으면 레벨을 **완화하지 않는다**", () => {
  const f = { ...defaultFilter(), level: "error" as const, search: "  " };
  assert.equal(relaxForSearch(f).level, "error");
});

test("검색은 **메시지** 만 본다 — 데이터 객체까지 훑으면 매번 형식화 비용이 든다", () => {
  const f = { ...defaultFilter(), search: "gpu" };
  assert.equal(matches(e({ message: "gpu off", data: { other: "gpu" } }), f), true);
  assert.equal(matches(e({ message: "메시지", data: { other: "gpu" } }), f), false);
  // 대소문자 구분 없음
  assert.equal(matches(e({ message: "GPU OFF" }), f), true);
});

test("소스 필터", () => {
  const f = { ...defaultFilter(), sources: ["llama"] };
  assert.equal(matches(e({ source: "llama" }), f), true);
  assert.equal(matches(e({ source: "server" }), f), false);
});

test("라벨이 **왜 넓어졌는지** 말한다 — 사용자가 의아해하지 않게", () => {
  assert.equal(filterLabel({ ...defaultFilter(), level: "info" }), "정보 이상");
  const searched = filterLabel({ ...defaultFilter(), level: "error", search: "oom" });
  assert.match(searched, /검색 중/);
  assert.match(searched, /디버그 포함/, "완화 이유를 안 말한다");
  // 이미 debug 면 그 사실만
  assert.match(filterLabel({ ...defaultFilter(), level: "debug", search: "oom" }), /검색 중/);
  assert.match(filterLabel({ ...defaultFilter(), sources: ["llama"] }), /llama/);
});

test("긴 줄은 **앞/뒤만** 남기고 생략량을 말한다", () => {
  const long = "가".repeat(MAX_LINE_CHARS * 2);
  const r = clampLine(long);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < MAX_LINE_CHARS * 2, "자르지 않았다");
  assert.ok(r.dropped > 0, "생략량을 세지 않았다");
  assert.match(r.text, /생략/);
  // 짧은 줄은 그대로
  const s = clampLine("짧다");
  assert.equal(s.truncated, false);
  assert.equal(s.text, "짧다");
});

test("예산 계산: 줄/문자 수", () => {
  const b = budgetFor([e({ message: "abcd" }), e({ message: "ab" })]);
  assert.equal(b.lines, 2);
  // 4 + 1(줄바꿈) + 2 + 1(줄바꿈) = 8
  assert.equal(b.chars, 8, "문자 수가 맞지 않는다");
  assert.equal(budgetFor([]).chars, 0);
});

test("화면에는 **최근** N줄 — 오류는 보통 맨 아래에 있다", () => {
  const many = Array.from({ length: 5000 }, (_, i) => e({ seq: i, message: `${i}` }));
  const v = visibleTail(many, 2000);
  assert.equal(v.length, 2000);
  assert.equal(v[v.length - 1].seq, 4999, "마지막 줄이 없다 — 가장 중요한 줄이다");
  assert.equal(v[0].seq, 3000);
  assert.equal(visibleTail(many, 10000).length, 5000);
});

test("`bufferFull` 은 **유실** 을 뜻한다 — 상한 접촉이 아니면 배지가 없다", () => {
  assert.equal(bufferFullLabel({ keptChars: 100, droppedLines: 0, maxChars: DEFAULT_MAX_CHARS, bufferFull: false }), null, "유실이 없는데 경보를 띄웠다");
  const l = bufferFullLabel({ keptChars: 400_000, droppedLines: 1234, maxChars: DEFAULT_MAX_CHARS, bufferFull: true });
  assert.ok(l, "유실을 알리지 않는다");
  assert.match(l!.text, /1,234줄/);
  assert.match(l!.text, /유실/);
  assert.equal(bufferFullLabel(null), null);
});

test("`bufferFull` 이면 **최신 비율** 을 말한다 — 무엇이 남았는지", () => {
  const l = bufferFullLabel({ keptChars: DEFAULT_MAX_CHARS, droppedLines: 1, maxChars: DEFAULT_MAX_CHARS, bufferFull: true });
  assert.match(l!.text, /100% 유지/);
});

test("follow 를 끄면 **안 따라간** 줄 수를 말하고, 따라가면 null", () => {
  assert.equal(pendingIndicator(1000, 1000), null);
  assert.match(pendingIndicator(1000, 900) ?? "", /100줄 새 로그/);
  assert.match(pendingIndicator(1000, 0) ?? "", /1,000줄/);
});

test("상한 상수가 §5.12 값과 일치한다", () => {
  assert.equal(DEFAULT_MAX_CHARS, 500_000);
  assert.equal(MAX_LINES, 50_000);
  assert.equal(MAX_LINE_CHARS, 8 * 1024);
});

test("필터는 **순서를 유지**한다 — 로그 시간순이 깨지면 안 된다", () => {
  const es = [e({ seq: 1, level: "info" }), e({ seq: 2, level: "debug" }), e({ seq: 3, level: "error" })];
  const f = { ...defaultFilter(), search: "메시지" };
  // 검색이 debug 를 포함시키므로 3줄 모두 걸린다 — **순서는 그대로**여야 한다.
  assert.deepEqual(filterEntries(es, f).map((x) => x.seq), [1, 2, 3]);
  // 검색이 없으면 debug 는 빠진다. 이 차이가 §5.12 규칙의 전부다 —
  // "이 단어가 있는 debug 로그가 있는데 안 보인다" 는 불만이 바로 이것이다.
  assert.deepEqual(filterEntries(es, { ...defaultFilter(), level: "info" }).map((x) => x.seq), [1, 3]);
});
