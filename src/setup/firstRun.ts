/**
 * 최초 구동 — 로컬 llama.cpp 를 **세 가지 상태로** 판정하고 각자 다르게 처리한다(요구).
 *
 * 요구 원문: "로컬에 llama.cpp 가 동작하면 해당 서버의 endpoint 와 포트를 찾아서 재
 * 사용하고, 만약 llama.cpp 가 설치가 되어 있으나 구동이 안된 상태라면 포트를 지정해서
 * 구동시켜주고, 설치 자체가 없고 동작중인 llama.cpp 가 없다면 llama.cpp 와 모델을
 * 토컬 PC 사양에 맞춰 설정 및 설치해서 구동하게 해줘."
 *
 * ── 순서가 곧 이 모듈의 존재 이유 ────────────────────────────────────────────
 * 세 경우가 순서대로만 안전하다:
 *
 *   1. **동작 중** → endpoint/포트를 찾아 **재사용**. 우리가 띄우지 않았으니 죽이지도
 *      않는다. 그리고 **여기서 끝난다** — 설치·다운로드로 가지 않는다.
 *   2. **설치됨 · 미구동** → 지정한 포트로 **구동**. 빌드도 재다운로드도 없다.
 *   3. **설치 자체 없음** → 하드웨어를 재고 llama.cpp 를 빌드하고, 그 사양에 맞는
 *      모델을 **찾아서** 받는다.
 *
 * 실측으로 배운 것: 예전에 3번을 1번보다 **먼저** 돌았다. 그 결과 이미 떠 있던 서버가
 * 20GB 모델을 다시 받기 시작했다 — 서빙하던 파일이 이름도 바이트 수도 달라
 * "같은 모델이 있나" 검사가 걸리지 않았고, 그 파일을 서빙하던 서버는 그 내내 살아
 * 있었다(§setup/bootstrap.ts 에 같은 사건이 기록돼 있다). 그래서 1번이 **무조건
 * 먼저**다. 순서를 다시 바꾸면 20GB 를 쓴다.
 *
 * ── 세 번째 경우의 "사양에 맞춰" 가 실제로 무엇인지 ──────────────────────────
 * 추측으로 빌드 옵션을 정하지 않는다. `detectHardware` 로 CPU·RAM·GPU·CUDA 를 재고
 * 그 결과로만 정한다: CUDA 가 있으면 `-DGGML_CUDA=ON`, 없으면 CPU 빌드. 모델은 그
 * 머신에 **들어가는** 것 중 가장 큰 것(§7.2 표) — 아무것도 안 들어가면 가장 작은 것을
 * 고르되 **그 사실을 함께 말한다**(조용히 큰 것을 고르면 76GB 을 받는다, 실측).
 *
 * ── 하지 않는 것 ────────────────────────────────────────────────────────────
 * 모델을 **대체하거나 삭제하지 않는다**. 여기 있는 일은 "없으면 받는다" 뿐이다.
 * 사람이 받아 둔 파일을 지우는 프로그램은 그 파일을 되찾아줄 수 없다.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { detectHardware, type Hardware, type Run } from "./hardware.js";
import { findLlamaServer, buildLlamaCpp, probeLlamaServer, type LlamaLocation } from "./llamaCpp.js";
import { COMMON_PORTS, LLAMA_PORT, planPorts, tcpPortProbe, type PortProbe } from "./ports.js";
import { detectRunningServer, type DetectedServer as RunningServer } from "../backend/detect.js";

/** 세 경우가 이 열거형이다. 판정을 **문자열 비교**로 하지 않기 위해 만든다. */
export type LlamaSituation =
  /** 이미 떠 있다 → 재사용. 설치 여부와 무관하다. */
  | "running"
  /** 설치되어 있다 → 이 포트로 구동. */
  | "installed"
  /** 설치되어 있지 않다 → 빌드 + 모델 수령. */
  | "missing";

export interface FirstRunOptions {
  /** 구동 시킬 포트. 사용자가 지정하면 그 값이 우선이고, 비어 있으면 빈 포트를 고른다. */
  llamaPort?: number;
  modelsDir: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  /** 이걸 끄면 **아무것도 설치·다운로드하지 않는다**(판정만 한다). */
  allowInstall?: boolean;
  /** 이걸 끄면 모델을 받는다. 기본값은 `allowInstall` 을 따른다. */
  allowDownload?: boolean;
  log?: (line: string) => void;
  run?: Run;
  probe?: PortProbe;
  fetchImpl?: typeof fetch;
  detectServer?: (host: string, ports: number[]) => Promise<RunningServer | null>;
  hardware?: Hardware;
}

export interface FirstRunPlan {
  situation: LlamaSituation;
  /** 1번에서 찾은 서버. 있으면 우리가 **스폰하지도 종료하지도** 않는다. */
  running: RunningServer | null;
  /** 1번·2번에서 쓸 포트. 3번이면 빌드 후 고른다. */
  llamaPort: number;
  /** 2번·3번에서만 의미 있다. 1번이면 null — 이미 있는 서버다. */
  llama: LlamaLocation | null;
  hardware: Hardware | null;
  /** 3번에서만. 실제로 무엇을 했는지. */
  installed: { builtFrom?: string; cuda: boolean } | null;
  downloaded: { file: string; bytes: number } | null;
  /** 사람이 읽는 근거. 부팅 로그와 화면에 그대로 나간다. */
  reasons: string[];
  ok: boolean;
  errors: string[];
}

/**
 * `llama-server` 를 찾는 **실제** 경로들 (`llamaCpp.ts` 의 검색 순서와 같은 것).
 *
 * 예전엔 이 자리에 `process.platform === "win32" ? "nul" : "/dev/null"` 이 있었다 —
 * 그리고 `NO_SERVER_HINT` 에 **경로처럼** 들어가서 이렇게 말했다:
 *
 * > "llama-server 를 찾지 못했습니다. PATH 와 /dev/null 을 확인하십시오."
 *
 * 두 가지가 잘못이었다. `/dev/null` 은 **경로가 아니라 장치**라서 "확인"하라는
 * 말이 되지 않는다(여기 없지 않나? 있다? 무엇을?). 그리고 이 프로그램이 실제로
 * 보는 곳은 `~/llama.cpp` 아래 빌드 트리의 `bin` 과 `~/.harnesside/llama.cpp` 아래
 * 빌드 트리의 `bin` 인데,
 * 그 **어디를 봐야 하는지** 말하지 않았다.
 *
 * hint 는 **내가 실제로 확인한 경로**를 말해야 한다. 사용자가 고칠 수 있는 곳만.
 */
const SEARCH_DIRS_HINT = "PATH, ~/llama.cpp/build*/bin, ~/.harnesside/llama.cpp/build*/bin";

async function isFile(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isFile() ?? false;
}

/**
 * 상태를 **판정만** 한다. 아무것도 고치지 않는다.
 *
 * 판정 순서가 곧 우선순위다: "떠 있다" 는 다른 두 가지보다 앞선다. 떠 있는 서버가 있는데
 * 바이너리를 못 찾았다면(다른 컨테이너 등) **빌드가 정답이 아니다** — 이미 있는
 * 서버를 쓰면 끝나니까.
 */
export async function inspectLlama(opts: {
  env?: NodeJS.ProcessEnv;
  home: string;
  ports?: number[];
  probe?: PortProbe;
  detectServer?: (host: string, ports: number[]) => Promise<RunningServer | null>;
}): Promise<{ situation: LlamaSituation; running: RunningServer | null; llama: LlamaLocation | null }> {
  const env = opts.env ?? process.env;
  const detect = opts.detectServer ?? detectRunningServer;

  // 1) 먼저 "이미 떠 있나" — **설치 여부보다 앞선다**.
  const candidates = [...new Set([...(opts.ports ?? []), LLAMA_PORT, ...COMMON_PORTS])];
  const running = await detect("127.0.0.1", candidates).catch(() => null);
  if (running) return { situation: "running", running, llama: null };

  // 2) 바이너리.
  // 여기서는 **찾기만** 한다(판정 함수다). `findLlamaServer` 는 기본으로 후보를 실행해 보고 못 도는
  // 바이너리를 조용히 건너뛰는데, 그러면 "설치돼 있지만 실행할 수 없다" 가 "설치 없음" 으로 바뀌고
  // 사용자는 이유를 못 듣는다(2026-10-04 실측). 실행 가능 여부는 `planFirstRun` 이 `probeLlamaServer`
  // 로 따로 확인해 **이유와 함께** 말한다. 모델 호환성 검사도 여기서는 하지 않는다(모델 미정).
  const found = await findLlamaServer({ env, home: opts.home, probe: async () => true, checkModel: false }).catch(() => null);
  const llama = found?.location ?? null;
  if (llama) return { situation: "installed", running: null, llama };
  return { situation: "missing", running: null, llama: null };
}

/**
 * 포트를 **정한다**. 사용자가 지정한 포트를 우선하고, 그 포트가 이미 차 있으면
 * 이유를 **말하고** 옮긴다 — 조용히 바꾸면 "어제까진 8080 이었는데" 가 된다.
 */
export async function chooseLlamaPort(opts: {
  probe?: PortProbe;
  wanted?: number;
  /** 1번에서 찾은 서버가 있으면 이것이 정답이다(옮기지 않는다). */
  runningPort?: number;
}): Promise<{ port: number; notes: string[] }> {
  const notes: string[] = [];
  if (opts.runningPort) {
    // 그 포트를 후보로 낸 이유가 "거기 서버가 있다" 이므로 옮기면 두 번째 서버가 된다.
    notes.push(`포트를 지정하지 않고 기존 서버의 ${opts.runningPort} 을 그대로 사용합니다.`);
    return { port: opts.runningPort, notes };
  }
  // 0 이나 빈 값은 "자동" 이다 — 0 번 포트를 두드리면 그건 실패도 아니고 답도 없다.
  const wanted = opts.wanted && opts.wanted > 0 ? opts.wanted : LLAMA_PORT;
  const probe = opts.probe ?? tcpPortProbe;
  const state = await probe(wanted);
  if (state === "free") return { port: wanted, notes };
  if (state === "unknown") {
    // 방화벽이 DROP 하면 "연결 불가" 와 "비어 있음" 이 구분되지 않는다. 이 근거로
    // 거절하면 잠긴 네트워크에서 아무 이유 없이 실패한다.
    notes.push(`${wanted} 포트 응답 없음(방화벽) — 그대로 사용을 시도합니다.`);
    return { port: wanted, notes };
  }
  // 차 있다. **빈 포트를 찾아 쓰되 이유를 말한다.**
  const plan = await planPorts({ probe, llamaPort: wanted });
  for (const m of plan.moved) notes.push(`포트를 옮겼습니다: ${m.from} → ${m.to} (${m.because})`);
  return { port: plan.llamaPort, notes };
}

/**
 * 전체를 한 번에 판정하고(필요하면) 설치·수령한다.
 *
 * `allowInstall: false` 면 판정만 하고 손대지 않는다 — `--check` 처럼 상태를 물어보는
 * 경로와 실제 설치를 하는 경로가 **같은 코드** 를 쓴다. 그래서 "확인만" 하는 사람이
 * 실수로 20GB 를 받지 않는다.
 */
export async function planFirstRun(opts: FirstRunOptions): Promise<FirstRunPlan> {
  const log = opts.log ?? (() => {});
  const env = opts.env ?? process.env;
  const reasons: string[] = [];
  const errors: string[] = [];
  const install = opts.allowInstall !== false;
  const mayDownload = opts.allowDownload ?? install;

  const seen = await inspectLlama({
    env,
    home: opts.home,
    // **사용자가 지정한 포트도 후보에 넣는다.** 그 포트에 서버가 떠 있으면 우리가
    // 띄울 필요가 없다 — 요구의 "endpoint 와 포트를 찾아서 재 사용" 에 해당한다.
    // 0 은 "자동" 이므로 후보에 넣지 않는다(0 번 포트를 두드릴 수는 없다).
    ports: opts.llamaPort ? [opts.llamaPort] : undefined,
    probe: opts.probe,
    detectServer: opts.detectServer,
  });

  // ── 1. 이미 떠 있다 ────────────────────────────────────────────────────────
  if (seen.situation === "running" && seen.running) {
    const port = Number(new URL(seen.running.baseUrl).port);
    reasons.push(
      `이미 실행 중인 llama-server 를 사용합니다: ${seen.running.baseUrl} (${seen.running.model}). ` +
        `설치·다운로드는 하지 않습니다.`,
    );
    log(reasons[reasons.length - 1]);
    return {
      situation: "running",
      running: seen.running,
      llamaPort: port,
      llama: null,
      hardware: null,
      installed: null,
      downloaded: null,
      reasons,
      ok: true,
      errors,
    };
  }

  // ── 2/3. 포트 ──────────────────────────────────────────────────────────────
  const { port, notes } = await chooseLlamaPort({ probe: opts.probe, wanted: opts.llamaPort });
  for (const n of notes) {
    reasons.push(n);
    log(n);
  }

  // ── 2. 설치되어 있으나 구동 안 됨 ─────────────────────────────────────────
  if (seen.situation === "installed" && seen.llama) {
    reasons.push(
      `설치된 llama-server 를 찾았습니다: ${seen.llama.binPath} (${seen.situation === "installed" ? seen.llama.source : ""}). ` +
        `${port} 포트로 구동합니다 — 빌드도 모델 재다운로드도 하지 않습니다.`,
    );
    // **존재와 실행 가능은 다르다.** 실행 파일이 있어도 이 머신에서 못 돌릴 수 있다
    // (예: CUDA 를 못 찾는 빌드). 확인하고, 못 돌리면 "설치됨" 이라는 결론을 거둔다.
    if (opts.run) {
      const probeResult = await probeLlamaServer(seen.llama.binPath, opts.run).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (!probeResult.ok) {
        errors.push(`llama-server 를 실행할 수 없습니다: ${probeResult.error ?? "알 수 없음"}`);
        reasons.push(errors[errors.length - 1]);
      } else if (probeResult.version) {
        reasons.push(`바이너리 버전: ${probeResult.version}`);
      }
    }
    return {
      situation: "installed",
      running: null,
      llamaPort: port,
      llama: seen.llama,
      hardware: null,
      installed: null,
      downloaded: null,
      reasons,
      ok: errors.length === 0,
      errors,
    };
  }

  // ── 3. 설치 자체가 없다 ────────────────────────────────────────────────────
  if (!install) {
    // **하드웨어도 재지 않는다.** 판단만 하러 왔는데 `nvidia-smi` · `lscpu` 를
    // 띄우는 것은 "읽기 전용" 이어도 시간이 걸리고, 판단 결과를 바꾸지도 않는다
    // (하드웨어는 **설치할지 말지** 를 정하는 데만 쓰인다).
    reasons.push(`설치하지 않습니다(allowInstall=false). 'harnesside doctor --install' 로 설치하십시오.`);
    return {
      situation: "missing",
      running: null,
      llamaPort: port,
      llama: null,
      hardware: null,
      installed: null,
      downloaded: null,
      reasons,
      ok: false,
      errors,
    };
  }

  // 여기부터는 실제로 손댄다. 그 전에 하드웨어를 **재고** — 빌드 옵션(CUDA)과
  // 모델 선택(VRAM)이 모두 여기서 나온다.
  const hardware = opts.hardware ?? (await detectHardware(opts.run).catch(() => null));
  const cuda = hardware?.canBuildCuda ?? false;
  reasons.push(
    hardware
      ? `llama-server 를 찾지 못했습니다. 이 머신으로 설치합니다: CPU ${hardware.cpuCount}코어 · RAM ${(hardware.ramTotalBytes / 1024 ** 3).toFixed(0)}GiB · GPU ${hardware.gpus.length}개${cuda ? " · CUDA 빌드 가능" : ""}`
      : "llama-server 를 찾지 못했습니다. 하드웨어를 확인하지 못해 CPU 빌드로 진행합니다.",
  );
  log(reasons[reasons.length - 1]);

  const installed: FirstRunPlan["installed"] = { cuda };
  let llama: LlamaLocation | null = null;
  try {
    const binPath = await buildLlamaCpp({
      // `canBuildCuda` 가 정의되지 않은 하드웨어를 넣으면 CMake 가 CUDA 를 켠 채
      // configure 실패를 낸다(실측). 없는 값은 **false** 다 — 추측하지 않는다.
      hw: (hardware ?? { canBuildCuda: false }) as never,
      run: opts.run ?? ((await import("./llamaCpp.js")).defaultRun),
      log,
    });
    installed.builtFrom = binPath;
    llama = { binPath, source: "built", backend: cuda ? "cuda" : "cpu" };
    reasons.push(`llama.cpp 빌드 완료: ${binPath} (${cuda ? "CUDA" : "CPU"})`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push(`llama.cpp 설치 실패: ${message}`);
    reasons.push(errors[errors.length - 1]);
    log(errors[errors.length - 1]);
  }

  // 모델: "없으면 받는다" 까지만 한다. **있는 것을 지우거나 바꾸지 않는다.**
  let downloaded: FirstRunPlan["downloaded"] = null;
  if (llama && mayDownload) {
    const got = await fetchModelForMachine({
      modelsDir: opts.modelsDir,
      hardware,
      log,
      fetchImpl: opts.fetchImpl,
    }).catch((e) => {
      errors.push(`모델 받기 실패: ${e instanceof Error ? e.message : String(e)}`);
      reasons.push(errors[errors.length - 1]);
      return null;
    });
    downloaded = got;
  } else if (llama && !mayDownload) {
    reasons.push(`모델은 받지 않습니다(allowDownload=false). ${opts.modelsDir} 에 .gguf 를 두십시오.`);
  }

  return {
    situation: "missing",
    running: null,
    llamaPort: port,
    llama,
    hardware,
    installed,
    downloaded,
    reasons,
    ok: !!llama,
    errors,
  };
}

/**
 * 이 머신에 맞는 모델을 **찾아서** 받는다.
 *
 * 순서를 바꾼 적이 있다: 예전에 모델을 먼저 받고 서버를 나중에 봤다. 그 결과 이미
 * 떠 있던 서버가 있는 머신에서 20GB 가 다시 다운로드됐다. 그래서 이 함수는
 * `planFirstRun` 이 서버를 **확인한 뒤에야** 호출된다.
 *
 * 받은 뒤에도 **검증한다**: 크기가 0 인 파일은 "다운로드 성공" 이 아니라 실패다.
 * 그래프 {.part} 가 남은 채 성공한 것처럼 보일 수 있다.
 */
export async function fetchModelForMachine(opts: {
  modelsDir: string;
  hardware: Hardware | null;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ file: string; bytes: number } | null> {
  const log = opts.log ?? (() => {});
  const f = opts.fetchImpl ?? fetch;

  // 이미 있는 파일을 **먼저** 본다. 받아 둔 것을 다시 받지 않는다.
  const existing = await findUsableModel(opts.modelsDir);
  if (existing) {
    log(`이미 있는 모델을 씁니다: ${existing.file} (${(existing.bytes / 1024 ** 3).toFixed(1)}GiB)`);
    return existing;
  }

  const vramGiB = (opts.hardware?.gpus?.[0]?.vramTotalBytes ?? 0) / 1024 ** 3;
  if (vramGiB <= 0) {
    // **추측으로 크기를 정하지 않는다.** VRAM 을 모르면 어느 양자화가 맞는지
    // 말할 수 없다. 여기서 고르면 사용자는 그 말을 근거로 몇십 GB 를 받는다.
    log(`GPU VRAM 을 알 수 없어 모델을 고르지 않습니다. ${opts.modelsDir} 에 .gguf 를 두십시오.`);
    return null;
  }

  const { DEFAULT_PRIORITY_SERIES, searchHub, fillSizes, recommend } = await import("../models/hub.js");
  const { modelPathFor } = await import("../models/download.js");
  const series = DEFAULT_PRIORITY_SERIES[0];
  log(`이 머신에 맞는 모델을 찾습니다 (GPU ${vramGiB.toFixed(1)}GiB · ${series})…`);
  const models = await searchHub({ query: series, limit: 20, fetchImpl: f });
  if (!models.length) {
    log("HuggingFace 에서 후보를 찾지 못했습니다. 모델은 받지 않습니다.");
    return null;
  }
  const sizes = await fillSizes(models, { fetchImpl: f });
  const scored = recommend(sizes.models, opts.hardware, {});
  const pick = scored.pinned ?? scored.top[0] ?? null;
  if (!pick) {
    log(`추천할 모델이 없습니다 (${sizes.unknown.length}건은 크기를 모릅니다 — 점수 0).`);
    return null;
  }
  log(`받습니다: ${pick.model.file} (${(pick.model.bytes / 1024 ** 3).toFixed(1)}GiB) — ${pick.notes.join(", ") || "추천 1순위"}`);

  // 파일 이름만 떼어 **디렉터리 안에** 놓는다. `file` 은 `repo/경로` 모양이라 그대로
  // join 하면 models 디렉터리 밖(`../`)에 쓰게 된다 — 경로가 깨지면 조용히 엉뚱한
  // 곳에 20GB 가 쌓이고, 그 사실을 로그가 말하지 않는다.
  const fileName = pick.model.file.split("/").pop()!;
  const destPath = modelPathFor(opts.modelsDir, fileName);
  const { ModelDownloader } = await import("../models/download.js");
  const dl = new ModelDownloader({ fetchImpl: f, onProgress: (it) => log(`  ${it.file} ${Math.round(it.progress)}%`) });
  const item = await dl.download({
    id: `firstrun:${pick.model.file}`,
    // `/resolve/main/` 이 **없으면 404** 다. 목록 API 가 주는 `file` 은
    // `repo/경로` 라 그대로 붙이면 안 되고, 이 형태여야 실제 파일이 나온다.
    url: `https://huggingface.co/${pick.model.repo}/resolve/main/${pick.model.file.split("/").slice(1).join("/")}`,
    destPath,
    totalBytes: pick.model.bytes,
  });
  if (item.state !== "done") {
    log(`다운로드가 끝나지 않았습니다: ${item.state}`);
    return null;
  }
  const size = await stat(destPath).then((s) => s.size).catch(() => 0);
  if (size <= 0) {
    // **0 바이트를 성공으로 두지 않는다.** 그 파일로 서버를 띄우면 "모델이 없음" 이
    // 되는데, 로그는 "받았다" 고 말하고 있다.
    log(`다운로드된 파일이 비어 있습니다: ${destPath}`);
    return null;
  }
  return { file: destPath, bytes: size };
}

/** 디렉터리에서 **쓸 수 있는** .gguf 를 찾는다. */
async function findUsableModel(dir: string): Promise<{ file: string; bytes: number } | null> {
  const { readdir } = await import("node:fs/promises");
  const { isUsableModel } = await import("../models/manage.js");
  const names = await readdir(dir).catch(() => [] as string[]);
  const ggufs = names.filter((n) => n.toLowerCase().endsWith(".gguf") && isUsableModel(n));
  if (!ggufs.length) return null;
  // 가장 큰 것을 고른다(§7.2: 계열 안에서는 품질 우선).
  let best: { file: string; bytes: number } | null = null;
  for (const n of ggufs) {
    const p = join(dir, n);
    const size = await stat(p).then((s) => s.size).catch(() => 0);
    if (size > 0 && (!best || size > best.bytes)) best = { file: p, bytes: size };
  }
  return best;
}

/** 설치 여부만 빠르게. 파이프라인의 각 단계가 이걸로 갈라진다. */
export async function llamaStatus(opts: { env?: NodeJS.ProcessEnv; home: string }): Promise<string> {
  const env = opts.env ?? process.env;
  const s = await inspectLlama({ env, home: opts.home });
  if (s.situation === "running") return `running (${s.running!.baseUrl})`;
  if (s.situation === "installed") return `installed (${s.llama!.binPath})`;
  return "missing";
}

/** `doctor` 가 쓰는 한 줄. 판단을 **여기서만** 한다. */
export const NO_SERVER_HINT =
  `llama-server 를 찾지 못했습니다. ` +
  `설치되어 있다면 ${SEARCH_DIRS_HINT} 에 있는지 확인하십시오. ` +
  `없다면 하드웨어(GPU·메모리)에 맞춰 설치합니다 — 차감 없이 CPU 로도 동작합니다.`;
