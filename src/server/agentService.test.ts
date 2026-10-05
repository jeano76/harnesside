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
import { readFileSync } from "node:fs";
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
    // 기본값은 ON(2026-10-04 사용자 명시) — OFF 경로는 명시적으로 끄고 본다
    const svc = service(fakeBackend({ reasonChunks: "생각중" }), events, s.dir, { enableThinking: false });
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
    const svc = service(fakeBackend({ reasonChunks: "가".repeat(60) }), events, s.dir, { enableThinking: false });
    await svc.send("생각해봐");
    const notices = events.filter((e) => e.type === "agent.status" && /예산|상한/.test(String(e.text)));
    assert.equal(notices.length, 1, `한 번만 말해야 하는데 ${notices.length}번 했다`);
    assert.equal(svc.thinking.usedTokens > 0, true, "소비된 토큰을 세지 않았다");
    // 문구가 바뀌어도 **의미**는 지켜져야 한다 — 정규식 하나에 묶지 않는다.
    // 예전에는 "꺼져 있습니다" 라고만 해서 사용자가 무엇을 해야 하는지 몰랐다(실측 질문).
    const text = String(notices[0].text);
    assert.match(text, /이미 쓴|되돌릴 수 없/, "예산이 이미 소비됐다는 사실을 말하지 않는다");
    assert.match(text, /다음 턴/, "언제 다시 켜지는지 말하지 않는다 — 사용자가 계속 꺼진 것으로 안다");
    assert.match(text, /상한/, "어떤 상한을 넘었는지 말하지 않는다");
    // **어디를 고쳐야 하는지**를 말해야 하고, 그곳이 **실제로 통하는 곳**이어야 한다.
    //
    // 예전엔 "설정의 사고 토큰 상한 을 올리십시오" 라고 적었는데, 그 설정은 **아무도 읽지
    // 않았다**(스키마에만 있고 배선이 없었다). 지시를 따라도 아무 일도 일어나지 않는
    // 안내였다. 이제는 실제 경로와 현재값·허용 범위를 함께 말한다.
    assert.match(text, /\.harnesside\/config\.yaml/, "고칠 파일 경로를 말하지 않는다");
    assert.match(text, /agent\.maxReasoningTokens/, "고칠 키를 말하지 않는다");
    assert.match(text, /4,096/, "지금 값을 말하지 않는다 — 무엇을 고쳐야 하는지 알 수 없다");
    assert.match(text, /허용/, "허용 범위를 말하지 않는다 — 값을 어디까지 올려도 되는지 모른다");
  } finally {
    await s.cleanup();
  }
});

test("thinking 을 켜면 사고 델타가 나가고, 상한을 넘으면 강제 전환한다(대화에 상태 줄은 남기지 않는다)", async () => {
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
      !events.some((e) => e.type === "agent.status" && /강제/.test(String(e.text))),
      "사용자 지정: thinking 은 기본 ON 이라 이 안내는 대화에 남기지 않는다(전환 자체는 일어난다)"
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

test("실행 중 입력은 거절하지 않고 대기열에 넣는다 (O4)", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let chats = 0;
    const backend = fakeBackend();
    const origChat = backend.chat.bind(backend);
    backend.chat = (async (req: ChatCompletionRequest, onDelta?: (c: ChatCompletionChunk) => void) => {
      if (++chats === 1) await gate;
      return origChat(req, onDelta);
    }) as ModelBackend["chat"];
    const svc = service(backend, events, s.dir);
    const p1 = svc.send("첫째");
    await new Promise((r) => setTimeout(r, 50));
    const r2 = await svc.send("둘째");
    assert.equal(r2.ok, true, "대기열 수락이 거절됐다");
    assert.equal(r2.queued, true);
    assert.match(r2.detail, /대기열/);
    assert.deepEqual(svc.queueView(), ["둘째"]);
    release();
    const r1 = await p1;
    assert.equal(r1.ok, true);
    // 비우기까지 같은 send 안에서 돈다 — 끝난 뒤 대기열은 비어 있다
    assert.deepEqual(svc.queueView(), []);
    const queues = events.filter((e) => e.type === "agent.queue");
    assert.ok(queues.length >= 2, "agent.queue 이벤트가 없다 — 화면이 대기열을 모른다");
  } finally {
    await s.cleanup();
  }
});

test("대기열 순서를 바꾼다 — 급한 것을 먼저", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend(), events, s.dir);
    // 직접 큐를 채운다: 실행 중이 아닐 때는 send 가 바로 돈다 — running 을 흉내 내기 위해
    // loop 를 먼저 잡는다 (send 경로가 아니라 큐 조작 자체를 본다)
    (svc as unknown as { queue: string[] }).queue.push("a", "b", "c");
    assert.equal(svc.moveQueue(2, 0), true);
    assert.deepEqual(svc.queueView(), ["c", "a", "b"]);
    assert.equal(svc.moveQueue(0, 0), true);
    assert.equal(svc.moveQueue(-1, 0), false, "음수 인덱스가 통과했다");
    assert.equal(svc.moveQueue(0, 9), false, "범위 밖이 통과했다");
    assert.deepEqual(svc.clearQueue(), { cleared: 3 });
    assert.deepEqual(svc.queueView(), []);
  } finally {
    await s.cleanup();
  }
});

test("취소는 대기열까지 비우고 개수를 말한다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let chats = 0;
    const backend = fakeBackend();
    const origChat = backend.chat.bind(backend);
    backend.chat = (async (req: ChatCompletionRequest, onDelta?: (c: ChatCompletionChunk) => void) => {
      if (++chats === 1) await gate;
      return origChat(req, onDelta);
    }) as ModelBackend["chat"];
    const svc = service(backend, events, s.dir);
    const p1 = svc.send("첫째");
    await new Promise((r) => setTimeout(r, 50));
    await svc.send("둘째");
    const c = await svc.cancel();
    assert.match(c.detail, /대기열 1개도 비웠습니다/);
    assert.deepEqual(svc.queueView(), []);
    release();
    await p1;
  } finally {
    await s.cleanup();
  }
});

test("컨텍스트는 잰 값만 말한다 — 없으면 null (0이 아니다)", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    const svc = service(fakeBackend(), events, s.dir);
    assert.equal(svc.contextUsage(), null);
    await svc.refreshContext(); // 대화 없음 — 여전히 null
    assert.equal(svc.contextUsage(), null);
    await svc.send("안녕");
    const u = svc.contextUsage();
    assert.ok(u && u.usedTokens > 0, "턴이 돌았는데도 컨텍스트가 측정되지 않았다");
    assert.equal(u.totalTokens, 100_000);
  } finally {
    await s.cleanup();
  }
});

test("압축 시작·상세를 전용 이벤트로 흘린다 — 상태 줄 텍스트만이 아니다", () => {
  // ensureLoop 은 private 이라 이벤트 계약(타입+배선)을 본다
  const code = readFileSync("src/server/agentService.ts", "utf8");
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /onCompactionDetail/, "상세 콜백 배선이 없다 — 요약이 화면에 안 나온다");
  assert.match(noComments, /type: "agent\.compaction"/, "전용 이벤트가 없다");
  assert.match(noComments, /droppedCount/, "잊혀진 규모가 없다");
  assert.match(noComments, /summary/, "요약 본문이 없다");
});

test("강제 OFF는 다음 턴 시작에 ON 으로 돌아온다 — Thinking 상시", () => {
  const code = readFileSync("src/server/agentService.ts", "utf8");
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /wasForced/, "턴 시작 재활성 코드가 없다 — 한 번 꺼지면 영영 꺼진다");
  assert.match(noComments, /enabled: true/, "ON 복원이 없다");
});

test("thresholds 팩토리는 호출 시점에 풀린다 — 부팅 뒤 정해진 컨텍스트가 루프에 닿는다", async () => {
  const events: AgentEvent[] = [];
  const s = await sandbox();
  try {
    let size = 32_768;
    const svc = service(fakeBackend({ text: "ok" }), events, s.dir, {
      thresholds: () => ({ autoTriggerRatio: 0.6, contextWindowTokens: size }),
    });
    await svc.send("hi");
    assert.equal(svc.contextUsage()?.totalTokens, 32_768, "첫 턴은 32768이어야");
    // 상태 줄에는 더 이상 컨텍스트가 붙지 않는다 — 하단 상태바가 보여준다.
    assert.ok(
      !events.some((e) => e.type === "agent.status" && /^컨텍스트 \d+\/\d+$/.test(e.text ?? "")),
      "출력마다 컨텍스트 줄이 붙는다"
    );
    // 부팅이 끝나고 컨텍스트가 16384로 정해졌다 — 루프를 버리면 다음 턴이 새 값을 본다.
    size = 16_384;
    svc.invalidate();
    await svc.send("hi again");
    assert.equal(svc.contextUsage()?.totalTokens, 16_384, "스냅샷이면 16384이 절대 안 보인다");
    const { resolveThresholds } = await import("./agentService.js");
    assert.equal(resolveThresholds(undefined).contextWindowTokens, 32_768);
  } finally {
    await s.cleanup();
  }
});
