/**
 * 승인 게이트의 **통과 경로**를 고정한 테스트 (§2 todo · S-6).
 *
 * `approval.test.ts` 는 게이트 자체를 검증한다("승인 없는 파괴적 명령이 실행되지
 * 없다">여기는 거기가 아니라 **게이트가 실제로 루프에 배선되어 지나는지**를
 * 본다 — todo 의 "게이트를 지나는 것을 유닛으로 고정" 이다. 배선이 없으면 S-6 은
 * 허공이다(요구한 쪽이 그렇게 적었다).
 *
 * 실제 모델 서버 없이 **가짜 백엔드**로 돈다. 게이트는 `setApprovalGate` 로 달고,
 * 거기에 allowlist 에 넣거나 수동으로 결정만 주면 UI 가 필요 없다(실제 창이 아니라도
 * 통과/거절의 결과를 볼 수 있다).
 *
 * 동기화: 도구 호출은 `svc.send()` **안에서** 일어난다. 그래서 send() 를 먼저 시작해
 * (Promise 로 잡는다) 그 뒤 루프가 `gate.request()` 로 대기 항목을 만들기를 기다려,
 * pendingCount 가 0 이 되면 결정(reject/decide)한다. 결정 없이 보내면 send() Promise
 * 가 영원히 풀리지 않으므로 반드시 결정이 들어간다.
 */

import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "./agentService.js";
import { ApprovalGate } from "./approval.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, ModelBackend } from "../backend/types.js";

const CLEANUPS: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of CLEANUPS) await c();
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-gate-"));
  CLEANUPS.push(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** tool_call 을 처음 한 번만 내보내는 가짜 백엔드.
 * 두 번째 chat() 부터는 tool_call 없이 끝낸다 — 실제 모델은 같은 호출을 무한으로
 * 되내리지 않는다. 게이트 거절 후 루프가 chat() 을 다시 부르면 턴이 자연스럽게
 * 끝나 send() Promise 가 풀린다(거절 후에도 같은 tool_call 을 계속 내뱉으면
 * request() 가 새 대기 항목을 만들고 아무도 풀지 못해 턴이 멈춘다). */
function fakeBackend(toolCall?: { name: string; args: string }): ModelBackend & { calls: ChatCompletionRequest[] } {
  const calls: ChatCompletionRequest[] = [];
  let chatCalls = 0;
  return {
    calls,
    async listModels() {
      return ["fake-model"];
    },
    async chat(_req, _onDelta) {
      if (++chatCalls > 1) toolCall = undefined; // 두 번째부터는 도구 호출 없이 끝낸다
      const msg: ChatCompletionResponse = {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "fake-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: toolCall
                ? [{ id: "call_1", type: "function", function: { name: toolCall.name, arguments: toolCall.args } }]
                : undefined,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } as unknown as ChatCompletionResponse;
      return msg;
    },
  };
}

/** send() 를 시작하고 (거의 즉시) 대기 중인 게이트 결정이 들어올 때까지 기다린다. */
function waitForPending(gate: ApprovalGate, ms = 500): Promise<void> {
  return new Promise((res, rej) => {
    const t = setInterval(() => {
      if (gate.pendingCount > 0) { clearInterval(t); res(); }
    }, 5);
    setTimeout(() => { clearInterval(t); rej(new Error("대기 항목이 만들어지지 않았다")); }, ms);
  });
}

test("allow-once 이면 파괴적 도구가 **통과해서 실행된다**", async () => {
  const dir = await sandbox();
  const target = join(dir, "created.txt");
  const backend = fakeBackend({ name: "write_file", args: JSON.stringify({ path: target, content: "승인됨" }) });
  const gate = new ApprovalGate();
  gate.allow("write_file"); // allowlist → request() 가 바로 allow-once 를 반환한다
  const svc = new AgentService({
      backend,
      baseUrl: () => "",
      model: "fake-model",
      systemPrompt: "",
      baseDir: () => dir,
      emit: () => {},
    });
  svc.setApprovalGate(gate);

  const r = await svc.send("이 파일을 만들어 보세요");
  assert.equal(r.ok, true, `턴이 끝났으나 ok=${r.ok}`);

  // **통과 경로**의 증거는 디스크다 — 도구가 실제로 파일을 썼는지.
  await access(target); // 존재하지 않으면 여기서 reject 된다
  const content = await readFile(target, "utf8");
  assert.equal(content, "승인됨", "allow-once 가 지났는데도 파일이 만들어지지 않았다");

  // (test-local harness) cancel the in-progress turn. AgentService.cancel() is
  // the public entry; TurnState exposes only plain status fields, not .cancel().
  await svc.cancel().catch(() => {});
});

test("reject 이면 파괴적 도구가 **통과하지 못해 실행되지 않는다**", async () => {
  const dir = await sandbox();
  const target = join(dir, "refused.txt");
  const backend = fakeBackend({ name: "write_file", args: JSON.stringify({ path: target, content: "거절됨" }) });
  const gate = new ApprovalGate();
  const svc = new AgentService({
      backend,
      baseUrl: () => "",
      model: "fake-model",
      systemPrompt: "",
      baseDir: () => dir,
      emit: () => {},
    });
  svc.setApprovalGate(gate);

  // send() 를 먼저 시작한다 (도구 호출이 내부에서 request() 를 만든다).
  const pSend = svc.send("이 파일을 만들어 보세요");
  await waitForPending(gate);
  gate.rejectAll(); // pending → reject → request() Promise 를 거절로 푼다

  const r = await pSend;
  assert.equal(r.ok, true, `턴은 끝났다 (거절도 턴을 끝낸다). ok=${r.ok}`);

  // 실행되지 않았는지 — 파일이 없어야 한다.
  assert.equal(existsSync(target), false, "거절된 도구라도 파일이 만들어졌다 — 게이트가 뚫렸다");
});

test("allow-always 는 **한 번** 승인하면 다음 요청을 묻지 않고 지어난다", async () => {
  const dir = await sandbox();
  const backend = fakeBackend({ name: "write_file", args: JSON.stringify({ path: join(dir, "a.txt"), content: "1" }) });
  const gate = new ApprovalGate();
  const svc = new AgentService({
      backend,
      baseUrl: () => "",
      model: "fake-model",
      systemPrompt: "",
      baseDir: () => dir,
      emit: () => {},
    });
  svc.setApprovalGate(gate);

  // send() 시작 후 대기 항목이 생기면 allow-always 로 결정한다.
  const pSend = svc.send("이 파일을 만들어 보세요");
  await waitForPending(gate);
  gate.decide([...gate["waiting"].keys()][0], "allow-always", "user");

  const r = await pSend;
  assert.equal(r.ok, true, `turn ended ok=${r.ok}`);

  // 두 번째 요청: allowlist 에 올라갔으니 request() 가 대기하지 않고 바로 풀어준다.
  const askedAgain = gate.request({ tool: "write_file", summary: "2" });
  assert.equal(await askedAgain, "allow-once", `allowlist 항목은 묻지 않고 allow-once 여야 한다. 실제: ${await askedAgain}`);
  assert.equal(gate.pendingCount, 0, "allow-always 가 allowlist 를 채우지 않았다");
});
