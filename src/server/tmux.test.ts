import { test } from "node:test";
import assert from "node:assert/strict";
import { Tmux, isManagedName, tmuxEnv, type ExecFn } from "./tmux.js";
import { CliSessions, sessionNameFor } from "./cliSessions.js";

function fake(): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("세션명 규칙 — hs- 접두사와 서버가 만든 형식만 통과한다", () => {
  assert.equal(isManagedName("hs-claude-ab12cd"), true);
  assert.equal(isManagedName("claude"), false);
  assert.equal(isManagedName("opencode"), false);
  assert.equal(isManagedName("hs-claude-ab; rm -rf /"), false);
  assert.equal(isManagedName("hs-Claude-ab12"), false);
  assert.equal(isManagedName("hs-claude-ab"), false);
});

test("hs- 가 아닌 세션은 어떤 변경 메서드도 tmux 를 호출하지 않는다", async () => {
  const f = fake();
  const t = new Tmux({ exec: f.exec, socket: "x" });
  for (const fn of [() => t.kill("claude"), () => t.has("opencode"), () => t.applyWebOptions("claude"), () => t.resize("claude", 80, 24), () => t.newSession({ name: "claude", cwd: "/", cols: 80, rows: 24, command: [] })]) {
    await assert.rejects(fn);
  }
  assert.throws(() => t.attachArgs("claude"));
  assert.equal(f.calls.length, 0);
});

test("명령은 배열 인자로 전달된다 — 셸 문자열로 합치지 않는다", async () => {
  const f = fake();
  const t = new Tmux({ exec: f.exec, socket: "s" });
  await t.newSession({ name: "hs-claude-ab12cd", cwd: "/tmp/a b;c", cols: 100, rows: 30, command: ["claude", "--continue"] });
  assert.deepEqual(f.calls[0], ["tmux", "-L", "s", "new-session", "-d", "-s", "hs-claude-ab12cd", "-c", "/tmp/a b;c", "-x", "100", "-y", "30", "--", "claude", "--continue"]);
  assert.deepEqual(t.attachArgs("hs-claude-ab12cd"), ["-L", "s", "attach-session", "-t", "hs-claude-ab12cd"]);
});

test("TMUX 환경변수는 자식에게 넘기지 않는다(중첩 거부 방지)", () => {
  const e = tmuxEnv({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%1", PATH: "/bin" });
  assert.equal(e.TMUX, undefined);
  assert.equal(e.TMUX_PANE, undefined);
  assert.equal(e.PATH, "/bin");
});

test("list: 서버가 없으면 빈 목록, 옵션이 거절되면 조용히 넘기지 않고 돌려준다", async () => {
  const none: ExecFn = async () => ({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/x" });
  assert.deepEqual(await new Tmux({ exec: none, socket: "x" }).list(), []);
  const bad: ExecFn = async (_f, args) => (args.includes("allow-passthrough") || args.includes("mouse") ? { code: 1, stdout: "", stderr: "invalid option" } : { code: 0, stdout: "", stderr: "" });
  const r = await new Tmux({ exec: bad, socket: "x" }).applyWebOptions("hs-claude-ab12cd");
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!, /mouse/);
});

test("CliSessions.kill — hs- 가 아니면 403, confirm 없으면 미리보기만", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes("list-sessions")) return { code: 0, stdout: "hs-claude-ab12cd\t1700000000\t0\t/tmp\t0\t\nclaude\t1700000000\t1\t/tmp\t0\t\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const cli = new CliSessions({ terminal: { list: () => [], cwd: "/tmp", close: () => ({ ok: true, detail: "" }) } as never, root: () => "/tmp", exec, tmux: new Tmux({ exec, socket: "x" }) });
  const human = await cli.kill("claude", true);
  assert.equal(human.status, 403);
  const preview = await cli.kill("hs-claude-ab12cd", false);
  assert.equal(preview.ok, false);
  assert.ok(preview.preview);
  assert.equal(calls.some((c) => c.includes("kill-session")), false);
  const done = await cli.kill("hs-claude-ab12cd", true);
  assert.equal(done.ok, true);
  assert.equal(calls.filter((c) => c.includes("kill-session")).length, 1);
});

test("cwd 는 루트 밖이면 거절한다(../ 우회 포함)", () => {
  const cli = new CliSessions({ terminal: { cwd: "/tmp", list: () => [] } as never, root: () => "/tmp", exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.equal(cli.checkCwd("/tmp/../etc").ok, false);
  assert.equal(cli.checkCwd("/etc").ok, false);
  assert.equal(cli.checkCwd("/tmp").ok, true);
});

test("같은 provider+cwd 는 같은 세션명, forceNew 접미사는 규칙을 지킨다", () => {
  const a = sessionNameFor("claude", "/x/y");
  assert.equal(a, sessionNameFor("claude", "/x/y"));
  assert.notEqual(a, sessionNameFor("claude", "/x/z"));
  assert.equal(isManagedName(sessionNameFor("claude", "/x/y", "2")), true);
});

import { isYoloSessionName } from "../shared/cliProviders.js";

test("YOLO 세션명은 이름만으로 구분되고 규칙을 지킨다", () => {
  assert.equal(isYoloSessionName("hs-claude-ab12cdy"), true);
  assert.equal(isYoloSessionName("hs-claude-ab12cd"), false);
  assert.equal(isManagedName("hs-claude-ab12cdy"), true);
  assert.equal(isManagedName(sessionNameFor("claude", "/x", "y")), true);
  assert.equal(isYoloSessionName(sessionNameFor("claude", "/x", "y")), true);
  assert.equal(isYoloSessionName(sessionNameFor("claude", "/x", "y1")), true);
  assert.equal(isYoloSessionName(sessionNameFor("claude", "/x", "2")), false);
});

test("start({yolo}) — 확인된 인자로만 시작하고, 인자 없는 CLI 는 거절한다", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes("list-sessions")) return { code: 1, stdout: "", stderr: "no server running" };
    return { code: 0, stdout: "x 1.0", stderr: "" };
  };
  const created: unknown[] = [];
  const terminal = { cwd: "/tmp", list: () => [], create: (o: unknown) => { created.push(o); return { ok: true, session: { id: "t1", title: (o as { title: string }).title }, detail: "" }; }, write: () => ({ ok: true, detail: "" }) };
  const cli = new CliSessions({ terminal: terminal as never, root: () => "/tmp", exec, tmux: new Tmux({ exec, socket: "x" }) });
  const r = await cli.start({ provider: "claude", cwd: "/tmp", yolo: true, resume: true });
  assert.equal(r.ok, true);
  const ns = calls.find((c) => c.includes("new-session"))!;
  assert.deepEqual(ns.slice(ns.indexOf("--")), ["--", "claude", "--dangerously-skip-permissions", "--continue"]);
  assert.match(ns[ns.indexOf("-s") + 1]!, /^hs-claude-[0-9a-f]{6}y$/);
  assert.match((created[0] as { title: string }).title, /YOLO/);
  const g = await cli.start({ provider: "gemini", cwd: "/tmp", yolo: true });
  assert.equal(g.ok, true);
  assert.deepEqual(calls.filter((c) => c.includes("new-session")).pop()!.slice(-3), ["--", "gemini", "--yolo"]);
  const x = await cli.start({ provider: "codex", cwd: "/tmp", yolo: true });
  assert.equal(x.ok, false);
});
