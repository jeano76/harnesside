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
import {
  planPorts,
  tcpPortProbe,
  LLAMA_PORT,
  IDE_PORT,
  COMMON_PORTS,
  type PortProbe,
  type PortPlan,
  type AdoptedLlama,
} from "../setup/ports.js";
import { tuneForHardware, type LlamaTuning } from "../setup/tuning.js";
import { decideGpuMode, type GpuDecision, type GpuMode } from "../setup/gpuPolicy.js";
import { detectRunningServer } from "../backend/detect.js";
import { chooseModel, type ModelChoice } from "./modelChoice.js";
import { stat as fsStat } from "node:fs/promises";

/**
 * "이미 떠 있는 OpenAI 호환 서버" 를 찾는 함수형태.
 *
 * **주입하는 이유**: 기본값은 진짜로 127.0.0.1 을 두드린다. 테스트가 그걸 그대로 쓰면
 * 그 테스트는 "이 머신의 8080 에 뭐가 떠 있나" 를 검증한다 — 로컬엔 조용히 있고
 * 러unner에 뭐가 떠 있으면 경로가 달라진다(실제로 그렇게 CI 에서 뒤집혔다).
 */
export type DetectServer = (host: string, ports: number[]) => Promise<{ baseUrl: string; model: string } | null>;

/** 기본 탐지기. setup(설치) 경로가 쓰는 것과 **같은 함수**다 —
 *  "설치할 때 찾던 서버" 와 "부팅할 때 찾던 서버" 가 달라지면 안 된다. */
const defaultDetectRunningServer: DetectServer = (host, ports) => detectRunningServer(host, ports);

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

/**
 * 포트 계획 결과. **정본은 `src/setup/ports.ts` 의 `PortPlan` 이다.**
 *
 * 여기서 같은 모양을 한 번 더 정의하면(모델이 바뀐 버그 #10 처럼) 어느 쪽이 진짜인지
 * 알 수 없게 된다. 그래서 형(type)으로 가리킨다.
 */
export type PortPlanResult = PortPlan;

export interface BootstrapDeps {
  run?: Run;
  probe?: PortProbe;
  /**
   * 주입된 하드웨어. 있으면 **실제 탐지를 하지 않고 그대로 쓴다** — 호출자가 진실을
   * 준 것인데 뒤에서 다시 찾으면 테스트는 그 테스트가 도는 **머신** 을 검증하게 된다.
   * (실제로 겪은 버그: llama-server 를 멈추자 free VRAM 이 285→7517 MiB 이 되어
   *  "off 이어야 한다" 는 테스트가 budgeted 를 받았다.)
   */
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
   * 이미 떠 있는 서버를 찾는다(§6.2 adopt). **기본값은 진짜 localhost 를 두드린다.**
   * 테스트는 반드시 주입한다 — 안 주면 테스트가 그 테스트가 도는 **머신** 을 검증한다.
   */
  detectServer?: DetectServer;
  /**
   * llama-server 를 실제로 스폰하지 않는다. 단계 [7]·[8] 의 플래그 계산만 검증할 때 쓴다
   * (테스트와 `--dry` 경로). P1-3 에서 index.ts 가 스폰을 연결한다.
   */
  skipLlamaSpawn?: boolean;
  /**
   * 이미 획득한 인스턴스 락. 엔트리포인트가 락을 먼저 잡고 부트스트랩에 넘긴다.
   * 이게 없으면 bootstrap 이 직접 획득한다. **둘 다 하면 자기 자신의 락을 "이미 실행 중" 으로
   * 판단해 부팅이 실패한다**(실제로 겪은 버그) — 한 곳에서만 획득해야 한다.
   */
  lock?: InstanceLock;
  /**
   * 9~12 단계 구현체. 나중에 Phase(P2/P3)가 자기를 **여기에 꽂는다** — 단계 목록은
   * 이 파일 하나만 진실원이고, 다른 곳에서 별도로 "부팅 로그"를 만들면 두 진실원이 된다.
   * 없는 단계는 `pending` 으로 남는다("지났습니다"라고 말하지 않는다).
   *
   * 구현체는 **지금까지의 결과**를 인자로 받는다. 결과를 바깥 변수(`boot`)로 대신 보면
   * bootstrap() 이 아직 반환 전이므로 항상 비어 있다 — 실제로 `/api/gpu` 가 정책 없이
   * 나왔던 버그(단계 10 이 1~9 결과를 볼 수 없음)의 원인이다.
   */
  lateSteps?: Partial<
    Record<9 | 10 | 11 | 12, (ctx: { result: BootstrapResult }) => Promise<{ ok: boolean; detail: string }>>
  >;
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
  /**
   * **실제로 서빙 중인 모델 이름.** 채택한 서버가 있으면 단계 6 의 `/v1/models`
   * 응답으로 알 수 있다 — 단계 [4] 의 "모델 없음" 을 그대로 두면 화면이
   * "사용 중: 없음" 을 쓰면서 추측 문장까지 붙인다(2026-10-01 실측).
   *
   * **경로가 아니라 이름일 수 있다.** 실제로 있는 파일인지 확인하지 않으면 경로로
   * 지어내지 않는다.
   */
  servedModel?: string;
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
    const l = opts.lock ?? (await acquireInstanceLock(opts));
    if (!opts.lock) opts.lock = l;
    record({
      n: 1,
      name: STEP_NAMES[0],
      ok: true,
      detail: l.detail,
      tookSeconds: (Date.now() - t0) / 1000,
      fatal: false,
    });
  }

  // [2] 하드웨어 탐지 ---------------------------------------------------------
  let hw: Hardware | undefined = opts.hardware;
  {
    const { value, seconds } = await timed(async () => {
      // **주입된 하드웨어가 있으면 실제 탐지를 하지 않는다.** 항상 실제 값을 쓰는 것은
      // "모킹보다 실기" 와 다르다: 테스트가 주입한 가짜 머신이 무시되면 테스트는
      // 그 테스트가 돌고 있는 **머신의 VRAM** 을 검증하게 된다.
      // 실제로 이 버그가 있었다 — llama-server 를 멈추자 free VRAM 이 285→7517 MiB 이 되어
      // "off 이어야 한다" 는 테스트가 budgeted 를 받았다(기계에 의존한 테스트).
      if (opts.hardware) return opts.hardware;
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
        // `findLlamaServer` returns a richer `FindResult` (rejected / unverified
        // paths travel with it) so a "found nothing" answer can say WHY. The
        // 12-step report only has a slot for the location, so unwrap here —
        // the extra fields are `/server`·`/models`' business (slashService), not this one's.
        return (await findLlamaServer({ env: opts.env })).location;
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
        result.llama = { binPath, source: "built", backend: hw?.gpuBackend === "none" ? "cpu" : "cuda" };
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
  //
  // **먼저 "이미 떠 있는 서버가 있나" 를 보고, 그다음에 포트를 정한다.**
  //
  // 순서를 뒤집으면 adopt 가 **구조적으로 불가능**해진다. `planPorts` 는 포트가
  // free 일 때만 그대로 두므로, 그 결과로 받은 포트를 다시 물으면 당연히 답이 없다.
  // 실제로 그랬다: `tryAdopt(ports.llamaPort)` 은 planPorts 가 "비어 있다고 확인한"
  // 포트를 두드렸다. 그래서 8080 에 정상 llama-server 가 있어도 **8081 로 옮겨 두 번째
  // 모델을 띄웠다** — 실측된 OOM(`cudaMalloc failed`, 1476 MiB 요청 / 321 MiB 여유) 과
  // 정확히 같은 경로. 주석에는 "adopt 한다" 고 적혀 있었지만 **닿지 않는 코드** 였다.
  //
  // 판단은 주입 seam(`detectServer`)으로 한다. 실제로 localhost 를 두드려야 하고,
  // 테스트가 그걸 하면 **이 머신에 뭐가 떠 있는지** 를 검증하게 된다.
  let adoptedServer: AdoptedLlama | undefined;
  {
    const { value, seconds } = await timed(async () => {
      const preferred = opts.ports?.llamaPort ?? LLAMA_PORT;
      const detect = opts.detectServer ?? defaultDetectRunningServer;

      // 설정된 포트가 먼저다, 그 다음 흔한 포트. 중복은 한 번만 — 같은 포트를 두 번
      // 두들리면 "몇c 개를 보킼니다" 를 로그에서 셀 수 없는 모양입니다.
      const candidates = [preferred, ...COMMON_PORTS.filter((p) => p !== preferred)];
      const found = await detect("127.0.0.1", candidates);

      if (found) {
        // **옮기지 않는다.** 그 포트를 후보로 낸 이유가 "거기에 이미 서버가 있다" 이므로.
        // 옮기면 우리가 띄울 두 번째 서버의 자리를 정하는 셈이고, 그 경로는 실측된 OOM
        // 이다(1476 MiB 요청 / 321 MiB 여유). `moved` 에도 거짓을 남기지 않는다.
        return planPorts({
          probe: opts.probe ?? tcpPortProbe,
          llamaPort: preferred,
          idePort: opts.ports?.idePort ?? IDE_PORT,
          adoptedLlama: { port: Number(new URL(found.baseUrl).port), model: found.model },
        });
      }

      return planPorts({
        probe: opts.probe ?? tcpPortProbe,
        llamaPort: preferred,
        idePort: opts.ports?.idePort ?? IDE_PORT,
      });
    });
    result.ports = value;
    adoptedServer = value.adopted;
    record({
      n: 6,
      name: STEP_NAMES[5],
      ok: true,
      detail: adoptedServer
        ? `llama ${value.llamaPort} · IDE ${value.idePort} — 기존 서버를 채택(${adoptedServer.model}). ` +
            `두 번째 서버를 띄우지 않습니다: 8GiB 카드에서 두 개는 즉시 OOM 합니다(실측).`
        : `llama ${value.llamaPort} · IDE ${value.idePort}` +
          (value.moved.length ? ` (${value.moved.length}건 이동: ${value.moved.map((m) => m.what).join(",")})` : ""),
      tookSeconds: seconds,
      fatal: false,
    });
  }

  // [7] llama-server 기동 ----------------------------------------------------
  {
    const t0 = Date.now();
    let detail = "dry";
    if (adoptedServer) {
      // **튜닝을 계산하지 않는다.** 그 숫자는 지금 실행되지 않을 프로세스의 플래그라서
      // 보여주면 "이 플래그로 돈다" 고 읽힌다.
      detail = `스폰하지 않음 — 기존 서버를 그대로 사용(${adoptedServer.model}:${adoptedServer.port}). ` +
        `종료할 때도 이 서버는 죽이지 않습니다(우리가 띄운 것이 아닙니다).`;
    } else if (result.llama && result.model?.path && result.ports) {
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
    } else {
      detail = "선행 조건 미충족(llama binary 또는 모델 없음) — 스킵";
    }
    // `ok` 는 늘 true 다. 단계 7 은 실패로 표시하지 않는다 — 모델이 없거나 스폰을
    // 건너뛰어도 **창은 떠야 한다**(요구 9 의 degrade). "준비됐는가" 는 단계 8 이 말한다.
    record({
      n: 7,
      name: STEP_NAMES[6],
      ok: true,
      detail,
      tookSeconds: (Date.now() - t0) / 1000,
      fatal: false,
    });
  }

  // ── 채택한 서버의 모델을 **현재 모델**로 기록한다 ────────────────────────────
  //
  // 실측(2026-10-01): 실제 llama-server 가 8080 에서 `Ornith-1.5-35B-Q4_K_M.gguf`
  // 를 서빙하는데, 화면은 "사용 중: 없음 (모델 서버가 adopt 했다면 그 서버가 사용
  // 중입니다)" 라고 **추측으로** 쓰고 있었다. 그 괄호 문장이 바로 "답을 모른다" 의
  // 증거다 — **않으면 된다**. 단계 6 의 탐지가 `/v1/models` 로 실린 이름을 이미
  // 알고 있다.
  //
  // 그래서 단계 [4] 의 "모델 없음" 을 **그대로 두지 않는다** — 단, 경로를 지어내지
  // 않는다. 서빙 이름이 **실제 파일** 일 때만 경로로 쓰고, 아니면 이름으로만 둔다
  // (`fake-model` 같은 이름을 경로로 만들면 그 파일을 열었다고 believing—that is worse).
  if (adoptedServer) {
    result.servedModel = adoptedServer.model;
    const asPath = adoptedServer.model.startsWith("/") || adoptedServer.model.startsWith(".") ? adoptedServer.model : null;
    const exists = asPath ? await fileSize(asPath).then((n) => n > 0).catch(() => false) : false;
    if (exists) {
      // **경로가 실재한다** — 이제 단계 4 의 결과를 지배한다.
      result.model = {
        path: asPath,
        reason: `기존 서버가 서빙 중인 모델을 사용합니다: ${adoptedServer.model}`,
        via: "priority-series",
        suggestions: [],
      };
      // **단계 4 를 **성공**으로 다시 남긴다.** `record` 는 항목을 쌓기만 하고
      // 지우지 않는다 — 그래서 여기서 다시 쓰면 "모델 없음 (실패)" 다음에
      // "모델 있음" 이 연달아 나온다. 이건 **오류가 아니라 정정**이므로 사용자에게
      // 두 줄을 보여주기보다 **한 줄로** 말해야 한다.
      //
      // 그래서 기존의 실패 항목을 **제자리에서 고친다**(§5.10: 세션에 남는 것은
      // 최종 사실이어야 한다).
      const prior = [...steps].reverse().find((s) => s.n === 4);
      if (prior) {
        prior.ok = true;
        prior.detail = `기존 서버가 서빙 중인 모델을 사용합니다: ${asPath}`;
        logger?.info({ step: 4, ok: true }, `부팅 4/12 정정: ${prior.detail}`);
        log(`[4/12] ${prior.name} — ${prior.detail} (기존 서버 채택으로 정정 · 앞줄 "모델 없음" 은 superseded)`);
      }
    } else {
      // **경로는 없다.** 이름만 안다는 사실을 구분해서 기록한다.
      record({
        n: 4,
        name: STEP_NAMES[3],
        detail: `모델 파일 경로는 모릅니다 — 실행 중인 서버가 "${adoptedServer.model}" 을 서빙 중입니다.`,
        ok: true,
        fatal: false,
        tookSeconds: 0,
      });
    }
  }

  // [8] 헬스체크 -------------------------------------------------------------
  {
    const t0 = Date.now();
    // 채택한 서버는 **이미** `/v1/models` 에 답했다 — 단계 6 의 탐지가 그 증거다.
    // 그래서 로컬에 모델 파일이 없어도 준비된 상태다. 여기서 "모델 없음" 으로 기록하면
    // 살아 있는 서버를 죽은 것으로 남기게 된다(요구 9 의 degrade 와 정반대).
    result.llamaReady = !!adoptedServer || (!!result.llama && !!result.model?.path);
    record({
      n: 8,
      name: STEP_NAMES[7],
      ok: result.llamaReady,
      detail: adoptedServer
        ? `기존 서버 ${adoptedServer.model} 응답 확인(채택) — 스폰 없음`
        : result.llamaReady
          ? `모델 ${result.model?.path ?? result.servedModel ?? "(경로 모름)"} 준비됨`
          : "모델 서버 미기동 — 창은 계속 뜨고 '모델 연결 실패' 배너를 표시합니다",
      tookSeconds: (Date.now() - t0) / 1000,
      fatal: false,
    });
  }

  // [9]~[12] — Phase P2/P3 가 `lateSteps` 로 자기 구현을 꽂는다.
  // 지금 단계에서 구현되지 않은 것은 "지났습니다"가 아니라 `pending` 이다.
  const PHASE_LABEL: Record<9 | 10 | 11 | 12, string> = {
    9: "P2",
    10: "P1.5",
    11: "P2",
    12: "P3",
  };
  for (const n of [9, 10, 11, 12] as const) {
    const impl = opts.lateSteps?.[n];
    if (!impl) {
      record({
        n,
        name: STEP_NAMES[n - 1],
        ok: false,
        detail: `아직 구현되지 않음 (${PHASE_LABEL[n]})`,
        tookSeconds: 0,
        fatal: false,
        pending: true,
      });
      continue;
    }
    const t0 = Date.now();
    try {
      const out = await impl({ result });
      record({ n, name: STEP_NAMES[n - 1], ok: out.ok, detail: out.detail, tookSeconds: (Date.now() - t0) / 1000, fatal: false });
    } catch (e) {
      // 실패해도 부팅은 계속된다 — 창은 떠야 한다(§3.2 [8] 의 degrade 원칙과 같다).
      errors.push(`단계 ${n} 실패: ${msg(e)}`);
      record({
        n,
        name: STEP_NAMES[n - 1],
        ok: false,
        detail: `실패: ${msg(e)}`,
        tookSeconds: (Date.now() - t0) / 1000,
        fatal: false,
      });
    }
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
