/** restore 매핑 검사 — 뒤집으면 실패해야 한다 (2026-10-12 실측 결함 고정). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toAgentBlocks } from "./restore.js";
import { packTool } from "./bridge.js";
import { applyEvent, type AgentBlock } from "./blocks.js";

describe("restore", () => {
  it("도구 블록이 인자·완료 표시를 잃지 않는다", () => {
    const live: AgentBlock[] = applyEvent([], {
      type: "agent.tool",
      text: "seq 1 3\n1\n2\n3\n",
      tool: { name: "run_shell", args: { command: "seq 1 3" }, done: true },
      at: 1000,
    });
    // capture와 같은 모양: packTool 로 저장 형식 만들기
    const stored = live.map((b, i) => ({
      id: b.id,
      kind: b.kind,
      title: b.tool?.name ?? b.kind,
      content: b.text,
      createdAt: b.at,
      tool: b.tool ? packTool(b.tool) : undefined,
    }));
    const back = toAgentBlocks(stored);
    assert.equal(back.length, 1);
    assert.equal(back[0]!.tool?.name, "run_shell", "도구 이름이 없다 — GenericToolBlock 빈 모양이 된다");
    assert.equal(back[0]!.tool?.done, true, "완료 표시가 없다 — '실행 중' 으로 보인다");
    assert.deepEqual(
      (back[0]!.tool?.args as Record<string, unknown> | undefined)?.["command"],
      "seq 1 3",
      "인자가 없다 — 셸 명령·파일 경로를 그릴 수 없다"
    );
    assert.equal(back[0]!.text, live[0]!.text, "출력 텍스트가 바뀌었다");
  });
  it("view 블록은 복원하지 않는다 (모양이 없어 빈 화면만 남는다)", () => {
    const back = toAgentBlocks([{ id: "v1", kind: "view", title: "view", content: "", createdAt: 1 }]);
    assert.deepEqual(back, []);
  });
  it("문자열이 아닌 content 는 title 로 떨어진다 (기존 동작 유지)", () => {
    const back = toAgentBlocks([{ id: "a", kind: "text", title: "답변", content: 42, createdAt: 1 }]);
    assert.equal(back[0]!.text, "답변");
  });
  it("인자가 상한을 넘으면 빼고 사유를 남긴다 (조용히 자르지 않는다)", () => {
    const big = { command: "x".repeat(9000) };
    const packed = packTool({ name: "run_shell", done: true, args: big });
    assert.equal(packed.args, undefined, "큰 인자가 통째로 저장됐다");
    assert.match(packed.argsNote ?? "", /상한/, "잘린 사유가 없다 — 빈 인자로 보인다");
    const back = toAgentBlocks([{ id: "b", kind: "tool", title: "run_shell", content: "out", createdAt: 1, tool: packed }]);
    assert.equal(back[0]!.tool?.name, "run_shell", "이름까지 잃었다");
  });
});
