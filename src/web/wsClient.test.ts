/**
 * WsClient 테스트 (§2.3 · §5.10).
 *
 * 창이 흔들려도 화면이 흔들리면 안 된다 — 그래서 재접속·이어받기·epoch 처리를
 * 브라우저 없이 가짜 소켓으로 검증한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { WsClient } from "./wsClient.js";

/** 브라우저 WebSocket 을 흉내내는 최소 소켓. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: string) {
    this.onmessage?.({ data });
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  drop() {
    // 네트워크 단절: onclose 없이 사라지는 경우
    this.readyState = 3;
  }
}

/** 재연결은 백오프 타이머로 이뤄지므로 기다려야 한다(500ms 가 첫 간격). */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  FakeSocket.instances = [];
  const events: Record<string, unknown>[] = [];
  const status: string[] = [];
  const c = new WsClient({
    port: 7317,
    token: "T",
    onEvent: (e) => events.push(e),
    onStatus: (s) => status.push(s),
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  return { c, events, status, sockets: FakeSocket.instances };
}

test("연결하고 열리면 상태가 connecting → open", () => {
  const { c, status, sockets } = setup();
  c.connect();
  assert.equal(status[0], "connecting");
  sockets[0].open();
  assert.equal(status[1], "open");
  c.close();
});

test("URL 에 토큰이 실린다 — WS 는 헤더를 못 넣으므로 쿼리만 방법이다", () => {
  const { c, sockets } = setup();
  c.connect();
  assert.ok(sockets[0].url.startsWith("ws://127.0.0.1:7317/ws"), sockets[0].url);
  assert.ok(sockets[0].url.includes("t=T"));
  c.close();
});

test("seq 를 기억하고, 재연결 때 sinceSeq 로 이어받기를 요청한다", async () => {
  const { c, sockets, events } = setup();
  c.connect();
  sockets[0].open();
  sockets[0].emit(JSON.stringify({ type: "log.append", epoch: "E1", seq: 5, message: "a" }));
  sockets[0].emit(JSON.stringify({ type: "log.append", epoch: "E1", seq: 9, message: "b" }));
  assert.equal(events.length, 2);

  // 끊김 → 자동 재연결 (백오프 500ms 대기)
  sockets[0].close();
  await wait(700);
  const second = sockets[1];
  assert.ok(second, "재연결하지 않았다");
  second.open();
  const req = second.sent.map((s) => JSON.parse(s) as { type: string; since: number });
  assert.ok(req.some((m) => m.type === "sinceSeq" && m.since === 9), `이어받기 요청이 없다: ${JSON.stringify(req)}`);
  c.close();
});

/**
 * **설계를 뒤집었다** (2026-10-01).
 *
 * 예전엔 이렇게 고정해 뒀다: "역순·중복 seq 는 무시해도 이벤트는 전달된다 —
 * **필터는 서버 몫**." 그때는 맞았다. 서버(`wsHub`)가 `seq > since` 로 걸러준다고
 * 생각했다.
 *
 * **실측이 그 설계를 틀렸다고 증명했다.** 사용자가 셸 명령 하나를 보냈는데 **같은
 * 블록이 두 개** 떴다. 서버 필터는 `sinceSeq` 를 **보낸 뒤**의 재생에만 걸린다 —
 * 재연결 중 **이미 도착한** 이벤트는 다시 흘러온다. 그리고 `appendToBlock` 의 `tool`
 * 은 항상 새 블록을 만들기 때문에 두 번 적용되면 **명령이 두 개로 보인다.**
 *
 * 그래서 필터를 **클라이언트로 옮겼다.** 여기서 버리는 것이 화면의 중복을 막는다.
 * `wsClient.dedupe.test.ts` 가 그 규칙(되감김·epoch·순서·seq 없는 이벤트)을 고정한다.
 */
test("**되감긴 seq** 는 버린다 — 재연결로 같은 이벤트가 또 오면 화면에 블록이 둘로 보인다", () => {
  const { c, sockets, events } = setup();
  c.connect();
  sockets[0].open();
  sockets[0].emit(JSON.stringify({ type: "log.append", epoch: "E1", seq: 10, message: "1" }));
  sockets[0].emit(JSON.stringify({ type: "log.append", epoch: "E1", seq: 3, message: "2" })); // 과거
  assert.deepEqual(
    events.map((e) => (e as { message?: string }).message),
    ["1"],
    "되감긴 이벤트를 적용했다 — 같은 내용이 화면에 두 번 쌓인다",
  );
  c.close();
});

test("**순서가 앞선 seq** 는 **각각** 전달된다 — 필터가 흐름을 막으면 안 된다", () => {
  const { c, sockets, events } = setup();
  c.connect();
  sockets[0].open();
  for (const seq of [1, 2, 3]) {
    sockets[0].emit(JSON.stringify({ type: "log.append", epoch: "E1", seq, message: `n${seq}` }));
  }
  assert.deepEqual(
    events.map((e) => (e as { message?: string }).message),
    ["n1", "n2", "n3"],
    "새 이벤트를 버렸다 — 로그가 조용히 사라진다",
  );
  c.close();
});

test("인스턴스가 바뀌면 seq 를 리셋한다 — 이전 프로세스 seq 와 섞으면 안 된다", async () => {
  const { c, sockets } = setup();
  c.connect();
  sockets[0].open();
  sockets[0].emit(JSON.stringify({ type: "log.append", epoch: "E1", seq: 42, message: "a" }));
  sockets[0].close();
  await wait(700);
  sockets[1].open();
  // 새 인스턴스 = 새 epoch. seq 가 작은 값으로 돌아온다.
  sockets[1].emit(JSON.stringify({ type: "hello", epoch: "E2", seq: 1 }));

  sockets[1].close();
  await wait(1400); // 두 번째 백오프(1000ms)
  sockets[2].open();
  const req = sockets[2].sent.map((s) => JSON.parse(s) as { type: string; since: number });
  const since = req.find((m) => m.type === "sinceSeq");
  // E2 의 seq 1 이 latest 여야 한다 (E1 의 42 를 그대로 보내면 새 인스턴스가 튕긴다)
  assert.ok(since, "이어받기 요청이 없다");
  assert.ok(since!.since <= 2, `이전 인스턴스 seq(${since!.since}) 를 재사용했다`);
  c.close();
});

test("지수 백오프 — 창을 열었다 닫았다 반복해도 돌지 않는다", async () => {
  const { c, sockets } = setup();
  c.connect();
  sockets[0].open();
  // 1초 안에 확인했을 때 연결 시도가 3개도 안 되어야 한다(첫 간격 500ms, 두 번째 1000ms).
  sockets[0].close();
  await wait(50);
  sockets[1]?.close();
  assert.ok(sockets.length <= 2, `${sockets.length} 번이나 즉시 재시도했다 — 백오프가 없다`);
  c.close();
});

test("close() 후에는 재연결하지 않는다 — 의도적으로 떠난 것", () => {
  const { c, sockets } = setup();
  c.connect();
  sockets[0].open();
  c.close();
  const before = sockets.length;
  sockets[0].drop();
  assert.equal(sockets.length, before, "닫은 뒤에도 다시 붙었다");
});

test("파싱 불가능한 메시지는 조용히 무시 — 연결은 산다", () => {
  const { c, sockets, events } = setup();
  c.connect();
  sockets[0].open();
  sockets[0].emit("이건 JSON 아님");
  sockets[0].emit(JSON.stringify({ type: "log.append", epoch: "E1", seq: 1, message: "살아있음" }));
  assert.equal(events.length, 1);
  c.close();
});

test("send 는 연결 안 됐으면 조용히 버린다 — 예외가 화면을 깨면 안 된다", () => {
  const { c } = setup();
  assert.doesNotThrow(() => c.send({ type: "ping" }));
});
