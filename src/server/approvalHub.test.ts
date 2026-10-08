/**
 * `bindApprovalEvents` 헬퍼가 게이트를 허브(ring/hub)에 어떻게 배선하는지 고정한
 * 유닛 테스트 (§5 todo · S-6).
 *
 * 헬퍼는 원래 `index.ts` 에 인라인으로 붙어 있던 glue 를 빼낸 것이다. 동작은 그대로
 * 두되, "게이트가 루프에 배선되어 지나는 것"을 유닛으로 고정하고 싶다 — 그 배선은
 * `index.ts` 에 숨 있어서 브라우저 없이 검사가 닿지 않았다. 헬퍼의 결착이 없거나
 * 바뀌면 `approval.request`(요청)와 `approval.done`(결정)을 허브로 보내는 경로가
 * 조용히 사라질 수 있다(실제 창 없이도 통과/거절 결과를 볼 수 있다).
 *
 * WsHub과 LogRing은 fake로 채워 실제 WS 소켓/로그 파일이 필요 없다. 헬퍼가 부르는
 * 시그니처만 맞으면 된다(`WsHub.publish(ev: ServerEvent)`, `LogRing.info/warn`).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApprovalGate } from "./approval.js";
import type { LogRing } from "./logRing.js";
import type { WsHub } from "./wsHub.js";
import { bindApprovalEvents, type ApprovalGateBindings } from "./approvalHub.js";

/** fake WsHub — publish된 이벤트를 담는다. real은 `publish(ev: ServerEvent)`. */
function fakeHub() {
  const events: unknown[] = [];
  return { events, publish(ev: unknown) { events.push(ev); } };
}

/** fake LogRing — info/warn으로 쌓는 메시지를 담는다. real은 `(scope, message, source?, data?)`. */
function fakeRing() {
  const logs: { scope: string; message: string; source: string }[] = [];
  return {
    logs,
    info(scope: string, message: string, source: string) { logs.push({ scope, message, source }); },
    warn(scope: string, message: string, source: string) { logs.push({ scope, message, source }); },
  };
}

/** pending 항목 id를 하나 얻는다 — 게이트 promise.resolve 시그니처는 public이 아니다. */
function pendingId(gate: ApprovalGate): string {
  return [...(gate as any)["waiting"].keys()][0] as string;
}

test("onRequest 는 approval.request 를 허브에 보낸다 — 순서·모양 고정", () => {
  const hub = fakeHub();
  const ring = fakeRing();
  // 배선은 한 번만. 헬퍼가 없으면 이 경로는 유닛이 못 잡는다(S-6).
  const gate = new ApprovalGate({}, bindApprovalEvents(hub as unknown as WsHub, ring as unknown as LogRing));

  // request() 는 Promise executor 안에서 synchronously onRequest 를 발화한다.
  const pSend = gate.request({ tool: "write_file", summary: "make file" });

  assert.equal(hub.events.length, 1, `onRequest 가 approval.request 를 보내지 않았다. 실제: ${JSON.stringify(hub.events)}`);
  const ev = hub.events[0] as any;
  assert.equal(ev.type, "approval.request");
  assert.equal(ev.request.tool, "write_file");
  assert.equal(ev.request.summary, "make file");

  assert.equal(ring.logs.length, 1, `onRequest 가 ring.warn 을 못 불렀다`);
  assert.equal(ring.logs[0].scope, "approval");
  assert.match(ring.logs[0].message, /승인 대기/);

  // 미해결 promise + unref 하지 않는 60초 타이머가 루프를 붙잡지 못하게 정리.
  gate.rejectAll(); // settle → clearTimeout + resolve → process 가 빠르게 끝난다.
});

test("approve 시 onDecision 은 approval.done 를 허브 + ring.info 로 보낸다", () => {
  const hub = fakeHub();
  const ring = fakeRing();
  const gate = new ApprovalGate({}, bindApprovalEvents(hub as unknown as WsHub, ring as unknown as LogRing));

  const pSend = gate.request({ tool: "write_file", summary: "make file" }); // onRequest 발화
  assert.equal(hub.events.length, 1, "request 가 approval.request 를 보내지 않았다");

  gate.decide(pendingId(gate), "allow-once", "user"); // onDecision 발화 (synchronously)

  assert.equal(hub.events.length, 2, `onDecision 이 approval.done 를 보내지 않았다. 실제: ${JSON.stringify(hub.events.map((e: any) => e.type))}`);
  const done = hub.events[1] as any;
  assert.equal(done.type, "approval.done");
  assert.equal(done.tool, "write_file");
  assert.equal(done.decision, "allow-once");
  assert.equal(done.by, "user");

  // ring.info 에는 거절도 포함해 남는다 — 승인만 기록하면 "아무도 안 쓰는 도구"를 모른다.
  const infoMsg = ring.logs.find((l) => l.scope === "approval" && l.message.includes("승인 결정"));
  assert.ok(infoMsg, `승인 결정 ring.info 가 없다. 실제: ${JSON.stringify(ring.logs.map((l) => l.message))}`);
  assert.match(infoMsg!.message, /write_file → allow-once \(user\)/);

  void pSend; // settle 이 resolve — 미해결 확인 방지.
});

test("rejectAll 시 onDecision 은 approval.done 를 거절 모양으로 보낸다", () => {
  const hub = fakeHub();
  const ring = fakeRing();
  const gate = new ApprovalGate({}, bindApprovalEvents(hub as unknown as WsHub, ring as unknown as LogRing));

  const pSend = gate.request({ tool: "delete_file", summary: "rm" }); // onRequest 발화
  assert.equal(hub.events.length, 1, "request 가 approval.request 를 보내지 않았다");

  gate.rejectAll("창이 닫혀 승인 불가능"); // onDecision (all reject, synchronously)

  const done = hub.events[1] as any;
  assert.ok(done && done.type === "approval.done", `reject_all 가 approval.done 를 보내지 않았다. 실제: ${JSON.stringify(hub.events.map((e: any) => e.type))}`);
  assert.equal(done.decision, "reject");

  const info = ring.logs.filter((l) => l.message.includes("승인 결정"));
  assert.ok(info.length >= 1, `거절 ring.info 가 없다. 실제: ${JSON.stringify(ring.logs.map((l) => l.message))}`);

  void pSend; // rejectAll 이 resolve — 미해결 확인 방지.
});
