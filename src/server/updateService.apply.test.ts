/**
 * 업데이트 **적용** 실측 — 교체 → 부팅 확인 → 실패 시 롤백.
 *
 * 여기서 실행 파일을 **실제 바이너리로 쓰지 않는다.** temp 디렉터리에 가짜 실행
 * 파일을 만들고 그게 "부팅" 하는지 안 하는지를 정하게 한다. 그러면 두 경우를
 * **같은 머신에서** 볼 수 있고, 실패 경로가 실제로 파일을 되돌리는지 확인할 수 있다.
 *
 * 세 가지를 본다:
 *  1. 새 버전이 기동하면 **성공** — 그리고 그 파일이 그대로 있다.
 *  2. 새 버전이 기동하지 못하면 **되돌림** — 그리고 **옛 파일 내용이 돌아온다**.
 *  3. 되돌릴 곳이 없으면 **시도조차 하지 않는다**(교체 전 파일이 사라진다).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateService } from "./updateService.js";
import { DEFAULT_ROLLBACK } from "./update/pipeline.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-apply-"));
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

/** 실행 파일처럼 보이는 셸 스크립트 — 내용이 곧 버전이다. */
async function fakeBin(p: string, body: string): Promise<string> {
  await writeFile(p, body, "utf8");
  await chmod(p, 0o755);
  return p;
}

function svc(dir: string, over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  return new UpdateService({
    currentVersion: "0.1.0",
    slotsDir: join(dir, "slots"),
    selfPath: join(dir, "harnesside"),
    fetchImpl: (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch,
    guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: false, daemon: true, estimatedSeconds: 3, assetBytes: 1024 }),
    ...over,
  });
}

test("새 버전이 **기동하면 성공** — 그리고 그 파일이 실제로 놓인다", async () => {
  const s = await sandbox();
  try {
    await fakeBin(join(s.dir, "harnesside"), "#!/bin/sh\necho '버전 0.1.0'\n");
    await fakeBin(join(s.dir, "new"), "#!/bin/sh\necho '버전 0.2.0'\n");
    const up = svc(s.dir, {
      guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: true, daemon: true, estimatedSeconds: 3, assetBytes: 1024 }),
    });
    const restarts: string[] = [];
    const r = await up.apply({
      newBinary: join(s.dir, "new"),
      probeHello: async () => true, // 새 프로세스가 살아 있다
      restart: async () => void restarts.push("restart"),
      now: (() => {
        let t = 1_000_000;
        return () => (t += 200); // 200ms 진행
      })(),
      policy: { enabled: true, bootGraceSec: 90 },
    });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.rolledBack, false);
    assert.equal(r.verdict, "healthy");
    // **교체만으로는 아무것도 바뀌지 않는다.** 재기동이 없으면 성공 보고만 하고
    // 옛 프로세스가 계속 돈다(실측으로 확인된 순서 버그).
    assert.equal(restarts.length, 1, "교체 후 재기동을 안 했다 — 새 버전이 실행된 적 없다");
    assert.equal(await readFile(join(s.dir, "harnesside"), "utf8"), "#!/bin/sh\necho '버전 0.2.0'\n", "교체가 반영되지 않았다");
    // **실행 가능해야 한다** — mode 가 없으면 되돌린 파일이 바로 실패한다.
    assert.equal((await stat(join(s.dir, "harnesside"))).mode & 0o111, 0o111, "실행 권한이 없다");
  } finally {
    await s.cleanup();
  }
});

test("기동하지 못하면 **되돌린다** — 그리고 옛 내용이 돌아온다", async () => {
  const s = await sandbox();
  try {
    const OLD = "#!/bin/sh\necho '버전 0.1.0 — 살아있다'\n";
    await fakeBin(join(s.dir, "harnesside"), OLD);
    await fakeBin(join(s.dir, "new"), "#!/bin/sh\necho '버전 0.2.0 — 기동 실패'\nexit 1\n");
    const up = svc(s.dir, {
      guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: true, daemon: true, estimatedSeconds: 3, assetBytes: 1024 }),
    });
    const restarts: string[] = [];
    const ticks: number[] = [];
    let t = 1_000_000;
    const r = await up.apply({
      newBinary: join(s.dir, "new"),
      probeHello: async () => false, // 새 버전이 헬스를 응답하지 않는다
      restart: async () => void restarts.push("restart"),
      onTick: (s2) => ticks.push(s2),
      now: () => (t += 1_000), // 1초씩 → grace 를 넘긴다
      policy: { enabled: true, bootGraceSec: 3 },
    });
    assert.equal(r.ok, false, "기동 실패인데 성공으로 보고했다");
    assert.equal(r.rolledBack, true, "되돌리지 않았다");
    assert.equal(r.verdict, "failed");
    assert.match(r.detail, /기동 신호/, `사유가 원본 문장이 아니다: ${r.detail}`);
    // 교체 → 재기동(1회) → 확인 실패 → 되돌리고 **다시** 띄워야(총 2회) 한다.
    // 복구만 하고 띄우지 않으면 사용자는 "복구됐다" 는 메시지와 함께 죽은 창을 본다.
    assert.equal(restarts.length, 2, `재기동 횟수 ${restarts.length} — 되돌린 뒤 다시 띄워야 한다`);
    assert.equal(await readFile(join(s.dir, "harnesside"), "utf8"), OLD, "옛 버전으로 되돌아오지 않았다");
    // 사용자가 멈췄다고 느끼지 않도록 기다리는 동안 알려야 한다.
    assert.ok(ticks.length > 0, "기다리는 동안 아무 말도 하지 않았다");
  } finally {
    await s.cleanup();
  }
});

test("**되돌릴 곳이 없으면 시도조차 하지 않는다** — 파일을 바꿔 놓고 되돌릴 곳이 없다", async () => {
  const s = await sandbox();
  try {
    const OLD = "#!/bin/sh\necho '옛 버전'\n";
    await fakeBin(join(s.dir, "harnesside"), OLD);
    await fakeBin(join(s.dir, "new"), "#!/bin/sh\necho '새 버전'\n");
    // canRollback=false → `planApply` 가 막는다. 슬롯은 **교체 후**에 만들어진다.
    const up = svc(s.dir); // 기본 guard 의 canRollback=false
    let probed = false;
    const r = await up.apply({
      newBinary: join(s.dir, "new"),
      probeHello: async () => {
        probed = true;
        return true;
      },
      restart: async () => {},
    });
    assert.equal(r.ok, false, "되돌릴 곳이 없는데 적용했다");
    assert.equal(r.rolledBack, false);
    assert.match(r.detail, /되돌릴 수 없/, `차단 사유가 없다: ${r.detail}`);
    assert.equal(probed, false, "거부했는데 기동 확인까지 했다");
    assert.equal(await readFile(join(s.dir, "harnesside"), "utf8"), OLD, "파일을 바꿔 버렸다");
  } finally {
    await s.cleanup();
  }
});

test("교체 전 **임시 파일이 남지 않는다** — 반만 남은 파일을 다음 실행이 쓴다", async () => {
  const s = await sandbox();
  try {
    await fakeBin(join(s.dir, "harnesside"), "#!/bin/sh\n");
    await fakeBin(join(s.dir, "new"), "#!/bin/sh\necho 새\n");
    const up = svc(s.dir, {
      guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: true, daemon: true, estimatedSeconds: 1, assetBytes: 1 }),
    });
    await up.apply({ newBinary: join(s.dir, "new"), probeHello: async () => true, restart: async () => {} });
    const { readdir } = await import("node:fs/promises");
    const left = (await readdir(s.dir)).filter((f) => f.includes("harnesside-tmp") || f.includes("rollback"));
    assert.deepEqual(left, [], `임시 파일이 남았다: ${left.join(", ")}`);
  } finally {
    await s.cleanup();
  }
});

test("**grace 안에 신호가 오면 기다리지 않는다** — 90초를 다 기다리는 것이 아니다", async () => {
  const s = await sandbox();
  try {
    await fakeBin(join(s.dir, "harnesside"), "#!/bin/sh\n");
    await fakeBin(join(s.dir, "new"), "#!/bin/sh\n");
    const up = svc(s.dir, {
      guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: true, daemon: true, estimatedSeconds: 1, assetBytes: 1 }),
    });
    let calls = 0;
    let t = 1_000_000;
    const r = await up.apply({
      newBinary: join(s.dir, "new"),
      probeHello: async () => {
        calls++;
        return calls >= 3; // 세 번째 확인에서 살아 있다
      },
      restart: async () => {},
      now: () => (t += 100),
      policy: { enabled: true, bootGraceSec: 90 },
    });
    assert.equal(r.ok, true);
    assert.equal(calls, 3, `세 번이 아니라 ${calls} 번 물었다`);
  } finally {
    await s.cleanup();
  }
});

test("롤백 정책이 꺼져 있으면 grace 도 **무시** 된다 — 기다리는 척 하지 않는다", async () => {
  const s = await sandbox();
  try {
    await fakeBin(join(s.dir, "harnesside"), "#!/bin/sh\n옛\n");
    await fakeBin(join(s.dir, "new"), "#!/bin/sh\n새\n");
    const up = svc(s.dir, {
      guard: async () => ({ runningTurns: [], processes: [], dirtyTabs: 0, canRollback: true, daemon: true, estimatedSeconds: 1, assetBytes: 1 }),
    });
    let t = 1_000_000;
    const r = await up.apply({
      newBinary: join(s.dir, "new"),
      probeHello: async () => false,
      restart: async () => {},
      now: () => (t += 50),
      policy: { enabled: false, bootGraceSec: DEFAULT_ROLLBACK.bootGraceSec },
    });
    assert.equal(r.ok, false);
    assert.equal(r.elapsedSec <= 1, true, `꺼져 있는데 ${r.elapsedSec}초 기다렸다`);
  } finally {
    await s.cleanup();
  }
});

test("rollback() 은 가장 최근 슬롯으로 되돌린다", async () => {
  const s = await sandbox();
  try {
    await fakeBin(join(s.dir, "harnesside"), "#!/bin/sh\necho 'new'\n");
    const up = svc(s.dir);
    // 슬롯 만들기: 현재 파일을 슬롯에 복사한다
    await up.makeSlot();
    await fakeBin(join(s.dir, "harnesside"), "#!/bin/sh\necho 'broken'\n");
    const r = await up.rollback();
    assert.equal(r.ok, true, r.detail);
    assert.equal(await readFile(join(s.dir, "harnesside"), "utf8"), "#!/bin/sh\necho 'new'\n", "슬롯 내용이 돌아오지 않았다");
    assert.equal((await stat(join(s.dir, "harnesside"))).mode & 0o111, 0o111, "실행 권한이 없다");
  } finally {
    await s.cleanup();
  }
});

test("rollback() 은 슬롯이 없으면 시도하지 않는다", async () => {
  const s = await sandbox();
  try {
    const up = svc(s.dir);
    const r = await up.rollback();
    assert.equal(r.ok, false);
    assert.match(r.detail, /슬롯이 없습니다/);
  } finally {
    await s.cleanup();
  }
});

test("rollback() 은 슬롯 범위 밖의 경로를 거부한다", async () => {
  const s = await sandbox();
  try {
    const up = svc(s.dir);
    const evil = join(s.dir, "..", "outside");
    const r = await up.rollback(evil);
    assert.equal(r.ok, false);
    assert.match(r.detail, /범위 밖/);
    // 뒤집으면 실패해야 한다: 거부 없이 통과하면 임의 파일 복사가 된다
    assert.equal(r.path, undefined);
  } finally {
    await s.cleanup();
  }
});

test("stageSwap() 은 슬롯을 먼저 만들고 교체한다 (순서 고정)", async () => {
  const s = await sandbox();
  try {
    await fakeBin(join(s.dir, "harnesside"), "#!/bin/sh\necho 'old'\n");
    await fakeBin(join(s.dir, "new"), "#!/bin/sh\necho 'new'\n");
    const up = svc(s.dir);
    const r = await up.stageSwap(join(s.dir, "new"));
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.slot, "슬롯 경로가 없다 — 교체 전에 되돌릴 곳을 만들어야 한다");
    assert.equal(await readFile(join(s.dir, "harnesside"), "utf8"), "#!/bin/sh\necho 'new'\n");
    // 슬롯에는 교체 전 내용이 있다
    assert.equal(await readFile(r.slot!, "utf8"), "#!/bin/sh\necho 'old'\n");
  } finally {
    await s.cleanup();
  }
});
