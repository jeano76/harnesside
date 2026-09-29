/**
 * 블록 저장소 테스트 (§5.6 · §10.2 "웹 순수 로직" 행).
 *
 * 성능 관련 규칙을 검증한다: 정렬(시작 순서), 버전(바뀔 때만), 상한(완료된 것부터).
 * 이 셋이 깨지면 화면이 "위치가 튀고, 매 토큰 리렌더되고, 결국 멈춘다" 가 된다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BlockStore, StreamBuffer, clampOutput, summarizeBlock } from "./blocks.js";

test("블록은 **시작 순서**로 정렬된다 — 도구가 늦게 끝나도 위치가 튀지 않는다", () => {
  const s = new BlockStore();
  const a = s.create({ kind: "tool", title: "A" });
  const b = s.create({ kind: "tool", title: "B" });
  const c = s.create({ kind: "tool", title: "C" });
  // C 가 먼저 끝나도
  s.finish(c.id);
  s.finish(a.id);
  assert.deepEqual(s.list().map((x) => x.id), [a.id, b.id, c.id], "완료 순서로 재배열됐다");
});

test("버전은 **실제로 바뀔 때만** 올라간다 — 매 토큰 리렌더를 막는다", () => {
  const s = new BlockStore();
  const b = s.create({ kind: "text", title: "답변" });
  const v0 = b.version;
  const r1 = s.apply(b.id, { type: "appendText", text: "가" });
  assert.equal(r1.changed, true);
  assert.equal(r1.block!.version, v0 + 1);
  // 같은 상태로 다시 설정하면 changed=false 여야 한다(불필요한 렌더 방지)
  s.apply(b.id, { type: "setStatus", status: "running" });
  const r2 = s.apply(b.id, { type: "setStatus", status: "running" });
  assert.equal(r2.changed, false, "같은 상태를 다시 넣었는데 변경으로 보고됐다");
});

test("스트리밍 중 텍스트는 누적된다", () => {
  const s = new BlockStore();
  const b = s.create({ kind: "text", title: "t" });
  s.apply(b.id, { type: "appendText", text: "가" });
  s.apply(b.id, { type: "appendText", text: "나" });
  const got = s.get(b.id)!;
  assert.equal((got.content as { text: string }).text, "가나");
});

test("없는 블록에 패치를 넣어도 예외가 아니다 — 늦은 이벤트를 버려야 한다", () => {
  const s = new BlockStore();
  const r = s.apply("없는-ID", { type: "appendText", text: "x" });
  assert.equal(r.changed, false);
  assert.equal(r.block, undefined);
});

test("상한을 넘으면 **완료된 블록부터** 버린다 — 진행 중인 것은 절대 버리지 않는다", () => {
  const s = new BlockStore({ maxBlocks: 5 });
  const running = Array.from({ length: 10 }, () => s.create({ kind: "tool", title: "진행 중" }));
  // 전부 진행 중인데 상한을 넘겼다 → 아무것도 버리지 않는다(데이터 손실이 나쁘다)
  assert.equal(s.size, 10, "진행 중인 블록이 버려졌다");
  for (const b of running) s.finish(b.id);
  // 이제 완료된 것만 있으므로 오래된 것부터 버려야 한다
  assert.ok(s.size <= 5, `${s.size} 개 남았다`);
});

test("접힘 상태는 블록마다 독립이다", () => {
  const s = new BlockStore();
  const a = s.create({ kind: "text", title: "A" });
  const b = s.create({ kind: "text", title: "B" });
  s.setCollapsed(a.id, true);
  assert.equal(s.get(a.id)!.collapsed, true);
  assert.equal(s.get(b.id)!.collapsed, false);
});

test("running() 은 진행 중인 것만 — 턴 중단 시 이것들에 abort 를 찍는다", () => {
  const s = new BlockStore();
  const a = s.create({ kind: "tool", title: "A" });
  s.create({ kind: "tool", title: "B" });
  s.finish(a.id);
  const r = s.running();
  assert.equal(r.length, 1);
  assert.equal(r[0].title, "B");
});

test("접힘 요약 라벨이 규칙을 따른다 (§5.1)", () => {
  assert.match(summarizeBlock({ kind: "reasoning", title: "x", content: { text: "가".repeat(1240) } }), /사고 과정 · 1,240자/);
  assert.match(summarizeBlock({ kind: "tool", title: "read_file", content: { text: "a".repeat(1204) } }), /read_file · 1,204자/);
  assert.equal(summarizeBlock({ kind: "plan", title: "계획", content: {} }), "계획");
});

test("스트리밍 버퍼는 50ms 에 한 번만 커밋한다", async () => {
  const flushed: number[] = [];
  const buf = new StreamBuffer((items) => flushed.push(items.length), { intervalMs: 20 });
  for (let i = 0; i < 100; i++) buf.push("b", "x");
  assert.equal(flushed.length, 0, "버퍼링 없이 즉시 보냈다");
  assert.equal(buf.pendingCount, 100);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(flushed.length, 1, `${flushed.length} 번 커밋했다`);
  assert.equal(flushed[0], 100, "일부만 커밋됐다");
});

test("스트리밍 버퍼 dispose 는 대기 중인 타이머를 없앤다 — 프로세스가 안 끝나면 안 된다", async () => {
  const buf = new StreamBuffer(() => {}, { intervalMs: 20 });
  buf.push("b", "x");
  buf.dispose();
  assert.equal(buf.pendingCount, 0);
});

test("대용량 출력은 앞/뒤만 남기고 생략량을 알린다", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `줄 ${i}`).join("\n");
  const r = clampOutput(text, 1000, 100);
  const lines = r.text.split("\n");
  assert.ok(lines.length < 1100, `줄 수가 줄지 않았다: ${lines.length}`);
  assert.ok(r.omitted > 3900, "생략량을 세지 않았다");
  assert.match(r.text, /줄 생략/);
  assert.ok(r.text.includes("줄 0"), "앞부분이 사라졌다");
  assert.ok(r.text.includes("줄 4999"), "끝부분이 사라졌다");
});

test("상한 이하면 아무것도 자르지 않는다", () => {
  const text = "가\n나\n다";
  const r = clampOutput(text, 10, 2);
  assert.equal(r.text, text);
  assert.equal(r.omitted, 0);
});
