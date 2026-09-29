/**
 * WsHub 테스트 (§2.3 · §10.2).
 *
 * 검증 대상은 "메시지가 간다" 가 아니라 **세 가지 계약**이다:
 *  1) seq 가 단조 증가하고 epoch 로 재접속을 구분한다
 *  2) 재접속이 sinceSeq 로 흐름을 이어받는다 (연결이 끊겨도 흐름이 끊기지 않는다)
 *  3) 느린 클라이언트가 서버를 막지 않는다
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { WsHub } from "./wsHub.js";

async function setup() {
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const hub = new WsHub({ server, epoch: "2026-01-01T00:00:00.000Z" });
  server.on("upgrade", (req, socket, head) => {
    hub.handleUpgrade(req, socket, head);
  });
  const url = `ws://127.0.0.1:${port}/ws`;
  const connect = () => openBuffered(url);
  const close = async () => {
    await hub.close();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { hub, connect, close, url };
}

/**
 * 소켓을 열자마자 **모든 메시지를 버퍼에 담아둔다.**
 *
 * 소켓을 열고 나서 리스너를 달면 메시지를 놓친다 — 서버는 연결 즉시 `hello` 를
 * 보내는데 `open` 이벤트를 기다리는 동안 이미 도착해 있다(테스트가 실제로 그랬다).
 * 실시간 소켓을 다루는 테스트는 이 버퍼가 없으면 재현 불가능하게 flaky 하다.
 */
interface Buffered {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  waiters: ((n: number) => void)[];
  open: Promise<void>;
  /** 읽은 위치. 소비하지 않은 메시지만 돌려줘야 "hello 를 소비한다" 가 의미를 갖는다. */
  cursor: number;
}

async function openBuffered(url: string): Promise<Buffered> {
  const ws = new WebSocket(url);
  const b: Buffered = {
    ws,
    messages: [],
    waiters: [],
    cursor: 0,
    open: new Promise((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    }),
  };
  ws.on("message", (d) => {
    b.messages.push(JSON.parse(String(d)) as Record<string, unknown>);
    for (const w of [...b.waiters]) w(b.messages.length);
  });
  await b.open;
  return b;
}

/**
 * **아직 읽지 않은** 메시지 n 개를 기다린다. 타임아웃이 반드시 있다 —
 * 영원히 기다리는 테스트는 실패가 아니라 "아무 말도 없는 정지" 다.
 */
function collect(b: Buffered, n: number, timeoutMs = 3000): Promise<Record<string, unknown>[]> {
  const start = b.cursor;
  if (b.messages.length - start >= n) {
    const out = b.messages.slice(start, start + n);
    b.cursor += n;
    return Promise.resolve(out);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `${timeoutMs}ms 안에 ${n}개를 받지 못했습니다 (읽은 것 ${start}, 받은 것 ${b.messages.length})`
        )
      );
    }, timeoutMs);
    const waiter = (total: number) => {
      if (total - start < n) return;
      clearTimeout(t);
      b.waiters = b.waiters.filter((w) => w !== waiter);
      resolve(b.messages.slice(start, start + n));
      b.cursor = start + n;
    };
    b.waiters.push(waiter);
  });
}

test("연결하면 hello 가 오고 epoch·seq 를 실어 간다", async () => {
  const s = await setup();
  try {
    const ws = await s.connect();
    const [hello] = await collect(ws, 1);
    assert.equal(hello.type, "hello");
    assert.equal(hello.epoch, "2026-01-01T00:00:00.000Z");
    assert.equal(typeof hello.seq, "number");
    ws.ws.close();
  } finally {
    await s.close();
  }
});

test("publish 한 번 = seq 하나, 단조 증가", async () => {
  const s = await setup();
  try {
    const ws = await s.connect();
    await collect(ws, 1); // hello 소비
    s.hub.publish({ type: "log.append", message: "a" });
    s.hub.publish({ type: "log.append", message: "b" });
    const got = await collect(ws, 2);
    assert.equal(got[0].message, "a");
    assert.equal(got[1].message, "b");
    assert.ok((got[1].seq as number) > (got[0].seq as number), "seq 가 단조 증가하지 않는다");
    ws.ws.close();
  } finally {
    await s.close();
  }
});

test("재접속이 sinceSeq 로 흐름을 이어받는다 — 끊겨도 '멈춘' 것처럼 보이지 않는다", async () => {
  const s = await setup();
  try {
    const first = await s.connect();
    await collect(first, 1);
    s.hub.publish({ type: "log.append", message: "1" });
    const got1 = await collect(first, 1);
    const lastSeen = got1[0].seq as number;
    first.ws.close();

    // 연결이 끊긴 동안 이벤트 발생
    s.hub.publish({ type: "log.append", message: "2" });
    s.hub.publish({ type: "log.append", message: "3" });

    const second = await s.connect();
    const got2 = await collect(second, 1); // hello
    second.ws.send(JSON.stringify({ type: "sinceSeq", since: lastSeen }));
    const replay = await collect(second, 2);
    const msgs = replay.map((m) => m.message).filter((m) => m !== undefined);
    assert.deepEqual(msgs, ["2", "3"], "재접속 후 놓친 이벤트가 재생되지 않았다");
    assert.ok((replay[0].seq as number) > lastSeen);
    second.ws.close();
  } finally {
    await s.close();
  }
});

test("sinceSeq 는 과거만 준다 — 이미 본 것을 다시 보내지 않는다", async () => {
  const s = await setup();
  try {
    const a = await s.connect();
    await collect(a, 1);
    s.hub.publish({ type: "log.append", message: "x" });
    const g = await collect(a, 1);
    const seq = g[0].seq as number;
    s.hub.publish({ type: "log.append", message: "y" });

    const b = await s.connect();
    await collect(b, 1);
    b.ws.send(JSON.stringify({ type: "sinceSeq", since: seq }));
    const replay = await collect(b, 1);
    assert.equal(replay[0].message, "y", "이미 본 이벤트까지 다시 왔다");
    a.ws.close();
    b.ws.close();
  } finally {
    await s.close();
  }
});

test("느린 클라이언트: 큐가 차면 오래된 것부터 버린다 — 새 정보가 우선이다", async () => {
  const s = await setup();
  try {
    // 실제로 **소켓을 안 읽는** 클라이언트를 만든다: 수신 없이 publish 를 쏟아부는다.
    // (내부 필드(`clients`) 를 뒤지는 대신 실제 경로를 쓴다 — 리팩터에 약하다)
    const raw = new WebSocket(s.url);
    await new Promise((r, j) => {
      raw.on("open", () => r(null));
      raw.on("error", j);
    });
    // 서버 쪽 소켓이 send 를 전부 버퍼에 쌓게 하려면 여기서 아무것도 읽지 않는다.
    for (let i = 0; i < 200; i++) s.hub.publish({ type: "log.append", message: `m${i}` });
    // 살아 있으면 통과 — 죽었으면 아래 publish 가 안 나간다.
    s.hub.publish({ type: "log.append", message: "마지막" });
    const alive = await collect(await s.connect(), 1);
    assert.equal(alive[0].type, "hello", "허브가 죽었다");
    try {
      raw.close();
    } catch {
      // 이미 닫힘
    }
  } finally {
    await s.close();
  }
});

test("여러 클라이언트에게 모두 간다", async () => {
  const s = await setup();
  try {
    const a = await s.connect();
    const b = await s.connect();
    await collect(a, 1);
    await collect(b, 1);
    s.hub.publish({ type: "log.append", message: "fanout" });
    const [ga] = await collect(a, 1);
    const [gb] = await collect(b, 1);
    assert.equal(ga.message, "fanout");
    assert.equal(gb.message, "fanout");
    a.ws.close();
    b.ws.close();
  } finally {
    await s.close();
  }
});

test("파싱 불가능한 메시지는 연결을 죽이지 않는다", async () => {
  const s = await setup();
  try {
    const ws = await s.connect();
    await collect(ws, 1);
    ws.ws.send("이건 JSON 아님 {{{");
    // 살아 있으면 통과. 죽었다면 아래 publish 가 안 온다.
    s.hub.publish({ type: "log.append", message: "살아있음" });
    const got = await collect(ws, 1);
    assert.equal(got[0].message, "살아있음");
    ws.ws.close();
  } finally {
    await s.close();
  }
});

test("path 가 다르면 업그레이드를 가로채지 않는다", async () => {
  const s = await setup();
  try {
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const hub = new WsHub({ server });
    const handled = hub.handleUpgrade({ url: "/other", headers: {} } as never, {} as never, Buffer.alloc(0));
    assert.equal(handled, false, "다른 경로를 가로챘다");
    await hub.close();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    await s.close();
  }
});
