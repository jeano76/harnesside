/**
 * 세션 영속화 테스트 (§5.10).
 *
 * 검증의 중심은 **"스트리밍 중 화면이 통째로 바뀌지 않는다"** 다. 이건 회귀하면
 * 사용자가 보던 도구 블록이 사라졌다가 다시 쌓이는 형태로 나타난다 — 눈에 잘 띄지만
 * 원인이 "WS 재연결" 이라고 아무도 모른다. 그래서 `replaceScreen` 을 직접 검증한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, planRestore, hydrateBlocks, clampBlock, sessionId, INLINE_BLOCK_LIMIT, COMPRESS_THRESHOLD, type SessionDoc } from "./store.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-sess-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function doc(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    id: "s-20260101-000000-abc123",
    workspace: "/home/u/proj",
    name: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [{ role: "user", text: "안녕", at: 1_500 }],
    blocks: [
      { id: "b1", kind: "text", title: "답변", status: "ok", version: 7, createdAt: 1_600, updatedAt: 1_700, collapsed: false, content: { text: "내용" } },
      { id: "b2", kind: "tool", title: "read_file", status: "ok", version: 2, createdAt: 1_610, updatedAt: 1_620, collapsed: true, content: null },
    ],
    plan: null,
    compactions: [],
    abortedTurn: null,
    spilled: [],
    bytes: 500,
    version: 1,
    ...over,
  };
}

test("저장 → 읽기 왕복이 보존된다", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    await store.write(doc());
    const got = await store.read(doc().id);
    assert.ok(got, "세션이 안 읽힌다");
    assert.equal(got!.messages.length, 1);
    assert.equal(got!.blocks.length, 2);
    // **접힘 상태**가 보존되어야 한다 — 복원하면 사용자가 접어둔 것이 펼쳐진다
    assert.equal(got!.blocks[1].collapsed, true);
    // 블록 버전도 보존되어야 한다 (새로 매기면 스크롤이 튄다)
    assert.equal(got!.blocks[0].version, 7);
  } finally {
    await s.cleanup();
  }
});

test("**WS 재연결은 세션을 재적재하지 않는다** — 스트리밍 중 화면이 통째로 바뀐다(§5.10)", async () => {
  const store = new SessionStore("/tmp", 10);
  const p = planRestore("reconnect", doc(), 12);
  assert.equal(p.replaceScreen, false, "WS 재연결에 화면을 갈아엎었다");
  assert.equal(p.doc, null, "WS 재연결이 디스크에서 다시 읽었다");
  assert.equal(p.streaming, true, "스트리밍 중임을 모른다");
  void store;
});

test("**페이지 새로고침만** 화면을 교체한다", () => {
  const p = planRestore("reload", doc(), 0);
  assert.equal(p.replaceScreen, true, "새로고침 후 복원이 화면을 유지했다 — 사용자는 빈 화면을 본다");
  assert.ok(p.doc);
  assert.match(p.note, /새로고침/);
});

test("서버 재시작도 디스크에서 복원한다", () => {
  const p = planRestore("server-restart", doc(), 0);
  assert.equal(p.replaceScreen, true);
  assert.match(p.note, /서버 재시작/);
});

test("저장된 세션이 없으면 **빈 화면이 아니라 이유** 를 말한다", () => {
  const p = planRestore("reload", null, 0);
  assert.equal(p.doc, null);
  assert.equal(p.replaceScreen, false, "빈 화면을 갈아엌다");
  assert.match(p.note, /없습니다/);
});

test("중단된 턴이 있으면 **스트리밍 복원**으로 표시한다 — '어디까지 했는지'가 남아야 한다(§5.10)", () => {
  const p = planRestore("server-restart", doc({ abortedTurn: { blockIds: ["b1"], at: 1_900 } }), 0);
  assert.equal(p.streaming, true);
});

test("복원된 블록은 **버전 그대로** — 새로 매기면 스크롤이 튄다", () => {
  const b = hydrateBlocks(doc());
  assert.equal(b[0].version, 7);
  assert.equal(b[0].id, "b1");
});

test("복원 블록은 **생성 순서**로 정렬된다", () => {
  const d = doc({
    blocks: [
      { id: "b2", kind: "tool", title: "t", status: "ok", version: 1, createdAt: 300, updatedAt: 300, collapsed: false, content: null },
      { id: "b1", kind: "text", title: "t", status: "ok", version: 1, createdAt: 100, updatedAt: 100, collapsed: false, content: null },
    ],
  });
  assert.deepEqual(hydrateBlocks(d).map((b) => b.id), ["b1", "b2"], "생성 순서가 뒤집혔다 — 블록이 튄다");
});

test("디바운스: 연속 저장은 하나로 합쳐진다 — 스트리밍 중 매 델타 저장 금지", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 120);
    for (let i = 0; i < 20; i++) store.schedule(doc({ bytes: i }));
    assert.equal(store.pending, 1, `대기 중인 저장이 ${store.pending}개 — 매 델타마다 디스크를 쓴다`);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(store.pending, 0);
    // 마지막 값이 저장되어야 한다 (중간 값이 아니다)
    const got = await store.read(doc().id);
    assert.equal(got?.bytes, 19, "마지막 상태가 아니라 중간 상태가 저장됐다");
  } finally {
    await s.cleanup();
  }
});

test("flushAll 은 대기 중인 저장을 전부 쓴다 — 종료 전에 필수", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10_000);
    store.schedule(doc());
    assert.equal(store.pending, 1);
    await store.flushAll();
    assert.equal(store.pending, 0);
    assert.ok(await store.read(doc().id), "저장이 안 됐다 — 종료하면 대화가 사라진다");
  } finally {
    await s.cleanup();
  }
});

test("큰 블록은 앞/뒤만 남기고 **생략량을 말한다**", () => {
  const big = "가".repeat(INLINE_BLOCK_LIMIT * 2);
  const r = clampBlock({ text: big });
  assert.ok(r.spilled, "전문이 따로 보존되지 않는다");
  const c = r.content as { head: string; tail: string; omittedLines: number; note: string };
  assert.ok(c.head.length <= 2000);
  assert.ok(c.tail.length <= 2000);
  assert.ok(c.omittedLines > 0, "생략량을 세지 않았다");
  assert.match(c.note, /생략/);
});

test("작은 블록은 그대로 — 잘라내지 않는다", () => {
  const r = clampBlock({ text: "짧다" });
  assert.equal(r.spilled, null);
  assert.deepEqual(r.content, { text: "짧다" });
});

test("큰 세션은 gzip 으로 압축되고 **읽을 수 있다**", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    // 임계값을 확실히 넘긴다
    const messages = Array.from({ length: 20_000 }, (_, i) => ({ role: "assistant" as const, text: "가".repeat(200) + i, at: i }));
    const big = doc({ messages });
    const path = await store.write(big);
    assert.match(path, /\.json\.gz$/, `압축되지 않았다: ${path}`);
    const got = await store.read(big.id);
    assert.ok(got, "압축본을 못 읽는다");
    assert.equal(got!.messages.length, 20_000);
    assert.equal(got!.messages[0].text, "가".repeat(200) + "0");
    void COMPRESS_THRESHOLD;
  } finally {
    await s.cleanup();
  }
});

test("목록은 **최신순** — 워크스페이스별로 나뉜다", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    await store.write(doc({ id: "s-old", workspace: "/w1" }));
    await new Promise((r) => setTimeout(r, 5));
    await store.write(doc({ id: "s-new", workspace: "/w1" }));
    await store.write(doc({ id: "s-other", workspace: "/w2" }));
    const l = await store.list("/w1");
    assert.deepEqual(l.map((x) => x.id), ["s-new", "s-old"], "최신순이 아니다");
    const l2 = await store.list("/w2");
    assert.equal(l2.length, 1, "워크스페이스 구분이 안 된다");
  } finally {
    await s.cleanup();
  }
});

test("latest() 는 가장 최근 세션을 준다 — 서버 재시작 복원 경로", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    // `write()` 는 저장 시각을 다시 찍으므로 순서는 **마지막으로 쓴 것** 이다.
    await store.write(doc({ id: "s-a" }));
    await store.write(doc({ id: "s-b" }));
    await new Promise((r) => setTimeout(r, 5));
    await store.write(doc({ id: "s-c" }));
    const l = await store.latest();
    assert.equal(l?.id, "s-c", "마지막으로 저장한 세션이 아니다");
  } finally {
    await s.cleanup();
  }
});

test("없는 세션은 null — 예외가 아니다", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    assert.equal(await store.read("nope"), null);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.latest(), null);
  } finally {
    await s.cleanup();
  }
});

test("삭제가 실제로 지운다", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    await store.write(doc());
    await store.remove(doc().id);
    assert.equal(await store.read(doc().id), null);
  } finally {
    await s.cleanup();
  }
});

test("세션 ID 는 사람이 읽고 **정렬 가능**하다", () => {
  const a = sessionId("/w", Date.parse("2026-01-02T03:04:05Z"));
  const b = sessionId("/w", Date.parse("2026-03-04T05:06:07Z"));
  assert.match(a, /^s-\d{8}-\d{6}-[0-9a-f]{6}$/);
  assert.ok(a < b, "시간순 정렬이 안 된다 — 목록이 뒤섞인다");
  assert.notEqual(sessionId("/x", 1), sessionId("/y", 1), "다른 루트가 같은 ID 를 만든다");
});

test("이름 붙이기가 보존된다", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    await store.write(doc({ name: "버그 수정" }));
    assert.equal((await store.read(doc().id))?.name, "버그 수정");
    assert.equal((await store.list())[0].name, "버그 수정");
  } finally {
    await s.cleanup();
  }
});

test("디렉터리가 없으면 목록은 빈 배열 — 예외가 아니다", async () => {
  const store = new SessionStore("/nonexistent-path-xyz/deep", 10);
  assert.deepEqual(await store.list(), []);
});

test("깨진 세션 파일 하나가 목록 전체를 막지 않는다", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    await mkdir(join(s.dir, "sessions"), { recursive: true });
    await writeFile(join(s.dir, "sessions", "s-broken.json"), "{ 이건 json 이 아니다", "utf8");
    await store.write(doc({ id: "s-ok" }));
    const l = await store.list();
    assert.equal(l.length, 1, `깨진 파일 때문에 목록이 막혔다: ${JSON.stringify(l.map((x) => x.id))}`);
    assert.equal(l[0].id, "s-ok");
  } finally {
    await s.cleanup();
  }
});

test("updatedAt 이 같으면 **결정적 순서** — 같은 목록이 두 번 달라지면 버그처럼 보인다", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(s.dir, 10);
    // write() 가 시각을 다시 찍으므로 같은 밀리초에 저장되게 만든다.
    for (const id of ["s-c", "s-a", "s-b"]) await store.write(doc({ id }));
    const l1 = (await store.list()).map((x) => x.id);
    const l2 = (await store.list()).map((x) => x.id);
    assert.deepEqual(l1, l2, "같은 목록이 두 번 조회에서 달랐다");
    assert.equal(l1.length, 3);
  } finally {
    await s.cleanup();
  }
});
