/**
 * 터미널 세션 테스트 (M1).
 *
 * 이 모듈에서 가장 값진 검사는 **PTY 를 띄우지 않아도 되는 것들** 다:
 * 열지 못한 셸, 이미 죽은 탭, 한도를 넘긴 상태 — 사용자는 이 셋을 자주 본다.
 * "빈 화면" 으로 보이는 경우가 바로 그 셋이다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager, exitLabel, type TerminalSession } from "./terminal.js";

async function root() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-term-"));
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

type Ev = { data: string[]; exits: TerminalSession[]; warns: string[] };

function mgr(dir: string, over: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) {
  const ev: Ev = { data: [], exits: [], warns: [] };
  const m = new TerminalManager({
    root: dir,
    events: {
      onData: (id, d) => ev.data.push(`${id}:${d}`),
      onExit: (s) => ev.exits.push(s),
      onWarn: (msg) => ev.warns.push(msg),
    },
    ...over,
  });
  return { m, ev };
}

/** 열었을 때 — 실패면 그 사실 자체를 테스트가 실패로 보이게 한다. */
function opened(m: TerminalManager, opts?: { cwd?: string; cols?: number; rows?: number }): TerminalSession {
  const r0 = m.create(opts);
  assert.equal(r0.ok, true, `셸을 못 열었다: ${r0.detail}`);
  return r0.session as TerminalSession;
}

/** 출력이 올 때까지 기다린다(PTY 는 비동기). 타임아웃이면 false. */
async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return fn();
}

test("셸을 열면 **cwd 가 루트 안** 이고 살아 있다", async () => {
  const r = await root();
  const { m } = mgr(r.dir);
  try {
    const s = opened(m);
    assert.equal(s.state, "running");
    assert.equal(s.cwd, r.dir);
    assert.equal(s.exitCode, null, "살아 있는데 종료 코드가 있다");
    assert.equal(s.exitedAt, null);
    assert.equal(exitLabel(s), null, "살아 있는 탭에 종료 문장이 붙는다");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("cwd 를 루트 밖으로 줘도 **루트로 떨어뜨린다** — 새지 않는다", async () => {
  const r = await root();
  const { m } = mgr(r.dir);
  try {
    assert.equal(opened(m, { cwd: "/etc" }).cwd, r.dir, "루트 밖의 cwd 를 그대로 받았다");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("cwd 안쪽 하위 디렉터리는 **그대로 쓴다** — 막으면 탐색기가 쓸모없다", async () => {
  const r = await root();
  const sub = join(r.dir, "src");
  await mkdir(sub, { recursive: true });
  const { m } = mgr(r.dir);
  try {
    assert.equal(opened(m, { cwd: sub }).cwd, sub);
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("입력을 보내면 **그 출력이 온다** — 셸이 실제로 살아 있다", async () => {
  const r = await root();
  const { m, ev } = mgr(r.dir);
  try {
    const s = opened(m);
    assert.equal(m.write(s.id, "echo HARNESSIDE_PTY_OK\n").ok, true);
    const got = await until(() => ev.data.some((d) => d.includes("HARNESSIDE_PTY_OK")));
    assert.equal(got, true, `PTY 출력이 오지 않았다: ${ev.data.join("").slice(0, 200)}`);
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("종료하면 **exit code 를 보존** 한다 — 0 과 '없음' 이 다르다", async () => {
  const r = await root();
  const { m, ev } = mgr(r.dir);
  try {
    const s = opened(m);
    m.write(s.id, "exit 3\n");
    assert.equal(await until(() => ev.exits.length > 0), true, "종료 이벤트가 오지 않았다");
    const dead = m.get(s.id)!;
    assert.equal(dead.state, "exited");
    assert.equal(dead.exitCode, 3, `exit code 가 보존되지 않았다: ${dead.exitCode}`);
    assert.equal(dead.exitedAt !== null, true, "종료 시각이 없다");
    assert.equal(exitLabel(dead), "종료됨 (3)");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("정상 종료는 **'신호로 종료(0)' 가 되지 않는다** — node-pty 의 0 은 신호 없음이다", async () => {
  // 실측: node-pty 은 정상 종료에도 `signal: 0` 을 준다. 그대로 노출하면
  // "신호로 종료 (0)" 이라는 **이름을 모르는 죽음** 이 되고, 진짜 신호(1 이상)와
  // 같은 칸에 놓인다.
  const r = await root();
  const { m, ev } = mgr(r.dir);
  try {
    const s = opened(m);
    m.write(s.id, "exit 0\n");
    await until(() => ev.exits.length > 0);
    assert.equal(m.get(s.id)!.exitCode, 0);
    assert.equal(m.get(s.id)!.exitSignal, null, "신호 0 을 신호로 기록했다");
    assert.equal(exitLabel(m.get(s.id)!), "종료됨 (0)");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("죽은 탭에 쓰면 **버리지 않고 말한다** — 조용히 버리면 입력 소모처럼 보인다", async () => {
  const r = await root();
  const { m, ev } = mgr(r.dir);
  try {
    const s = opened(m);
    m.write(s.id, "exit 0\n");
    await until(() => ev.exits.length > 0);
    const w = m.write(s.id, "echo 안 통함\n");
    assert.equal(w.ok, false);
    assert.match(w.detail, /끝난/, "왜 안 됐는지 말하지 않는다");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("탭이 **여러 개** 다 — 하나를 닫아도 나머지 산다", async () => {
  const r = await root();
  const { m } = mgr(r.dir);
  try {
    const a = opened(m);
    const b = opened(m);
    const c = opened(m);
    assert.equal(m.list().length, 3);
    // **최근 쓴 탭이 먼저** — 화면이 그 순서를 가정한다.
    assert.deepEqual(
      m.list().map((x) => x.id),
      [c.id, b.id, a.id],
      "탭 순서가 최근-쓴-순서가 아니다"
    );
    m.close(b.id);
    assert.equal(m.list().length, 2);
    assert.equal(m.get(b.id), null, "닫은 탭이 목록에 남았다");
    assert.equal(m.get(a.id)?.state, "running", "다른 탭까지 죽었다");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("탭 한도 넘으면 **열지 않았다고 말한다** — 다른 탭을 넘기면 안 된다", async () => {
  const r = await root();
  const { m, ev } = mgr(r.dir, { maxTabs: 2 });
  try {
    const a = opened(m);
    const b = opened(m);
    const third = m.create();
    assert.equal(third.ok, false, "한도를 넘었는데 열린 척했다");
    assert.equal(third.session, null, "실패인데 세션을 돌려줬다");
    assert.match(third.detail, /2개/, `사유가 없다: ${third.detail}`);
    assert.equal(m.list().length, 2, "목록에 없는 탭이 들어갔다");
    assert.ok(ev.warns.some((w) => /2개/.test(w)), `경고가 없다: ${ev.warns.join("|")}`);
    // **죽은 탭은 한도에서 빠져야 한다** — 아니면 닫은 만큼 열어도 열리지 않는다.
    m.close(a.id);
    assert.equal(m.create().ok, true, "빈 자리를 못 채웠다");
    assert.equal(m.get(b.id)?.state, "running");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("resize 하면 **크기가 갱신** 된다 — 줄이 깨지면 사용자가 안다", async () => {
  const r = await root();
  const { m } = mgr(r.dir);
  try {
    const s = opened(m, { cols: 80, rows: 24 });
    const r1 = m.resize(s.id, 120, 40);
    assert.equal(r1.ok, true, r1.detail);
    assert.equal(m.get(s.id)!.cols, 120);
    assert.equal(m.get(s.id)!.rows, 40);
    // 비정상 크기는 **고정한다** — 0 행이면 셸이 죽는다.
    m.resize(s.id, 0, 0);
    assert.equal(m.get(s.id)!.rows, 5, "0 행을 그대로 보냈다");
    assert.equal(m.get(s.id)!.cols, 20);
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("죽은 셸에 resize 하면 **버리지 않고 말한다**", async () => {
  const r = await root();
  const { m, ev } = mgr(r.dir);
  try {
    const s = opened(m);
    m.write(s.id, "exit 0\n");
    await until(() => ev.exits.length > 0);
    const r1 = m.resize(s.id, 100, 30);
    assert.equal(r1.ok, false);
    assert.match(r1.detail, /살아 있는 셸/);
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("셸을 못 열면 **왜인지 말하고 아무것도도 만들지 않는다**", async () => {
  // 실측: node-pty 는 없는 셸에 대해 **throw 하지 않는다.** PTY 를 열고
  // `execvp(3) failed.` 를 화면에 찍고 exit 1 한다. 즉 사용자는 탭이 열렸다가
  // 사라지는 것만 보고 "터미널이 고장났다" 고 판단한다. 그래서 openError 로 구분한다.
  const r = await root();
  const { m, ev } = mgr(r.dir, { shell: "/nonexistent/shell" });
  try {
    const s = opened(m);
    assert.equal(await until(() => !!m.get(s.id)?.openError || !!m.get(s.id) && m.get(s.id)!.state === "exited"), true, "셸이 끝났는데 아무 말도 하지 않았다");
    const dead = m.get(s.id)!;
    assert.equal(dead.openError !== null, true, "열지 못한 사실이 기록되지 않았다");
    assert.match(String(dead.openError), /execvp|no such file/i, `사유가 원본이 아니다: ${dead.openError}`);
    assert.match(exitLabel(dead) ?? "", /셸 열기 실패/, `종료와 실행 실패를 구분 못 한다: ${exitLabel(dead)}`);
    assert.ok(ev.warns.length > 0, "경고가 없다");
  } finally {
    m.shutdown();
    await r.cleanup();
  }
});

test("shutdown 은 **살아 있는 탭 수** 를 말하고 전부 죽인다", async () => {
  const r = await root();
  const { m } = mgr(r.dir);
  try {
    opened(m);
    opened(m);
    assert.equal(m.shutdown(), 2, "죽인 탭 수를 말하지 않는다");
    assert.equal(m.list().length, 0, "죽은 뒤에도 목록에 남았다");
    assert.equal(m.shutdown(), 0, "두 번 부르면 0 이어야 한다");
  } finally {
    await r.cleanup();
  }
});
