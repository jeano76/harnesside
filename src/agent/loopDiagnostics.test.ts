/**
 * U-7 루프 훅 — 턴 끝 증분 진단이 한 번만 피드백하고 끝나게 한다.
 * 가짜 백엔드 + 가짜 진단 실행자로 실제 턴을 돌린다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";import { AgentLoop } from "./loop.js";
import type { Diagnostic } from "../recipes/diagnostics.js";
import type { ChatCompletionResponse, ModelBackend } from "../backend/types.js";

async function withTempProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "diag-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function msg(content: string | null): ChatCompletionResponse {
  return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function toolMsg(calls: { id: string; type: "function"; function: { name: string; arguments: string } }[]): ChatCompletionResponse {
  return { choices: [{ message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }] };
}

function scripted(responses: ChatCompletionResponse[]): { backend: ModelBackend; requests: { messages: { content: unknown }[] }[] } {
  let i = 0;
  const requests: { messages: { content: unknown }[] }[] = [];
  const backend: ModelBackend = {
    async chat(req: never) {
      const r = req as { tools?: unknown; messages: { content: unknown }[] };
      if (!r.tools) {
        return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
      }
      requests.push({ messages: r.messages });
      const res = responses[i];
      i++;
      if (!res) throw new Error(`no scripted response for call ${i}`);
      return res;
    },
    async listModels() {
      return ["fake"];
    },
    async tokenize() {
      return 5;
    },
  };
  return { backend, requests };
}

const PROB: Diagnostic = {
  file: "a.txt",
  line: 1,
  col: 0,
  severity: "error",
  rule: "R1",
  message: "boom",
  source: "lint",
};

function provider(runs: Diagnostic[][]): { diagnostics: { runAll(): Promise<Diagnostic[]> }; calls: number } {
  let i = 0;
  const o = { calls: 0, diagnostics: { async runAll() { o.calls++; return runs[Math.min(i++, runs.length - 1)]; } } };
  return o;
}

test("U-7: 새 문제 → 1회 피드백 → 고쳐지면 블록 없음", () =>
  withTempProject(async (dir) => {
    const target = join(dir, "a.txt");
    const write = { id: "c1", type: "function" as const, function: { name: "write_file", arguments: JSON.stringify({ path: target, content: "x" }) } };
    const { backend, requests } = scripted([toolMsg([write]), msg("edited"), msg("fixed")]);
    // baseline [] → 턴 끝 [PROB] → 피드백 후 [] (고침)
    const p = provider([[], [PROB], []]);
    const blocks: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100000 },
      diagnostics: p.diagnostics,
      onDiagnostics: (text) => blocks.push(text),
    });
    await loop.send("fix it");
    // 초기 2회 + 피드백 후 1회 = 3회. 무한 재시도 아님.
    assert.equal(requests.length, 3);
    assert.ok(requests[2].messages.some((m) => String(m.content).includes("[diagnostics]")));
    assert.deepEqual(blocks, []);
  }));

test("U-7: 고쳐지지 않으면 사람에게 블록 1개 (피드백은 1회)", () =>
  withTempProject(async (dir) => {
    const target = join(dir, "a.txt");
    const write = { id: "c1", type: "function" as const, function: { name: "write_file", arguments: JSON.stringify({ path: target, content: "x" }) } };
    const { backend, requests } = scripted([toolMsg([write]), msg("edited"), msg("tried")]);
    const p = provider([[], [PROB], [PROB]]);
    const blocks: { text: string; n: number; pre: number }[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100000 },
      diagnostics: p.diagnostics,
      onDiagnostics: (text, n, pre) => blocks.push({ text, n, pre }),
    });
    await loop.send("fix it");
    assert.equal(requests.length, 3);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].n, 1);
    assert.match(blocks[0].text, /만든 문제 1/);
  }));

test("U-7: 파일 수정 없으면 진단 블록·피드백 없음", () =>
  withTempProject(async (dir) => {
    const { backend, requests } = scripted([msg("just chatting")]);
    const p = provider([[]]);
    const blocks: string[] = [];
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100000 },
      diagnostics: p.diagnostics,
      onDiagnostics: (text) => blocks.push(text),
    });
    await loop.send("hello");
    assert.equal(requests.length, 1);
    assert.deepEqual(blocks, []);
  }));
