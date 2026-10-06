/**
 * 설치 시 실측 — `harnesside measure` (설치 스크립트가 `setup` 뒤에 부른다).
 *
 * ── 왜 이것이 있는가 ─────────────────────────────────────────────────────────
 * `tuneForHardware` 는 **예측**이고, `startCalibrated` 는 **메모리에 들어가는가**만 본다
 * (NVIDIA 에서만 VRAM 을 읽을 수 있었다). 어느 쪽도 "이 머신에서 이 설정이 **빠른가**" 를
 * 재지 않는다. 그래서 OS·CPU·GPU 조합마다 다른 최적값을 문서의 추정치가 아니라
 * **설치하는 그 머신에서** 잰다:
 *
 *   1. 기준 설정으로 기동 — `startCalibrated` 그대로(메모리 적합성 · OOM 재시도).
 *   2. 후보 설정(스레드 수 · MoE 오프로드 경계)을 하나씩 기동해 같은 프롬프트로 잰다.
 *      지표: 프리필 tok/s · 생성 tok/s(llama-server `/completion` 의 `timings`) · 남은 메모리.
 *   3. 생성 tok/s 가 기준보다 `MIN_GAIN` 이상 빠른 후보만 채택한다(잡음으로 설정을 흔들지 않는다).
 *
 * 순수 함수(`measureCandidates`·`pickBest`·`measurementKey`)와 실행부(`runMeasure`)를
 * 나눴다. 실행부는 서버·벤치·메모리 측정을 주입받아 서버 없이 테스트된다.
 *
 * 규칙: 못 잰 것은 `null` 이다. 실패한 후보는 실패로 기록하고 **수치를 지어내지 않는다.**
 */
import { readdirSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import type { LlamaServerConfig } from "../backend/llamaServer.js";
import type { Hardware } from "./hardware.js";
import type { CpuProfile } from "./machineProbe.js";
import { defaultReadVramFreeMiB, startCalibrated, type CalibrationResult, type ServerLike } from "./calibrate.js";
import { tcpPortProbe } from "./ports.js";

const MiB = 1024 * 1024;

/** 채택 기준 — 생성 tok/s 가 이만큼(비율) 이상 빨라야 기준 설정을 바꾼다. */
export const MIN_GAIN = 0.03;

export type MeasureMode = "quick" | "full";

export interface MeasureCandidate {
  label: string;
  /** 기준 설정에 덮어쓸 값. 빈 객체 = 기준 그대로. */
  patch: Partial<Pick<LlamaServerConfig, "threads" | "cpuMoeLayers">>;
}

export interface BenchResult {
  promptTokens: number;
  promptTps: number;
  genTokens: number;
  genTps: number;
}

export interface BenchSample {
  label: string;
  patch: MeasureCandidate["patch"];
  ok: boolean;
  /** 기동에 걸린 초. */
  loadSeconds: number | null;
  bench: BenchResult | null;
  /** 기동 직후 남은 메모리(MiB) — 측정 수단이 없으면 null. */
  freeMiB: number | null;
  error?: string;
}

// ── 메모리 측정 수단 (백엔드별) ─────────────────────────────────────────────

export interface MemoryProbe {
  /** 어떤 수단으로 읽는가 — 기록에 그대로 남는다. */
  source: "nvidia-smi" | "amdgpu-sysfs" | "ram" | "none";
  /** 무엇의 여유인가 — 전용 VRAM 인가, 통합/시스템 RAM 인가. */
  pool: "vram" | "unified" | "ram" | "none";
  freeMiB(): Promise<number | undefined>;
}

/** amdgpu 의 sysfs — 첫 번째 카드의 `mem_info_vram_total - used`. */
function readAmdFreeMiB(drmRoot = process.env.HARNESSIDE_DRM_ROOT || "/sys/class/drm"): number | undefined {
  try {
    for (const card of readdirSync(drmRoot).filter((n) => /^card\d+$/.test(n)).sort()) {
      const dev = join(drmRoot, card, "device");
      try {
        const total = Number(readFileSync(join(dev, "mem_info_vram_total"), "utf8").trim());
        const used = Number(readFileSync(join(dev, "mem_info_vram_used"), "utf8").trim());
        if (Number.isFinite(total) && Number.isFinite(used) && total > 0) return Math.round((total - used) / MiB);
      } catch {
        /* 이 카드는 amdgpu 가 아니다 */
      }
    }
  } catch {
    /* drm 이 없다 */
  }
  return undefined;
}

/**
 * 이 머신의 메모리 측정 수단. 예전 calibration 은 `nvidia-smi` 하나뿐이라 다른 머신에서는
 * 측정값이 `undefined` 였고, 그래서 **예측값이 측정 없이** 남았다.
 */
export function memoryProbeFor(hw: Pick<Hardware, "gpuBackend" | "gpus" | "platform">): MemoryProbe {
  const primary = hw.gpus[0];
  if (hw.gpuBackend === "cuda") return { source: "nvidia-smi", pool: "vram", freeMiB: () => defaultReadVramFreeMiB() };
  if (primary?.unifiedMemory || hw.gpuBackend === "metal") {
    return { source: "ram", pool: "unified", freeMiB: async () => Math.round(freemem() / MiB) };
  }
  if ((hw.gpuBackend === "rocm" || hw.gpuBackend === "vulkan") && hw.platform === "linux" && primary?.vendor === "amd") {
    return { source: "amdgpu-sysfs", pool: "vram", freeMiB: async () => readAmdFreeMiB() };
  }
  if (hw.gpuBackend === "none") return { source: "ram", pool: "ram", freeMiB: async () => Math.round(freemem() / MiB) };
  // Vulkan 위의 Intel·Windows AMD: 아직 읽는 수단이 없다 — **모른다**고 기록한다.
  return { source: "none", pool: "none", freeMiB: async () => undefined };
}

// ── 순수 계산 ────────────────────────────────────────────────────────────────

/** 같은 엔진·모델·컨텍스트·오프로드에서의 측정만 재사용한다. 하나라도 바뀌면 다시 잰다. */
export function measurementKey(cfg: Pick<LlamaServerConfig, "binPath" | "modelPath" | "contextSize" | "gpuLayers">): string {
  return [cfg.binPath, cfg.modelPath, `c${cfg.contextSize}`, `ngl${cfg.gpuLayers}`].join("|");
}

/**
 * 후보 설정. 기준(=예측·calibration 결과)이 항상 첫 번째다.
 *
 * 스레드: 물리 코어 · P코어만(하이브리드) · 논리 코어 · 물리-1. llama.cpp 생성은 메모리 대역폭에
 * 묶여 있어 SMT·E코어를 더 쓰면 **느려지는** 머신이 흔하다 — 예측으로는 알 수 없고 재야 한다.
 * MoE 오프로드(`--n-cpu-moe`): 기준 ±2 (full 에서만, 메모리 경계라 OOM 이면 실패로 기록된다).
 */
export function measureCandidates(
  base: Pick<LlamaServerConfig, "threads" | "cpuMoeLayers" | "gpuLayers">,
  cpu: Pick<CpuProfile, "logicalCores" | "physicalCores" | "performanceCores">,
  opts: { mode: MeasureMode; moeLayers?: number }
): MeasureCandidate[] {
  const out: MeasureCandidate[] = [{ label: `기준 (-t ${base.threads}${base.cpuMoeLayers ? ` · --n-cpu-moe ${base.cpuMoeLayers}` : ""})`, patch: {} }];
  const seen = new Set<number>([base.threads]);
  const addThreads = (n: number | null | undefined, why: string) => {
    if (!n || n < 1 || seen.has(n)) return;
    seen.add(n);
    out.push({ label: `-t ${n} (${why})`, patch: { threads: n } });
  };
  const order: Array<[number | null | undefined, string]> =
    opts.mode === "quick"
      ? // 앞의 둘이 기준과 같으면(비하이브리드에서 기준 = 물리 코어) 논리 코어라도 하나는 비교한다.
        [[cpu.performanceCores, "P코어만"], [cpu.physicalCores, "물리 코어"], [cpu.logicalCores, "논리 코어"]]
      : [
          [cpu.performanceCores, "P코어만"],
          [cpu.physicalCores, "물리 코어"],
          [cpu.logicalCores, "논리 코어"],
          [cpu.physicalCores ? cpu.physicalCores - 1 : null, "물리 코어 - 1"],
        ];
  const limit = opts.mode === "quick" ? 2 : 5;
  for (const [n, why] of order) {
    if (out.length >= limit) break;
    addThreads(n, why);
  }
  if (opts.mode === "full" && opts.moeLayers && base.gpuLayers > 0 && (base.cpuMoeLayers ?? 0) > 0) {
    const cur = base.cpuMoeLayers ?? 0;
    for (const d of [-2, 2]) {
      const v = cur + d;
      if (v >= 0 && v <= opts.moeLayers) out.push({ label: `--n-cpu-moe ${v} (기준 ${d > 0 ? "+" : ""}${d})`, patch: { cpuMoeLayers: v } });
    }
  }
  return out;
}

export interface PickResult {
  baseline: BenchSample | null;
  chosen: BenchSample | null;
  /** 기준과 다른 설정을 채택했는가. */
  changed: boolean;
  /** 생성 tok/s 이득 비율 (채택했을 때). */
  gain: number | null;
  reason: string;
}

/** 생성 tok/s 최대인 후보 — 기준보다 `minGain` 이상 빠를 때만 바꾼다. 동률이면 프리필이 빠른 쪽. */
export function pickBest(samples: BenchSample[], minGain = MIN_GAIN): PickResult {
  const baseline = samples[0] ?? null;
  if (!baseline || !baseline.ok || !baseline.bench) {
    return { baseline, chosen: null, changed: false, gain: null, reason: "기준 설정을 측정하지 못했습니다 — 설정을 바꾸지 않습니다" };
  }
  const measured = samples.filter((s) => s.ok && s.bench);
  const best = measured.reduce((a, b) =>
    b.bench!.genTps > a.bench!.genTps || (b.bench!.genTps === a.bench!.genTps && b.bench!.promptTps > a.bench!.promptTps) ? b : a
  );
  const gain = best.bench!.genTps / baseline.bench.genTps - 1;
  if (best === baseline || gain < minGain) {
    return {
      baseline,
      chosen: baseline,
      changed: false,
      gain: null,
      reason:
        best === baseline
          ? `기준 설정이 가장 빠릅니다 (생성 ${baseline.bench.genTps.toFixed(1)} tok/s)`
          : `${best.label} 이(가) ${(gain * 100).toFixed(1)}% 빨랐지만 기준(${(minGain * 100).toFixed(0)}%) 미만이라 잡음으로 봅니다`,
    };
  }
  return {
    baseline,
    chosen: best,
    changed: true,
    gain,
    reason: `${best.label} — 생성 ${baseline.bench.genTps.toFixed(1)} → ${best.bench!.genTps.toFixed(1)} tok/s (+${(gain * 100).toFixed(1)}%)`,
  };
}

// ── 벤치 ─────────────────────────────────────────────────────────────────────

/** 고정 프롬프트 — 코드 에이전트가 실제로 받는 모양(코드 + 지시). 매번 같아야 비교가 된다. */
export function benchPrompt(approxTokens = 1500): string {
  const unit =
    "function parseConfig(text) {\n  const out = {};\n  for (const line of text.split('\\n')) {\n" +
    "    const [k, v] = line.split('=');\n    if (k && v) out[k.trim()] = v.trim();\n  }\n  return out;\n}\n";
  // 이 단위는 대략 60 토큰이다. 정확한 수는 서버가 `timings.prompt_n` 으로 돌려준다.
  const reps = Math.max(1, Math.round(approxTokens / 60));
  return `${Array.from({ length: reps }, (_, i) => `// part ${i}\n${unit}`).join("")}\n// 위 코드를 검토하고 개선점을 설명하라.\n`;
}

/** llama-server `/completion` 한 번 — `timings` 가 없으면 **잴 수 없는 서버**다(throw). */
export async function benchCompletion(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; promptTokens?: number; nPredict?: number; timeoutMs?: number } = {}
): Promise<BenchResult> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${baseUrl.replace(/\/+$/, "")}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: benchPrompt(opts.promptTokens ?? 1500),
      n_predict: opts.nPredict ?? 128,
      temperature: 0,
      cache_prompt: false,
      // EOS 로 일찍 끝나면 생성 tok/s 가 후보마다 다른 길이로 재진다 — 길이를 고정한다.
      ignore_eos: true,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
  });
  if (!res.ok) throw new Error(`/completion HTTP ${res.status}`);
  const j = (await res.json()) as { timings?: Record<string, unknown> };
  const t = j.timings ?? {};
  const n = (k: string) => (typeof t[k] === "number" && Number.isFinite(t[k] as number) ? (t[k] as number) : NaN);
  const r = { promptTokens: n("prompt_n"), promptTps: n("prompt_per_second"), genTokens: n("predicted_n"), genTps: n("predicted_per_second") };
  if (Object.values(r).some((v) => Number.isNaN(v))) throw new Error("응답에 timings 가 없습니다 — 이 서버는 처리량을 보고하지 않습니다");
  return r;
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

export interface MeasureOptions {
  base: LlamaServerConfig;
  cpu: Pick<CpuProfile, "logicalCores" | "physicalCores" | "performanceCores">;
  mode: MeasureMode;
  /** MoE 모델의 층 수 — 없으면 MoE 후보를 만들지 않는다. */
  moeLayers?: number;
  make: (cfg: LlamaServerConfig) => ServerLike & { baseUrl?: string };
  memory: MemoryProbe;
  say?: (line: string) => void;
  /** 주입: 기준 기동(기본 `startCalibrated` — 메모리 적합성·OOM 재시도). */
  startBaseline?: typeof startCalibrated;
  /** 주입: 벤치(기본 `benchCompletion`). */
  bench?: (baseUrl: string) => Promise<BenchResult>;
  /** 이 시간을 넘으면 남은 후보를 건너뛴다(기록에 남긴다). */
  maxSeconds?: number;
  /** 서버를 내린 뒤 메모리가 돌아오기를 기다리는 시간. */
  settleMs?: number;
  /**
   * 주입: 내린 서버가 **실제로 끝났는가**(기본: 측정 포트가 빌 때까지, 최대 30초).
   * 후보들은 같은 포트를 쓴다. `stop()` 은 신호만 보내므로, 확인 없이 다음 후보를 띄우면
   * 옛 서버가 포트·VRAM 을 쥔 채라 다음 후보가 "포트 사용 중"·OOM 으로 실패하고,
   * 그 실패가 **그 설정의 결과**로 잘못 기록된다(실측: 종료 직후 옛 서버가 아직 떠 있었다).
   */
  waitStopped?: (cfg: LlamaServerConfig) => Promise<boolean>;
  now?: () => number;
}

export interface MeasureResult {
  ok: boolean;
  mode: MeasureMode;
  key: string;
  /** `startCalibrated` 를 거친 기준 설정 — 메모리 경계가 바뀌었으면 여기에 반영돼 있다. */
  baseCfg: LlamaServerConfig;
  calibration?: CalibrationResult;
  samples: BenchSample[];
  skipped: string[];
  pick: PickResult;
  memory: { source: MemoryProbe["source"]; pool: MemoryProbe["pool"] };
  seconds: number;
}

async function defaultWaitStopped(cfg: LlamaServerConfig): Promise<boolean> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if ((await tcpPortProbe(cfg.port)) === "free") return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const baseUrlOf = (server: { baseUrl?: string }, cfg: LlamaServerConfig) => server.baseUrl ?? `http://${cfg.host}:${cfg.port}`;

export async function runMeasure(o: MeasureOptions): Promise<MeasureResult> {
  const say = o.say ?? (() => {});
  const now = o.now ?? Date.now;
  const t0 = now();
  const bench = o.bench ?? ((url: string) => benchCompletion(url));
  const settle = o.settleMs ?? 1500;
  const waitStopped = o.waitStopped ?? defaultWaitStopped;
  const samples: BenchSample[] = [];
  const skipped: string[] = [];
  const halt = async (server: ServerLike, cfg: LlamaServerConfig) => {
    server.stop();
    if (!(await waitStopped(cfg))) say(`  경고: 포트 ${cfg.port} 의 서버가 30초 안에 내려가지 않았습니다 — 다음 측정이 영향을 받을 수 있습니다`);
  };

  const once = async (server: ServerLike & { baseUrl?: string }, cfg: LlamaServerConfig) => {
    // 첫 요청은 그래프·캐시 준비가 섞인다 — 짧게 한 번 흘려보낸 뒤 잰다.
    const url = baseUrlOf(server, cfg);
    await bench(url).catch(() => undefined);
    return bench(url);
  };

  // 1) 기준 — 메모리 적합성은 기존 calibration 이 정한다(규칙을 두 벌로 만들지 않는다).
  say(`기준 설정으로 기동합니다 (-t ${o.base.threads} · -ngl ${o.base.gpuLayers}${o.base.cpuMoeLayers ? ` · --n-cpu-moe ${o.base.cpuMoeLayers}` : ""})`);
  const tLoad = now();
  let baseCfg = o.base;
  let calibration: CalibrationResult | undefined;
  try {
    const started = await (o.startBaseline ?? startCalibrated)(o.base, { make: o.make, say, calibrate: true });
    baseCfg = started.cfg;
    calibration = started.calibration;
    const server = started.server as ServerLike & { baseUrl?: string };
    const loadSeconds = (now() - tLoad) / 1000;
    const free = (await o.memory.freeMiB().catch(() => undefined)) ?? null;
    try {
      const b = await once(server, baseCfg);
      samples.push({ label: `기준 (-t ${baseCfg.threads}${baseCfg.cpuMoeLayers ? ` · --n-cpu-moe ${baseCfg.cpuMoeLayers}` : ""})`, patch: {}, ok: true, loadSeconds, bench: b, freeMiB: free });
      say(`  기준: 프리필 ${b.promptTps.toFixed(0)} tok/s · 생성 ${b.genTps.toFixed(1)} tok/s${free !== null ? ` · 남은 메모리 ${free} MiB (${o.memory.source})` : ""}`);
    } catch (e) {
      samples.push({ label: "기준", patch: {}, ok: false, loadSeconds, bench: null, freeMiB: free, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await halt(server, baseCfg);
    }
  } catch (e) {
    samples.push({ label: "기준", patch: {}, ok: false, loadSeconds: null, bench: null, freeMiB: null, error: e instanceof Error ? e.message : String(e) });
  }
  const pickNow = () => pickBest(samples);
  if (!samples[0]?.ok) {
    const result = pickNow();
    return { ok: false, mode: o.mode, key: measurementKey(baseCfg), baseCfg, calibration, samples, skipped, pick: result, memory: { source: o.memory.source, pool: o.memory.pool }, seconds: (now() - t0) / 1000 };
  }

  // 2) 후보 — 기준(calibration 결과) 위에서 만든다.
  const candidates = measureCandidates(baseCfg, o.cpu, { mode: o.mode, moeLayers: o.moeLayers }).slice(1);
  for (const c of candidates) {
    if (o.maxSeconds !== undefined && (now() - t0) / 1000 > o.maxSeconds) {
      skipped.push(`${c.label} (시간 상한 ${o.maxSeconds}s 초과)`);
      continue;
    }
    await new Promise((r) => setTimeout(r, settle));
    const cfg = { ...baseCfg, ...c.patch };
    const server = o.make(cfg);
    const tl = now();
    say(`후보 ${c.label} 기동…`);
    try {
      await server.start();
      const loadSeconds = (now() - tl) / 1000;
      const free = (await o.memory.freeMiB().catch(() => undefined)) ?? null;
      const b = await once(server, cfg);
      samples.push({ label: c.label, patch: c.patch, ok: true, loadSeconds, bench: b, freeMiB: free });
      say(`  ${c.label}: 프리필 ${b.promptTps.toFixed(0)} tok/s · 생성 ${b.genTps.toFixed(1)} tok/s`);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      samples.push({ label: c.label, patch: c.patch, ok: false, loadSeconds: null, bench: null, freeMiB: null, error: msg });
      say(`  ${c.label}: 실패 — ${msg}`);
    } finally {
      await halt(server, cfg);
    }
  }

  const pick = pickNow();
  return { ok: true, mode: o.mode, key: measurementKey(baseCfg), baseCfg, calibration, samples, skipped, pick, memory: { source: o.memory.source, pool: o.memory.pool }, seconds: (now() - t0) / 1000 };
}

/** 채택된 설정 = 기준 + 채택 후보의 patch. */
export function chosenConfig(r: MeasureResult): LlamaServerConfig {
  return r.pick.changed && r.pick.chosen ? { ...r.baseCfg, ...r.pick.chosen.patch } : r.baseCfg;
}

// ── 저장 — 머신 단위 ────────────────────────────────────────────────────────
//
// 프로젝트 설정(`.harnesside/config.yaml`)은 **작업 디렉터리마다** 다르다. 설치 스크립트가 잰
// 값이 설치 폴더의 설정에만 남으면, 다른 프로젝트에서 띄운 서버는 다시 예측값으로 돈다.
// 그래서 실측은 **머신 단위** 파일에도 남기고, `bootstrap` 이 같은 키(엔진·모델·컨텍스트·오프로드)
// 일 때 그 값을 쓴다.

export interface StoredMeasurement {
  at: string;
  mode: MeasureMode;
  /** 채택된 값 — 기준과 같으면 기준 값 그대로. */
  threads: number;
  cpuMoeLayers: number | null;
  changed: boolean;
  reason: string;
  memory: MeasureResult["memory"];
  samples: Array<{ label: string; ok: boolean; promptTps: number | null; genTps: number | null; freeMiB: number | null; loadSeconds: number | null; error?: string }>;
}

export interface MachineProfileFile {
  version: 1;
  updatedAt: string;
  machine: unknown;
  measurements: Record<string, StoredMeasurement>;
}

export function machineProfilePath(home: string): string {
  return join(home, ".harnesside", "machine-profile.json");
}

export function toStored(r: MeasureResult, at: Date): StoredMeasurement {
  const c = chosenConfig(r);
  return {
    at: at.toISOString(),
    mode: r.mode,
    threads: c.threads,
    cpuMoeLayers: c.cpuMoeLayers ?? null,
    changed: r.pick.changed,
    reason: r.pick.reason,
    memory: r.memory,
    samples: r.samples.map((s) => ({
      label: s.label,
      ok: s.ok,
      promptTps: s.bench ? Math.round(s.bench.promptTps * 10) / 10 : null,
      genTps: s.bench ? Math.round(s.bench.genTps * 100) / 100 : null,
      freeMiB: s.freeMiB,
      loadSeconds: s.loadSeconds === null ? null : Math.round(s.loadSeconds * 10) / 10,
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

export function parseMachineProfile(text: string | null): MachineProfileFile | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as MachineProfileFile;
    if (j && j.version === 1 && j.measurements && typeof j.measurements === "object") return j;
  } catch {
    /* 손상된 파일은 없는 것으로 본다 — 다음 측정이 새로 쓴다 */
  }
  return null;
}

export function mergeMachineProfile(prev: MachineProfileFile | null, machine: unknown, key: string, m: StoredMeasurement): MachineProfileFile {
  return { version: 1, updatedAt: m.at, machine, measurements: { ...(prev?.measurements ?? {}), [key]: m } };
}

/** 같은 키로 잰 스레드 수 — 없으면 undefined(예측값을 그대로 쓴다). */
export function measuredThreads(profile: MachineProfileFile | null, key: string): number | undefined {
  const m = profile?.measurements[key];
  return m && Number.isInteger(m.threads) && m.threads > 0 ? m.threads : undefined;
}
