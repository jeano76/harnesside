/**
 * 대화 **묶음(turn)** 테스트 (2026-10-01).
 *
 * 요구: "답변은 하나의 묶음인거고 파일을 여는것, DIFF 해주는거, 쉘을 구동하거나
 * 도구를 구동하는 것 모두 하나의 대화 덩어리처럼 보여주고"
 *
 * 즉 묶음의 경계가 **사람이 보낸 말** 이고, 그 뒤의 모든 것이 그 안에 든다.
 * 경계 규칙이 **여러 곳에 있으면** 대화가 저녁마다 다르게 나뉜다 — 그래서 정본
 * 함수 하나를 두고 여기서 그 규칙을 고정한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyEvent, groupTurns, normalizeTool, openView, summarizeTurn, toolCommand, toolPath, type AgentBlock } from "./blocks.js";

const b = (kind: AgentBlock["kind"], text: string, at: number, extra: Partial<AgentBlock> = {}): AgentBlock => ({
  id: `${kind}-${at}`,
  kind,
  text,
  at,
  ...extra,
});

test("사람이 보낸 말에서 **묶음이 나뉜다** — 그 뒤의 모든 것이 같은 묶음이다", () => {
  const blocks: AgentBlock[] = [
    b("user", "첫 질문", 1),
    b("reasoning", "…", 2),
    b("tool", "", 3, { tool: { name: "read_file", done: true, args: { path: "a.ts" } } }),
    b("text", "답변", 4),
    b("user", "둘째 질문", 10),
    b("tool", "", 11, { tool: { name: "run_shell", done: true, args: { command: "npm test" } } }),
    b("text", "두번째 답변", 12),
  ];
  const turns = groupTurns(blocks);
  assert.equal(turns.length, 2, `묶음이 ${turns.length} 개 — 사람 말을 경계로 세어야 한다`);
  assert.equal(turns[0].prompt, "첫 질문");
  assert.equal(turns[1].prompt, "둘째 질문");
  // **도구·파일이 그 묶음 안에 있어야 한다** — 이것이 요구의 핵심이다.
  assert.equal(turns[0].blocks.length, 4, "첫 묶음에 사고·도구·답변이 모두 있어야 한다");
  assert.equal(turns[1].blocks.length, 3);
});

test("묶음의 요약은 **한 일의 종류**를 말한다 — 개수가 아니라 사실", () => {
  const t = summarizeTurn([
    b("user", "질문", 1),
    b("tool", "", 2, { tool: { name: "read_file", done: true, args: { path: "a.ts" } } }),
    b("tool", "", 3, { tool: { name: "read_file", done: true, args: { path: "b.ts" } } }),
    b("tool", "", 4, { tool: { name: "run_shell", done: true, args: { command: "npm test" } } }),
  ]);
  assert.match(t, /파일 2/, `파일을 두 개 열었는데 요약이 안 보인다: ${t}`);
  assert.match(t, /셸 1/, `셸을 돌렸는데 요약이 안 보인다: ${t}`);
});

test("**묶음 앞의 블록**(세션 복원 잔여)을 버리지 않는다", () => {
  // 버리면 사용자는 "내 대화가 잘렸다" 고 읽는다(§5.10).
  const turns = groupTurns([b("text", "이전 답변", 1), b("user", "새 질문", 2)]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, "", "묶음 앞은 제목을 만들지 않는다 — 무엇에 대한 답인지 모른다");
  assert.equal(turns[0].blocks[0].text, "이전 답변", "이전 답변이 사라졌다");
});

test("사람이 연 **파일도 그 묶음 안**에 들어간다 — 같은 대화 덩어리다", () => {
  const blocks = openView([b("user", "파일 봐", 1)], { what: "file", path: "src/x.ts" }, 2);
  const turns = groupTurns(blocks);
  assert.equal(turns.length, 1, "파일 열람이 새 묶음을 시작하게 했다");
  assert.ok(turns[0].blocks.some((x) => x.kind === "view"), "파일 블록이 묶음에 없다");
  assert.match(turns[0].summary, /파일 1/);
});

test("같은 것을 **두 번 열면 하나로** — 화면에 두 번 쌓이지 않는다", () => {
  const once = openView([b("user", "q", 1)], { what: "settings" }, 2);
  const twice = openView(once, { what: "settings" }, 3);
  assert.equal(twice.length, once.length, "같은 설정을 두 번 열었다");
  // **다른 것**은 또 열어야 한다.
  const other = openView(twice, { what: "diff" }, 4);
  assert.equal(other.length, once.length + 1, "변경 검토는 따로 열린다");
});

test("서버가 보내는 `args` 는 **문자열** — 객체로 펴야 화면이 그릴 수 있다", () => {
  const n = normalizeTool({ name: "read_file", args: '{"path":"src/a.ts"}', done: true });
  assert.equal(n?.path, "src/a.ts");
  assert.equal(toolPath(n?.args), "src/a.ts");
  // **파싱 실패는 "모른다"** — 빈 객체로 채우면 경로가 없는 블록이 생기고,
  // 사용자는 "파일을 못 읽는다" 를 화면 문제로 오인한다.
  const bad = normalizeTool({ name: "x", args: "not json" });
  assert.equal(bad?.args, undefined, "깨진 JSON 을 빈 객체로 만들었다");
  assert.equal(bad?.path, undefined, "깨진 JSON 에서 경로를 지어냈다");
});

test("셸 인자를 **여러 키 이름**에서 찾는다 — 도구마다 이름이 다르다", () => {
  assert.equal(toolCommand({ command: "npm test" }), "npm test");
  assert.equal(toolCommand({ cmd: "ls" }), "ls");
  assert.equal(toolCommand({ nothing: 1 }), null, "없는 인자를 지어냈다");
});

test("`agent.user` 이벤트가 **사람 말 블록**을 만든다 — 묶음의 경계", () => {
  const blocks = applyEvent([], { type: "agent.user", text: "뭐해", at: 5 });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "user", `kind 가 ${blocks[0].kind} — 묶음의 경계가 없다`);
  assert.equal(blocks[0].text, "뭐해");
});
