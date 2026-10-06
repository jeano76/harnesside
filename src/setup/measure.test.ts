import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlamaServerConfig } from "../backend/llamaServer.js";
import {
  benchCompletion,
  chosenConfig,
  measureCandidates,
  measuredThreads,
  measurementKey,
  memoryProbeFor,
  mergeMachineProfile,
  parseMachineProfile,
  pickBest,
  runMeasure,
  toStored,
  type BenchSample,
} from "./measure.js";

const cfg = (over: Partial<LlamaServerConfig> = {}): LlamaServerConfig => ({
  binPath: "/b/llama-server", modelPath: "/m/model.gguf", host: "127.0.0.1", port: 18080,
  contextSize: 32768, threads: 6, gpuLayers: 999, ...over,
});
const sample = (label: string, genTps: number | null, promptTps = 500, patch: BenchSample["patch"] = {}): BenchSample => ({
  label, patch, ok: genTps !== null, loadSeconds: 1, freeMiB: null,
  bench: genTps === null ? null : { promptTokens: 1500, promptTps, genTokens: 128, genTps },
  ...(genTps === null ? { error: "OOM" } : {}),
});

test("후보 — 기준이 항상 첫 번째, 같은 스레드 수는 한 번만", () => {
  const c = measureCandidates(cfg({ threads: 6 }), { logicalCores: 12, physicalCores: 6, performanceCores: null }, { mode: "full" });
  assert.deepEqual(c[0].patch, {});
  const threads = c.slice(1).map((x) => x.patch.threads);
  assert.deepEqual(threads, [12, 5], "물리(=기준 6)는 중복이라 빠지고 논리·물리-1 이 남는다");
});

test("후보 — quick 은 기준 + 1개, 하이브리드면 P코어만을 먼저", () => {
  const c = measureCandidates(cfg({ threads: 10 }), { logicalCores: 20, physicalCores: 14, performanceCores: 6 }, { mode: "quick" });
  assert.equal(c.length, 2);
  assert.equal(c[1].patch.threads, 6);
});

test("후보 — MoE 오프로드 ±2 는 full 에서만, 범위 밖은 만들지 않는다", () => {
  const base = cfg({ cpuMoeLayers: 1 });
  const cpu = { logicalCores: 6, physicalCores: 6, performanceCores: null };
  assert.equal(measureCandidates(base, cpu, { mode: "quick", moeLayers: 40 }).some((x) => x.patch.cpuMoeLayers !== undefined), false);
  const moe = measureCandidates(base, cpu, { mode: "full", moeLayers: 40 }).filter((x) => x.patch.cpuMoeLayers !== undefined);
  assert.deepEqual(moe.map((x) => x.patch.cpuMoeLayers), [3], "1-2 = -1 은 범위 밖");
});

test("선택 — 기준보다 3% 미만 빠르면 잡음으로 보고 바꾸지 않는다", () => {
  const r = pickBest([sample("기준", 20), sample("-t 5", 20.4, 500, { threads: 5 })]);
  assert.equal(r.changed, false);
  assert.match(r.reason, /잡음/);
});

test("선택 — 충분히 빠르면 채택, 실패 후보는 무시", () => {
  const r = pickBest([sample("기준", 20), sample("-t 12", null, 0, { threads: 12 }), sample("-t 5", 23, 500, { threads: 5 })]);
  assert.equal(r.changed, true);
  assert.equal(r.chosen?.label, "-t 5");
  assert.ok(Math.abs((r.gain ?? 0) - 0.15) < 1e-9);
});

test("선택 — 기준을 못 재면 아무것도 바꾸지 않는다", () => {
  const r = pickBest([sample("기준", null), sample("-t 5", 30, 500, { threads: 5 })]);
  assert.equal(r.changed, false);
  assert.equal(r.chosen, null);
});

test("후보 — quick 이라도 비교 대상이 최소 하나 (기준 = 물리 코어인 비하이브리드, 실측 머신 i5-12400F)", () => {
  const c = measureCandidates(cfg({ threads: 6 }), { logicalCores: 12, physicalCores: 6, performanceCores: null }, { mode: "quick" });
  assert.deepEqual(c.map((x) => x.patch.threads), [undefined, 12]);
});

test("측정 키 — 엔진·모델·컨텍스트·오프로드가 하나라도 다르면 다른 키", () => {
  const k = measurementKey(cfg());
  assert.notEqual(k, measurementKey(cfg({ contextSize: 16384 })));
  assert.notEqual(k, measurementKey(cfg({ binPath: "/other/llama-server" })));
  assert.notEqual(k, measurementKey(cfg({ gpuLayers: 28 })));
  assert.equal(k, measurementKey(cfg({ threads: 12 })), "스레드는 측정 대상이지 키가 아니다");
});

test("메모리 측정 수단 — 백엔드별, 없으면 '없음'으로 말한다", () => {
  assert.equal(memoryProbeFor({ gpuBackend: "cuda", gpus: [], platform: "linux" }).source, "nvidia-smi");
  assert.equal(memoryProbeFor({ gpuBackend: "metal", gpus: [{ index: 0, name: "Apple", vramTotalBytes: 1, vramFreeBytes: 1, vendor: "apple", unifiedMemory: true }], platform: "darwin" }).pool, "unified");
  assert.equal(memoryProbeFor({ gpuBackend: "vulkan", gpus: [{ index: 0, name: "RX", vramTotalBytes: 1, vramFreeBytes: 1, vendor: "amd" }], platform: "linux" }).source, "amdgpu-sysfs");
  assert.equal(memoryProbeFor({ gpuBackend: "vulkan", gpus: [{ index: 0, name: "Arc", vramTotalBytes: 1, vramFreeBytes: 1, vendor: "intel" }], platform: "win32" }).source, "none");
  assert.equal(memoryProbeFor({ gpuBackend: "none", gpus: [], platform: "linux" }).pool, "ram");
});

test("벤치 — timings 를 읽고, 없으면 지어내지 않고 실패한다", async () => {
  const ok = (async () => ({ ok: true, json: async () => ({ timings: { prompt_n: 1480, prompt_per_second: 812.5, predicted_n: 128, predicted_per_second: 41.2 } }) })) as unknown as typeof fetch;
  const r = await benchCompletion("http://x", { fetchImpl: ok });
  assert.deepEqual(r, { promptTokens: 1480, promptTps: 812.5, genTokens: 128, genTps: 41.2 });
  const none = (async () => ({ ok: true, json: async () => ({ content: "hi" }) })) as unknown as typeof fetch;
  await assert.rejects(benchCompletion("http://x", { fetchImpl: none }), /timings/);
});

test("runMeasure — 기준(calibration 결과) 위에서 후보를 재고 빠른 쪽을 채택한다", async () => {
  const started: number[] = [];
  const stopped: number[] = [];
  const tps: Record<number, number> = { 6: 20, 12: 15, 5: 24 };
  let current = 0;
  const make = (c: LlamaServerConfig) => ({
    baseUrl: `http://t/${c.threads}`,
    start: async () => void started.push((current = c.threads)),
    stop: () => void stopped.push(c.threads),
  });
  const r = await runMeasure({
    base: cfg({ threads: 6 }),
    cpu: { logicalCores: 12, physicalCores: 6, performanceCores: null },
    mode: "full",
    make,
    memory: { source: "ram", pool: "ram", freeMiB: async () => 4096 },
    // 기준 기동 = calibration 이 --n-cpu-moe 를 정했다고 가정 — 후보가 그 값을 물려받아야 한다.
    startBaseline: (async (c: LlamaServerConfig, o: { make: typeof make }) => {
      const adj = { ...c, cpuMoeLayers: 4 };
      const s = o.make(adj);
      await s.start();
      return { server: s, cfg: adj };
    }) as never,
    bench: async (url) => ({ promptTokens: 1500, promptTps: 600, genTokens: 128, genTps: tps[Number(url.split("/").pop())] ?? 0 }),
    settleMs: 0,
    waitStopped: async () => true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(started, [6, 12, 5]);
  assert.deepEqual(stopped, [6, 12, 5], "모든 후보 서버를 내린다 — 남으면 VRAM 을 쥔 채 다음 후보가 OOM 난다");
  assert.equal(r.pick.chosen?.patch.threads, 5);
  const c = chosenConfig(r);
  assert.equal(c.threads, 5);
  assert.equal(c.cpuMoeLayers, 4, "calibration 이 정한 오프로드를 잃지 않는다");
  assert.equal(r.samples[0].freeMiB, 4096);
  void current;
});

test("runMeasure — 기준이 뜨지 않으면 후보를 시도하지 않고 실패로 끝난다", async () => {
  let made = 0;
  const r = await runMeasure({
    base: cfg(),
    cpu: { logicalCores: 12, physicalCores: 6, performanceCores: null },
    mode: "full",
    make: () => ({ start: async () => void made++, stop: () => {} }),
    memory: { source: "none", pool: "none", freeMiB: async () => undefined },
    startBaseline: (async () => {
      throw new Error("CUDA error: out of memory");
    }) as never,
    bench: async () => ({ promptTokens: 1, promptTps: 1, genTokens: 1, genTps: 1 }),
    settleMs: 0,
    waitStopped: async () => true,
  });
  assert.equal(r.ok, false);
  assert.equal(made, 0);
  assert.match(r.samples[0].error ?? "", /out of memory/);
});

test("runMeasure — 시간 상한을 넘으면 남은 후보를 건너뛰고 그 사실을 남긴다", async () => {
  let t = 0;
  const r = await runMeasure({
    base: cfg(),
    cpu: { logicalCores: 12, physicalCores: 6, performanceCores: null },
    mode: "full",
    make: (c) => ({ baseUrl: "http://t", start: async () => {}, stop: () => {}, ...c }) as never,
    memory: { source: "none", pool: "none", freeMiB: async () => undefined },
    startBaseline: (async (c: LlamaServerConfig, o: { make: (c: LlamaServerConfig) => { start(): Promise<void> } }) => {
      const s = o.make(c);
      await s.start();
      return { server: s, cfg: c };
    }) as never,
    bench: async () => {
      t += 100_000;
      return { promptTokens: 1, promptTps: 1, genTokens: 1, genTps: 1 };
    },
    maxSeconds: 150,
    now: () => t,
    settleMs: 0,
    waitStopped: async () => true,
  });
  assert.ok(r.skipped.length > 0, "건너뛴 후보가 기록되지 않았다");
  assert.match(r.skipped[0], /시간 상한/);
});

test("runMeasure — 다음 후보는 이전 서버가 **실제로 내려간 뒤에** 띄운다", async () => {
  const log: string[] = [];
  await runMeasure({
    base: cfg({ threads: 6 }),
    cpu: { logicalCores: 12, physicalCores: 6, performanceCores: null },
    mode: "quick",
    make: (c) => ({ baseUrl: "http://t", start: async () => void log.push(`start ${c.threads}`), stop: () => void log.push(`stop ${c.threads}`) }),
    memory: { source: "none", pool: "none", freeMiB: async () => undefined },
    startBaseline: (async (c: LlamaServerConfig, o: { make: (c: LlamaServerConfig) => { start(): Promise<void> } }) => {
      const s = o.make(c);
      await s.start();
      return { server: s, cfg: c };
    }) as never,
    bench: async () => ({ promptTokens: 1, promptTps: 1, genTokens: 1, genTps: 1 }),
    settleMs: 0,
    waitStopped: async (c) => {
      log.push(`stopped ${c.threads}`);
      return true;
    },
  });
  assert.deepEqual(log, ["start 6", "stop 6", "stopped 6", "start 12", "stop 12", "stopped 12"]);
});

test("머신 프로필 — 저장·병합·조회, 손상된 파일은 없는 것으로", () => {
  const r = {
    ok: true, mode: "quick" as const, key: "k1", baseCfg: cfg(), samples: [sample("기준", 20)], skipped: [],
    pick: { baseline: null, chosen: sample("-t 5", 23, 500, { threads: 5 }), changed: true, gain: 0.15, reason: "빠름" },
    memory: { source: "ram" as const, pool: "ram" as const }, seconds: 3,
  };
  const stored = toStored(r, new Date("2026-10-07T00:00:00Z"));
  assert.equal(stored.threads, 5);
  const merged = mergeMachineProfile(parseMachineProfile("{not json"), { platform: "linux" }, "k1", stored);
  const back = parseMachineProfile(JSON.stringify(merged));
  assert.equal(measuredThreads(back, "k1"), 5);
  assert.equal(measuredThreads(back, "other"), undefined, "다른 조건의 측정은 쓰지 않는다");
});
