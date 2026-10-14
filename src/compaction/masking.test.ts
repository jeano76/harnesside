import { test } from "node:test";
import assert from "node:assert/strict";
import { maskObservations, MASK_MARKER } from "./masking.js";
import type { ChatMessage } from "../backend/types.js";

const call = (id: string, name: string, args = "{}"): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});
const result = (id: string, content: string): ChatMessage => ({ role: "tool", tool_call_id: id, content });
const convo = (n: number, size = 2000): ChatMessage[] => [
  { role: "user", content: "do it" },
  ...Array.from({ length: n }, (_, i) => [call(`c${i}`, "read_file", `{"path":"f${i}"}`), result(`c${i}`, `line${i} ` + "x".repeat(size))]).flat(),
];

test("masks old tool outputs but protects the most recent N, and labels what they were", () => {
  const r = maskObservations(convo(10), { keepRecentToolResults: 4 });
  assert.equal(r.maskedCount, 6);
  const tools = r.messages.filter((m) => m.role === "tool");
  assert.ok(tools.slice(0, 6).every((m) => String(m.content).startsWith(MASK_MARKER)));
  assert.ok(String(tools[0].content).includes("read_file"), "label names the tool call");
  assert.ok(tools.slice(6).every((m) => !String(m.content).startsWith(MASK_MARKER)), "recent outputs untouched");
  assert.ok(r.savedTokens > 0);
});

test("never touches assistant/user text, tool_calls, or message order/ids", () => {
  const input = convo(8);
  const r = maskObservations(input, { keepRecentToolResults: 2 });
  assert.equal(r.messages.length, input.length);
  r.messages.forEach((m, i) => {
    assert.equal(m.role, input[i].role);
    assert.equal(m.tool_call_id, input[i].tool_call_id);
    assert.deepEqual(m.tool_calls, input[i].tool_calls);
    if (m.role !== "tool") assert.equal(m.content, input[i].content);
  });
});

test("does not mutate its input, and is idempotent", () => {
  const input = convo(8);
  const snapshot = JSON.stringify(input);
  const once = maskObservations(input);
  assert.equal(JSON.stringify(input), snapshot);
  const twice = maskObservations(once.messages);
  assert.equal(twice.maskedCount, 0);
  assert.equal(twice.messages, once.messages);
});

test("short outputs and disabled masking are left alone; errors keep a longer head", () => {
  assert.equal(maskObservations(convo(8, 50)).maskedCount, 0);
  assert.equal(maskObservations(convo(8), { enabled: false }).maskedCount, 0);
  const msgs = [call("a", "run_shell"), result("a", "Error: ENOENT " + "y".repeat(2000)), ...convo(6).slice(1)];
  const r = maskObservations(msgs, { keepRecentToolResults: 2, keepChars: 100 });
  const errOut = String(r.messages[1].content);
  const plain = String(r.messages[3].content);
  assert.ok(errOut.length > plain.length, "error output keeps 3x head");
});

test("needTokens masks only as many as needed, oldest first; the rest stay verbatim", () => {
  const input = convo(10);
  const all = maskObservations(input, { keepRecentToolResults: 2 });
  assert.equal(all.maskedCount, 8);
  const some = maskObservations(input, { keepRecentToolResults: 2, needTokens: 1 });
  assert.equal(some.maskedCount, 1, "one is enough to cover a 1-token need");
  const tools = some.messages.filter((m) => m.role === "tool");
  assert.ok(String(tools[0].content).startsWith(MASK_MARKER), "the OLDEST output is the one masked");
  assert.ok(tools.slice(1).every((m) => !String(m.content).startsWith(MASK_MARKER)), "everything newer is kept verbatim");
  const half = maskObservations(input, { keepRecentToolResults: 2, needTokens: Math.floor(all.savedTokens / 2) });
  assert.ok(half.maskedCount > 1 && half.maskedCount < 8, `got ${half.maskedCount}`);
});

test("archivePath is named in the placeholder and the original is returned for archiving", () => {
  const r = maskObservations(convo(6), { keepRecentToolResults: 2, archivePath: "/p/archive/x.txt" });
  const first = r.messages.find((m) => m.role === "tool")!;
  assert.match(String(first.content), /read_file \/p\/archive\/x\.txt and look for "entry c0"/);
  assert.equal(r.archived.length, 4);
  assert.ok(r.archived[0].text.startsWith("line0 "), "the archived text is the untouched original");
  assert.ok(!String(maskObservations(convo(6)).messages.find((m) => m.role === "tool")!.content).includes("FULL text is saved"), "no path claimed when none given");
});
