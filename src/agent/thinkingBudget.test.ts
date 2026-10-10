import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "./loop.js";
import { overBudget, effectiveBudget, reasoningExcerpt, thinkingBudgetNudge, REASONING_EXCERPT_CHARS, MAX_BUDGET_CUTS_PER_TURN } from "./thinkingBudget.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ModelBackend } from "../backend/types.js";

// ── 순수 ─────────────────────────────────────────────────────────────────────

test("overBudget: 예산이 켜져 있고, 보이는 출력이 없고, 넘었을 때만", () => {
  assert.equal(overBudget({ spent: 5000, budget: 4000, sawOutput: false }), true);
  assert.equal(overBudget({ spent: 4000, budget: 4000, sawOutput: false }), false, "같으면 넘은 게 아니다");
  assert.equal(overBudget({ spent: 5000, budget: 4000, sawOutput: true }), false, "이미 답/도구 호출이 시작됐으면 끊지 않는다");
  assert.equal(overBudget({ spent: 5000, budget: 0, sawOutput: false }), false, "0 이하는 끈 것");
});

test("effectiveBudget: 끊을 때마다 2배로 늘리고, 상한 횟수에서 끈다", () => {
  assert.equal(effectiveBudget(1000, 0), 1000);
  assert.equal(effectiveBudget(1000, 1), 2000);
  assert.equal(effectiveBudget(1000, 2), 4000);
  assert.equal(effectiveBudget(1000, MAX_BUDGET_CUTS_PER_TURN), 0, "상한이면 예산을 꺼서 끊고-도구-폭주 순환을 막는다");
  assert.equal(effectiveBudget(0, 0), 0);
  assert.equal(effectiveBudget(-5, 0), 0);
});

test("reasoningExcerpt: 짧으면 그대로, 길면 뒤쪽만 남긴다", () => {
  assert.equal(reasoningExcerpt("  짧은 생각 "), "짧은 생각");
  const long = "A".repeat(10_000) + "결론";
  const ex = reasoningExcerpt(long);
  assert.ok(ex.endsWith("결론"), "결론은 뒤에 있다 — 뒤를 남겨야 한다");
  assert.ok(ex.length <= REASONING_EXCERPT_CHARS + 1);
});

test("thinkingBudgetNudge: 행동하라는 말과 지금까지의 생각을 담는다", () => {
  assert.match(thinkingBudgetNudge("x를 하면 된다"), /Stop deliberating[\s\S]*x를 하면 된다/);
  assert.doesNotMatch(thinkingBudgetNudge(""), /reasoning so far/);
});

// ── 루프 ─────────────────────────────────────────────────────────────────────

type Script = "overthink" | "answer";

async function run(opts: { budget: number | undefined; scripts: Script[]; enableThinking?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-tbudget-"));
  const requests: ChatCompletionRequest[] = [];
  let i = 0;
  let cancelled = false;
  let cancelCalls = 0;
  const backend: ModelBackend = {
    cancel() {
      cancelled = true;
      cancelCalls++;
    },
    async chat(req, onChunk) {
      if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
      requests.push(JSON.parse(JSON.stringify(req)));
      const script = opts.scripts[Math.min(i, opts.scripts.length - 1)];
      i++;
      if (script === "overthink") {
        cancelled = false;
        // 끝없이 생각만 한다 — 루프가 끊기 전에는 멈추지 않는다.
        for (let n = 0; n < 200; n++) {
          onChunk?.({ choices: [{ delta: { reasoning_content: `step ${n}: ` + "think ".repeat(200) } }] } as any);
          if (cancelled) throw new Error("cancelled by user");
        }
        return { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] } as ChatCompletionResponse;
      }
      onChunk?.({ choices: [{ delta: { content: "답입니다." } }] } as any);
      return { choices: [{ message: { role: "assistant", content: "답입니다." }, finish_reason: "stop" }] } as ChatCompletionResponse;
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
      thinkingBudgetTokens: opts.budget,
      enableThinking: opts.enableThinking,
      onStatus: (s) => status.push(s),
    });
    await loop.send("do it");
    return { status, requests, cancelCalls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("예산을 넘기면 생성을 끊고, 다음 요청은 thinking 을 끄고 지금까지의 생각을 실어 보낸다", async () => {
  const { status, requests, cancelCalls } = await run({ budget: 1000, scripts: ["overthink", "answer"] });
  assert.equal(cancelCalls, 1, "폭주한 생성을 끊지 못했다");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].chat_template_kwargs, undefined, "첫 요청은 thinking 이 켜져 있어야 한다");
  assert.deepEqual(requests[1].chat_template_kwargs, { enable_thinking: false });
  const last = requests[1].messages[requests[1].messages.length - 1];
  assert.equal(last.role, "user");
  assert.match(String(last.content), /Stop deliberating/);
  assert.match(String(last.content), /step \d+: think/, "지금까지의 생각을 넘기지 않았다");
  assert.ok(status.some((s) => s.startsWith("[thinking budget]")), `끊었다고 말하지 않았다: ${JSON.stringify(status)}`);
  assert.ok(!status.some((s) => s.startsWith("[cancelled]")), "예산 중단을 사용자 취소로 보고했다");
  assert.ok(status[status.length - 1].startsWith("[done"), "복구 뒤에 정상 완료해야 한다");
});

test("끈 라운드 다음에는 thinking 이 다시 켜진다 — 한 번만 끈다", async () => {
  const { requests } = await run({ budget: 1000, scripts: ["overthink", "answer", "answer"] });
  // 두 번째 응답이 도구 호출 없는 답이라 턴이 끝난다 — 요청은 2개. 끈 설정이 첫 요청에 새지 않았는지만 본다.
  assert.equal(requests[0].chat_template_kwargs, undefined);
});

test("예산 안에서 끝나는 생각은 건드리지 않는다", async () => {
  const { requests, cancelCalls } = await run({ budget: 10_000_000, scripts: ["answer"] });
  assert.equal(cancelCalls, 0);
  assert.equal(requests.length, 1);
});

test("예산을 주지 않으면(기본) 끊지 않는다 — 기존 동작 그대로", async () => {
  const { cancelCalls, requests } = await run({ budget: undefined, scripts: ["overthink", "answer"] });
  assert.equal(cancelCalls, 0, "예산이 없는데 끊었다");
  assert.ok(requests.length >= 1);
});

test("thinking 을 아예 끈 설정이면 예산도 적용하지 않는다", async () => {
  const { cancelCalls } = await run({ budget: 1000, scripts: ["overthink"], enableThinking: false });
  assert.equal(cancelCalls, 0);
});

test("루프: 끊을 때마다 다음 예산이 커지고, 상한 횟수 뒤에는 더 끊지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-tbudget-esc-"));
  const chunksBeforeCancel: number[] = [];
  const thinkOff: boolean[] = [];
  let cancelled = false;
  let chat = 0;
  const toolCall = (n: number) =>
    ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "nope.txt" }) } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) as unknown as ChatCompletionResponse;
  const backend: ModelBackend = {
    cancel() {
      cancelled = true;
    },
    async chat(req, onChunk) {
      if (!req.tools) return { choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] };
      chat++;
      const off = req.chat_template_kwargs?.enable_thinking === false;
      thinkOff.push(off);
      // 생각을 끈 라운드: 도구를 하나 불러 턴을 이어 간다 (실측: 끊은 뒤 모델은 이렇게 행동했다).
      if (off) return toolCall(chat);
      // 생각을 켠 라운드: 끝없이 생각한다 (≈150 토큰 조각). 끊기지 않으면 400조각 뒤 정상 종료.
      cancelled = false;
      for (let n = 0; n < 400; n++) {
        onChunk?.({ choices: [{ delta: { reasoning_content: "think ".repeat(100) } }] } as any);
        if (cancelled) {
          chunksBeforeCancel.push(n + 1);
          throw new Error("cancelled by user");
        }
      }
      chunksBeforeCancel.push(400);
      return { choices: [{ message: { role: "assistant", content: "끝" }, finish_reason: "stop" }] } as ChatCompletionResponse;
    },
    async listModels() {
      return ["m"];
    },
    async tokenize() {
      return 3;
    },
  };
  try {
    const loop = new AgentLoop({
      projectRoot: dir,
      model: "m",
      backend,
      systemPrompt: "sys",
      thresholds: { autoTriggerRatio: 0.9, contextWindowTokens: 100_000 },
      thinkingBudgetTokens: 600,
    });
    await loop.send("do it");
    // 생각 라운드 4개: 앞 3개는 끊기고(예산 600 → 1200 → 2400), 4번째는 상한이라 끊기지 않고 끝까지 간다.
    assert.equal(chunksBeforeCancel.length, 4, `생각 라운드 수: ${JSON.stringify(chunksBeforeCancel)}`);
    const [a, b, c, d] = chunksBeforeCancel;
    assert.ok(a < b && b < c, `끊기까지의 길이가 늘지 않았다: ${JSON.stringify(chunksBeforeCancel)}`);
    assert.ok(a < 400 && b < 400 && c < 400, "앞 3번은 끊겨야 한다");
    assert.equal(d, 400, "상한 횟수 뒤에도 계속 끊었다 — 끊고-도구-폭주 순환이 안 막힌다");
    assert.deepEqual(thinkOff, [false, true, false, true, false, true, false]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
