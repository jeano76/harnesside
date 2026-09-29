/**
 * 프로세스/PTY/취소 테스트 (M1 · M3 · M2 · §10.2).
 *
 * 특히 두 가지를 검증한다:
 *  1. **출력은 오프셋으로 이어 읽는다** — 매번 처음부터 주면 긴 출력이 잘려서
 *     사용자는 어디서 잘렸는지 알 수 없다.
 *  2. **취소는 진행 중인 것까지 멈춘다** — 취소했는데 도구가 계속 돌면 사용자는
 *     버튼을 여러 번 누르고, 결국 프로세스를 수동으로 죽인다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  judgeExit,
  isRunning,
  readFrom,
  appendOutput,
  outputDroppedLabel,
  defaultPty,
  newTurn,
  cancelTurn,
  completeTurn,
  canCancel,
  turnLabel,
  reviewTargets,
  humanTouched,
  READ_CHUNK,
  MAX_KEPT,
  type Proc,
  type ProcFileTouch,
} from "./manage.js";

const p = (over: Partial<Proc> = {}): Proc => ({
  id: "p1",
  title: "npm test",
  command: "npm test",
  cwd: "/w",
  state: "running",
  pid: 1,
  exitCode: null,
  signal: null,
  startedAt: 0,
  endedAt: null,
  cursor: 0,
  bytes: 0,
  dropped: 0,
  ...over,
});

test("종료 코드 0 은 성공 — 다만 \"아직 실행 중\" 과 구분한다", () => {
  const v = judgeExit(p({ state: "exited", exitCode: 0 }));
  assert.equal(v.ok, false, "exit 0 을 성공으로 봤다 — 판정 함수의 ok 는 '처리 성공' 이다");
  assert.equal(v.isError, false);
  assert.match(v.message, /정상 종료/);
  // 실행 중에는 "성공도 실패도 아니다" — 조용히 성공으로 보내면 안 된다
  const running = judgeExit(p());
  assert.match(running.message, /아직 실행 중/);
  assert.equal(running.isError, false, "실행 중을 오류로 표시한다");
});

test("자주 있는 실패 코드를 **사람 말로** 설명한다", () => {
  assert.match(judgeExit(p({ state: "exited", exitCode: 127 })).message, /명령을 찾을 수 없/);
  assert.match(judgeExit(p({ state: "exited", exitCode: 126 })).message, /실행 권한/);
  assert.match(judgeExit(p({ state: "exited", exitCode: 130 })).message, /Ctrl\+C/);
  assert.match(judgeExit(p({ state: "exited", exitCode: 1 })).message, /종료 코드 1/);
  assert.equal(judgeExit(p({ state: "exited", exitCode: 1 })).isError, true);
});

test("**SIGKILL 은 메모리 부족일 수 있다** — 원인이 다르다", () => {
  const v = judgeExit(p({ state: "exited", signal: "SIGKILL" }));
  assert.equal(v.isError, true);
  assert.match(v.message, /메모리 부족/);
  // 다른 시그널에는 그 문장을 붙이지 않는다
  assert.equal(/메모리 부족/.test(judgeExit(p({ state: "exited", signal: "SIGTERM" })).message), false);
});

test("시그널 종료는 **실패** — 코드가 없는데 성공으로 오인하면 안 된다", () => {
  const v = judgeExit(p({ state: "exited", exitCode: null, signal: "SIGTERM" }));
  assert.equal(v.isError, true);
  assert.match(v.message, /SIGTERM/);
});

test("사용자 중단은 **오류가 아니다** — 도구가 실패한 게 아니므로", () => {
  const v = judgeExit(p({ state: "killed" }));
  assert.equal(v.isError, false);
  assert.match(v.message, /사용자가 중단/);
  // 시작 실패는 오류다
  assert.equal(judgeExit(p({ state: "failed" })).isError, true);
});

test("실행 중 판정", () => {
  assert.equal(isRunning(p({ state: "running" })), true);
  assert.equal(isRunning(p({ state: "starting" })), true);
  assert.equal(isRunning(p({ state: "exited" })), false);
  assert.equal(isRunning(p({ state: "killed" })), false);
});

test("출력은 **오프셋으로 이어 읽는다** — 잘린 지점을 알 수 있어야 한다", () => {
  const out = "A".repeat(100) + "B".repeat(100);
  const r1 = readFrom(out, 0, 50);
  assert.equal(r1.text, "A".repeat(50));
  assert.equal(r1.more, true, "더 있는데 없다고 했다");
  assert.equal(r1.nextCursor, 50);
  // 두 번째 읽기는 **이어서** — 50~100 은 여전히 A 구간이다
  const r2 = readFrom(out, r1.nextCursor, 50);
  assert.equal(r2.text, "A".repeat(50));
  // 100 부터가 B 구간
  const r3 = readFrom(out, r2.nextCursor, 50);
  assert.equal(r3.text, "B".repeat(50));
  const r4 = readFrom(out, r3.nextCursor, READ_CHUNK);
  assert.equal(r4.text, "B".repeat(50));
  assert.equal(r4.more, false);
  // 전부 읽은 뒤 같은 오프셋을 다시 주면 빈 문자열 (중복이 아니다)
  assert.equal(readFrom(out, out.length).text, "");
});

test("오프셋이 범위를 벗어나도 **예외 없이** 읽는다", () => {
  const out = "abc";
  assert.equal(readFrom(out, -5).text, "abc");
  assert.equal(readFrom(out, 999).text, "");
  assert.equal(readFrom(out, 1).nextCursor, 3);
});

test("출력 상한: **앞을 버리고 최신을 남긴다** — 어디서 잘렸는지 말해야 한다", () => {
  let r = { text: "", dropped: 0 };
  r = appendOutput(r, "A".repeat(MAX_KEPT - 10));
  assert.equal(r.dropped, 0);
  r = appendOutput(r, "B".repeat(100));
  assert.equal(r.dropped, 90, "잘린 바이트를 세지 않았다");
  assert.equal(r.text.length, MAX_KEPT);
  // **가장 최근 100바이트는 반드시 B** — 그것이 "최신을 남긴다" 의 의미다.
  assert.match(r.text, /B{100}$/, "최신 출력이 남지 않았다");
  assert.match(r.text, /^A/, "앞부분이 잘렸다 — 상한이 최신을 우선한다는 규칙과 반대다");
  const label = outputDroppedLabel(r);
  assert.ok(label, "잘렸는데 말하지 않는다");
  assert.match(label!, /상한/);
  // 자르지 않았으면 경고가 없다
  assert.equal(outputDroppedLabel({ text: "짧다", dropped: 0 }), null);
});

test("PTY 기본값: 크기가 0 이면 **이상모드** — 최소선을 잡는다", () => {
  const o = defaultPty("/w", { PATH: "/bin" });
  assert.ok(o.cols >= 20 && o.rows >= 5);
  // **TERM 이 없으면 색과 진행바가 사라진다**
  assert.equal(o.env.TERM, "xterm-256color");
  assert.equal(o.cwd, "/w");
  // 사용자가 준 TERM 은 존중한다
  assert.equal(defaultPty("/w", { TERM: "dumb" }).env.TERM, "dumb");
});

test("M3: 취소는 **진행 중인 것을 전부** 멈춘다", () => {
  const t = newTurn("t1");
  const withWork = { ...t, running: ["tool-a", "proc-b"] };
  const { turn, toAbort } = cancelTurn(withWork);
  assert.deepEqual(toAbort, ["tool-a", "proc-b"], "멈추지 않은 것이 있다");
  assert.equal(turn.state, "cancelled");
  assert.equal(turn.running.length, 0);
  assert.match(turnLabel(turn), /중단됨/);
  assert.match(turn.note ?? "", /2개 작업 중단/);
});

test("취소는 **항상 가능**해야 한다 — 그리고 이미 끝난 턴에는 중복되지 않는다", () => {
  const t = newTurn("t1");
  assert.equal(canCancel(t), true);
  const done = completeTurn(t, true);
  assert.equal(canCancel(done), false);
  const cancelled = cancelTurn(t).turn;
  assert.equal(canCancel(cancelled), false, "이미 취소한 턴을 또 취소할 수 있다");
  // 종료된 턴에 취소해도 상태가 바뀌지 않는다
  const again = cancelTurn(cancelled);
  assert.equal(again.toAbort.length, 0);
  assert.equal(again.turn.state, "cancelled");
});

test("취소불가로 표시된 턴은 취소를 **거부**한다", () => {
  const t = { ...newTurn("t1"), cancellable: false };
  const r = cancelTurn(t);
  assert.deepEqual(r.toAbort, []);
  assert.equal(r.turn.state, "running");
});

test("턴 상태 라벨이 **무엇을 하고 있는지** 말한다(§11.3)", () => {
  assert.match(turnLabel(newTurn("t")), /실행 중/);
  assert.match(turnLabel({ ...newTurn("t"), state: "cancelling" }), /중단 중/);
  assert.equal(turnLabel(completeTurn(newTurn("t"), true)), "완료");
  assert.equal(turnLabel(completeTurn(newTurn("t"), false)), "실패");
  // "멈춘 것처럼 보이지 않는다" — 개수가 있으면 말한다
  assert.match(turnLabel({ ...newTurn("t"), running: ["a", "b", "c"] }), /\(3개 작업\)/);
});

test("M2: **프로세스가 만든 파일**만 검토 대상으로 모은다", () => {
  const t: ProcFileTouch[] = [
    { path: "src/a.ts", byProcess: "npm test" },
    { path: "notes.md", byProcess: null },
    { path: "dist/b.js", byProcess: "npm test" },
  ];
  assert.deepEqual(reviewTargets(t).map((x) => x.path), ["src/a.ts", "dist/b.js"]);
  assert.deepEqual(humanTouched(t).map((x) => x.path), ["notes.md"]);
});
