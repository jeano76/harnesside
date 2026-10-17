/** X-4: 코드를 고치고 검증 없이 끝내려는 턴은 한 번 되돌려 보낸다. 가짜 백엔드로 실제 턴을 돌린다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./loop.js";
import type { ChatCompletionResponse, ModelBackend } from "../backend/types.js";

const msg = (content: string): ChatCompletionResponse => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const call = (name: string, args: object): ChatCompletionResponse => ({
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
});

function scripted(responses: ChatCompletionResponse[]) {
  let i = 0;
  const seen: string[][] = [];
  const backend: ModelBackend = {
    async chat(req: never) {
      const r = req as { tools?: unknown; messages: { content: unknown }[] };
      if (!r.tools) return msg("summary");
      seen.push(r.messages.map((m) => String(m.content)));
      const res = responses[i++];
      if (!res) throw new Error("no scripted response");
      return res;
    },
    async listModels() { return ["fake"]; },
    async tokenize() { return 5; },
  };
  return { backend, seen };
}

async function run(responses: ChatCompletionResponse[]) {
  const dir = await mkdtemp(join(tmpdir(), "vg-"));
  try {
    const { backend, seen } = scripted(responses);
    const loop = new AgentLoop({ projectRoot: dir, model: "m", backend, systemPrompt: "sys", thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100000 } });
    await loop.send("fix it");
    return seen;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("X-4: 코드 편집 후 검증 없이 끝내면 verify gate 안내가 한 번 들어간다", async () => {
  const dir = tmpdir();
  const seen = await run([call("write_file", { path: join(dir, "vg-a.ts"), content: "x" }), msg("고쳤습니다"), msg("미검증입니다")]);
  assert.equal(seen.length, 3);
  assert.ok(seen[2].some((m) => m.includes("[verify gate]")));
});

test("X-4: 문서만 고치면 안내 없음", async () => {
  const seen = await run([call("write_file", { path: join(tmpdir(), "vg-a.md"), content: "x" }), msg("done")]);
  assert.equal(seen.length, 2);
});
