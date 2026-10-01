/**
 * WS 재연결 시 **같은 이벤트가 두 번** 적용되지 않는지 (2026-10-01).
 *
 * 실측 출발점: 사용자가 셸 명령 하나를 보냈는데 **같은 블록이 두 개** 떴다.
 *
 *   ▸ 셸 실행  ls -la /home/jeano/harnessCli   실행 중…
 *   ✓ 셸 실행  ls -la /home/jeano/harnessCli
 *
 * `ls` 가 두 번 실행된 것일 수 있고, **한 번 실행되고 블록만 둘**일 수 있다.
 * 둘을 구분하지 않고 "중복" 이라고 말하면 원인을 고치지 못한다. 그래서 **어느 쪽인지**
 * 먼저 판정한다: 서버가 같은 `seq` 를 **몇 번** 보냈는지를 본다.
 *
 * 원인 구조:
 *   - 클라이언트가 `lastSeq` 를 **기록만 하고** 중복을 걸러내지 않는다.
 *   - `onopen` 에서 `sinceSeq` 를 보내므로, **보내기 전에 이미 도착한** 이벤트는
 *     서버의 `seq > since` 필터를 통과해 다시 온다.
 *   - `appendToBlock` 의 `tool` 은 `streamable` 이 아니라 **항상 새 블록**을 만든다.
 *     그래서 같은 도구 호출이 **무조건 둘로 보인다.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WsClient } from "./wsClient.js";

/** 실제로 쓰는 소켓 모양. 이벤트 하나를 쏴주는 최소한. */
class FakeWs {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  /** 테스트가 서버 흉내를 내린다. */
  emit(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function mk(events: Record<string, unknown>[]) {
  const seen: Record<string, unknown>[] = [];
  const status: string[] = [];
  const c = new WsClient({
    token: "T",
    port: 7317,
    WebSocketImpl: FakeWs as never,
    onEvent: (e) => seen.push(e),
    onStatus: (s) => status.push(s),
  });
  c.connect();
  const ws = c.socket as unknown as FakeWs;
  return { c, ws, seen, status };
}

// ── 1. 같은 seq 가 두 번 오면 **한 번만** 적용되어야 한다 ────────────────────

test("**같은 seq** 가 두 번 도착해도 **한 번만** 적용된다", () => {
  const { ws, seen } = mk([]);
  const ev = { type: "agent.tool", epoch: "E1", seq: 7, text: "셸 실행" };
  ws.emit(ev);
  ws.emit(ev);
  assert.equal(seen.length, 1, `같은 이벤트가 ${seen.length}번 적용됐다 — 블록이 둘로 보인다`);
});

test("**연속된 seq** 는 각각 적용된다 — 중복 필터가 순서를 막으면 안 된다", () => {
  const { ws, seen } = mk([]);
  for (const seq of [1, 2, 3]) ws.emit({ type: "agent.tool", epoch: "E1", seq, text: `n${seq}` });
  assert.equal(seen.length, 3, `3개를 받아야 하는데 ${seen.length}개`);
  assert.deepEqual(seen.map((e) => e.seq), [1, 2, 3]);
});

test("**되감긴 seq** 는 버린다 — 재전송은 무시한다", () => {
  const { ws, seen } = mk([]);
  ws.emit({ type: "agent.tool", epoch: "E1", seq: 5, text: "a" });
  ws.emit({ type: "agent.tool", epoch: "E1", seq: 3, text: "b" });
  ws.emit({ type: "agent.tool", epoch: "E1", seq: 6, text: "c" });
  // **`deepEqual` 이어야 한다.** `assert.equal` 은 **참조 비교**라 배열은 절대 같지 않다고
  // 친다 — 값이 `["a","c"]` 로 맞게 나와도 **항상 실패**한다. 그 실패는 "값이 다름" 이라는
  // 뜻이 아니라 **검사 도구가 잘못**이라는 뜻이다. 그래서 이런 실수를 감추지 않으려고
  // 여기서 한 번 더 확인한다.
  assert.deepEqual(
    seen.map((e) => e.text),
    ["a", "c"],
    `되감긴 이벤트를 적용했다: ${JSON.stringify(seen.map((e) => e.text))}`,
  );
});

test("**seq 가 없는** 이벤트는 버리지 않는다 — 계측·제어 메시지에 seq 가 없을 수 있다", () => {
  const { ws, seen } = mk([]);
  ws.emit({ type: "log", text: "seq 없음" });
  ws.emit({ type: "log", text: "seq 없음 2" });
  assert.equal(seen.length, 2, "seq 없는 이벤트를 통째로 버린다 — 로그가 사라진다");
});

// ── 2. 재연결 시 중복 ───────────────────────────────────────────────────────
//
// 이것이 **실제 증상**이다. 재연결로 같은 이벤트가 다시 오면 블록이 늘어난다.

test("**재연결** 후 같은 seq 를 다시 받아도 **또 적용하지 않는다**", () => {
  const { c, ws, seen } = mk([]);
  ws.emit({ type: "agent.tool", epoch: "E1", seq: 10, text: "셸 실행" });
  const afterFirst = seen.length;
  assert.equal(afterFirst, 1);

  // **끊졌다가** 다시 붙는다 — 서버가 `sinceSeq` 이후를 흘려보낸다.
  ws.onclose?.();
  c.connect();
  const ws2 = c.socket as unknown as FakeWs;
  // 새 연결에서 **같은** 이벤트가 다시 온다(서버는 `seq > since` 로 걸러야 하지만,
  // 클라이언트가 이미 본 것은 **클라이언트가** 걸러야 한다).
  ws2.emit({ type: "agent.tool", epoch: "E1", seq: 10, text: "셸 실행" });

  assert.equal(seen.length, 1, `재연결로 이벤트가 ${seen.length}번 적용됐다 — 화면에 블록이 둘로 보인다`);
});

test("**epoch 가 바뀌면** 다시 받아야 한다 — 서버가 재시작되면 seq 가 0 으로 되돌아간다", () => {
  const { ws, seen } = mk([]);
  ws.emit({ type: "agent.tool", epoch: "E1", seq: 100, text: "a" });
  // **새 인스턴스** — seq 가 1 로 되돌아간다. seq 만 보면 "되감김" 이라 버려지는데,
  // 이건 **새 이벤트** 다. 그래서 epoch 가 다르면 기준을 초기화해야 한다.
  ws.emit({ type: "agent.tool", epoch: "E2", seq: 1, text: "b" });
  assert.equal(seen.length, 2, `epoch 변경 후 이벤트를 버렸다: ${JSON.stringify(seen.map((e) => e.text))}`);
});

test("**같은 seq 라도 epoch 가 다르면** 적용한다 — seq 는 인스턴스 안에서만 유효하다", () => {
  const { ws, seen } = mk([]);
  ws.emit({ type: "agent.tool", epoch: "E1", seq: 5, text: "이전 인스턴스" });
  ws.emit({ type: "agent.tool", epoch: "E2", seq: 5, text: "새 인스턴스" });
  assert.deepEqual(seen.map((e) => e.text), ["이전 인스턴스", "새 인스턴스"], "epoch 가 다른데 seq 같아서 버렸다");
});

// ── 3. 중복 필터가 흐름을 막지 않는지 ───────────────────────────────────────

test("중복 필터는 **이벤트를 지연시키지 않는다** — 순서가 보존된다", () => {
  const { ws, seen } = mk([]);
  const order = ["a", "b", "c", "d"];
  for (const [i, t] of order.entries()) ws.emit({ type: "agent.text", epoch: "E1", seq: i + 1, text: t });
  assert.deepEqual(seen.map((e) => e.text), order, "중복 필터가 순서를 바꾸었다");
});

test("**구현된 필터가 위 규칙을 지키는지** — 실제 코드에 대조한다", () => {
  // 순서만 지키면 중복이 새는 검사가 된다. 그래서 **구현**을 본다:
  // 중복 판정이 `onEvent` 를 호출하기 **전에** 있어야 한다.
  //
  // **소스를 직접 읽는다.** 윈도우만 보면 "되돌아 오면 필터가 있나" 를 확인할 수
  // 없다 — 필터가 없을 수도 있기 때문이다.
  //
  // `require` 를 쓰지 않는다(2026-10-01 실측 2번째): 테스트 모듈에서 `require` 가
  // 없으면 catch 가 조용히 실패하고, **조용한 실패는 통과로 읽힌다.** 정적 import 를 쓴다.
  const src = readFileSync(join(process.cwd(), "src/web/wsClient.ts"), "utf8");
  const callIdx = src.indexOf("this.opts.onEvent(msg)");
  assert.ok(callIdx >= 0, "onEvent 호출을 찾지 못 했다");
  // 되감김 판정은 **반드시** 먼저 와야 한다.
  //
  // `indexOf` 로 찾는다 — `lastIndexOf` 는 `onEvent` **뒤 주석**에 적힌 같은 문자열을
  // 잡아 위치가 뒤로 밀린다(실측). 그래서 **`onEvent` 앞 구간 안에서만** 찾는다.
  const head = src.slice(0, callIdx);
  const guardIdx = head.indexOf("if (msg.seq <= this.lastSeq) return;");
  assert.ok(guardIdx >= 0, "되감김 판정이 없다 — 같은 이벤트가 두 번 적용된다");
  // **되감긴 것만** 버린다 — `seq` 가 없는 이벤트를 버리면 로그가 조용히 사라진다.
  // 타입 가드는 `return` **앞**에 와야 한다: `if (msg.seq <= this.lastSeq) return;` 만
  // 보면 **`null` 이나 `undefined` 도 버린다** — 비교가 거짓이 아니고, 거짓이 아니라
  // **undefined 비교** 다. 그래서 가드가 먼저 존재하는지 본다.
  const typeGuard = head.indexOf('typeof msg.seq === "number"');
  assert.ok(
    typeGuard >= 0 && typeGuard < guardIdx,
    "`typeof msg.seq` 가드가 없다 — seq 가 없는 이벤트까지 버린다",
  );
});
