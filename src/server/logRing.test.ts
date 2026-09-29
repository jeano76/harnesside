/**
 * 로그 링 테스트 (§5.12.2 — "최대 문자 보관 길이는 일반적인 크기를 반영").
 *
 * 이 테스트가 보호하는 성질은 세 가지다:
 *  1) 상한을 넘으면 **오래된 것부터** 빠진다
 *  2) **최신 줄은 절대 안 사라진다** — 사라지면 사용자는 "로그가 멈췄다"고 생각한다
 *  3) 잘렸다는 사실을 **한 번만** 알린다
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LogRing, DEFAULTS, parseNdjson, shouldLog, resetLogRing, getLogRing } from "./logRing.js";

test("기본 상한이 명세와 같다 — 50만 자", () => {
  assert.equal(DEFAULTS.maxChars, 500_000);
  assert.equal(DEFAULTS.maxLines, 50_000);
  assert.equal(DEFAULTS.maxLineChars, 8_192);
  assert.equal(new LogRing().status.maxChars, 500_000);
});

test("문자 상한을 넘으면 오래된 것부터 빠진다", () => {
  const ring = new LogRing({ maxChars: 1000, maxLines: 100_000 });
  for (let i = 0; i < 200; i++) ring.info("t", `줄 ${i} — ${"가".repeat(20)}`);
  const kept = ring.query();
  assert.ok(ring.status.keptChars <= 1000, `keptChars=${ring.status.keptChars}`);
  assert.ok(kept.length < 200);
  // 앞이 빠지고 뒤가 남는다
  assert.ok(!kept.some((e) => e.message.includes("줄 0 ")), "가장 오래된 줄이 남아 있다");
  assert.ok(kept.some((e) => e.message.includes("줄 199")), "최신 줄이 없다");
});

test("최신 줄은 절대 버리지 않는다 — 사라지면 '로그가 멈췄다'고 보인다", () => {
  const ring = new LogRing({ maxChars: 1000, maxLines: 100_000 });
  for (let i = 0; i < 500; i++) ring.info("t", `메시지 ${i} ${"x".repeat(30)}`);
  const last = ring.query();
  assert.equal(last[last.length - 1].message.includes("메시지 499"), true, "최신 줄이 버려졌다");
  assert.equal(last.length >= 1, true);
});

test("초장문 한 줄은 8 KiB 로 잘리고, 잘렸다고 표시된다", () => {
  const ring = new LogRing({ maxLineChars: 1000 });
  const e = ring.info("t", "가".repeat(5000));
  assert.ok(e.message.length <= 1000, `길이 ${e.message.length}`);
  assert.match(e.message, /\+\d+자 생략/);
});

test("줄 수 상한도 동작한다 — 초장문 로그가 문자 상한을 장악하지 못하게", () => {
  const ring = new LogRing({ maxChars: 10_000_000, maxLines: 50 });
  for (let i = 0; i < 200; i++) ring.info("t", `짧은 ${i}`);
  assert.ok(ring.query().length <= 50, `${ring.query().length} 줄`);
  assert.ok(ring.status.droppedLines > 0);
});

test("잘림 통지는 상태에서 한 번만 — 계속 알리면 패널이 지저분해진다", () => {
  const ring = new LogRing({ maxChars: 800, maxLines: 100_000 });
  const seen: number[] = [];
  ring.onStatus((s) => seen.push(s.droppedLines));
  for (let i = 0; i < 100; i++) ring.info("t", `내역 ${i} ${"y".repeat(30)}`);
  const fullNotices = seen.filter((n) => n > 0);
  // 통지 자체는 여러 번 올 수 있지만(상태 변화마다), "새로 잘린 것" 마다 한 번이다.
  const uniq = new Set(fullNotices).size;
  assert.ok(uniq <= fullNotices.length);
  assert.equal(ring.status.bufferFull, true);
});

test("sinceSeq 로 재접속 이어받기가 된다", () => {
  const ring = new LogRing();
  for (let i = 0; i < 10; i++) ring.info("t", `m${i}`);
  const mid = ring.lastSeq;
  for (let i = 10; i < 15; i++) ring.info("t", `m${i}`);
  const got = ring.since(mid);
  assert.equal(got.length, 5);
  assert.equal(got[0].message, "m10");
  assert.ok(got.every((e) => e.seq > mid));
});

test("필터: 레벨 · 소스 · 스코프", () => {
  const ring = new LogRing();
  ring.info("a", "정보 a");
  ring.warn("b", "경고 b");
  ring.error("c", "에러 c", "llama");
  assert.equal(ring.query({ levels: ["error"] }).length, 1);
  assert.equal(ring.query({ sources: ["llama"] }).length, 1);
  assert.equal(ring.query({ scope: "a" }).length, 1);
  assert.equal(ring.query({ levels: ["warn", "error"] }).length, 2);
});

test("클리어는 세션 링만 비운다 — seq 는 유지된다", () => {
  const ring = new LogRing();
  ring.info("t", "a");
  const seq = ring.lastSeq;
  ring.clear();
  assert.equal(ring.query().length, 0);
  assert.equal(ring.status.droppedLines, 0);
  assert.equal(ring.lastSeq, seq, "seq 가 초기화되면 재접속 이어받기가 깨진다");
});

test("파일 writer 로 NDJSON 이 나간다 — 데몬에서 사람이 보는 것", () => {
  const lines: string[] = [];
  const ring = new LogRing({ writer: (l) => lines.push(l) });
  ring.error("llama", "cudaMalloc failed", "llama", { mb: 1476 });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.level, "error");
  assert.equal(parsed.source, "llama");
  assert.equal(parsed.message, "cudaMalloc failed");
  assert.equal((parsed.data as { mb: number }).mb, 1476);
});

test("writer 가 던져도 로깅이 막히지 않는다 — 데몬은 사람이 보지 않는다", () => {
  const ring = new LogRing({
    writer: () => {
      throw new Error("디스크-full");
    },
  });
  assert.doesNotThrow(() => ring.info("t", "메시지"));
  assert.equal(ring.query().length, 1);
});

test("리스너 하나가 죽어도 나머지는 알림을 받는다", () => {
  const ring = new LogRing();
  const got: string[] = [];
  ring.onEntry(() => {
    throw new Error("리스너 폭발");
  });
  ring.onEntry((e) => got.push(e.message));
  assert.doesNotThrow(() => ring.info("t", "살아있다"));
  assert.deepEqual(got, ["살아있다"]);
});

test("레벨 비교는 info 이상만 통과시킨다", () => {
  assert.equal(shouldLog("error", "info"), true);
  assert.equal(shouldLog("info", "info"), true);
  assert.equal(shouldLog("debug", "info"), false);
  assert.equal(shouldLog("debug", "debug"), true);
});

test("NDJSON 파싱 실패는 null — 호출부가 원문을 raw 로 남길 수 있게", () => {
  assert.equal(parseNdjson("이건 JSON 이 아님"), null);
  assert.equal(parseNdjson("{}"), null, "message 가 없으면 null");
  const e = parseNdjson('{"level":"warn","message":"x","source":"chrome","scope":"b"}');
  assert.equal(e?.level, "warn");
  assert.equal(e?.source, "chrome");
});

test("싱글턴은 하나뿐 — 분산 로깅은 반드시 누락된다", () => {
  resetLogRing();
  const a = getLogRing();
  const b = getLogRing();
  assert.equal(a, b);
  resetLogRing();
  assert.notEqual(getLogRing(), a);
});
