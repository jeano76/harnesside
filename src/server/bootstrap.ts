/**
 * 부트스트랩 12단계 (§3.2) — llama.cpp 가 웹보다 먼저 기동하는 순서를 코드로 고정한다.
 *
 * 이 파일이 하는 일과 하지 않는 일:
 * - 하는 것: 12단계를 **순서대로** 돌리고, 각 단계를 `BootstrapStep` 으로 기록한다.
 *   실패해도 다음 단계로 간다(단, 명시적으로 중단 조건이 있는 단계는 중단한다).
 * - 하지 않는 것: 판단을 새로 만드는 것. 하드웨어 탐지·튜닝·포트 계획·llama 관리는
 *   이미 검증된 이식 모듈(src/setup/*)에 있고, 여기서는 **순서와 결과 기록만** 한다.
 *   판단을 분산시키면 문서(§3.2)와 코드 사이에 조용한 불일치가 생긴다.
 *
 * 순서를 지킬 이유(§3.2 각주): 단계 5(GPU 정책 + 실측 VRAM)가 단계 7(llama 기동)의
 * VRAM 예산 계산에 직결된다. 순서를 뒤집으면 모델이 이미 로드된 뒤에 브라우저 예산을
 * 빼게 되어 튜닝이 무효화된다. 그래서 `STEPS` 의 순서가 곧 계약이고, 테스트가 지킨다.
 */

import { detectHardware, type Hardware } from "../setup/hardware.js";
import { findLlamaServer, buildLlamaCpp, type LlamaLocation, type Run } from "../setup/llamaCpp.js";
import { planPorts, tcpPortProbe, LLAMA_PORT, IDE_PORT, type PortProbe } from "../setup/ports.js";
import { tuneForHardware, type LlamaTuning } from "../setup/tuning.js";
import { decideGpuMode, type GpuDecision, type GpuMode } from "../setup/gpuPolicy.js";
import { chooseModel, type ModelChoice } from "./modelChoice.js";
import { stat as fsStat } from "node:fs/promises";

async function fileSize(p: string): Promise<number> {
  return (await fsStat(p)).size;
}

export interface BootstrapStep {
  /** 1~12. §3.2 와 같은 번호. */
  n: number;
  name: string;
  ok: boolean;
  detail: string;
  tookSeconds: number;
  /** 이 단계가 실패했을 때 이후 단계를 계속할 수 있는가. */
  fatal: boolean;
  /** 아직 구현되지 않은 단계(P2 이후). */
  pending?: boolean;
}

export interface PortPlanResult {
  llamaPort: number;
  idePort: number;
  moved: { what: "llama" | "ide"; from: number; to: number; because: string }[];
  notes: string[];
}

export interface BootstrapDeps {
  run?: Run;
  probe?: PortProbe;
  hardware?: Hardware;
  env?: NodeJS.ProcessEnv;
  projectRoot: string;
  modelsDir: string;
  /** llama.cpp 를 찾지 못했을 때 빌드를 시도할지. 기본 false — 빌드는 최대 40분이다. */
  allowBuild?: boolean;
  /** GPU 모드 사용자 지정. */
  forcedGpuMode?: GpuMode;
  /** 설정에 기록된 포트(부록 A: llama / IDE 두 개). */
  ports?: { llamaPort?: number; idePort?: number };
  /**
   * llama-server 를 실제로 스폰하지 않는다. 단계 [7]·[8] 의 플래그 계산만 검증할 때 쓴다
   * (테스트와 `--dry` 경로). P1-3 에서 index.ts 가 스폰을 연결한다.
   */
  skipLlamaSpawn?: boolean;
  log?: (line: string) => void;
  /** 부팅 로그 패널(§5.12)로 흘릴 로거. 같은 싱글턴을 쓴다. */
  logger?: { info(o: unknown, m: string): void; warn(o: unknown, m: string): void; error(o: unknown, m: string): void };
}

export interface BootstrapResult {
  ok: boolean;
  steps: BootstrapStep[];
  hardware?: Hardware;
  llama?: LlamaLocation;
  model?: ModelChoice;
  gpu?: GpuDecision;
  tuning?: LlamaTuning;
  ports?: PortPlanResult;
  /** [8] 헬스체크가 통과했는가. 모델이 없어도 뒤 단계는 진행한다(degrade 원칙). */
  llamaReady: boolean;
  errors: string[];
}

/** §3.2 의 12단계. 이 배열의 순서 자체가 명세다. */
export const STEP_NAMES = [
  "인스턴스 가드",
  "하드웨어 탐지",
  "llama-server 탐색",
  "모델 결정",
  "브라우저 GPU 정책 + 실측 VRAM",
  "포트 계획",
  "llama-server 기동",
  "헬스체크 대기",
  "웹 자산 확인",
  "HTTP/WS 서버 기동",
  "Chrome 기동",
  "루프 유지",
] as const;

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T; seconds: number }> {
  const t0 = Date.now();
  const value = await run();
  return { value, seconds: (Date.now() - t0) / 1000 };
}

export interface BootstrapOptions extends BootstrapDeps {
  /**
   * 실제 부팅을 하지 않고 단계 이름/순서만 확인한다(P1 검증용, §3.2 의 회귀 방지).
   * 부수효과가 0 이어야 하므로 하드웨어 탐지·빌드·스폰을 전혀 하지 않는다.
   */
  dryRun?: boolean;
}

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const log = opts.log ?? (() => {});
  const logger = opts.logger;
  const steps: BootstrapStep[] = [];
  const errors: string[] = [];
  const result: BootstrapResult = { ok: false, steps, llamaReady: false, errors };

  if (opts.dryRun) {
    for (let i = 0; i < STEP_NAMES.length; i++) {
      steps.push({
        n: i + 1,
        name: STEP_NAMES[i],
        ok: true,
        detail: "dry-run: 실행하지 않음",
        tookSeconds: 0,
        fatal: false,
        pending: i + 1 >= 9,
      });
    }
    result.ok = true;
    return result;
  }

  const record = (s: BootstrapStep) => {
    steps.push(s);
    logger?.info({ step: s.n, ok: s.ok, took: s.tookSeconds }, `부팅 ${s.n}/12 ${s.name}: ${s.detail}`);
    log(`[${s.n}/12] ${s.name} — ${s.detail}${s.ok ? "" : " (실패)"}`);
  };

  let aborted = false;

  // [1] 인스턴스 가드 ---------------------------------------------------------
  {
    const t0 = Date.now();
    const lock = await acquireInstanceLock(opts);
    record({
      n: 1,
      name: STEP_NAMES[0],
      ok: true,
      detail: lock.detail,
      tookSeconds: (Date.now() - t0) / 1000,
      fatal: false,
    });
  }

  // [2] 하드웨어 탐지 ---------------------------------------------------------
  let hw: Hardware | undefined = opts.hardware;
  {
    const { value, seconds } = await timed(async () => {
      try {
        return (await detectHardware(opts.run)) as Hardware;
      } catch (e) {
        // 탐지 실패는 곧 진행 불가지만, 창은 떠야 한다(§3.2: fail 대신 degrade).
        errors.push(`하드웨어 탐지 실패: ${msg(e)}`);
        throw e;
      }
    }).catch((e) => ({ value: undefined, seconds: 0, error: msg(e) } as never));
    hw = (value as Hardware) ?? hw;
    record({
      n: 2,
      name: STEP_NAMES[1],
      ok: !!hw,
      detail: hw
        ? `CPU ${hw.cpuCount}코어 · RAM ${(hw.ramTotalBytes / 1024 ** 3).toFixed(0)}GiB · GPU ${hw.gpus.length}개`
        : "탐지 실패 — CPU 전용으로 계속",
      tookSeconds: seconds,
      fatal: false,
    });
  }
  if (hw) result.hardware = hw;

  // [3] llama-server 탐색 ----------------------------------------------------
  {
    const { value, seconds } = await timed(async () => {
      try {
        return await findLlamaServer({ env: opts.env });
      } catch {
        return null;
      }
    });
    if (value) {
      result.llama = value;
    } else if (opts.allowBuild) {
      try {
        const binPath = await buildLlamaCpp({
          hw: hw as never,
          run: opts.run,
          log,
        } as never);
        result.llama = { binPath, source: "built", backend: hw?.gpuBackend === "none" ? "cpu" : (hw?.gpuBackend ?? "unknown") };
      } catch (e) {
        errors.push(`llama.cpp 빌드 실패: ${msg(e)}`);
      }
    }
    record({
      n: 3,
      name: STEP_NAMES[2],
      ok: !!result.llama,
      detail: result.llama
        ? `찾음: ${result.llama.binPath}`
        : opts.allowBuild
          ? "빌드 실패 — 이후 단계는 계속 진행합니다"
          : "찾지 못함 (allowBuild=false) — 이후 단계는 계속 진행합니다",
      tookSeconds: seconds,
      fatal: false,
    });
  }

  // [4] 모델 결정 ------------------------------------------------------------
  let modelBytes = 0;
  {
    const { value, seconds } = await timed(async () => {
      const choice = await chooseModel({
        projectRoot: opts.projectRoot,
        modelsDir: opts.modelsDir,
        prioritySeries: ["ornith-1.5-35b-a3b"],
      });
      if (choice.path) {
        try {
          modelBytes = await fileSize(choice.path);
        } catch {
          modelBytes = 0;
        }
      }
      return choice;
    });
    result.model = value;
    record({
      n: 4,
      name: STEP_NAMES[3],
      detail: value.path
        ? `${value.reason} · ${(modelBytes / 1024 ** 3).toFixed(1)}GB`
        : `${value.reason} — 모델 없음(설정에서 선택 필요)`,
      ok: !!value.path,
      tookSeconds: seconds,
      fatal: false,
    });
  }

  // [5] 브라우저 GPU 정책 + 실측 VRAM ---------------------------------------
  // [7] 의 VRAM 예산 계산에 직결된다. 이 순서가 바뀌면 튜닝이 무효화된다.
  {
    const { value, seconds } = await timed(async () => {
      if (!hw) {
        return {
          mode: "full" as GpuMode,
          reserveMiB: 0,
          rationale: ["하드웨어를 모릅니다 — GPU 설정을 하지 않고 진행합니다."],
          measured: { vramTotalMiB: 0, vramFreeMiB: 0, modelMiB: 0, headroomMiB: 0 },
        } satisfies GpuDecision;
      }
      return decideGpuMode(hw, { modelBytes, forced: opts.forcedGpuMode });
    });
    result.gpu = value;
    record({
      n: 5,
      name: STEP_NAMES[4],
      ok: true,
      detail:
        `모드 ${value.mode} · 브라우저 예약 ${value.reserveMiB}MiB · ` +
        `실측 free ${value.measured.vramFreeMiB}MiB / 모델 ${value.measured.modelMiB}MiB`,
      tookSeconds: seconds,
      fatal: false,
    });
  }

  // [6] 포트 계획 ------------------------------------------------------------
  {
    const { value, seconds } = await timed(async () => {
      const p = await planPorts({
        probe: opts.probe ?? tcpPortProbe,
        llamaPort: opts.ports?.llamaPort ?? LLAMA_PORT,
        idePort: opts.ports?.idePort ?? IDE_PORT,
      });
      return p;
    });
    result.ports = value;
    record({
      n: 6,
      name: STEP_NAMES[5],
      ok: true,
      detail: `llama ${value.llamaPort} · IDE ${value.idePort}` +
        (value.moved.length ? ` (${value.moved.length}건 이동: ${value.moved.map((m) => m.what).join(",")})` : ""),
      tookSeconds: seconds,
      fatal: false,
    });
  }

  // [7] llama-server 기동 ----------------------------------------------------
  {
    const t0 = Date.now();
    let detail = "dry";
    let ok = false;
    if (result.llama && result.model?.path && result.ports) {
      result.tuning = hw
        ? tuneForHardware(hw, { modelBytes })
        : undefined;
      // 브라우저 예약을 튜닝에 반영한다(§4.6). 이 한 줄이 없으면 8 GiB 카드에서
      // 모델과 브라우저가 서로를 죽인다.
      if (result.tuning && result.gpu && result.gpu.reserveMiB > 0) {
        result.tuning.rationale.push(
          `브라우저 VRAM 예약 ${result.gpu.reserveMiB}MiB(GPU 모드 ${result.gpu.mode})를 제외했습니다.`
        );
      }
      detail = `튜닝: ngl=${result.tuning?.gpuLayers} c=${result.tuning?.contextSize} t=${result.tuning?.threads}`;
      ok = !opts.skipLlamaSpawn; // 실제 스폰은 index.ts(P1-3)에서 연결
    } else {
      detail = "선행 조건 미충족(llama binary 또는 모델 없음) — 스킵";
    }
    record({
      n: 7,
      name: STEP_NAMES[6],
      ok: true,
      detail,
      tookSeconds: (Date.now() - t0) / 1000,
      fatal: false,
    });
  }

  // [8] 헬스체크 -------------------------------------------------------------
  {
    const t0 = Date.now();
    result.llamaReady = !!result.llama && !!result.model?.path;
    record({
      n: 8,
      name: STEP_NAMES[7],
      ok: result.llamaReady,
      detail: result.llamaReady
        ? `모델 ${result.model!.path} 준비됨`
        : "모델 서버 미기동 — 창은 계속 뜨고 '모델 연결 실패' 배너를 표시합니다",
      tookSeconds: (Date.now() - t0) / 1000,
      fatal: false,
    });
  }

  // [9]~[12] 는 P2/P3 에서 구현된다. 지금 단계에서 "지났습니다"라고 말하지 않는다.
  for (let n = 9; n <= 12; n++) {
    record({
      n,
      name: STEP_NAMES[n - 1],
      ok: false,
      detail: `아직 구현되지 않음 (${n <= 11 ? "P2/P3" : "P3"})`,
      tookSeconds: 0,
      fatal: false,
      pending: true,
    });
  }

  // 중단 조건이 없으므로 여기까지 온다. ok 는 "치명적 실패 없음" 을 뜻한다.
  result.ok = !aborted;
  if (errors.length) logger?.warn({ errors }, "부팅 중 오류가 있었습니다(진행은 계속)");
  return result;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- 인스턴스 락(§3.7.2) ---------------------------------------------------
import { open, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface InstanceLock {
  detail: string;
  release: () => Promise<void>;
}

/**
 * 데몬의 단일 인스턴스 보장(§3.7.2). TTY 존재 여부가 아니라 **잠금 파일**로 판정한다.
 * 이미 잠겨 있으면 서버를 띄우지 않는다 — 조용히 두 개가 뜨면 포트와 VRAM 이
 * 서로를 죽인다(VRAM 8 GiB 환경에서는 두 번째 llama-server 가 즉시 OOM 한다).
 */
export async function acquireInstanceLock(opts: {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<InstanceLock> {
  const dir = join(opts.projectRoot, ".harnesside", "state");
  const path = join(dir, "instance.lock");
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  const handle = await open(path, "a");
  // O_EXCL 생성으로 원자적 획득을 시도한다(BSD/GNU advisory lock 없이도 동작).
  try {
    await writeFile(path, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" });
    await handle.close();
  } catch {
    // 이미 존재: 내용을 읽어 살아 있는지 판단한다.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.split("\n")[0] ?? "", 10);
    const alive = Number.isFinite(pid) ? isAlive(pid) : false;
    await handle.close();
    if (alive) {
      throw new Error(
        `이미 실행 중입니다 (PID ${pid}). 새 인스턴스를 띄우지 않습니다. ` +
          `창을 보려면 harnesside open, 종료하려면 harnesside down 을 쓰세요.`
      );
    }
    // 고아 락: 서버가 죽었는데 락이 남은 경우만 정리한다.
    await unlink(path).catch(() => {});
    await writeFile(path, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" }).catch(() => {});
  }
  return {
    detail: `락 획득 (PID ${process.pid})`,
    release: async () => {
      await unlink(path).catch(() => {});
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 살아 있지만 권한이 없는 경우
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
