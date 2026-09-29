/**
 * 세션 이어받기 배선 테스트 (§5.10).
 *
 * `store.ts` 의 테스트는 **저장 파일** 을 검사한다. 여기는 **배선** 을 검사한다:
 * 블록이 바뀌면 저장이 예약되는가, 턴이 끝나면 즉시 쓰이는가, 저장이 안 되면
 * 사용자가 알게 되는가, 그리고 재연결/새로고침이 구분되는가.
 *
 * 특히 마지막 것이 중요하다. 둘을 섞으면 스트리밍 도중 화면이 통째로 바뀌고,
 * 사용자는 "내 대화가 리셋됐다" 고 읽는다(§5.10 이 명시적으로 금지).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBridge } from "./bridge.js";
import { applyEvent, type AgentBlock } from "./blocks.js";
import { sessionsDir } from "./store.js";

async function sandbox() {
  const stateDir = await mkdtemp(join(tmpdir(), "harnesside-bridge-"));
  return { stateDir, cleanup: async () => rm(stateDir, { recursive: true, force: true }) };
}

function blocks(...kinds: AgentBlock["kind"][]): AgentBlock[] {
  let b: AgentBlock[] = [];
  let at = 1000;
  for (const k of kinds) b = applyEvent(b, { type: k === "text" ? "agent.delta" : k === "reasoning" ? "agent.reasoning" : "agent.status", text: `${k} 내용`, at: (at += 100) });
  return b;
}

test("블록이 바뀌면 저장이 **예약**된다 — 스트리밍마다 쓰면 I/O 가 스트리밍을 끊는다", async () => {
  const s = await sandbox();
  try {
    const b = new SessionBridge({ stateDir: s.stateDir, workspace: () => "/proj", debounceMs: 1000 });
    b.start();
    b.capture(blocks("text", "text"));
    assert.equal(b.pending, 1, "저장 예약이 없다 — 창을 닫으면 대화가 사라진다");
  } finally {
    await s.cleanup();
  }
});

test("턴이 끝나면 **즉시** 쓰인다 — 마지막 1초가 사라지지 않는다", async () => {
  const s = await sandbox();
  try {
    const b = new SessionBridge({ stateDir: s.stateDir, workspace: () => "/proj", debounceMs: 60_000 });
    b.start();
    b.noteUser("무엇을 할까요");
    b.capture(blocks("text"));
    const r = await b.saveNow();
    assert.equal(r.ok, true, `저장 실패: ${r.detail}`);
    const files = await readdir(sessionsDir(s.stateDir));
    assert.equal(files.length, 1);
    const doc = JSON.parse(await readFile(join(sessionsDir(s.stateDir), files[0]), "utf8"));
    assert.equal(doc.messages[0].text, "무엇을 할까요", "사용자 메시지가 없다 — '뭘 했나' 가 남지 않는다");
    assert.ok(doc.blocks.length >= 1);
  } finally {
    await s.cleanup();
  }
});

test("저장 **실패**는 조용히 삼키지 않는다 — 복구 불가능한 순간에야 알게 되는 실패가 있다", async () => {
  const s = await sandbox();
  try {
    // **확실히 실패하는 상태**를 만든다: 세션 디렉터리 자리에 **파일**을 놓는다.
    // 그러면 mkdir 이 EEXIST 로 실패한다(권한 대신 구조로 막는다 — sudo 없이 재현 가능).
    await mkdir(sessionsDir(s.stateDir), { recursive: true });
    await writeFile(join(sessionsDir(s.stateDir), "s-blocked.json"), "막음", { flag: "w" });
    await rm(join(sessionsDir(s.stateDir), "s-blocked.json"), { force: true });
    const errors: string[] = [];
    // 이번엔 stateDir 자체가 **파일**이라 mkdir 이 불가능하다.
    const blocked = join(s.stateDir, "state-as-file");
    await writeFile(blocked, "x");
    const b = new SessionBridge({ stateDir: blocked, workspace: () => "/proj", onError: (m) => errors.push(m) });
    b.start();
    b.noteUser("대화");
    const r = await b.saveNow();
    assert.equal(r.ok, false, "막힌 경로에 저장이 성공했다 — 실패를 만들지 못했다");
    assert.ok(errors.length > 0, "실패했는데 알리지 않았다 — 사용자는 창을 닫을 때까지 모른다");
    assert.equal(b.lastError, r.detail, "마지막 오류가 남지 않는다");
  } finally {
    await s.cleanup();
  }
});

test("**재연결**은 화면을 교체하지 않고, **새로고침**은 교체한다 — 둘을 섞으면 대화가 리셋된다", async () => {
  const s = await sandbox();
  try {
    const b = new SessionBridge({ stateDir: s.stateDir, workspace: () => "/proj" });
    b.start();
    const re = b.restore("reconnect", 5);
    assert.equal(re.replaceScreen, false, "재연결에서 화면을 갈아엎으면 스트리밍이 깨진다");
    const rl = b.restore("reload", 5);
    assert.equal(rl.replaceScreen, true, "새로고침에서 교체하지 않으면 빈 화면이다");
  } finally {
    await s.cleanup();
  }
});

test("세션은 **워크스페이스별로** 분리된다 — 다른 프로젝트의 대화가 섞이면 안 된다", async () => {
  const s = await sandbox();
  try {
    const a = new SessionBridge({ stateDir: s.stateDir, workspace: () => "/proj-a" });
    const bb = new SessionBridge({ stateDir: s.stateDir, workspace: () => "/proj-b" });
    a.start();
    a.noteUser("A 의 대화");
    await a.saveNow();
    bb.start();
    bb.noteUser("B 의 대화");
    await bb.saveNow();
    const listA = await a.list();
    assert.equal(listA.every((x) => x.workspace === "/proj-a"), true, "다른 워크스페이스의 세션이 섞였다");
    assert.equal(listA.length, 1);
  } finally {
    await s.cleanup();
  }
});

test("사고 블록은 전문이 아니라 **크기만** 저장한다 — 접힌 내용에 토큰을 쓰지 않는다", async () => {
  const s = await sandbox();
  try {
    const b = new SessionBridge({ stateDir: s.stateDir, workspace: () => "/proj" });
    b.start();
    b.capture(blocks("reasoning"));
    await b.saveNow();
    const files = await readdir(sessionsDir(s.stateDir));
    const doc = JSON.parse(await readFile(join(sessionsDir(s.stateDir), files[0]), "utf8"));
    const reason = doc.blocks.find((x: { kind: string }) => x.kind === "reasoning");
    assert.ok(reason, "사고 블록이 없다");
    assert.equal(String(reason.content).includes("내용"), false, `사고 본문이 통째로 저장됐다: ${reason.content}`);
    assert.match(String(reason.content), /자$/, "크기만 남는다");
  } finally {
    await s.cleanup();
  }
});

test("같은 종류의 연속 델타는 **한 블록** 으로 합쳐진다 — 블록이 100개 쌓이면 스크롤이 무의미해진다", async () => {
  const b0: AgentBlock[] = [];
  let b = b0;
  for (let i = 0; i < 50; i++) b = applyEvent(b, { type: "agent.delta", text: "가", at: 1000 + i * 10 });
  assert.equal(b.length, 1, `50개 델타가 ${b.length}개 블록이 됐다`);
  assert.equal(b[0].text.length, 50);
});

test("서로 다른 종류는 **따로** 쌓인다 — 사고와 답변이 한 블록이 되면 읽을 수 없다", () => {
  const b = applyEvent(applyEvent([], { type: "agent.reasoning", text: "생각", at: 1000 }), { type: "agent.delta", text: "답", at: 1010 });
  assert.equal(b.length, 2);
  assert.equal(b[0].kind, "reasoning");
  assert.equal(b[1].kind, "text");
});

test("상태 문구는 **각각 한 줄** 다 — 같은 종류라는 이유로 합치면 사건이 사라진다", () => {
  // 실측에서 이렇게 뉘었다: "컨텍스트 984/32768모델이 응답 중입니다모델이 사고 델타를…"
  // 세 개의 서로 다른 사건이 한 줄이 되어, 왜 일어났는지 읽을 수 없었다.
  let b: AgentBlock[] = [];
  b = applyEvent(b, { type: "agent.status", text: "컨텍스트 984/32768", at: 1000 });
  b = applyEvent(b, { type: "agent.status", text: "모델이 응답 중입니다", at: 1010 });
  b = applyEvent(b, { type: "agent.status", text: "계획 0/0", at: 1020 });
  assert.equal(b.length, 3, `세 사건이 ${b.length}개로 뭉개졌다`);
  assert.deepEqual(
    b.map((x) => x.text),
    ["컨텍스트 984/32768", "모델이 응답 중입니다", "계획 0/0"]
  );
});

test("도구 호출도 **각각** 쌓인다 — 같은 도구를 두 번 불렀다 한 줄이 되면 몇 번 불렀는지 모른다", () => {
  let b: AgentBlock[] = [];
  b = applyEvent(b, { type: "agent.tool", text: "read_file", tool: { name: "read_file" }, at: 1000 });
  b = applyEvent(b, { type: "agent.tool", text: "read_file", tool: { name: "read_file" }, at: 1100 });
  assert.equal(b.length, 2, "같은 도구 두 번이 한 사건으로 합쳐졌다");
});
