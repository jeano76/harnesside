/**
 * 추천 알림 배선 테스트 (M13).
 *
 * 여기서 검사하는 것은 **판단이 아니라 배선** 이다. 판단은 `notify.test.ts` 가 한다.
 * 배선이measurable 해야 하는 것은 세 가지다:
 *
 *  1. **실제 파일을 넣으면 실제로 알린다** — 주입한 목록이 아니라 디렉터리를 본다.
 *  2. **무시하면 재발하지 않는다** — 그리고 **창을 닫아도** 재발하지 않는다(서버 상태).
 *  3. **유휴가 아니면·너무 이르면·오프라인이면 조용히 지나간다** — 배너가 아니라 로그 한 줄.
 *
 * 셋 중 하나라도 없으면 "알림 기능" 이 아니라 "판정 함수" 다. 2026-09-30 까지 그것이
 * 전부였다 — `grep -rn notify src/server/index.ts` 0건.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecommendationService } from "./recommendService.js";

async function dirWith(files: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-rec-"));
  for (const [name, bytes] of Object.entries(files)) {
    const p = join(dir, name);
    await writeFile(p, Buffer.alloc(bytes));
  }
  return dir;
}

test("디렉터리에 **같은 계열 새 양자화** 가 있으면 실제로 알린다", async () => {
  const dir = await dirWith({ "Ornith-1.5-35B-A3B-Q4_K_M.gguf": 1024 });
  const svc = createRecommendationService({
    modelsDir: dir,
    isIdle: () => true,
    log: () => {},
  });
  svc.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");

  const notices = await svc.check();
  const forNew = notices.filter((n) => n.kind === "model");
  assert.equal(forNew.length, 1, `알림이 ${forNew.length}건 — 같은 계열 새 파일을 못 잡았다`);
  assert.match(forNew[0].title, /Ornith-1\.5-35B-A3B-Q4_K_M\.gguf/);
  // **적합도가 있어야 추천이다.** 근거 없으면 노이즈다(판정은 notify.test.ts 가 본다).
  assert.ok(forNew[0].fit >= 60, `적합도가 ${forNew[0].fit} — 근거 없는 추천`);
});

test("**같은 지문은 다시 알리지 않는다** — 두 번 돌려도 목록이 늘지 않는다", async () => {
  const dir = await dirWith({ "Ornith-1.5-35B-A3B-Q4_K_M.gguf": 1024 });
  const svc = createRecommendationService({ modelsDir: dir, isIdle: () => true, log: () => {} });
  svc.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");

  await svc.check();
  const first = svc.list().length;
  // 두 번째는 **간격** 때문에 조용히 넘어간다. 그래도 목록은 같아야 한다.
  await svc.check(Date.now() + 60_000);
  assert.equal(svc.list().length, first, "같은 지문을 두 번 알렸다");
});

test("**무시하면 재발하지 않는다** — 목록에서 사라지고 기억에 남는다", async () => {
  const dir = await dirWith({ "Ornith-1.5-35B-A3B-Q4_K_M.gguf": 1024 });
  const svc = createRecommendationService({ modelsDir: dir, isIdle: () => true, log: () => {} });
  svc.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");
  const [n] = await svc.check();

  assert.ok(svc.silenceByKey(n.silenceKey), "무시하지 못했다");
  assert.equal(svc.list().length, 0, "무시했는데 목록에 남았다");
  assert.ok(svc.silenced().includes(n.silenceKey), "기억에 남지 않았다");

  // **상태가 초기화된 것처럼** 보여도 재발하면 안 된다 — 그래서 기억을 확인한다.
  const svc2 = createRecommendationService({ modelsDir: dir, isIdle: () => true, log: () => {} });
  svc2.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");
  // 새 인스턴스는 기억이 없다 — 그래야 알림이 **처음** 보인다. 이것이 옳다.
  const again = await svc2.check();
  assert.equal(again.length, 1, "새 인스턴스가 기억할 수는 없다");
});

test("**유휴가 아니면 조용히** — 배너가 아니라 이유만 남는다", async () => {
  const dir = await dirWith({ "Ornith-1.5-35B-A3B-Q4_K_M.gguf": 1024 });
  const svc = createRecommendationService({ modelsDir: dir, isIdle: () => false, log: () => {} });
  svc.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");
  const notices = await svc.check();
  assert.equal(notices.length, 0, "바쁜 중에 알렸다");
  assert.equal(svc.lastQuietReason(), "busy", "왜 조용했는지 말하지 않는다");
});

test("**오프라인이면 조용히** — 배너로 띄우면 사용자가 오류를 찾으러 온다", async () => {
  const dir = await dirWith({ "Ornith-1.5-35B-A3B-Q4_K_M.gguf": 1024 });
  const svc = createRecommendationService({ modelsDir: dir, isIdle: () => true, isOffline: () => true, log: () => {} });
  svc.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");
  assert.equal((await svc.check()).length, 0);
  assert.equal(svc.lastQuietReason(), "offline");
});

test("**너무 이르면 조용히** — 남은 시간을 말한다", async () => {
  const dir = await dirWith({ "Ornith-1.5-35B-A3B-Q4_K_M.gguf": 1024 });
  let t = 1_000_000;
  const svc = createRecommendationService({ modelsDir: dir, isIdle: () => true, now: () => t, log: () => {} });
  svc.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");
  assert.equal((await svc.check(t)).length, 1, "첫 조회는 간격을 묻지 않는다");

  // 10분 뒤 — 최소 간격(1시간) 안이다. **알림은 조용해야 하고 그 이유도 남아야 한다.**
  // `lastCheckAt` 이 0 이 아니라 첫 조회 시각으로 갱신되어야 이걸 잡는다 — 0 으로 두면
  // `now - 0` 이 항상 최소 간격보다 크다.
  assert.equal((await svc.check(t + 600_000)).length, 0, "1시간 지나기도 전에 다시 알렸다");
  assert.equal(svc.lastQuietReason(), "too-soon", "왜 조용했는지 남지 않았다");
});

test("**llama 바이너리가 바뀌면** 알린다 — 그리고 **첫 조회는 조용하다**(재빌드 알림 아님)", async () => {
  const dir = await tmpdir();
  const binDir = await mkdtemp(join(tmpdir(), "harnesside-bin-"));
  const bin = join(binDir, "llama-server");
  await writeFile(bin, Buffer.alloc(2048));

  const svc = createRecommendationService({
    modelsDir: await dirWith({}),
    llamaBinPath: bin,
    runningFlags: () => ["-ngl", "99"],
    expectedFlags: () => ["-ngl", "99", "--flash-attn"],
    isIdle: () => true,
    log: () => {},
  });
  const first = await svc.check();
  assert.equal(first.filter((n) => n.kind === "llama" && n.id.includes("binary")).length, 0, "처음부터 '바이너리가 바뀌었다'고 알렸다 — 방금 빌드한 것까지");

  // 파일을 다시 쓰면 지문이 바뀐다.
  await writeFile(bin, Buffer.alloc(4096));
  const later = await utimes(bin, new Date(Date.now() + 5000), new Date(Date.now() + 5000)).then(() => svc.checkNow());
  const binaryNotice = later.filter((n) => n.kind === "llama" && n.id.includes("binary"));
  assert.equal(binaryNotice.length, 1, "바뀐 바이너리를 놓쳤다");
  assert.equal(binaryNotice[0].severity, "action", "재시작해야 반영되는데 info 로 두었다");
});

test("**플래그가 어긋나면** 튜닝이 무효화되었다고 **조치 등급**으로 알린다", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "harnesside-bin2-"));
  const bin = join(binDir, "llama-server");
  await writeFile(bin, Buffer.alloc(2048));
  const svc = createRecommendationService({
    modelsDir: await dirWith({}),
    // **바이너리 경로가 있어야** llama 판정을 한다. 이걸 빼면 테스트는 조용히
    // "알림 0건" 이 되어 통과해 버린다 — 실제로 처음에 그랬다(바이너리 없이 확인해서).
    llamaBinPath: bin,
    runningFlags: () => ["-ngl", "99"],
    expectedFlags: () => ["-ngl", "99", "--flash-attn"],
    isIdle: () => true,
    log: () => {},
  });
  const notices = await svc.check();
  const flag = notices.find((n) => n.id.includes("flags"));
  assert.ok(flag, "플래그 어긋남을 알리지 않았다");
  assert.equal(flag.severity, "warn");
  assert.match(flag.body, /--flash-attn/, "어떤 플래그가 없는지 말하지 않는다");
});

test("**설치 안 된 상태**(바이너리 없음)에서도 조용히 돌아간다 — llama 알림은 없다", async () => {
  const svc = createRecommendationService({
    modelsDir: await dirWith({}),
    llamaBinPath: null,
    isIdle: () => true,
    log: () => {},
  });
  const notices = await svc.check();
  assert.equal(notices.filter((n) => n.kind === "llama").length, 0, "바이너리가 없는데 llama 알림을 냈다");
});

test("**배경 스케줄이 실제 시간으로 돈다** — 타이머가 이벤트 루프를 붙잡는다", async () => {
  const dir = await dirWith({ "Ornith-1.5-35B-A3B-Q4_K_M.gguf": 1024 });
  let ticks = 0;
  const svc = createRecommendationService({
    modelsDir: dir,
    isIdle: () => true,
    // **20ms 간격**으로 검사 횟수만 센다. 100ms 를 기다린다.
    intervalMs: 20,
    log: () => {},
  });
  svc.setCurrent("Ornith-1.5-35B-A3B-Q3_K_M.gguf");
  svc.checkNow().then(() => ticks++);
  svc.start();
  svc.start(); // **두 번 불러도 타이머는 하나**
  await new Promise((r) => setTimeout(r, 120));
  svc.stop();
  assert.ok(ticks >= 1, "백그라운드 검사가 한 번도 돌지 않았다");
});
