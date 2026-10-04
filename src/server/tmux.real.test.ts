/**
 * 실제 tmux 통합 시험 — **전용 소켓**(`-L hs-test-<pid>`)에서만 돈다.
 * 사용자의 기본 tmux 서버와 그 안의 세션(`claude`, `opencode` …)은 건드리지 않는다.
 * tmux 가 없으면 건너뛴다(없다고 실패하지 않는다).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tmux } from "./tmux.js";

const t = new Tmux({ socket: `hs-test-${process.pid}` });
const have = (await t.version()).installed;

test("실제 tmux: 만들기 → 옵션 → 목록 → 종료", { skip: !have && "tmux 없음" }, async () => {
  const name = "hs-shell-test01";
  try {
    await t.newSession({ name, cwd: "/tmp", cols: 100, rows: 30, command: ["sleep", "30"] });
    assert.equal(await t.has(name), true);
    const { rejected } = await t.applyWebOptions(name);
    assert.deepEqual(rejected, [], `거절된 옵션: ${rejected.join("; ")}`);
    const list = await t.list();
    const s = list.find((x) => x.name === name);
    assert.ok(s && s.managed && !s.dead);
    await t.kill(name);
    assert.equal(await t.has(name), false);
  } finally {
    // 전용 소켓의 세션만 정리한다.
    await t.kill(name).catch(() => {});
  }
});
