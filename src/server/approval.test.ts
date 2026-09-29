/**
 * 승인 게이트 테스트 (§3.6 · §10.3.1).
 *
 * 여기서 통과한다는 것은 "승인 없는 파괴적 명령이 실행되지 않는다"는 뜻이다.
 * 느슨한 곳이 하나라도 있으면 사용자의 파일과 셸이 그대로 노출된다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApprovalGate, DEFAULT_POLICY, riskOf, summarizeArgs } from "./approval.js";

test("화이트리스트에 있으면 즉시 허용 — 읽기 전용 도구는 물어보면 안 된다", async () => {
  const g = new ApprovalGate();
  const seen: string[] = [];
  new ApprovalGate({}, { onDecision: (_r, d) => seen.push(d) });
  g["events"] = { onDecision: (_r, d) => seen.push(d) };
  const d = await g.request({ tool: "read_file", summary: "src/a.ts 읽기" });
  assert.equal(d, "allow-once");
  assert.equal(g.pendingCount, 0, "허용된 요청이 대기열에 남아 있다");
});

test("화이트리스트에 없으면 **대기한다** — 모르는 도구를 자동 허용하지 않는다", async () => {
  const g = new ApprovalGate();
  const asked: unknown[] = [];
  g["events"] = { ...g["events"], onRequest: (r) => asked.push(r) };
  const p = g.request({ tool: "run_shell", summary: "rm -rf build" });
  assert.equal(asked.length, 1, "승인을 요청하지 않았다");
  assert.equal(g.pendingCount, 1);
  const id = (asked[0] as { id: string }).id;
  assert.equal(g.decide(id, "allow-once", "user"), true);
  assert.equal(await p, "allow-once");
});

test("denylist 는 allowlist 보다 먼저다 — 정책이 최종 권한이다", async () => {
  const g = new ApprovalGate();
  g.deny("delete_file");
  const d = await g.request({ tool: "delete_file", summary: "파일 삭제" });
  assert.equal(d, "reject", "거부 목록인데 실행되었다");
  assert.equal(riskOf("delete_file", g.getPolicy()), "deny");
});

test("무응답은 거절이다 — 승인이 더 안전하다", async () => {
  const g = new ApprovalGate({ timeoutSec: 0.05 });
  const p = g.request({ tool: "run_shell", summary: "위험" });
  const d = await p;
  assert.equal(d, "timeout", "타임아웃이 거절로 표현되지 않았다");
  assert.equal(g.pendingCount, 0, "만료된 요청이 대기열에 남았다");
});

test("창이 닫히면 대기 중인 요청은 **즉시 거절**된다 — 좀비 금지", async () => {
  const g = new ApprovalGate({ timeoutSec: 600 });
  const p1 = g.request({ tool: "run_shell", summary: "a" });
  const p2 = g.request({ tool: "git_push", summary: "b" });
  assert.equal(g.pendingCount, 2);
  const rejected = g.rejectAll();
  assert.equal(rejected, 2);
  assert.equal(await p1, "reject");
  assert.equal(await p2, "reject");
  assert.equal(g.pendingCount, 0);
});

test("'항상 허용'은 화이트리스트에 등록된다 — 같은 명령을 매번 묻지 않는다", async () => {
  const g = new ApprovalGate();
  const asked: { id: string }[] = [];
  g["events"] = { ...g["events"], onRequest: (r) => asked.push(r) };
  const p1 = g.request({ tool: "git_commit", summary: "커밋" });
  g.decide(asked[0].id, "allow-always", "user");
  assert.equal(await p1, "allow-always", "결정 결과가 그대로 전달되어야 한다 — 회차/영구 구분");
  // 다음부터는 묻지 않는다
  const p2 = await g.request({ tool: "git_commit", summary: "커밋 2" });
  assert.equal(p2, "allow-once");
  assert.equal(g.pendingCount, 0);
});

test("이미 결정된 요청을 다시 결정할 수 없다 — 이중 실행 방지", async () => {
  const g = new ApprovalGate();
  const asked: { id: string }[] = [];
  g["events"] = { ...g["events"], onRequest: (r) => asked.push(r) };
  const p = g.request({ tool: "run_shell", summary: "x" });
  assert.equal(g.decide(asked[0].id, "allow-once"), true);
  assert.equal(g.decide(asked[0].id, "allow-once"), false, "같은 요청이 두 번 실행됐다");
  await p;
});

test("기본 정책: 위험 도구는 묻고, 읽기 도구는 묻지 않는다", () => {
  assert.equal(riskOf("read_file"), "auto");
  assert.equal(riskOf("list_dir"), "auto");
  assert.equal(riskOf("run_shell"), "ask");
  assert.equal(riskOf("git_push"), "ask");
  assert.equal(riskOf("start_process"), "ask");
  assert.equal(riskOf("delete_file"), "ask", "삭제는 명시적으로 위험을 지정해야 한다");
  assert.equal(DEFAULT_POLICY.timeoutSec, 60);
});

test("세션이 격리된다 — 한 세션의 화이트리스트가 다른 세션/기본값에 새지 않는다", () => {
  // 얕은 복사 버그의 재발 방지: allowlist/denylist 는 배열이라 참조가 공유된다.
  const a = new ApprovalGate();
  const b = new ApprovalGate();
  a.allow("run_shell");
  a.deny("delete_file");
  assert.equal(riskOf("run_shell", b.getPolicy()), "ask", "A 세션의 허용이 B 세션으로 번졌다");
  assert.equal(riskOf("delete_file", b.getPolicy()), "ask", "A 세션의 거부가 B 세션으로 번졌다");
  assert.equal(DEFAULT_POLICY.allowlist.includes("run_shell"), false, "기본값이 오염됐다");
  assert.equal(DEFAULT_POLICY.denylist.includes("delete_file"), false, "기본값이 오염됐다");
  // getPolicy 가 내부 배열을 그대로 주면 밖에서 조작할 수 있다 → 복사본이어야 한다
  const p = b.getPolicy();
  p.allowlist.push("hacked");
  assert.equal(riskOf("hacked", b.getPolicy()), "ask", "getPolicy 가 내부 배열을 노출했다");
});

test("요약은 사람이 읽을 수 있어야 한다 — 인자가 화면에 그대로 나온다", () => {
  assert.match(summarizeArgs({ path: "src/a.ts", line: 12 }), /path=src\/a\.ts/);
  assert.match(summarizeArgs({ cmd: "npm test" }), /cmd=npm test/);
  assert.equal(summarizeArgs(undefined), "(인자 없음)");
  assert.equal(summarizeArgs({}), "(인자 없음)");
});

test("요약에서 시크릿 값을 가린다 — 승인 화면도 스크린샷에 찍힌다", () => {
  const s = summarizeArgs({ apiToken: "abcdef123456", path: "a.ts" });
  assert.equal(s.includes("abcdef123456"), false, `토큰이 노출됐다: ${s}`);
  assert.match(s, /apiToken=ab\*{3}/);
});

test("긴 요약은 자른다 — 승인 화면이 화면 밖으로 밀리면 안 된다", () => {
  const s = summarizeArgs({ cmd: "x".repeat(1000) }, 50);
  assert.ok(s.length <= 51, `길이 ${s.length}`);
  assert.match(s, /…$/);
});
