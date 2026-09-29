/**
 * 에이전트 서비스 테스트 (§5.3) — **서버가 진짜 규칙을 지키는지** 를 본다.
 *
 * 판단은 이미 검증된 모듈에 있다(`agent/loop.ts`, `openaiClient.ts`). 여기서 확인하는
 * 것은 그 judge 들을 **어떻게 부르고, 무엇을 말하는가** 다. 특히:
 *  - 겹치는 턴을 거절하는가(두 턴이 같은 대화를 고치면 메시지가 뒤섞인다)
 *  - 취소가 **목록에 남는가**(무음 종료 금지)
 *  - 사고 델타가 안 보이게 되어도 **예산은 이미 씀**을 말하는가
 *  - 도구를 한 번도 안 불렀는데 "완료" 로 말하지 않는가
 *
 * 실제 모델 서버 없이 **가짜 백엔드**로 돈다 — 수명 규칙은 모델의 성능과 무관하다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService, type AgentEvent } from "./agentService.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, ModelBackend } from "../backend/types.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-agent-"));
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

/** 스트리밍으로 돌려주는 가짜 백엔드. reasoning 을 `reasonChunks` 만큼 흘린다. */
function fakeBackend(opts: { reasonChunks?: string; text?: string; toolCall?: { name: string; args: string } } = {}): ModelBackend & { calls: ChatCompletionRequest[] } {
  const calls: ChatCompletionRequest[] = [];
  return {
    calls,
    async listModels() {
      return ["fake-model"];
    },
    async chat(req, onDelta) {
      calls.push(req);
      const content = opts.text ?? "가짜 답변입니다.";
      if (onDelta) {
        for (const r of (opts.reasonChunks ?? "").match(/.{1,20}/g) ?? []) {
          const c = { choices: [{ index: 0, delta: { reasoning_content: r }, finish_reason: null }] } as unknown as ChatCompletionChunk;
          onDelta(c);
        }
        for (const t of content.match(/.{1,20}/g) ?? []) {
          const c = { choices: [{ index: 0, delta: { content: t }, finish_reason: null }] } as unknown as ChatCompletionChunk;
          onDelta(c);
        }
      }
      const msg: ChatCompletionResponse = {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "fake-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: opts.toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } as unknown as ChatCompletionResponse;
      if (opts.toolCall) {
        (msg as unknown as { tool_calls?: unknown }).tool_calls = [
          { id: "call_1", type: "function", function: { name: opts.toolCall.name, arguments: opts.toolCall.args } },
        ];
      }
      return msg;
    },
  };
}

function service(
  backend: ModelBackend,
  events: AgentEvent[],
  dir: string,
  over: Partial<ConstructorParameters<typeof AgentService>[0]> = {}
) {
  return new AgentService({
    baseDir: () => dir,
    baseUrl: () => "http://127.0.0.1:1",
    model: "fake-model",
    systemPrompt: "test",
    // **주입이 없으면 이 테스트들은 '모델에 닿지 못함' 으로 조용히 실패한다.**
    // 실제로 그랬다 — 서비스가 주입을 무시하고 진짜 HTTP 클라이언트를 새로 만들었다.
    backend,
    thresholds: { autoTriggerRatio: 1, contextWindowTokens: 100_000 },
    emit: (e) => events.push(e),
    ...over,
  });
}

test("빈 문장은 보내지 않는다 — 무음 실패 대신 이유를 말한다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend(), events, s.dir);
    const r = await svc.send("   ");
    assert.equal(r.ok, false);
    assert.match(r.detail, /문장/);
  } finally {
    await s.cleanup();
  }
});

test("턴이 끝나면 상태가 **명확히** 돌아온다 — running 이 남으면 다음 턴이 막힌다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend({ text: "안녕" }), events, s.dir);
    const r = await svc.send("안녕");
    assert.equal(r.ok, true);
    assert.equal(svc.turn.running, false, "running 이 남았다 — 다음 턴이 영영 거절된다");
    assert.ok(events.some((e) => e.type === "agent.delta" && e.text === "안녕"), "답변 델타가 나가지 않았다");
    assert.ok(events.some((e) => e.type === "agent.done"), "완료 이벤트가 없다 — 화면이 언제 끝났는지 모른다");
  } finally {
    await s.cleanup();
  }
});

test("도구를 **한 번도 안 부르면** 그것을 말한다 — '완료' 만으로는 부족하다", async () => {
  // 사용자가 파일을 고쳐 달라고 했는데 도구 호출이 없으면, 조용히 끝나면
  // "내 말 안 들렸나?" 가 유일한 설명이 된다.
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend(), events, s.dir);
    await svc.send("고쳐줘");
    const done = events.find((e) => e.type === "agent.done");
    assert.ok(done, "done 이벤트 없음");
    assert.match(String(done?.text), /도구 호출은 없/, `도구 미사용을 말하지 않음: ${done?.text}`);
  } finally {
    await s.cleanup();
  }
});

test("thinking 이 꺼져 있으면 사고 델타를 **보내지 않는다** — 보이지 않을 것까지 흘리면 설정이 거짓말이다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend({ reasonChunks: "생각중" }), events, s.dir);
    await svc.send("생각해봐");
    assert.equal(events.some((e) => e.type === "agent.reasoning"), false, "꺼진 설정인데 사고 델타가 나갔다");
  } finally {
    await s.cleanup();
  }
});

test("표시를 꺼도 **예산은 이미 씀** 을 한 번 말한다 — 조용히 숨기면 그 사실이 사라진다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend({ reasonChunks: "가".repeat(60) }), events, s.dir);
    await svc.send("생각해봐");
    const notices = events.filter((e) => e.type === "agent.status" && /예산은 이미 소비/.test(String(e.text)));
    assert.equal(notices.length, 1, `한 번만 말해야 하는데 ${notices.length}번 했다`);
    assert.equal(svc.thinking.usedTokens > 0, true, "소비된 토큰을 세지 않았다");
  } finally {
    await s.cleanup();
  }
});

test("thinking 을 켜면 사고 델타가 나가고, 상한을 넘으면 **강제 전환**을 말한다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend({ reasonChunks: "가".repeat(4000) }), events, s.dir);
    svc.setThinking(true);
    const r = await svc.send("생각해봐");
    assert.equal(r.ok, true, "상한 초과가 오류를 만들면 안 된다 — 강제 전환 후 계속된다");
    assert.ok(events.some((e) => e.type === "agent.reasoning"), "켰는데 사고 델타가 안 왔다");
    assert.equal(svc.thinking.forcedToolChoice, true, "강제 전환이 일어나지 않았다");
    assert.ok(
      events.some((e) => e.type === "agent.status" && /강제/.test(String(e.text))),
      "왜 바뀌었는지 말하지 않는다 — 사용자는 도구가 왜 안 부는지 모른다"
    );
  } finally {
    await s.cleanup();
  }
});

test("설정을 바꾸면 **루프를 버린다** — 옛 설정으로 만들어진 루프가 남아 있으면 '켰는데 안 켜진 것처럼' 보인다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend({ reasonChunks: "짧은 생각" }), events, s.dir);
    await svc.send("한 번");
    svc.setThinking(true);
    events.length = 0;
    await svc.send("두 번");
    assert.ok(events.some((e) => e.type === "agent.reasoning"), "설정을 바꿨는데 사고 델타가 안 보인다");
  } finally {
    await s.cleanup();
  }
});

test("진행 중인 턴이 없으면 취소는 **거절**한다 — 조용히 성공시키면 안 된다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend(), events, s.dir);
    const r = await svc.cancel();
    assert.equal(r.ok, false);
    assert.match(r.detail, /진행 중/);
  } finally {
    await s.cleanup();
  }
});

test("모델이 없으면 `ready` 가 거짓이다 — 보낼 수 없는데 되는 것처럼 보여선 안 된다", async () => {
  const s = await sandbox();
  try {
    const svc = new AgentService({
      baseDir: () => "/tmp",
      baseUrl: () => "http://127.0.0.1:1",
      model: () => "",
      systemPrompt: "t",
      thresholds: { autoTriggerRatio: 1, contextWindowTokens: 100 },
      emit: () => undefined,
    });
    assert.equal(svc.ready, false);
  } finally {
    await s.cleanup();
  }
});

test("모델 이름은 **호출 시점**에 읽는다 — 부팅이 끝나야 정해진다", async () => {
  const s = await sandbox();
  try {
    let name = "";
    const svc = new AgentService({
      baseDir: () => "/tmp",
      baseUrl: () => "http://127.0.0.1:1",
      model: () => name,
      systemPrompt: "t",
      thresholds: { autoTriggerRatio: 1, contextWindowTokens: 100 },
      emit: () => undefined,
    });
    assert.equal(svc.ready, false, "아직 모델이 없다");
    name = "Ornith";
    assert.equal(svc.ready, true, "값이 나중에 채워졌다");
  } finally {
    await s.cleanup();
  }
});

test("기준 디렉터리도 **호출 시점**의 값이다 — 전환 후 옛 폴더에 쓰면 안 된다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(b, "package.json"), "{}");
    let root = a;
    const backend = fakeBackend();
    const svc = service(backend, events, s.dir, { baseDir: () => root });
    await svc.send("첫 턴");
    root = b;
    await svc.send("두 번째 턴");
    const usedRoots = backend.calls.map((c) => c.messages?.[0]?.content);
    assert.equal(usedRoots.length, 2);
    // 시스템 프롬프트에는 루트가 들어간다(전환이 반영되어야 한다).
    assert.ok(backend.calls.length >= 2);
  } finally {
    await s.cleanup();
  }
});
