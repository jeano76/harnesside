import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./loop.js";
import { judgeReply, MAX_INCOMPLETE_REPLY_RETRIES } from "./incompleteReply.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ModelBackend } from "../backend/types.js";

// ── 판정(순수) ───────────────────────────────────────────────────────────────

test("도구 호출이 있으면 내용이 비어도 완료다", () => {
  assert.equal(judgeReply({ content: "", tool_calls: [{}] }, "tool_calls"), "complete");
});

test("내용이 비었고 도구 호출도 없으면 empty — 사고만 하고 끝난 응답", () => {
  assert.equal(judgeReply({ content: "", tool_calls: [] }, "stop"), "empty");
  assert.equal(judgeReply({ content: "  \n " }, "stop"), "empty");
  assert.equal(judgeReply({ content: null }, "stop"), "empty");
});

test("내용이 있고 length 로 끝났으면 cut-off, stop 이면 완료", () => {
  assert.equal(judgeReply({ content: "잠깐 — 논리" }, "length"), "cut-off");
  assert.equal(judgeReply({ content: "끝났습니다." }, "stop"), "complete");
  assert.equal(judgeReply({ content: "끝났습니다." }, undefined), "complete");
});

// ── 루프 ─────────────────────────────────────────────────────────────────────

const reply = (content: string | null, finish = "stop"): ChatCompletionResponse => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
});

async function run(responses: ChatCompletionResponse[]) {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-incomplete-"));
  const requests: ChatCompletionRequest[] = [];
  let i = 0;
  const backend: ModelBackend = {
    async chat(req) {
      if (!req.tools) return reply("summary");
      requests.push(JSON.parse(JSON.stringify(req)));
      const res = responses[Math.min(i, responses.length - 1)];
      i++;
      return res;
    },
    async listModels() {
      return ["m"];
    },
    async tokenize() {
      return 3;
    },
  };
  const status: string[] = [];
  try {
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100_000 },
      onStatus: (s) => status.push(s),
    });
    await loop.send("do it");
    return { status, requests };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("빈 응답(사고만)은 완료가 아니다 — 이어서 하라고 한 번 요청하고, 정상 응답이면 끝낸다", async () => {
  const { status, requests } = await run([reply(""), reply("끝났습니다.")]);
  assert.equal(requests.length, 2, "빈 응답에서 턴을 끝내 버렸다");
  assert.ok(status.some((s) => s.startsWith("[empty reply]")), `재요청을 말하지 않았다: ${JSON.stringify(status)}`);
  const last = requests[1].messages[requests[1].messages.length - 1];
  assert.equal(last.role, "user");
  assert.match(String(last.content), /empty/i);
  assert.ok(status[status.length - 1].startsWith("[done"), "정상 응답 뒤에는 완료로 끝나야 한다");
  // 빈 assistant 메시지는 기록에 남기지 않는다
  assert.ok(!requests[1].messages.some((m) => m.role === "assistant" && !String(m.content ?? "").trim() && !m.tool_calls));
});

test("빈 응답이 계속되면 상한에서 사유를 말하고 멈춘다 — 무한 재시도 없음", async () => {
  const { status, requests } = await run([reply("")]);
  assert.equal(requests.length, MAX_INCOMPLETE_REPLY_RETRIES + 1);
  assert.ok(status.some((s) => s.startsWith("[stopped]")), `멈춘 사유를 말하지 않았다: ${JSON.stringify(status)}`);
  assert.ok(!status.some((s) => s.startsWith("[done")), "실패를 완료로 보고했다");
});

test("출력 한도로 잘린 응답은 이어서 하라고 요청하고, 잘린 말은 기록에 남긴다", async () => {
  const { status, requests } = await run([reply("첫 부분입니다", "length"), reply("나머지입니다.")]);
  assert.equal(requests.length, 2);
  assert.ok(status.some((s) => s.startsWith("[reply cut off]")));
  const msgs = requests[1].messages;
  assert.ok(msgs.some((m) => m.role === "assistant" && m.content === "첫 부분입니다"), "잘린 응답을 버렸다");
  assert.match(String(msgs[msgs.length - 1].content), /cut off/);
});

test("빈 응답이 상한 안에서 두 번 나온 뒤 정상 응답이 오면 완료로 끝난다", async () => {
  // 빈 → 빈 → 정상(도구 없음): 상한(3) 안이므로 재시도하고, 정상 응답에서 턴이 완료된다.
  const { status, requests } = await run([reply(""), reply(""), reply("완료")]);
  assert.equal(requests.length, 3);
  assert.ok(status[status.length - 1].startsWith("[done"));
});
