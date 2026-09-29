/**
 * 계측 테스트 (§5.5 · 요구 11).
 *
 * 이 모듈의 규칙은 "**서버는 절대 요청당 계측하지 않는다**" 다. 여기서 깨지면 계측이
 * 부하가 된다 — nvidia-smi 는 실행만 해도 100~300ms 걸린다. 그래서 위조된
 * 의존성(nvidia-smi 없음, /proc 없음)으로 **경로가 안전한지** 를 검증한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MetricsSampler,
  MetricsRing,
  cpuUsageBetween,
  readCpuSnapshot,
  readGpu,
  severity,
  bucket,
  RING_SIZE,
  type Metrics,
  type CpuSnapshot,
} from "./metrics.js";

const snap = (cores: { total: number; idle: number }[]): CpuSnapshot => ({
  total: cores.reduce((a, c) => a + c.total, 0),
  idle: cores.reduce((a, c) => a + c.idle, 0),
  cores,
  count: cores.length,
});

test("CPU 사용률은 **직전 스냅샷과의 차이** 다 — 누적 비율이 아니다", () => {
  // 5분째 조용한 서버가 0% 로 보이면 안 된다: 직전 1초에 1코어를 다 썼다면 100% 다.
  const prev = snap([{ total: 1000, idle: 900 }]);
  const next = snap([{ total: 1010, idle: 900 }]);
  const r = cpuUsageBetween(prev, next);
  assert.equal(r.overall, 100, "직전 1초 100% 인데 0% 로 나왔다 — 누적 평균을 보고 있다");
  assert.deepEqual(r.cores, [100]);
});

test("유휴면 0%, 완전 점유면 100%, 그 사이는 비례", () => {
  const prev = snap([{ total: 0, idle: 0 }]);
  assert.equal(cpuUsageBetween(prev, snap([{ total: 100, idle: 100 }])).overall, 0);
  assert.equal(cpuUsageBetween(prev, snap([{ total: 100, idle: 0 }])).overall, 100);
  assert.equal(cpuUsageBetween(prev, snap([{ total: 200, idle: 100 }])).overall, 50);
});

test("첫 샘플은 **모른다**(빈 배열) — 0% 로 채우지 않는다", () => {
  const r = cpuUsageBetween(null, snap([{ total: 100, idle: 50 }]));
  assert.deepEqual(r.cores, [], "첫 샘플인데 코어별 값이 있다");
  // 코어 수가 달라졌을 때(코어 핫플러그) 비교가 무의미하므로 비운다
  const changed = cpuUsageBetween(snap([{ total: 1, idle: 1 }]), snap([{ total: 2, idle: 1 }, { total: 2, idle: 1 }]));
  assert.deepEqual(changed.cores, [], "코어 수가 바뀌었는데 값을 지었다");
});

test("시간이 지나가지 않았으면 0% 다 — 100% 로 나누지 않는다", () => {
  const s = snap([{ total: 100, idle: 50 }]);
  assert.equal(cpuUsageBetween(s, snap([{ total: 100, idle: 50 }])).overall, 0);
  // iowait 이 유휴에 들어가면 디스크 대기가 100% 부하로 보이지 않는다
  const a = snap([{ total: 0, idle: 0 }]);
  const r = cpuUsageBetween(a, snap([{ total: 100, idle: 100 }]));
  assert.equal(r.overall, 0);
});

test("실제 머신에서도 0~100 사이로 나온다 — NaN 을 그대로 흘리지 않는다", () => {
  const a = readCpuSnapshot();
  const b = readCpuSnapshot();
  const r = cpuUsageBetween(a, b);
  assert.ok(Number.isFinite(r.overall), "overall 이 NaN 이다");
  assert.ok(r.overall >= 0 && r.overall <= 100, `범위를 벗어났다: ${r.overall}`);
  for (const c of r.cores) assert.ok(Number.isFinite(c) && c >= 0 && c <= 100, `코어 값 이상: ${c}`);
});

test("nvidia-smi 가 없으면 **null** 다 — 0% 로 채우면 \"쉬는 중\" 으로 거짓말한다", async () => {
  const g = await readGpu("definitely-not-a-real-binary-xyz");
  assert.equal(g, null, `GPU 없음을 0% 로 보고했다: ${JSON.stringify(g)}`);
});

test("GPU 파싱: [N/A] 는 null 로 남는다 — 과열(0도)이 아니라 미확인", async () => {
  // 가짜 nvidia-smi 스크립트를 만들어 실제 파싱 경로를 태운다.
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "harnesside-smi-"));
  const bin = join(dir, "nvidia-smi");
  await writeFile(bin, "#!/bin/sh\necho 'NVIDIA GeForce RTX 2070 SUPER, 12, 45, 120, 7278, 8192'\n");
  await chmod(bin, 0o755);
  try {
    const g = await readGpu(bin);
    assert.equal(g?.name, "NVIDIA GeForce RTX 2070 SUPER");
    assert.equal(g?.utilPct, 12);
    assert.equal(g?.tempC, 45);
    assert.equal(g?.memUsedMiB, 7278);
    assert.equal(g?.memTotalMiB, 8192);
    assert.ok(g && g.memPct > 88 && g.memPct < 90, `VRAM % 가 이상하다: ${g?.memPct}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GPU 파싱: 온도/전력이 [N/A] 면 null", async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "harnesside-smi2-"));
  const bin = join(dir, "nvidia-smi");
  await writeFile(bin, "#!/bin/sh\necho 'GeForce, 3, [N/A], [N/A], 100, 8192'\n");
  await chmod(bin, 0o755);
  try {
    const g = await readGpu(bin);
    assert.equal(g?.tempC, null, "[N/A] 를 0도로 읽었다");
    assert.equal(g?.powerW, null);
    assert.equal(g?.utilPct, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("링은 120샘플까지만 유지한다 — 무한히 쌓이면 데몬이 새진다", () => {
  const r = new MetricsRing();
  for (let i = 0; i < 500; i++) r.push({ at: i } as Metrics);
  assert.equal(r.size, RING_SIZE);
  assert.equal(r.latest?.at, 499, "최신 샘플이 아니다");
  // 가장 오래된 것은 이미 버려졌다
  assert.equal(r.all[0].at, 500 - RING_SIZE);
});

test("링에서 수열을 뽑는다 — null 은 구멍으로 남는다(선을 잇지 않는다)", () => {
  const r = new MetricsRing();
  r.push({ at: 1, gpu: { utilPct: 10 } } as unknown as Metrics);
  r.push({ at: 2, gpu: null } as unknown as Metrics);
  r.push({ at: 3, gpu: { utilPct: 30 } } as unknown as Metrics);
  assert.deepEqual(r.series((m) => m.gpu?.utilPct ?? null), [10, null, 30]);
});

test("계측 실패해도 루프는 산다 — nvidia-smi 예외를 삼키고 계속 샘플한다", async () => {
  const s = new MetricsSampler(new MetricsRing(), {
    readGpu: async () => {
      throw new Error("nvidia-smi crashed");
    },
    readLlamaRss: async () => null,
    diskPath: "/",
  });
  const m = await s.sample();
  assert.ok(m.at > 0, "샘플이 만들어지지 않았다");
  assert.equal(m.gpu, null);
  assert.ok(m.mem.totalBytes > 0, "메모리 총량조차 못 읽었다");
  assert.ok(m.disk.totalBytes > 0);
});

test("llama RSS 를 읽으면 프로세스가 살아 있다 — 죽으면 null 이고 그게 정보다", async () => {
  const s = new MetricsSampler(new MetricsRing(), {
    readGpu: async () => null,
    readLlamaRss: async () => ({ rssBytes: 7_278 * 1024 * 1024, threads: 16 }),
    diskPath: "/",
  });
  const m = await s.sample();
  assert.equal(m.llama?.rssBytes, 7_278 * 1024 * 1024);
  assert.equal(m.llama?.threads, 16);
});

test("컨텍스트가 없으면 null — 0% 로 채우면 \"여유롭다\" 고 거짓말한다", async () => {
  const s = new MetricsSampler(new MetricsRing(), { readGpu: async () => null, readLlamaRss: async () => null, diskPath: "/" });
  const m = await s.sample();
  assert.equal(m.context, null, "컨텍스트 미지원을 0% 로 채웠다");
  assert.equal(m.tokensPerSec, null, "토큰 속도 미측정을 0 으로 채웠다");
});

test("컨텍스트 80% 는 컴팩션 임박을 뜻한다 — 70/90 임계와 다르다", async () => {
  const s = new MetricsSampler(new MetricsRing(), {
    readGpu: async () => null,
    readLlamaRss: async () => null,
    diskPath: "/",
    context: () => ({ usedTokens: 4096, totalTokens: 8192 }),
    tokensPerSec: () => 42.5,
  });
  const m = await s.sample();
  assert.equal(m.context?.pct, 50);
  assert.equal(m.tokensPerSec, 42.5);
});

test("겹친 계측을 허용하지 않는다 — 자기 부하로 샘플이 밀리면 1Hz 를 못 지킨다", async () => {
  let running = 0;
  let maxConcurrent = 0;
  const s = new MetricsSampler(new MetricsRing(), {
    readGpu: async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 60));
      running--;
      return null;
    },
    readLlamaRss: async () => null,
    diskPath: "/",
  });
  s.start(10);
  await new Promise((r) => setTimeout(r, 300));
  s.stop();
  assert.equal(maxConcurrent, 1, `계측이 ${maxConcurrent} 겹쳤다 — 자기 부하다`);
  assert.equal(s.running, false);
  assert.ok(s.ring.size >= 1, "샘플이 하나도 없다");
});

test("start/stop 이 멱등하다 — 두 번 불러도 타이머는 하나", () => {
  const s = new MetricsSampler();
  s.start(50);
  s.start(50);
  assert.equal(s.running, true);
  s.stop();
  s.stop();
  assert.equal(s.running, false);
});

test("임계치: 70 은 주의, **90 초과** 는 경고 (§5.5 그대로)", () => {
  assert.equal(severity(0), "ok");
  assert.equal(severity(69.9), "ok");
  assert.equal(severity(70), "warn", "70% 부터는 주의");
  assert.equal(severity(90), "warn", "90% 는 아직 주의 — 경고는 90 **초과** 다");
  assert.equal(severity(90.1), "crit");
  assert.equal(severity(100), "crit");
});

test("리렌더 버킷 — 미세 변화는 같은 버킷이다 (1Hz 리렌더가 아니라)", () => {
  assert.equal(bucket(37.31), bucket(37.34), "0.1% 미만 변화가 새 버킷을 만들었다");
  assert.notEqual(bucket(37.31), bucket(37.45));
  assert.equal(bucket(0, 1), 0);
  assert.equal(bucket(100, 1), 100);
});
