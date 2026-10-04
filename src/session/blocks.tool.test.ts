/**
 * 도구 호출과 그 결과가 **하나의 블록**이어야 한다 (2026-10-01).
 *
 * 실측 출발점: 사용자가 셸 명령 하나를 보냈는데 화면에 **같은 블록이 두 개** 떴다.
 * 로그가 결정적이었다 — 서버는 `kill …` 을 **한 번만** 실행했는데
 * (`[tool] kill 1802867 …` 한 줄), DOM 에 `셸 실행` 이 **2개** 있었다(y=98, y=130).
 * 화면의 두 개는 중복 표시였다.
 *
 * 원인: `agentService` 가 같은 호출을 **두 번** 보낸다.
 *   - `onToolCall`     → `{ done: false }` — 호출
 *   - `onToolCallDone` → `{ done: true }`  — 완료
 * `appendToBlock` 의 `tool` 은 `streamable` 이 아니어서 **항상 새 블록**을 만들었고,
 * 그래서 **명령 하나가 두 블록**으로 그려졌다.
 *
 * 요구: "쉘 실행과 쉘 실행 결과는 하나의 블럭에서 관리가 되어야."
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { appendToBlock, groupTurns, type AgentBlock } from "./blocks.js";

/** 호출/완료 이벤트 한 쌍 — 서버가 실제로 보내는 그대로. */
const call = (at: number, name: string, args: Record<string, unknown> = {}) =>
  appendToBlock([], "tool", "", at, { name, args, done: false });
const done = (blocks: AgentBlock[], at: number, name: string, args: Record<string, unknown> = {}) =>
  appendToBlock(blocks, "tool", "", at, { name, args, done: true });

test("**호출 + 완료** 가 **하나의 블록**이다 — 둘로 나누면 명령이 두 개로 보인다", () => {
  let b = call(100, "run_shell", { command: "ls" });
  assert.equal(b.length, 1, "호출만으로 블록이 둘 이상이다");
  b = done(b, 200, "run_shell", { command: "ls" });
  assert.equal(b.length, 1, `완료가 새 블록을 만들었다 — 총 ${b.length}개`);
  assert.equal(b[0]!.tool?.done, true, "합쳐졌는데 완료 표시가 없다 — '실행 중' 이 남는다");
});

test("**여러 개 명령**은 각각 자신의 블록이다 — 전부 하나가 되면 대화가 못 읽힌다", () => {
  let b = call(100, "run_shell", { command: "a" });
  b = done(b, 150, "run_shell", { command: "a" });
  b = appendToBlock(b, "tool", "", 300, { name: "run_shell", args: { command: "b" }, done: false });
  b = appendToBlock(b, "tool", "", 350, { name: "run_shell", args: { command: "b" }, done: true });
  assert.equal(b.length, 2, `명령 2개가 ${b.length}개 블록이다 — 합치면 어느 것이 끝났는지 모른다`);
});

test("**끝난 블록 다음의** 같은 도구는 새 블록이다 — `done` 이 경계다", () => {
  let b = call(100, "run_shell", { command: "a" });
  b = done(b, 150, "run_shell", { command: "a" });
  // **완료된 뒤** 다시 호출 — 같은 이름이어도 **새 명령**이다.
  b = appendToBlock(b, "tool", "", 400, { name: "run_shell", args: { command: "b" }, done: false });
  assert.equal(b.length, 2, "완료된 명령과 새 명령이 합쳐졌다");
  assert.equal(b[1]!.tool?.done, false, "새 명령이 '완료' 로 표시된다");
});

test("**서로 다른 도구**는 합치지 않는다 — 파일 읽기와 셸 실행이 한 블록이 되면 안 된다", () => {
  let b = call(100, "read_file", { path: "a.ts" });
  b = done(b, 120, "read_file", { path: "a.ts" });
  b = appendToBlock(b, "tool", "", 200, { name: "run_shell", args: { command: "ls" }, done: false });
  b = appendToBlock(b, "tool", "", 220, { name: "run_shell", args: { command: "ls" }, done: true });
  assert.equal(b.length, 2);
  assert.equal(b[0]!.tool?.name, "read_file");
  assert.equal(b[1]!.tool?.name, "run_shell");
});

test("**인자가 남는다** — 합치면서 버리면 끝난 블록에 경로가 없어 에디터가 안 열린다", () => {
  let b = call(100, "read_file", { path: "src/a.ts" });
  b = done(b, 200, "read_file", { path: "src/a.ts" });
  assert.deepEqual(b[0]!.tool?.args, { path: "src/a.ts" }, "완료된 블록에서 인자가 사라졌다");
});

test("**병합 창** 밖이면 새 블록이다 — 오래된 호출을 붙이면 엉뚱한 블록이 된다", () => {
  const MERGE_WINDOW_MS = 4000;
  let b = call(100, "run_shell", { command: "a" });
  b = done(b, 100 + MERGE_WINDOW_MS + 500, "run_shell", { command: "a" });
  // 너무 멀면 **합치지 않는다** — 그래야 멈춘 호출이 뒤따르는 것 같지 않다.
  assert.equal(b.length, 2, `창(${MERGE_WINDOW_MS}ms) 밖인데 합쳐졌다`);
});

test("도구 블록은 **사용자 발화 안**에 속한다 — 묶음 경계는 사람이 한 말이다", () => {
  let b: AgentBlock[] = [{ id: "u", kind: "user", text: "실행해", at: 50 }];
  b = appendToBlock(b, "tool", "", 100, { name: "run_shell", args: { command: "ls" }, done: false });
  b = appendToBlock(b, "tool", "", 150, { name: "run_shell", args: { command: "ls" }, done: true });
  const turns = groupTurns(b);
  assert.equal(turns.length, 1, `도구가 새 묶음을 열었다: ${turns.length}개`);
  // `Turn` 은 `{ prompt, at, blocks, summary }` 다. `turn.blocks` 로 본다 —
  // 배열 그 자체로 보면 `undefined` 가 나오고 **"빈 묶음" 으로 오해**된다.
  // **2개**다: 사용자 발화 1 + 도구 1. 호출과 결과가 합쳐졌으므로 도구가 둘이면
  // 안 된다. 여기를 3으로 쓰면 **중복을 부르는 검사가 된다** — 실제로 그랬다.
  assert.equal(turns[0]!.blocks.length, 2, `한 묶음에 ${turns[0]!.blocks.length}개 — 호출과 결과가 분리됐다`);
  assert.equal(
    turns[0]!.blocks.filter((x) => x.kind === "tool").length,
    1,
    "도구 블록이 둘이다 — 명령 하나가 두 개로 보인다",
  );
});

test("**세 개 이벤트가 와도** 호출·완료는 하나 — 스트리밍 결과까지 붙어도", () => {
  let b = call(100, "run_shell", { command: "npm test" });
  b = appendToBlock(b, "tool", "출력 시작", 150, { name: "run_shell", args: { command: "npm test" }, done: false });
  b = done(b, 900, "run_shell", { command: "npm test" });
  assert.equal(b.length, 1, `${b.length}개 — 진행 중 스트리밍이 블록을 쪼갰다`);
  assert.equal(b[0]!.tool?.done, true);
});

test("이 검사가 **자기 자신을 속이지 않는다** — `done` 경계가 실제로 코드에 있다", () => {
  // 위 창들이 **통과만** 하고 규칙이 무효여도 통과로 보일 수 있다. 그래서
  // **`done !== true` 라는 조건 자체**를 구현에서 찾는다 — 이것이 경계다.
  const src = readFileSync(new URL("./blocks.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /last\.tool\?\.done !== true/,
    "완료된 블록을 합치는 경계가 없다 — 서로 다른 명령이 계속 뭉친다",
  );
});

test("텍스트는 시간 창과 무관하게 이어 붙는다 — 표가 찢어지면 렌더가 깨진다", () => {
  // 실측(2026-10-04): 35B 모델 델타 간격 2529ms > 창 2500ms 라 "| 총 테스트 수 | 1" 과
  // ",569 |" 이 두 블록이 돼 표 전체가 문자로 깨져 보였다. 텍스트는 한 발언이므로
  // 사이가 벌어져도 합친다. 사이에 status·tool 이 끼면 kind 불일치로 새 블록이 된다.
  let b = appendToBlock([], "text", "| 총 테스트 수 | 1", 1000);
  b = appendToBlock(b, "text", ",569 |", 1000 + 2529);
  assert.equal(b.length, 1, "텍스트가 시간 때문에 쪼개졌다");
  assert.match(b[0]!.text, /\| 총 테스트 수 \| 1,569 \|/);
  // 뒤집으면 실패해야 한다: 다시 창을 걸면 같은 실측이 재발한다
  b = appendToBlock(b, "status", "컨텍스트 1/2", 5000);
  b = appendToBlock(b, "text", "다음 말", 5001);
  assert.equal(b.length, 3, "다른 종류 뒤의 텍스트가 합쳐졌다");
});
