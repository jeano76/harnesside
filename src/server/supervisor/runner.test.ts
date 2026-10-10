/**
 * 실행층 검사 — 진짜 프로세스·타이머·HTTP 없이, 주입된 가짜로만 돈다.
 *
 * 지키는 것: 기동 신호 없이 성공으로 세지 않는다 · 죽으면 정책대로 다시 띄운다 ·
 * code 0·외부 정지는 다시 띄우지 않는다 · 기동 실패도 crash-loop 에 들어간다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { supervise, type RunnerDeps, type SupervisorChild, type SupervisorEvent } from "./runner.js";
import type { ChildExit } from "./policy.js";

interface Script {
  /** 시도별 종료 상태. 다 쓰면 마지막을 반복한다. */
  exits: ChildExit[];
  /** probeHello 가 true 를 돌려주기까지 필요한 호출 횟수. */
  helloAfter: number;
  /** 시도별 생존 시간(실제 ms). 0이면 스폰 즉시 죽음(부팅 중 사망 재현). */
  dieAfterMs?: number[];
  /**
   * 시도별로 "기동 신호(hello)를 받은 직후 죽는다". 벽시계 ms 로 죽이면 부하가 큰 머신에서 hello 확인보다
   * 죽음이 먼저 와서 판정이 뒤집힌다(전체 테스트 중 실측 flake) — 신호에 맞춰 죽이면 결과가 시간과 무관하다.
   */
  dieAfterHello?: boolean[];
  /** 업데이트 위임 가짜. confirmed 는 확인할 때마다 앞에서부터 소모한다. */
  upgrade?: { confirmed: boolean[]; rollbackOk: boolean; rollbacks: string[] };
}

function rig(script: Script, opts: { bootGraceSec?: number; nowStep?: number } = {}) {
  const events: SupervisorEvent[] = [];
  const spawns: number[] = [];
  const delays: number[] = [];
  let probes = 0;
  let dieNow: (() => void) | null = null;
  let now = 1000;
  const step = opts.nowStep ?? 1;
  const confQueue = [...(script.upgrade?.confirmed ?? [])];
  const deps: RunnerDeps = {
    spawn: (attempt) => {
      spawns.push(attempt);
      const exit = script.exits[Math.min(attempt - 1, script.exits.length - 1)]!;
      const dieMs = script.dieAfterMs?.[Math.min(attempt - 1, (script.dieAfterMs?.length ?? 1) - 1)] ?? 60000;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let resolveExit!: (e: ChildExit) => void;
      const done = new Promise<ChildExit>((res) => {
        resolveExit = res;
      });
      const afterHello = script.dieAfterHello?.[Math.min(attempt - 1, (script.dieAfterHello?.length ?? 1) - 1)] ?? false;
      dieNow = afterHello ? () => setTimeout(() => resolveExit(exit), 1) : null;
      if (dieMs <= 0) resolveExit(exit);
      else timer = setTimeout(() => resolveExit(exit), dieMs);
      const child: SupervisorChild = {
        pid: 4000 + attempt,
        waitExit: () => done,
        kill: () => {
          if (timer) clearTimeout(timer);
          resolveExit(exit);
        },
      };
      return child;
    },
    probeHello: async () => {
      probes++;
      const ok = probes >= script.helloAfter;
      if (ok && dieNow) {
        const go = dieNow;
        dieNow = null;
        go();
      }
      return ok;
    },
    bootGraceSec: opts.bootGraceSec ?? 30,
    pollMs: 1,
    policy: { maxRestarts: 3, windowSec: 300, backoffBaseSec: 2, backoffMaxSec: 60 },
    nowSec: () => now,
    sleepMs: async (ms) => {
      delays.push(ms);
      now += step;
      // 매크로태스크에 양보한다 — 안 그러면 `await` 만 도는 루프가 실제 타이머
      // (외부 정지 같은)를 영원히 굶긴다(2026-10-09 실측 hang).
      await new Promise((res) => setTimeout(res, 0));
    },
    emit: (e) => events.push(e),
    upgrade: script.upgrade
      ? {
          checkConfirmed: async () => {
            const c = confQueue.length > 0 ? confQueue.shift()! : true;
            return c ? { confirmed: true, reason: "소비됨" } : { confirmed: false, reason: "마커 남음" };
          },
          rollback: async () => {
            script.upgrade!.rollbacks.push("rollback");
            return script.upgrade!.rollbackOk ? { ok: true, detail: "되돌림" } : { ok: false, detail: "슬롯 없음" };
          },
        }
      : undefined,
  };
  return { deps, events, spawns, delays, getProbes: () => probes };
}

test("기동 신호가 오고 code 0 으로 끝나면 다시 띄우지 않는다", async () => {
  const r = rig({ exits: [{ code: 0, signal: null }], helloAfter: 2, dieAfterMs: [60000], dieAfterHello: [true] });
  const out = await supervise(r.deps);
  assert.equal(r.spawns.length, 1, `재시작했다: ${JSON.stringify(r.spawns)}`);
  assert.ok(r.events.some((e) => e.type === "boot-healthy"), "기동 성공을 말하지 않았다");
  assert.ok(r.events.some((e) => e.type === "stopped"), "종료를 말하지 않았다");
  assert.match(out.reason, /정상 종료/);
  assert.equal(out.attempts, 1);
});

test("hello 없이 code 0 이면 기동 성공으로 세지 않는다 — 그래도 끝낸다", async () => {
  // 프로세스는 떴는데 앱이 기동 실패하고 조용히 0 으로 끝난 경우.
  // "떴다" 로 세면 고장난 서버를 정상으로 보고한다.
  const r = rig({ exits: [{ code: 0, signal: null }], helloAfter: 9999, dieAfterMs: [0] });
  const out = await supervise({ ...r.deps, bootGraceSec: 0 });
  assert.ok(!r.events.some((e) => e.type === "boot-healthy"), "신호 없이 기동 성공이라 했다");
  assert.ok(r.events.some((e) => e.type === "boot-failed"), "기동 실패를 말하지 않았다");
  assert.equal(r.spawns.length, 1, "code 0 인데 다시 띄웠다");
  assert.match(out.reason, /정상 종료/);
});

test("비정상 종료하면 정책대로 다시 띄운다 — 백오프 포함", async () => {
  const r = rig({ exits: [{ code: 1, signal: null }, { code: 0, signal: null }], helloAfter: 1, dieAfterMs: [0, 60000], dieAfterHello: [false, true] });
  const out = await supervise(r.deps);
  assert.deepEqual(r.spawns, [1, 2]);
  assert.ok(r.delays.includes(2000), `첫 백오프(2초)가 없다: ${JSON.stringify(r.delays)}`);
  assert.ok(
    r.events.some((e) => e.type === "exited" && e.exit === "code 1" && e.delaySec === 2),
    "종료 이벤트에 이유·대기가 없다"
  );
  assert.match(out.reason, /정상 종료/);
});

test("계속 죽으면 멈춘다 — crash-loop (3회 정책이면 4번째 스폰 없음)", async () => {
  const r = rig({ exits: [{ code: 1, signal: null }], helloAfter: 1, dieAfterMs: [0] });
  const out = await supervise(r.deps);
  assert.equal(r.spawns.length, 4, `스폰 횟수가 다르다: ${JSON.stringify(r.spawns)}`);
  assert.match(out.reason, /멈춥/);
  assert.ok(r.events.some((e) => e.type === "stopped"), "멈춤을 말하지 않았다");
});

test("외부 정지는 자식을 죽이고 끝낸다 — 재시작 없음", async () => {
  // helloAfter 를 천문학적으로 둔다 — 가짜 sleep 이 즉시 풀려 부팅 루프가 빨리 돌기 때문이다.
  const r = rig({ exits: [{ code: null, signal: null }], helloAfter: Number.MAX_SAFE_INTEGER, dieAfterMs: [60000] });
  const token = { stop: false };
  const p = supervise({ ...r.deps, stopToken: token, bootGraceSec: 300 });
  // 첫 프로브가 돌도록 양보한 뒤 정지를 요청한다.
  await new Promise((res) => setTimeout(res, 10));
  token.stop = true;
  const out = await p;
  assert.equal(r.spawns.length, 1);
  assert.match(out.reason, /외부 정지/);
});

test("기동 성공 뒤의 정지도 끝낸다 — 대기만 하다 멈추면 안 된다", async () => {
  // 2026-10-09 실기동 회귀: SIGTERM 이 정상 상태에 오면 감시기가 8초 넘게 안 끝났다.
  // 종료 대기에 정지 처리가 없어서였다.
  const r = rig({ exits: [{ code: null, signal: null }], helloAfter: 1, dieAfterMs: [60000] });
  const token = { stop: false };
  const p = supervise({ ...r.deps, stopToken: token, bootGraceSec: 300 });
  await new Promise((res) => setTimeout(res, 10));
  assert.ok(r.events.some((e) => e.type === "boot-healthy"), "기동 성공을 못 봤다");
  token.stop = true;
  const out = await p;
  assert.equal(r.spawns.length, 1, "정지했는데 다시 띄웠다");
  assert.match(out.reason, /외부 정지/);
});

test("코드 42 는 충돌 집계 없이 바로 다시 띄운다 — 마커 확인되면 확정", async () => {
  const up = { confirmed: [] as boolean[], rollbackOk: true, rollbacks: [] as string[] };
  const r = rig({
    exits: [{ code: 42, signal: null }, { code: 0, signal: null }],
    helloAfter: 1,
    dieAfterMs: [60000],
    dieAfterHello: [true],
    upgrade: up,
  });
  const out = await supervise(r.deps);
  assert.deepEqual(r.spawns, [1, 2]);
  assert.ok(
    !r.delays.some((d) => d >= 1000) && !r.events.some((e) => e.type === "exited"),
    `42에 백오프를 걸었다(충돌로 셈): ${JSON.stringify(r.delays)}`
  );
  assert.ok(r.events.some((e) => e.type === "upgrade-restart"), "위임 재기동이 없다");
  assert.ok(r.events.some((e) => e.type === "upgrade-confirmed"), "확정이 없다");
  assert.match(out.reason, /정상 종료/);
});

test("마커 남으면 되돌리고 옛것을 띄운다", async () => {
  const up = { confirmed: [false], rollbackOk: true, rollbacks: [] as string[] };
  const r = rig({
    exits: [{ code: 42, signal: null }, { code: 0, signal: null }],
    helloAfter: 1,
    dieAfterMs: [60000],
    dieAfterHello: [true],
    upgrade: up,
  });
  const out = await supervise(r.deps);
  assert.deepEqual(r.spawns, [1, 2, 3]);
  assert.deepEqual(up.rollbacks, ["rollback"]);
  assert.ok(r.events.some((e) => e.type === "upgrade-rolled-back"), "되돌림이 없다");
  assert.match(out.reason, /정상 종료/);
});

test("새 버전이 안 뜨면 되돌리고 옛것을 띄운다", async () => {
  const up = { confirmed: [] as boolean[], rollbackOk: true, rollbacks: [] as string[] };
  const r = rig({
    exits: [{ code: 42, signal: null }, { code: 0, signal: null }],
    helloAfter: 1,
    dieAfterMs: [60000, 0, 60000],
    dieAfterHello: [true, false, true],
    upgrade: up,
  });
  const out = await supervise(r.deps);
  // 시도2는 스폰 즉시 죽는다 → 기동 실패 → 되돌림 → 시도3 옛것.
  // dieAfterMs[1]=0 은 시도2에만 해당한다.
  assert.ok(r.spawns.length >= 3, `옛것을 안 띄웠다: ${JSON.stringify(r.spawns)}`);
  assert.deepEqual(up.rollbacks, ["rollback"]);
  assert.match(out.reason, /정상 종료/);
});

test("되돌리기 실패하면 멈춘다 — 망가진 채로 돌리지 않는다", async () => {
  const up = { confirmed: [false], rollbackOk: false, rollbacks: [] as string[] };
  const r = rig({
    exits: [{ code: 42, signal: null }],
    helloAfter: 1,
    dieAfterMs: [60000],
    dieAfterHello: [true],
    upgrade: up,
  });
  const out = await supervise(r.deps);
  assert.deepEqual(r.spawns, [1, 2]);
  assert.match(out.reason, /되돌리기 실패/);
});
