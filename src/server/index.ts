#!/usr/bin/env node
/**
 * harnesside 서버 엔트리포인트 — TTY 없는 데몬(§3.7)
 *
 * 이 파일의 계약(§0.2 불변 조건):
 * 1. llama.cpp 가 웹/창보다 **먼저** 기동한다(요구 9).
 * 2. 모델이 죽어도 **창은 뜬다**(degrade). 빈 화면·무한 로딩은 금지.
 * 3. 창을 닫으면 llama.cpp 도 멈춘다(기본 `window` 모드).
 * 4. 서버는 **TTY 없이** 돈다 — 화면 출력 금지, 파일/NDJSON 만.
 *
 * 아직 없는 것(단계 9~12): HTTP/WS 서버, Chrome 기동. 지금은 1~8 만 실제로 돌고
 * 나머지는 `pending` 으로 기록한다. 없는 걸 동작한다고 말하지 않는 것이 우선이다.
 *
 * 사용법:
 *   npx tsx src/server/index.ts              # 부팅 + 창(현재는 창 단계까지 미구현)
 *   npx tsx src/server/index.ts --no-browser # llama 만 기동(P1 검증용)
 *   npx tsx src/server/index.ts --dry        # 12단계 이름/순서만 (부수효과 0)
 *   npx tsx src/server/index.ts --daemon     # 데몬 모드 플래그(창 없음)
 */

import { bootstrap, type BootstrapResult } from "./bootstrap.js";
import { LlamaLauncher } from "./llamaLauncher.js";
import { resolveBrowserIntent } from "./browserIntent.js";
import { acquireInstanceLock, type InstanceLock } from "./bootstrap.js";
import { portOwner } from "../instanceGuard.js";
import { HttpServer, readBody, clampInt } from "./httpServer.js";
import { defaultPaths, initDaemonLogging, clearInstance, writeInstance, type DaemonMode } from "./daemon.js";
import { teeChild } from "./logWatcher.js";
import type { LogLevel, LogSource } from "./logRing.js";
import { safeListDir, safeReadFile, safeWriteFile, safeResolve } from "../fs/safePath.js";
import { searchFiles, listFiles, isSearchFailure } from "../fs/search.js";
import { gitStatus, gitShowHead } from "./gitDiff.js";
import { planClone, clone, redactUrl, pull, push, summarize, currentBranch, commit } from "../git/sync.js";
import { MetricsSampler } from "./metrics.js";
import { WorkspaceWatcher } from "./fsWatcher.js";
import { liveModelPath, applyModelSwitch, loadThinkBudget } from "./modelIdentity.js";
import { WorkspaceService } from "./workspaceService.js";
import { formatCrashReport, writeCrashLogSync, readCrashTail, acknowledgeCrashLog, archiveHarmlessCrashLog } from "../crashHandler.js";
import { AgentService, DEFAULT_THRESHOLDS } from "./agentService.js";
import { recommendThresholds, type CompactionThresholds } from "../compaction/compactor.js";
// 시스템 프롬프트 정본(출력 형식 규칙 포함). 여기서 문자열을 두지 않는다 — 2026-10-05.
import { buildSystemPrompt } from "../agent/systemPrompt.js";
import { ApprovalGate } from "./approval.js";
import { SessionBridge } from "../session/bridge.js";
import { searchHub, recommend, fillSizes } from "../models/hub.js";
import { ModelDownloader, modelPathFor } from "../models/download.js";
import { planSwap } from "../models/manage.js";
import { UpdateService } from "./updateService.js";
import type { ReleaseManifest } from "./update/manifest.js";
import { parseManifest } from "./update/manifest.js";
import { readBuildInfo } from "./buildInfo.js";
import { NoticeService } from "./update/noticeService.js";
import { TerminalManager, exitLabel } from "./terminal.js";
import type { UpdateChannel, ApplyGuard } from "./update/pipeline.js";
import { BrowserLauncher } from "./browserLauncher.js";
import { WsHub } from "./wsHub.js";
import { startWatchdog, type Watchdog } from "./watchdog.js";
import { issueToken } from "../auth/token.js";
import { detectModelAt } from "../backend/detect.js";
import { writeCheckpoint } from "../compaction/checkpoint.js";
import { CliSessions } from "./cliSessions.js";
import { installPipeGuard, isBrokenPipe, safeWrite } from "./safeOutput.js";
import { bootFailureLines } from "../shared/bootFailure.js";
import { readVersion } from "./version.js";
import { remoteBaseUrlNotice } from "./baseUrlPolicy.js";
import { SlashService, SERVER_SLASH_KEYS, type ServerSlashKey } from "./slashService.js";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, isAbsolute, resolve, relative } from "node:path";
import { mkdir, access, readdir, stat, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import stripAnsi from "strip-ansi";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const DRY = flag("--dry");
// "창을 띄워야 하는가" 의 **정본은 browserIntent.ts** 다. 여기서 또 판단하면
// 두 진실원이 되고, 실제로 그랬다 — 플래그 변수는 있었는데 단계 11 이 안 봤다.
const BROWSER_INTENT = resolveBrowserIntent(argv);
const NO_BROWSER = !BROWSER_INTENT.launch;

/** 데몬 상태 출력 — 한 줄씩만. 화면 출력(커서 이동·바)은 절대 하지 않는다(§3.7.1). */
function emit(line: string) {
  // 닫힌 파이프에 써도 죽지 않는다(`safeOutput.ts` — 크래시 로그 2.7억 자 사고).
  safeWrite(process.stdout, `${line}\n`);
}
installPipeGuard([process.stdout, process.stderr]);

/**
 * 읽기 전용 명령은 부팅 없이 즉시 처리한다(§3.7.4).
 * `status`/`logs`/`down`/`doctor` 는 서버가 죽어 있어도 동작해야 한다 —
 * "서버가 없으니 상태를 알 수 없다" 는 비참한 상황이 되기 때문이다.
 */
async function tryStandalone(): Promise<boolean> {
  const { runStandalone, USAGE } = await import("./cli.js");
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    emit(USAGE);
    return true;
  }
  const code = await runStandalone(argv);
  if (code !== null) process.exit(code);
  return false;
}

function stateDir(projectRoot: string): string {
  return join(projectRoot, ".harnesside", "state");
}

/** 모듈 로드 시각 — 프로세스 기동의 기준. `/api/health` 가 그대로 노출한다. */
const STARTED_AT = Date.now();

async function main(): Promise<number> {
  const projectRoot = process.cwd();
  const home = homedir();
  const modelsDir = process.env.HARNESSIDE_MODELS_DIR ?? join(home, ".harnesside", "models");
  const paths = defaultPaths(projectRoot, home);
  await mkdir(stateDir(projectRoot), { recursive: true });

  // 데몬 로깅: 전부 이 링을 지난다(분산 로깅은 반드시 누락된다 — §3.5.1).
  const logging = initDaemonLogging(paths);
  const ring = logging.ring;
  // **수명주기 이벤트는 stdout 에도 남긴다.** 링은 파일에만 있으므로, 창이 왜 닫혔는지
  // 알고 싶은 사람이 파일을 열어야 한다 — 그게 곧 원인을 숨기는 꼴이다(§5.12.1).
  // 링 항목 중 수명주기(scope=lifecycle)만 mirroring 한다. 전부 찍으면 로그가 두 배로
  // 부풀고(모델이 한 줄을 각자 다르게 말하는 문제), 아무것도 안 찍으면 원인이 사라진다.
  ring.onEntry((e) => {
    if (e.scope === "lifecycle") emit(`[${e.level === "error" ? "warn" : e.level}] ${e.message}`);
  });
  const mode: DaemonMode = flag("--daemon") ? "daemon" : "window";

  // §5.5: 계측은 **서버가 1Hz 로 한 번만** 한다. 라우트는 마지막 샘플만 읽는다 —
  // 요청마다 `nvidia-smi` 를 실행하면 계측 자체가 부하가 된다.
  /**
   * 컨텍스트 사용량 — **실측값**만 담는다 (2026-10-01).
   *
   * 실측: `MetricsSampler` 를 **의존성 없이** 만들어서 `deps.context` 가 항상
   * `undefined` 였다. 그래서 `context` 는 매 샘플 `null` 이었고, 모니터 패널의
   * 컨텍스트 게이지는 **"측정 불가"** 로 영구히 표시됐다. 그런데 값은 이미 어딘가에
   * 있었다 — `AgentService` 가 `onContextUsage` 로 **실측해서** 보내고 있었고, 그것은
   * 에이전트 스트림의 상태 줄(`컨텍스트 1221/32768`)로만 흘렀다.
   *
   * 즉 **수는 있었고 화면만 못 봤다.** 추측으로 채우지 않고 그 실측값을 그대로
   * 계측기에 물린다. "측정 불가" 를 "0" 으로 바꾸면 사용자는 "컨텍스트가 안 찼다" 고
   * 읽는데 실제로는 100 임을 알지 못한다 — 그래서 **0 이 아니라 null** 이 옳다.
   */
  // lastContext 삭제됨(2026-10-04): 값을 넣는 코드가 없어 항상 null 이었다.
  // 실측은 AgentService 가 들고 있다(턴 중 onContextUsage + 부팅 시 refreshContext).
  // eslint-disable-next-line prefer-const
  let agentRef: AgentService | null = null;
  const agentContextUsage = (): { usedTokens: number; totalTokens: number } | null => {
    try {
      return agentRef?.contextUsage() ?? null;
    } catch {
      return null;
    }
  };
  const metrics = new MetricsSampler(undefined, {
    context: () => agentContextUsage(),
  });
  // §8.3 워크스페이스 — **살아 있는 루트** 를 들고 있다. 경로 API 는 상수를 쓰지 않고
  // 여기서 읽는다. 전환은 확인을 거치고, 전이는 실패해도 이전 상태를 보존한다.
  const workspace = new WorkspaceService({
    root: projectRoot,
    onChange: (e) => {
      // 감시 루트도 같이 옮긴다. 옛 루트를 계속 감시하면 "변경됨" 알림이 엉뚱한
      // 파일에 대해 울린다(§5.2).
      fsWatcher.setRoot(e.to.root);
      hub?.publish({ type: "workspace.changed", change: e } as never);
      ring.info("lifecycle", `워크스페이스 전환: ${e.from.name} → ${e.to.name}`, "server", {
        from: e.from.root,
        to: e.to.root,
        warnings: e.switchPlan.warnings,
      });
      emit(`[workspace] ${e.from.root} → ${e.to.root}`);
    },
  });
  // M1 터미널. PTY 는 **워크스페이스 루트 에서만** 연다 — 밖에서 열면 승인 게이트를
  // 우회한 임의 실행이 된다(모듈 주석).
  const terminal = new TerminalManager({
    root: workspace.root(),
    events: {
      onData: (id, data) => hub?.publish({ type: "terminal.data", id, data } as never),
      onExit: (session) => {
        hub?.publish({ type: "terminal.exit", session } as never);
        ring.warn("terminal", `셸 종료: ${session.title} — ${exitLabel(session) ?? "종료"}`, "server", {
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
          openError: session.openError,
        });
      },
      onWarn: (message) => ring.warn("terminal", message, "server"),
    },
  });
  // §5.3: 에이전트 시스템 프롬프트. 워크스페이스의 **규칙 파일**을 여기에 싣는다 —
  // 규칙을 읽어놓고 프롬프트에 안 넣으면 "규칙이 적용됐다" 고 말할 수 없다.
  // **함수**로 둔다: 턴마다 읽어야 전환이 반영된다. 상수로 두면 규칙이 옛 폴더 것만 남는다.
  //
  // 프롬프트 **정본은 `agent/systemPrompt.ts`** 다. 여기서 문자열을 직접 만들면
  // (1) 출력이 어떤 규칙을 담는지 확인할 방법이 없고, (2) 규칙이 두 벌이 된다.
  // 2026-10-05 까지만 여기 4줄짜리 프롬프트가 있었고, 출력 형식에 관한 단 한 줄도
  // 없었다 — 그래서 답이 쉼표로 이어진 한 문단 벽으로 나왔다(사용자가 실측으로 신고).
  const systemPrompt = (): string =>
    buildSystemPrompt({
      workspaceRoot: workspace.root(),
      ruleFiles: workspace.rules().map((r) => r.path),
    });

  // §5.2: 워크스페이스 파일 변경 감지. 자기 쓰기는 `self:true` 로 표시되어
  // 사용자가 자기 저장을 "외부 변경" 으로 오해하지 않는다.
  const fsWatcher = new WorkspaceWatcher({
    root: projectRoot,
    onChange: (e) => {
      // 자기 쓰기가 아니라면 사용자에게 알린다 — 버퍼에 없는 파일의 외부 편집이다.
      if (e.self || !e.path) return;
      hub?.publish({ type: "fs.changed", path: e.path, kind: e.kind } as never);
    },
  });

  if (DRY) {
    const r = await bootstrap({ projectRoot, modelsDir, dryRun: true });
    for (const s of r.steps) emit(`${String(s.n).padStart(2)}. ${s.name}`);
    return 0;
  }

  // ── 최초 구동: llama.cpp 세 가지 상태를 먼저 판정한다 ──────────────────────
  //
  // 여기서 `allowInstall: false` 다. **기본 부팅은 설치하지 않는다** — cmake 도
  // 20GB 다운로드도 사용자가 모르게 일어나면 안 된다. 판정 결과는 그대로 알린다.
  // 설치는 `harnesside doctor --install` 이 한다(요구: 세 경우를 나누는 경로).
  //
  // 그런데 이 판정이 이미 있는 bootstrap 안에 **중복**된다는 게 걸린다. `bootstrap` 의
  // [3]·[6] 이 이미 "바이너리 찾기"와 "떠 있는 서버 채택" 을 한다. 그래서 여기서는
  // **판정만** 하고 결과는 부팅 단계에 실어서, 한 곳에 모은다 — 두 판정이 어긋나면
  // 어느 쪽이 옳은지 알 수 없다(실측: adopt 죽은 코드 사건).
  {
    const { inspectLlama } = await import("../setup/firstRun.js");
    const seen = await inspectLlama({ home }).catch(() => null);
    if (seen?.situation === "running") {
      emit(`[0] 실행 중인 llama-server 를 사용합니다: ${seen.running!.baseUrl} (${seen.running!.model}) — 설치하지 않습니다.`);
    } else if (seen?.situation === "installed") {
      emit(`[0] 설치된 llama-server: ${seen.llama!.binPath} — ${seen.llama!.source}`);
    } else {
      emit(`[0] llama-server 를 찾지 못했습니다. 'harnesside doctor --install' 로 이 머신에 맞춰 설치하십시오.`);
    }
  }

  // §8.3: 지문을 **한 번** 구한다. 이후 모든 판정이 같은 값을 봐야 전환 중에
  // 트리와 도구의 기준이 어긋나지 않는다.
  await workspace.init();

  // §5.3 에이전트. llama 포트(BaseUrl)는 **부팅 후에** 정해지므로(단계 6·7) 이 시점의
  // 값으로 박지 않는다 — 부팅 전에 만들어 두면 어차피 옛 값이다.
  const session = new SessionBridge({
    stateDir: stateDir(projectRoot),
    workspace: () => workspace.root(),
    onSaved: (doc) => ring.info("session", `세션 저장됨: ${doc.id}`, "server", { blocks: doc.blocks.length }),
    onError: (m) => {
      // **저장 실패를 조용히 삼키지 않는다** — 복구할 수 없는 순간에야 알게 되는 실패다.
      ring.error("session", `세션 저장 실패: ${m}`, "server");
      emit(`[session] 저장 실패: ${m}`);
    },
  });
  session.start();
  // §9.1 업데이트. GitHub 를 **실제로** 본다. 네트워크 주입은 테스트에만 쓴다.
  const updateSlotsDir = join(stateDir(projectRoot), "update-slots");
  const updateMarker = join(stateDir(projectRoot), "update-pending.json");
  const updateStatsFile = join(stateDir(projectRoot), "update-stats.json");

  // ── R-2.1: 추정으로 메우지 않는다 ──────────────────────────────────────────
  // 직전 적용에 걸린 **실측 초**. 저장된 값이 없으면 null — 화면에 "아직 실측한 적 없다".
  // 예전 값 `estimatedSeconds: 8` 은 **사용자 안내 문구**로 나갔던 숫자였다.
  const measuredApplySeconds = (): number | null => {
    try {
      const raw = JSON.parse(readFileSync(updateStatsFile, "utf8")) as { lastApplySeconds?: unknown };
      return typeof raw.lastApplySeconds === "number" && Number.isFinite(raw.lastApplySeconds) ? raw.lastApplySeconds : null;
    } catch {
      return null;
    }
  };
  /** 이번에 받을 자산의 실제 크기. 받을 자산이 없으면 null(모름). */
  const pendingAssetBytes = (): number | null => {
    // 받을 것은 **이 머신의 포터블 zip** 하나다 — 다른 자산의 크기를 대신 말하지 않는다.
    const { zip } = updates.bundleAssets();
    return zip && zip.size > 0 ? zip.size : null;
  };

  // ── 자기 경로: **`process.argv[1]` 이 아니라 이 모듈의 실제 경로** ────────────
//
// `installRoot()` 는 `selfPath` 의 세 단계 위 = 패키지 루트(포터블 설치 폴더)다.
// 그러므로 `selfPath` 가 **진짜 진입 파일** 이어야 한다.
//
// `process.argv[1]` 을 쓰면 **전역 설치에서 완전히 틀린다**:
//   npm 은 `<prefix>/bin/harnesside` 를 **심볼릭 링크**로 만든다.
//   `$PATH` 로 실행하면 argv[1] 은 그 링크 경로이고,
//   `resolve(링크, "..", "..")` 는 **`dist/` 가 아니라 npm 전역 prefix 전체**가 된다.
//   → 셀프업데이트가 **npm 전역 폴더 통째로** 교체하려 한다.
//
// `import.meta.url` 은 **노드가 심볼릭 링크를 따라가서** 실제 모듈 경로를 준다.
// 그래서 전역 설치에서도 `installRoot` 가 패키지 안의 `dist/` 를 정확히 가리킨다.
// (`src/server/` 와 `dist/server/` 는 둘 다 두 단계 아래라 개발 실행에서도 같다.)
const selfPath = fileURLToPath(import.meta.url);

const updates: UpdateService = new UpdateService({
    currentVersion: readVersion(),
    channel: (process.env.HARNESSIDE_UPDATE_CHANNEL as UpdateChannel) ?? "stable",
    slotsDir: updateSlotsDir,
    selfPath,
    measuredApplySeconds,
    onPhase: (p) => {
      hub?.publish({ type: "update.phase", phase: p } as never);
      const lvl = p.state === "failed" ? "error" : "info";
      ring[lvl]("update", p.message, "server", { state: p.state, progress: p.progress, error: p.error ?? null });
    },
    onError: (m) => emit(`[update] ${m}`),
    guard: async (): Promise<ApplyGuard> => ({
      runningTurns: agent.turn.running ? ["현재 진행 중"] : [],
      // **진행 중 자식은 무엇이든 알려야 한다** — 승인 대기 중인 셸도 포함.
      processes: launcher ? [launcher.baseUrl] : [],
      // ── R-2.1: 추정이 아니라 사실 ──────────────────────────────────────────
      //
      // **미저장 편집 탭 수를 서버는 모른다.** 편집 버퍼와 `dirtySince` 은
      // 브라우저 안에 있다(`src/web/editor/EditorView.tsx` · `autosave.ts`) — 서버는
      // 그걸 볼 수 없다. 예전엔 `0` 이었다. `0` 은 **"저장 안 한 것이 없다"** 라는
      // 거짓말이고, 그 거짓말이 사용자에게 "적용 가능" 과 함께 보여도 아무도 모른다.
      //
      // 그래서 `null`(모름)이다. `planApply` 는 `null` 을 **차단 사유가 아니라
      // 알림 항목**으로 말한다 — 사용자가 직접 확인하고 판단할 수 있는 사실이니까.
      // **결정 기록**: 차단 사유로 만들면 "모른다" 때문에 모든 업데이트가 막히고,
      // 그러면 사용자는 가짜로 0 을 넣도록 압박받는다. 알림이 옳다.
      dirtyTabs: null,
      // 슬롯이 하나도 없으면 **되돌릴 곳이 없다** → planApply 가 업데이트를 막는다(D14).
      canRollback: updates.get().slots.length > 0,
      daemon: mode === "daemon",
      // **직전 적용 실측**만 말한다. 첫 적용이면 `null` 이고 화면에 "아직 실측한 적 없다" 고
      // 보인다 — 숫자를 지어내면 그것이 사용자에게 **안내 문구**가 된다(R-2.1).
      estimatedSeconds: measuredApplySeconds(),
      // 이번에 **실제로 받을** 자산의 크기. 예전 값 `8 * 1024 * 1024` 은 숫자가 아니라
      // 희망이었다(구성 §2.2 실측 5번).
      assetBytes: pendingAssetBytes(),
      // 의존성은 **여기서 정하지 않는다.** UpdateService.planApply 가 항상 직접 본다
      // (Raiser R-1) — 호출자가 그 한 줄을 빠뜨려도 조용히 통과하지 않게 하기 위해서다.
      // 여기에도 넣으면 **정본이 두 개**가 되고, 빠뜨린 쪽이 조용히 놓친다.
      dependenciesReady: null,
      missingDependencies: [],
    }),
  });
  // M13 추천 알림 (§5.13.2). 판단 로직은 `update/notify.ts` 에 있었으나
  // 라우트·UI 가 없어 실행되지 않았다(◐). 서비스는 여기서 1회 생성 —
  // 프로세스당 1개이므로 dismiss 는 세션을 넘지 않고 silence 만 디스크에 남는다.
  const notices = new NoticeService(join(stateDir(projectRoot), "notices.json"));
  try {
    await notices.load();
  } catch (e) {
    // 깨진 silence 파일은 알리고 빈 채로 시작 — 깨진 것 때문에 알림이
    // 영원히 안 뜨는 쪽이 더 나쁘다.
    ring.warn("notice", `무시 목록을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, "server");
  }
  // §7.4 다운로드. 진행 상황은 WS 로 흘린다 — 라우트가 기다리는 동안 화면이 얼면 안 된다.
  const downloader = new ModelDownloader({
    onProgress: (item) => {
      hub?.publish({ type: "model.download", item } as never);
      if (item.state === "done" || item.state === "failed") {
        ring[item.state === "done" ? "info" : "error"](
          "models",
          `다운로드 ${item.state === "done" ? "완료" : "실패"}: ${item.file}${item.error ? ` — ${item.error}` : ""}`,
          "server"
        );
      }
    },
  });
  // 웹에서 tmux 로 AI CLI(claude·gemini·codex) 쓰기 — `PROMPT_TMUX_CLI.md`.
  // 서버를 내려도 tmux 세션(`hs-*`)은 죽이지 않는다 — `terminal.shutdown` 은 attach PTY 만 끊는다.
  const cliSessions = new CliSessions({ terminal, root: () => workspace.root(), warn: (m) => emit(`[cli] ${m}`) });
  // `/models` · `/server` · `/reset` — 구 TUI(2026-10-04 삭제)의 슬래시 명령을 그대로 서버에서 실행한다.
  // 서버가 바뀌면 **세션도 새 서버에 맞춘다**(안 맞추면 옛 모델 이름으로 요청한다).
  const slash = new SlashService({
    projectRoot,
    onModelSwitched: (modelPath) => {
      // ── 여기서 저절로 옛 모델이 화면에 남던 이유 (실측) ────────────────────
      //
      // `/api/system/version` 의 model 은 이 순서로 읽는다:
      //     `ports.adopted.model` → `model.path`
      //
      // **앞의 것이 뒤의 것을 가린다.** 이 세션은 부팅 때 이미 떠 있던
      // llama-server(35B)를 **채택**했으므로 `ports.adopted` 가 있고, 교체를
      // 알려 준 훅은 `model.path` 만 고쳤다. 결과적으로 화면은 계속 옛 이름을
      // 봤다 — 9B 로 바꿨는데 헤더에 35B 이 남아 있던 그 상황(실측으로 확인).
      //
      // **교체 뒤에는 이 서버를 우리가 띄운 것**이므로 "채택" 기록은 더 이상
      // 사실을 말하지 않는다. 둘 다 고쳐야 한다 — 하나만 고치면 또 한쪽이 남는다.
      // **두 곳을 함께 고치는 갱신**은 `applyModelSwitch` 가 한다(규칙과 테스트가 거기 있다).
      if (boot) boot = applyModelSwitch(boot, modelPath) as typeof boot;
      agent.invalidate();
      // **화면에 알려 준다** — 클라이언트는 이 값을 부팅 시 **한 번만** 읽는다.
      // 신호 없이 값만 바꾸면 사용자는 다음 창을 열 때까지 옛 이름을 본다.
      hub?.publish({ type: "model.changed", model: modelPath } as never);
      return [`세션이 새 서버에 연결되었습니다 — 모델 ${modelPath.split("/").pop()}`];
    },
  });
  /**
   * 사고 토큰 상한을 **설정에서 실제로 읽는다** (2026-10-05).
   *
   * 이 값은 스키마에 `사고 토큰 상한` 으로 노출되어 있고, 서버 로그도 "설정에서 올리라" 고
   * 안내했다. 그런데 **아무도 읽지 않았다** — 항상 기본값(4,096) 이라, 안내가 존재하지
   * 않는 손잡이를 가리켰다. 지시를 따라도 화면이 변하지 않는 것이 그 결과였다.
   *
   * 읽는 곳을 **한 군데**로 묶었다. 여기서 읽지 않으면 다른 곳에서 읽기 시작하고 그때마다
   * 값이 어긋난다.
   */
  const thinkCfg = await loadThinkBudget(projectRoot);

  const agent = new AgentService({ baseDir: () => workspace.baseDir(),
    baseUrl: () => `http://127.0.0.1:${boot?.ports?.llamaPort ?? 8080}`,
    // 모델 이름도 **호출 시점**에 읽는다 — 부팅이 끝나야 정해진다(`boot` 이 아직 없다).
    model: () => boot?.model?.path ?? process.env.HARNESSIDE_MODEL ?? "",
    systemPrompt,
    // 컴팩션 임계값은 **캘리브레이션에 적응**한다: 부팅이 정한 컨텍스트
    // (`boot.tuning.contextSize`)를 recommendThresholds()에 넣어 트리거·요약
    // 예산·압축 후 목표를 그 창에 맞게 잡는다. 예전 하드코딩 `{0.6, 32768}` 은
    // 16k 서버에서는 늦게(넘쳐서야) 터지고 98k 서버에서는 세 번에 한 번꼴로
    // 헛터졌다. 팩토리인 이유: 이 서비스는 부팅 전에 만들어지고 루프는 턴마다
    // 지연 생성되므로, 읽는 시점에는 이미 `boot` 가 있다(위 model/baseUrl 과
    // 같은 패턴). config.yaml 명시값이 있으면 그 키만 덮는다.
    thresholds: () => ({ ...recommendThresholds(boot?.tuning?.contextSize ?? 32_768), ...compactionOverrides }),
    // 읽어 온 설정값만 넘긴다 — 없는 키를 `undefined` 로 넘기면 기본값과 섞인다.
    ...(thinkCfg.set ? { maxReasoningTokens: thinkCfg.maxReasoningTokens } : {}),
    emit: (e) => {
      hub?.publish({ ...e } as never);
      // §5.10: 블록이 바뀌면 저장 예약. **매 델타마다** 쓰면 디스크 I/O 가 스트리밍을
      // 끊는다 — 그래서 디바운스(1초)로 합친다. 예약만 하고 실제로는 나중에 쓴다.
      if (e.type === "agent.delta" || e.type === "agent.reasoning" || e.type === "agent.tool") {
        session.capture(agent.conversation);
      }
    },
    onTurnEnd: () => {
      // 턴이 끝나면 주기적 안전망을 내리고 **즉시** 저장한다 — 마지막 몇 초가
      // 사라지면 사용자는 "답변 끝부분이 없다" 고 겪는다.
      session.stopPeriodic();
      void session.saveNow();
    },
    logger: (l) => emit(l),
    diff: (path, diff) => {
      // 도구 계층이 주는 diff 는 **ANSI 색이 들어 있다**(UI 전용이라고 명시돼 있다).
      // 색 제어문자를 그대로 WS 로 흘리면 웹이 이스케이프를 문자 그대로 화면에 찍는다 —
      // 그래서 **색을 벗겨서** 보낸다. 표시는 웹이 한다(한 곳에서만).
      hub?.publish({ type: "agent.diff", path, diff: stripAnsi(diff) } as never);
    },
  });
  agentRef = agent;

  let lock: InstanceLock | null = null;
  let launcher: LlamaLauncher | null = null;
  let boot: BootstrapResult | null = null;
  let http: HttpServer | null = null;
  let browser: BrowserLauncher | null = null;
  let hub: WsHub | null = null;
  /**
   * 승인 게이트 (S-6 §8.2).
   *
   * **왜 `null` 로 시작하나**: 게이트는 WS 허브가 만들어진 뒤에 이벤트 큐를 달아야
   * 한다. 부팅 전에 만들어두면 `hub` 가 `null` 인 동안 생긴 요청이 **아무도 모른다** —
   * 조용히 실패하는 것이 가장 나쁘다. 그래서 허브 다음에 만들고, 라우트는
   * **게이트가 없으면 503 을 말한다**(아래).
   */
  let approvalGate: ApprovalGate | null = null;
  let watchdog: Watchdog | null = null;
  let adoptedProbe: (() => boolean) | null = null;
  /** 창을 띄우려 한 적이 있는가. `never-opened` 판정의 전제다. */
  let browserLaunchAttempted = false;
  /** 단계 11 실패 설명용 — Chrome 이 낸 마지막 오류 줄(Q-5). */
  let lastChromeErr: string | null = null;
  /** 진행 중인 턴이 있는가 — S3 유예 사유 중 하나(§4.4). */
  let turnInProgress = false;

  /**
   * 채택한 서버의 생존 신호. **우리의 자식이 아니라 pid 로는 알 수 없다.**
   *
   * 워치독이 5초마다 **동기로** 부르기 때문에 판정은 캐시하고, 다시 보러 가는 일은
   * 백그라운드로 돌린다. "아직 판정 전" 은 죽은 것이 아니다 — 부재와 죽음은 다른
   * 신호다(`expectChrome` 에서 같은 이유로 한 번 배웠다).
   */
  const isAdoptedLlamaAlive = (): boolean => {
    const adopted = boot?.ports?.adopted;
    if (!adopted) return true;
    if (!adoptedProbe) adoptedProbe = makeAdoptedProbe(`http://127.0.0.1:${adopted.port}`);
    return adoptedProbe();
  };

  // SIGTERM/SIGINT = 명시적 종료(S5). SIGHUP 은 터미널을 닫는 것이므로 무시한다.
  const shutdown = async (reason: string) => {
    emit(`[shutdown] ${reason}`);
    // §4.4 순서: 턴 취소 → 체크포인트 → llama 종료 → 로그 flush
    try {
      await writeCheckpoint(stateDir(projectRoot), { reason } as never);      emit("[shutdown] 체크포인트 기록 완료");
    } catch (e) {
      emit(`[shutdown] 체크포인트 실패(무시하고 계속): ${String(e)}`);
    }
    // §5.10: 창을 닫아도 대화가 남아야 한다. **디바운스 대기 중인 저장을 잃지 않는다** —
    // 이걸 빼면 마지막 1초의 답변이 사라지고 사용자는 "끝이 잘렸다" 고 느낀다.
    session.stopPeriodic();
    const saved = await session.saveNow();
    emit(`[shutdown] 세션 ${saved.ok ? "저장됨" : `저장 실패(${saved.detail})`}`);
    // M1: 살아 있는 **셸 탭** 을 전부 죽인다. 조용히 남기면 다음 실행에서
    // 프로세스만 쌓이고 사용자는 "터미널을 안 닫았는데 프로세스가 있다" 고 본다.
    {
      const killed = terminal.shutdown();
      emit(`[shutdown] 셸 탭 ${killed}개 종료 (tmux 위의 AI CLI 세션 hs-* 는 그대로 둡니다 — 다시 열면 이어 붙습니다)`);
    }
    if (launcher) {
      await launcher.stop();
      emit("[shutdown] llama-server 종료 완료");
    } else if (boot?.ports?.adopted) {
      // **우리가 띄운 것만** 죽인다. 채택한 서버는 사용자의 것이므로 그대로 둔다.
      // 조용히 넘기면 "종료했는데 모델 서버가 그대로네" 를 로그에서 구분할 수 없다.
      emit(`[shutdown] 채택한 llama-server(${boot.ports.adopted.model}:${boot.ports.adopted.port})는 그대로 둡니다 — 우리가 띄운 것이 아닙니다.`);
    }
    if (browser) {
      browser.stopCdpWatch();
      await browser.stop();
      emit("[shutdown] Chrome 종료 완료");
    }
    if (watchdog) {
      watchdog.stop();
    }
    metrics.stop();
    await fsWatcher.stop().catch(() => {});
    if (hub) {
      await hub.close().catch(() => {});
      emit("[shutdown] WebSocket 종료 완료");
    }
    if (http) {
      await http.close().catch(() => {});
      emit("[shutdown] HTTP/WS 종료 완료");
    }
    if (lock) await lock.release();
    await clearInstance(paths).catch(() => {});
    logging.close();
    emit("[shutdown] 종료합니다");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => emit("[signal] SIGHUP 무시 — 데몬은 터미널 종료에 영향받지 않습니다"));
  // `exit` 는 동기적이라 비동기 종료 절차를 돌릴 수 없다. 그래도 **자식 llama-server 를
  // 즉시 죽이는 것**은 가능하다. 이게 없으면 `timeout`/강제 종료로 부모가 죽을 때 자식이
  // 남아 포트와 VRAM 을 붙잡는다(실제로 겪음 — orphan llama-server 가 8081 에 남음).
  process.on("exit", () => {
    void http?.close().catch(() => {});
    const pid = launcher?.pid;
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 이미 죽음
      }
    }
  });
  // 이전 실행의 크래시 기록이 **끊긴 파이프뿐**이면 배너 없이 보관 폴더로 옮긴다.
  if (archiveHarmlessCrashLog(projectRoot)) emit("[info] 이전 실행의 크래시 기록은 끊긴 파이프(EPIPE)뿐이라 .harnesside/crash-archive/ 로 옮겼습니다.");
  let crashing = false;
  process.on("uncaughtException", (e) => {
    // 출력 쪽이 끊긴 것(EPIPE)은 서버가 죽을 이유가 아니다 — 처리기가 같은 stdout 에 다시 써서 무한히 되풀이되던 사고.
    if (isBrokenPipe(e)) return;
    // 같은 처리기가 다시 불려도(처리 중 또 예외) **한 번만** 기록하고 종료를 시작한다.
    if (crashing) return;
    crashing = true;
    // M10: 죽기 전에 디스크에 남긴다 — 다음 실행의 창이 이것을 보여준다.
    // 구 Ink TUI(2026-10-04 삭제, Q-2)의 installCrashHandlers 와 같은 기록 함수(정본은 한 곳).
    writeCrashLogSync(projectRoot, formatCrashReport("uncaughtException", e));
    emit(`[fatal] 처리되지 않은 예외: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (e) => {
    writeCrashLogSync(projectRoot, formatCrashReport("unhandledRejection", e));
    emit(`[fatal] 처리되지 않은 Promise 거부: ${String(e)}`);
  });

  // 데몬 모드에서는 setsid 로 분리한다(터미널을 닫아도 살아남음).
  if (flag("--daemon") && process.stdin.isTTY) {
    emit("[info] 데몬 모드: 창 없이 계속 실행됩니다. 종료는 harnesside down 또는 SIGTERM.");
  }

  try {
    lock = await acquireInstanceLock({ projectRoot, env: process.env });
  } catch (e) {
    // 이미 실행 중 — 조용히 두 개를 띄우면 VRAM/포트가 서로를 죽인다.
    emit(`[fatal] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // ── 락이 아니라 **포트** 로 확인한다 ──────────────────────────────────────
  // 실측: 락이 243097 을 가리키는데 7317 의 소유자는 185924 였다(락을 읽고 그 pid 를
  // 죽였더니 옛 서버가 그대로 살았다). 그러면 **옛 코드가 계속 응답**하므로 아무도
  // 눈치채지 못한다 — 검증 스크립트가 새 코드가 아닌 옛 서버를 측정하는 사고로 이어진다.
  // 그래서 락은 "pid 뭐였다" 와, 포트는 "누가 잡고 있나" 를 **따로** 말한다.
  {
    const owner = portOwner(process.pid);
    if (owner) {
      emit(`[guard] 자기 pid ${process.pid} 가 포트 ${owner.host}:${owner.port} 를 소유 (정상)`);
    } else {
      // **내가 그 포트를 못 잡았다** 는 뜻일 수 있다(다른 인스턴스가 선점). 조용히
      // 진행하면 이후 모든 API 응답이 **옛 프로세스** 의 것이 된다.
      // 부팅 계획(단계 6)이 정하기 전에 여기서는 **환경 지정값** 만 본다. 정한 값이
      // 아니면 "아직 응답하지 않음" 이 정답이라 굳이 추측하지 않는다.
      const wantPort = Number(process.env.HARNESSIDE_PORT ?? 7317);
      const answered = await isPortServing(wantPort).catch(() => false);
      emit(
        answered
          ? `[guard] ⚠ 포트 ${wantPort} 가 응답하지만 그것이 자기 pid(${process.pid}) 의 소유가 아닙니다 — 이전 인스턴스가 살아 있을 수 있습니다`
          : `[guard] 포트 ${wantPort} 는 아직 응답하지 않음 (부팅 중 — 정상)`,
      );
    }
  }

  // ── 웹 자산 경로: **설치 기준**, 프로젝트 기준이 아니다 ──────────────────
  //
  // 예전엔 `join(projectRoot, "dist", "web")` 였다. 프로젝트가 곧 harnesside 저장소일
  // 때는 우연히 맞아서 **발견되지 않았다.** 전역 설치로 아무 프로젝트에서 실행하면
  // 이 경로에 **아무것도 없다.**
  //
  // 실측(전역 설치): 부팅 9단계가 "dist/web 없음 (실패)" 이었고, IDE 루트가
  // `{"error":"dist/web 가 없습니다 …","status":404}` 를 반환했다 — **창이 빈 화면이었다.**
  // §0.2 가 가장 무서워하는 것이 바로 이것("빈 화면 금지")이고, 전역 설치에서 실제로 일어났다.
  //
  // 그래서 **설치 위치**로 본다: 이 모듈(`<설치>/dist/server/index.js`)의 두 단계 위가
  // `dist/` 다. 개발 실행에서는 그게 `<저장소>/dist` 이므로 **예전과 같다.**
  //
  // **두 단계가 필요** (실측으로 잡은 내 계산 오류): `join("/…/dist/server/index.js", "..", "web")`
  // 는 `…/dist/server/web` 다. `..` 는 **파일명만** 상쇄하기 때문이다 — 파일이 있는
  // 디렉터리까지만 올라간다. 한 단계가 더 필요하다. 그래서 `resolve` 로 `dist/` 를
  // 먼저 만들고 거기서 `web` 을 뺀다 — **`installRoot()` 와 같은 규칙**이라 두 경로가
  // 어긋날 수 없다.
  const installDistDir = resolve(selfPath, "..", "..");
  const webDir = join(installDistDir, "web");
  let tokenRec: Awaited<ReturnType<typeof issueToken>> | null = null;

  // Q-10: 원격 baseUrl 은 지원하지 않는다 — 설정에 있으면 조용히 무시하지 않고 말한다(src/server/baseUrlPolicy.ts).
  // config.yaml 의 compaction 명시값도 여기서 한 번만 읽는다 — 아래 thresholds
  // 팩토리가 적응형 추천값 위에 덮는다(명시값 우선, 없는 키는 추천값).
  let compactionOverrides: Partial<CompactionThresholds> = {};
  {
    const raw = await readFile(join(projectRoot, ".harnesside", "config.yaml"), "utf8").catch(() => null);
    if (raw) {
      const { parse: parseYaml } = await import("yaml");
      let cfg: unknown = null;
      try { cfg = parseYaml(raw); } catch { cfg = null; }
      const notice = remoteBaseUrlNotice(cfg);
      if (notice) emit(`[warn] ${notice}`);
      const c = (cfg as { compaction?: Record<string, unknown> } | null)?.compaction;
      if (c && typeof c === "object") {
        const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        const pick: Partial<CompactionThresholds> = {};
        const r = num(c.autoTriggerRatio);
        if (r !== undefined && r > 0 && r < 1) pick.autoTriggerRatio = r;
        const s = num(c.summaryMaxTokens);
        if (s !== undefined && s > 0) pick.summaryMaxTokens = Math.floor(s);
        const p = num((c as Record<string, unknown>).postCompactionTargetRatio);
        if (p !== undefined && p > 0 && p < 1) pick.postCompactionTargetRatio = p;
        const m = num((c as Record<string, unknown>).minGrowthFraction);
        if (m !== undefined && m >= 0 && m < 1) pick.minGrowthFraction = m;
        compactionOverrides = pick;
      }
    }
  }
  boot = await bootstrap({
    projectRoot,
    modelsDir,
    hardware: undefined,
    // **모드를 강제할 수 있게** 배선한다. `forcedGpuMode` 은 bootstrap 옵션으로만
    // 존재했고 아무도 주지 않아 "정책이 정한다" 고 말할 수만 있었다. 사용자가
    // "브라우저 GPU 는 무조건 꺼" 라고 말할 수 있어야 하고, `off` 경로를 검증하려면
    // (GPU 없는 러너 말고) 이 머신에서 강제로 꺼 보는 수단이 있어야 한다.
    forcedGpuMode: gpuModeOf(process.env.HARNESSIDE_GPU_MODE),
    // **`--install` 가 명시됐을 때만** 빌드한다. 기본 부팅에서 cmake 를 띄우면
    // 사용자가 무엇을 설치하는지 모른 채 몇십 분을 기다리게 된다.
    allowBuild: process.argv.includes("--install"),
    skipLlamaSpawn: true, // 아래에서 실제 스폰(단계 7/8 을 여기서 이어받는다)
    lock, // 락은 여기서만 획득한다 — 두 곳이 잡으면 자기 자신을 "이미 실행 중" 으로 본다
    lateSteps: {
      // [9] 웹 자산 확인 — 없으면 설치 가이드를 보여준다는 사실만 알린다(P2).
      9: async () => {
        try {
          await access(join(webDir, "index.html"));
          return { ok: true, detail: `dist/web 준비됨 (${webDir})` };
        } catch {
          return { ok: false, detail: "dist/web 없음 — 'npm run build' 후 재시작 하세요 (P2)" };
        }
      },
      // [10] HTTP/WS 기동 — 인증은 **처음부터** 들어간다(retrofit 하지 않는다, §12).
      10: async ({ result: r }) => {
        const port = r.ports?.idePort ?? 7317;
        tokenRec = await issueToken(stateDir(projectRoot), port);
        // §2.3 허브: 로그·부팅 상태를 **흘려보낸다.** 2초 폴링은 "상시 출력" 요구를
        // 흉내 내지만 흐름이 요청 간격만큼 끊긴다.
        hub = new WsHub({
          server: undefined as never,
          path: "/ws",
          // 창 연결/해제도 **보여야 한다.** S3(하트비트 만료)이 "클라이언트가 사라진
          // 지 N 초" 를 재려면 그 기준점이 필요하고, 사용자에게도 "창이 붙었다/떼졌다" 가
          // 사실이다. 이 줄이 없으면 S3 는 언제 시작됐는지 로그에서 알 수 없다.
          onConnect: () => {
            if (hub && hub.clientCount === 1) {
              ring.info("lifecycle", "창이 서버에 연결되었습니다.", "server");
              emit("[ws] 창 연결됨 (1)");
            }
          },
          onDisconnect: () => {
            if (hub && hub.clientCount === 0) {
              ring.info("lifecycle", "창 연결이 끊어졌습니다.", "server", { signal: "S3-arming" });
              emit("[ws] 창 연결 끊김 — 창이 닫혔다면 곧 종료합니다(§4.4)");
            }
          },
        });
        // 링에 새 항목이 들어올 때마다 WS 로 보낸다(중간 계층 없이).
        ring.onEntry((e) => hub!.publish({ type: "log.append", entry: e } as never));
        ring.onStatus((st) => hub!.publish({ type: "log.status", status: st } as never));

        // ── S-6 승인 게이트를 **여기서** 살린다 ─────────────────────────────────
        //
        // **왜 허브 다음인가**: 게이트는 "승인 요청이 생겼다" 를 WS 로 **밀어**야 한다.
        // 폴링으로 받으면 사용자는 요청이 이미 타임아웃된 뒤에야 화면에서 보게 된다 —
        // 게이트가 60초 뒤 스스로 거절하면서 화면은 아무것도 모른다.
        //
        // **양쪽 다 보낸다**: 요청이 생났을 때(`approval.request`)와 결정됐을 때
        // (`approval.done`). 결정 이벤트에는 **무엇을 허용했는지** 를 실어 로그에도
        // 남긴다 — 나중에 "누가 이걸 승인했나" 를 확인할 수 있는 유일한 자리다.
        approvalGate = new ApprovalGate({}, {
          onRequest: (req) => {
            hub?.publish({ type: "approval.request", request: req } as never);
            ring.warn("approval", `승인 대기: ${req.summary}`, "server");
          },
          onDecision: (req, decision, by) => {
            hub?.publish({ type: "approval.done", id: req.id, tool: req.tool, decision, by } as never);
            // **거절도 기록한다.** 승인만 남기면 "이 도구는 아무도 안 쓰는가" 를 알 수 없다.
            ring.info("approval", `승인 결정: ${req.tool} → ${decision}${by ? ` (${by})` : ""}`, "server");
          },
        });
        // §5.5: 계측 시작. 1Hz 로 한 번만 재고 WS 로 브로드캐스트한다.
        // 라우트는 **계측하지 않고** 마지막 샘플만 읽는다(요청당 계측 금지).
        metrics.start();
        metrics.onSample((m) => hub?.publish({ type: "sys.metrics", metrics: m } as never));
        fsWatcher.start();
        http = new HttpServer({
          token: tokenRec,
          port,
          staticDir: webDir,
          onUpgrade: (req, socket, head) => hub!.handleUpgrade(req, socket, head),
          logger: (level, o, m) => (level === "error" ? emit(`[http] ${m}`) : undefined),
        });
        http
          .route("GET", "/api/health", () => ({
            ok: true,
            llamaUp: r.llamaReady,
            version: readVersion(),
            /**
             * 이 프로세스가 **떠난 시각** (2026-10-01).
             *
             * 왜 필요했나: 병렬 시험이 "디렉터리가 또 안 움직인다" 고 결론지었는데,
             * 코드는 이미 고쳐져 있었다 — **서버가 수정 이전에 떠 있었을 뿐**이었다.
             * 모든 결과가 옛 코드의 성능이었다. 이것은 시험이 할 수 있는 가장 위험한
             * 오류인데, **누군가 코드를 고친 뒤 서버를 안 띄운 순간**에만 생긴다.
             *
             * 그래서 기동 시각을 **공개**한다 — 누군가 시험을 돌릴 때 "이게 지금
             * 코드인가" 를 스스로 확인할 수 있어야 한다. 확인 수단이 없으면 전부 조용히
             * 거짓말이 된다.
             */
            startedAt: STARTED_AT,
          }))
          .route("GET", "/api/gpu", () => ({ ...r.gpu, llama: r.ports?.llamaPort, ide: port }))
          // M10 크래시 안내 — 이전 실행이 비정상 종료했으면 창이 그것을 말한다.
          // 없으면 present:false. 읽기 실패는 error 로 말하고 없음으로 덮지 않는다.
          .route("GET", "/api/crash", () => readCrashTail(projectRoot))
          // 배너의 "닫기" — 기록을 지우지 않고 보관 폴더로 옮긴다(다음 실행에 같은 배너가 또 뜨지 않게).
          .route("POST", "/api/crash/ack", () => ({ ok: true, ...acknowledgeCrashLog(projectRoot) }))
          .route("GET", "/api/bootstrap", () => ({
            steps: r.steps.map((s) => ({ n: s.n, name: s.name, ok: s.ok, detail: s.detail, pending: !!s.pending, tookSeconds: s.tookSeconds })),
            tuning: r.tuning?.rationale ?? [],
          }))
          .route("GET", "/api/system/version", () => ({
            version: readVersion(),
            // R-1/R-2.3: 릴리스 식별자 **와** 빌드 신원을 **따로** 말한다.
            // 한 줄로 이으면 뒤에 뭐가 붙었는지 읽는 사람이 모른다(§0.1).
            build: (() => {
              const b = readBuildInfo();
              return { date: b.date, sha: b.sha, dirty: b.dirty, builtAt: b.builtAt, stamped: b.stamped };
            })(),
            llama: r.llama?.source ?? null,
            // 채택한 경로에서는 **서버가 스스로 말한 모델 이름** 이 진짜다.
            // 로컬 파일 경로는 그 서버가 지금 serve 하는 것과 다를 수 있다.
            model: liveModelPath(r),
            gpuMode: r.gpu?.mode ?? null,
          }))
          // §8.2 파일 API — 경로 안전이 이 라우트 **앞에서** 처리된다(§3.4).
          .route("GET", "/api/fs/tree", async (c) => {
            // **루트를 캡처하지 않는다.** 전환 후에도 새 루트를 봐야 한다 —
            // 상수로 박아두면 화면은 옛 프로젝트, 도구는 새 프로젝토리 되는
            // "조용히 엉뚱한 곳" 상태가 된다(§8.3).
            const r = await safeListDir(c.query.get("path") || ".", { root: workspace.root() });
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-found" ? 404 : 403 });
            return r.value;
          })
          .route("GET", "/api/fs/file", async (c) => {
            const r = await safeReadFile(c.query.get("path") || "", { root: workspace.root() });
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-found" ? 404 : 403 });
            return r.value;
          })
          .route("PUT", "/api/fs/file", async (c) => {
            const body = (await readBody(c.req)) as { path?: string; content?: string; baseVersion?: number };
            if (typeof body.path !== "string" || typeof body.content !== "string") {
              throw Object.assign(new Error("path 와 content 가 필요합니다"), { status: 400 });
            }
            const r = await safeWriteFile(body.path, body.content, {
              root: workspace.root(),
              baseVersion: body.baseVersion,
              readOnlyPaths: [join(workspace.root(), ".harnesside")],
            });
            if (!r.ok) {
              // 충돌은 409 — 클라이언트가 "비교 / 내 변경 유지" 를 고르게 한다(§3.4)
              throw Object.assign(new Error(r.detail), {
                status: r.reason === "conflict" ? 409 : 403,
                conflict: r.reason === "conflict" ? r.current : undefined,
              });
            }
            return r.value;
          })
          // ── S-6 승인 게이트 (§8.2) ────────────────────────────────────────────
          //
          // **왜 여기서 처음 배선인가**: `ApprovalGate` 는 완성되어 있고 테스트도
          // 통과하지만(무응답=거절 · 무한 대기 방지 · 창 닫으면 거절) **라우트도 UI 도
          // 없었다**. 즉 "돌면 되지만 아무도 호출하지 않는다" — `PROGRESS.md` 가
          // `◐` 라고 부르는 그 상태다. 게이트가 없으면 `rm -rf` 가 확인 없이 돈다.
          //
          // **게이트가 아직 없을 때 503 을 말한다** — 빈 목록을 주면 사용자는
          // "승인 대기 중인 것이 없다" 고 읽는데 실제로는 **아직 시작도 안 됐다**.
          .route("GET", "/api/approval/pending", () => {
            if (!approvalGate) throw Object.assign(new Error("승인 게이트가 아직 준비되지 않았습니다"), { status: 503 });
            // **대기 중인 것만.** 이미 결정된 것을 다시 보여주면 사용자가
            // "내가 이미 눌렀는데 왜 뜨지" 한다(조용히 중복되는 UI).
            return { pending: approvalGate.pending };
          })
          .route("POST", "/api/approval/:id", async (c) => {
            if (!approvalGate) throw Object.assign(new Error("승인 게이트가 아직 준비되지 않았습니다"), { status: 503 });
            const body = (await readBody(c.req)) as { decision?: string };
            const decision = body.decision;
            // **결정의 종류를 먼저 검사한다.** 모르는 문자열이 들어오면
            // `settle` 이 조용히 아무 일도 하지 않고 `false` 를 돌려준다 — 사용자는
            // "누른 것 같다" 고 여긴다(조용히 실패하는 것이 가장 나쁘다).
            const allowed = ["allow-once", "allow-always", "reject"] as const;
            if (!decision || !(allowed as readonly string[]).includes(decision)) {
              throw Object.assign(new Error(`결정이 올바르지 않습니다: ${String(decision)}`), { status: 400 });
            }
            const ok = approvalGate.decide(c.params.id, decision as (typeof allowed)[number], "web");
            // **이미 결정되었거나 없는 id 라면 404** — "처리했다" 고 말하면 안 된다.
            // 사용자는 자신이 승인한 줄 알지만 실제로는 아무 일도 일어나지 않았다.
            if (!ok) throw Object.assign(new Error("이미 결정되었거나 존재하지 않는 승인 요청입니다"), { status: 404 });
            return { ok: true, decided: decision };
          })
          .route("GET", "/api/approval/policy", () => {
            if (!approvalGate) throw Object.assign(new Error("승인 게이트가 아직 준비되지 않았습니다"), { status: 503 });
            return approvalGate.getPolicy();
          })
          // ── S-5 찾기 — 저장소 전체 검색 · 빠른 이동 ────────────────────────────
          //
          // **왜 라우트인가**: 화면이 저장소를 직접 훑을 수는 없다(브라우저엔 디스크가
          // 없다). 그리고 이 라우트가 **루트 경계**를 enforcement 하는 자리다 —
          // `searchFiles` 안에서만 밖으로 못 나가므로, 여기서 경로를 다시 확인할 필요는
          // 없다. **규칙이 한 곳에 있다**(부록 B 6).
          .route("GET", "/api/fs/search", async (c) => {
            const pattern = c.query.get("q") ?? "";
            // **플래그를 명시적으로 해석한다.** `?regex=1` 과 `?regex=true` 를 다른
            // 것으로 취급하면 어느 쪽이 켜졌는지 사용자가 알 수 없다.
            const regex = c.query.get("regex") === "true";
            const caseSensitive = c.query.get("case") === "true";
            const maxHits = clampInt(c.query.get("max"), 1, 2000, 200);
            const r = await searchFiles(workspace.root(), { pattern, regex, caseSensitive }, { maxHits });
            // **깨진 정규식·빈 검색어는 400** 이다. 200 으로 빈 결과를 주면 사용자는
            // "이 저장소에 없다" 고 믿는다 — 실제로는 **자기 입력이 틀렸다**(§9.3).
            if (isSearchFailure(r)) throw Object.assign(new Error(r.detail), { status: 400 });
            return {
              hits: r.hits,
              truncated: r.truncated,
              truncatedReason: r.truncatedReason,
              report: r.report,
              // **무엇으로 검색했는지** 돌려준다. 이것이 없으면 화면은
              // "결과 N건" 만 말하고, 재현은 불가능하다(§7.2).
              query: { pattern: pattern.trim(), regex, caseSensitive },
            };
          })
          .route("GET", "/api/fs/files", async (c) => {
            const r = await listFiles(workspace.root());
            const q = (c.query.get("q") ?? "").trim();
            // **서버에서 한 번 더 순위를 매기지 않는다.** 순위 규칙은 `rankFiles` 한
            // 곳에 있고(부록 B 6), 화면이 같은 함수를 쓴다. 여기서 다시 매기면 두 곳에
            // 규칙이 생겨 어긋난다.
            return { files: r.files, truncated: r.truncated, total: r.total, query: q };
          })
          // §5.5 계측. **계측하지 않는다** — 마지막 샘플만 돌려준다.
          .route("GET", "/api/metrics", () => ({
            latest: metrics.ring.latest,
            series: metrics.ring.series((m) => m.cpu.overall),
            size: metrics.ring.size,
          }))
          // §5.2 Git 변경 소스(HEAD ↔ 워킹트리). 실패는 "변경 없음" 과 구분해 말한다.
          .route("GET", "/api/git/status", async () => {
            const r = await gitStatus(workspace.root());
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-a-repo" ? 400 : 500 });
            return r.value;
          })
          // ── §9.3 GitHub 연동 (P14) ─────────────────────────────────────────
          // 요구 16: clone → 파일 열기 → 커밋 → pull. **충돌이면 자동병합 없이 중단.**
          // 그 마지막 부분이 이 경로의 존재 이유다 — 조용히 섞어 넣으면 사용자는
          // 자기 파일이 바뀐 것도 모른다(모듈 주석 참조).
          .route("GET", "/api/git/summary", async () => {
            const r = await summarize(workspace.root());
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-a-repo" ? 400 : 500 });
            return r.value;
          })
          .route("POST", "/api/git/clone", async (c) => {
            const body = (await readBody(c.req)) as { url?: string; dir?: string; branch?: string; depth?: number };
            const url = String(body.url ?? "");
            if (!url) throw Object.assign(new Error("url 이 필요합니다"), { status: 400 });
            // **저장 위치는 워크스페이스 아래로 제한한다** — 임의 경로에 clone 되면
            // 경로 안전(§3.4) 밖에서 파일을 쓰게 된다.
            const dirInput = String(body.dir ?? "repo");
            const target = isAbsolute(dirInput) ? dirInput : join(workspace.root(), dirInput);
            const safe = await safeResolve(target, { root: workspace.root() });
            if (!safe.ok) throw Object.assign(new Error(safe.detail), { status: 403 });
            // **이미 있으면 덮어쓰지 않는다** — clone 은 통째로 쓰는 일이라 실수 비용이 크다.
            if (await stat(safe.value).then(() => true, () => false)) {
              throw Object.assign(new Error(`이미 있는 경로입니다: ${safe.value}`), { status: 409 });
            }
            const plan = planClone({ url, dir: safe.value, branch: body.branch, depth: body.depth });
            ring.info("git", `clone 시작: ${redactUrl(url)}`, "server");
            const r = await clone(plan);
            if (!r.ok) {
              ring.error("git", `clone 실패: ${r.detail}`, "server");
              throw Object.assign(new Error(r.detail), { status: 400 });
            }
            return { ok: true, dir: r.value.dir, tail: r.value.tail };
          })
          .route("POST", "/api/git/pull", async (c) => {
            const body = (await readBody(c.req)) as { branch?: string };
            // **브랜치를 지정하지 않으면 저장소의 실제 브랜치** 를 쓴다. "main" 을
            // 기본값으로 쓰면 master 저장소에서 조용히 "새 변경 없음" 이 된다(실측).
            const branch = body.branch ?? (await currentBranch(workspace.root()));
            // 충돌하면 **그 상태로 멈춘다**(자동 병합 금지). 사용자가 해결한다.
            const r = await pull(workspace.root(), branch);
            if (r.outcome === "conflict") {
              // **자동 병합하지 않는다**(§9.3). 어떤 파일을 사람이 고쳐야 하는지까지 말한다.
              ring.warn("git", "pull 충돌 — 자동 병합하지 않고 중단했습니다", "server", { files: r.filesChanged });
            }
            return r;
          })
          .route("POST", "/api/git/commit", async (c) => {
            const body = (await readBody(c.req)) as { message?: string; paths?: string[]; all?: boolean; allowEmpty?: boolean };
            const plan = {
              message: String(body.message ?? ""),
              paths: Array.isArray(body.paths) ? body.paths.map(String) : [],
              all: body.all === true,
              allowEmpty: body.allowEmpty === true,
            };
            // **빈 커밋을 조용히 허용하지 않는다.** "아무것도 안 한 커밋" 은 이력의
            // 노이즈다(§9.3). 판정은 `planCommit` 이 하고 여기서는 결과만 말한다.
            const r = await commit(workspace.root(), plan);
            // **사용자 입력 탓은 400, 서버 탓은 500.** 저장소 밖 경로를 500 으로
            // 보내면 콘솔에 서버 오류가 찍히고 "왜 안 되지" 를 추측하게 된다.
            if (!r.ok) {
              const userSide = r.reason === "nothing-to-commit" || r.reason === "outside-path";
              throw Object.assign(new Error(r.detail), { status: userSide ? 400 : 500 });
            }
            ring.info("git", `커밋 ${r.value.hash.slice(0, 7)} — ${r.value.message}`, "server", { files: r.value.files });
            emit(`[git] commit ${r.value.hash.slice(0, 7)} — ${r.value.message}`);
            return { ok: true, ...r.value };
          })
          .route("POST", "/api/git/push", async (c) => {
            const body = (await readBody(c.req)) as { branch?: string; setUpstream?: boolean };
            return push(workspace.root(), body.branch ?? (await currentBranch(workspace.root())), body.setUpstream === true);
          })
          // ── M1 터미널 ─────────────────────────────────────────────────────
          // PTY 출력은 **WS 로만** 보낸다. 라우트로 폴링하면 타이핑이 200ms 늦게
          // 도착하고, 더 나쁘게는 "셸이 멈췄다" 고 보인다(실측: 폴링 주기 = 지연).
          .route("GET", "/api/terminal", () => ({
            tabs: terminal.list(),
            // **공유 작업 경로 + 최근 본 디렉터리** (2026-10-01). 셸 위쪽 탐색 막대의
            // 정본이다. 화면이 따로 들고 있으면 어느 쪽이 맞는지 알 수 없다.
            cwd: terminal.cwd,
            /**
             * **경계(루트)** — 셸이 나갈 수 없는 곳. `cwd` 와 **다르다**.
             *
             * `cwd` 는 사용자가 옮긴 현재 위치라 바뀌지만, 루트는 고정이다. 화면의
             * 탐색 막대가 "위로" 를 얼마나 되돌릴 수 있는지 판단하려면 이 값이 필요하다
             * — `cwd` 만으로는 "여기가 루트인가" 를 알 수 없다.
             */
            root: terminal.root,
            recent: terminal.recentDirs(),
          }))
          // 디렉터리 목록 — 셸 탐색 막대의 후보. **디렉터리만** 준다(파일은 아래로).
          .route("GET", "/api/terminal/dirs", async (c) => {
            const target = resolve(terminal.cwd, String(c.query.get("path") ?? "."));
            // `resolve` 는 `..` 로 루트를 벗어난다 — `safePath` 와 같이 게이트를 둔다.
            if (!target.startsWith(terminal.cwd)) {
              throw Object.assign(new Error("루트 밖으로는 나갈 수 없습니다"), { status: 403 });
            }
            const names = await readdir(target, { withFileTypes: true }).catch(() => []);
            return {
              cwd: terminal.cwd,
              path: target,
              parent: target === terminal.cwd ? null : resolve(target, ".."),
              dirs: names
                .filter((d) => d.isDirectory() && !d.name.startsWith("."))
                .map((d) => d.name)
                .sort((a, b) => a.localeCompare(b)),
            };
          })
          // 작업 경로 변경. **존재하는 디렉터리만** 받고, 루트 밖은 **거절한다**(조용히
          // 되돌리지 않는다 — 이유를 말해야 사용자가 알아서 고친다).
          .route("POST", "/api/terminal/cwd", async (c) => {
            const body = (await readBody(c.req)) as { path?: string };
            const r = await terminal.setCwd(String(body.path ?? ""));
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: 400 });
            return r;
          })
          .route("POST", "/api/terminal", async (c) => {
            const body = (await readBody(c.req)) as { cwd?: string; cols?: number; rows?: number; title?: string; shell?: string; init?: string };
            const r = terminal.create({ cwd: body.cwd, cols: body.cols, rows: body.rows, title: body.title, shell: body.shell, init: body.init });
            // **열지 못했으면 성공으로 돌려주지 않는다.** 가짜 세션을 만들면 화면은
            // 열린 것처럼 그리고 사용자는 아무 것도 안 보이는 탭을 붙잡는다.
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: 409 });
            hub?.publish({ type: "terminal.open", session: r.session } as never);
            return r.session;
          })
          .route("POST", "/api/terminal/:id/input", async (c) => {
            const body = (await readBody(c.req)) as { data?: string };
            const r = terminal.write(c.params.id ?? "", String(body.data ?? ""));
            // 버린 입력을 사용자가 모른 채로 두지 않는다 — "먹혔다" 고 보인다.
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: 409 });
            return { ok: true };
          })
          .route("POST", "/api/terminal/:id/resize", async (c) => {
            const body = (await readBody(c.req)) as { cols?: number; rows?: number };
            const r = terminal.resize(c.params.id ?? "", Number(body.cols ?? 80), Number(body.rows ?? 24));
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: 409 });
            return { ok: true };
          })
          .route("POST", "/api/terminal/:id/redraw", async (c) => {
            const r = terminal.redraw(c.params.id ?? "");
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: 409 });
            return { ok: true };
          })
          .route("POST", "/api/terminal/:id/close", async (c) => {
            const r = terminal.close(c.params.id ?? "");
            hub?.publish({ type: "terminal.closed", id: c.params.id ?? "" } as never);
            // "이미 끝난 셸" 은 실패가 아니라 **알려진 사실** 이라 200 으로 말한다.
            return r;
          })
          .route("GET", "/api/git/head", async (c) => {
            const p = c.query.get("path") || "";
            const r = await gitShowHead(workspace.root(), p);
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-a-repo" ? 400 : 500 });
            return { path: p, content: r.value };
          })
          // §5.2 로그 패널 급유. 폴링 경로(WS 가 기본).
          .route("GET", "/api/logs", (c) => {
            const limit = Number(c.query.get("limit") ?? 500);
            const parseList = <T extends string>(v: string | null): T[] | undefined => {
              if (!v) return undefined;
              const parts = v.split(",").map((x) => x.trim()).filter(Boolean) as T[];
              return parts.length ? parts : undefined;
            };
            return {
              entries: ring.query({
                limit: Number.isFinite(limit) ? limit : 500,
                levels: parseList<LogLevel>(c.query.get("levels")),
                sources: parseList<LogSource>(c.query.get("sources")),
              }),
              status: ring.status,
            };
          })
          .route("POST", "/api/logs/clear", () => {
            ring.clear();
            return { cleared: true, status: ring.status };
          })
          // ── §8.3 워크스페이스 ──────────────────────────────────────────────
          // **루트만 있는 게 아니다.** 지문(종류·규칙·git)까지 같이 준다 — UI 가
          // "무엇을 하는 화면인지" 를 헤더 한 줄로 말할 수 있어야 하기 때문이다.
          .route("GET", "/api/workspace", () => ({ current: workspace.current, pendingNotes: workspace.pendingNotes() }))
          // 미리보기는 **부수효과 0** 이어야 한다. 보러 가는 것만으로 루트가 바뀌면 안 된다.
          .route("POST", "/api/workspace/plan", async (c) => {
            const body = (await readBody(c.req)) as { path?: string; openTabs?: string[] };
            const p = await workspace.preview(String(body.path ?? ""), body.openTabs ?? []);
            if (!p.ok) throw Object.assign(new Error(p.detail), { status: 400, reason: p.reason });
            return p.value;
          })
          .route("POST", "/api/workspace/switch", async (c) => {
            const body = (await readBody(c.req)) as { path?: string; openTabs?: string[]; confirm?: boolean };
            const r = await workspace.switchTo(String(body.path ?? ""), {
              openTabs: body.openTabs ?? [],
              confirm: body.confirm === true,
            });
            if (!r.ok) {
              // 확인 요구는 **409** 다 — 400 이면 "잘못된 요청" 이라 오해하고 그냥 재시도한다.
              const status = r.reason === "needs-confirm" ? 409 : 400;
              throw Object.assign(new Error(r.detail), { status, reason: r.reason });
            }
            return { current: workspace.current, change: r.value };
          })
          // ── §5.3 에이전트 턴 ────────────────────────────────────────────────
          // **이전엔 "보내기" 버튼이 죽어 있었다.** 도구·압축·자기보호 로직은 전부
          // 검증되어 있는데 서버에서 아무것도 호출하지 않았다. 이제 실제로 돈다.
          .route("GET", "/api/cli/status", async () => cliSessions.status())
          .route("GET", "/api/cli/providers", async () => ({ providers: await cliSessions.providers() }))
          .route("GET", "/api/cli/commands", async (c) => {
            const r = await cliSessions.commands(String(c.query.get("provider") ?? ""), c.query.get("cwd") ?? undefined);
            if ("error" in r) throw Object.assign(new Error(r.error), { status: r.status });
            return r;
          })
          .route("GET", "/api/cli/sessions", async () => ({ sessions: await cliSessions.sessions(), socket: cliSessions.tmux.socket }))
          .route("POST", "/api/cli/sessions", async (c) => {
            const body = (await readBody(c.req)) as { provider?: string; cwd?: string; forceNew?: boolean; resume?: boolean; yolo?: boolean; cols?: number; rows?: number };
            const r = await cliSessions.start({ provider: String(body.provider ?? ""), cwd: body.cwd, forceNew: body.forceNew === true, resume: body.resume === true, yolo: body.yolo === true, cols: body.cols, rows: body.rows });
            // 열지 못했으면 성공으로 돌려주지 않는다 — 가짜 탭을 만들지 않는다.
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.status });
            if (!r.reused) hub?.publish({ type: "terminal.open", session: r.session } as never);
            ring.info("cli", `${r.session.title} 탭 ${r.reused ? "연결" : "생성"} — ${r.sessionName}`, "server");
            return r;
          })
          .route("POST", "/api/cli/sessions/:name/kill", async (c) => {
            const body = (await readBody(c.req)) as { confirm?: boolean };
            const r = await cliSessions.kill(c.params.name ?? "", body.confirm === true);
            if (!r.ok && r.status !== 200) throw Object.assign(new Error(r.detail), { status: r.status });
            if (r.ok) ring.info("cli", r.detail, "server");
            return r;
          })
          .route("POST", "/api/slash/run", async (c) => {
            const body = (await readBody(c.req)) as { key?: string; arg?: string };
            const key = String(body.key ?? "");
            if (!(SERVER_SLASH_KEYS as readonly string[]).includes(key)) {
              throw Object.assign(new Error(`서버에서 실행하는 슬래시 명령이 아닙니다: ${key}`), { status: 400 });
            }
            return slash.start(key as ServerSlashKey, String(body.arg ?? ""));
          })
          .route("GET", "/api/slash/job/:id", (c) => {
            const v = slash.get(c.params.id);
            if (!v) throw Object.assign(new Error("없는 작업입니다"), { status: 404 });
            return v;
          })
          .route("POST", "/api/system/quit", async () => {
            // 응답을 먼저 돌려보낸 뒤 종료한다 — 안 그러면 화면이 "실패" 로 읽는다.
            setTimeout(() => void shutdown("슬래시 /quit"), 200);
            return { ok: true, detail: "종료합니다 (체크포인트·세션 저장 후)" };
          })
          .route("GET", "/api/agent/state", () => ({ turn: agent.turn, thinking: agent.thinking, ready: agent.ready }))
          .route("POST", "/api/agent/thinking", async (c) => {
            const body = (await readBody(c.req)) as { enabled?: boolean };
            return agent.setThinking(body.enabled === true);
          })
          .route("POST", "/api/agent/cancel", async () => agent.cancel())
          // ── 슬래시 명령의 서버 경로 (사용자 요구) ────────────────────────────
          // 구 Ink TUI(2026-10-04 삭제, Q-2)는 이 작업을 루프에 직접 있었다.
          // 웹 창에는 루프가 없고 라우트만 있다 — 없으면 명령이 **조용히 아무것도 안 하고** 끝난다.
          // 라우트가 부를 **이름 있는 진입점** 을 만들고, 못 하면 그 사실을 돌려준다.
          .route("POST", "/api/agent/compact", async () => agent.forceCompact())
          .route("POST", "/api/agent/improve", async () => agent.proposeImprovement())
          .route("POST", "/api/agent/improve/apply", async () => agent.applyImprovement())
          .route("POST", "/api/agent/plan/clear", async () => agent.clearPlan())
          // `/skills` · `/rules` — **뭐가 들어갔는지** 말한다. 비어 있으면 비었다고
          // 말한다(조용히 비면 "규칙이 적용됐다" 고 오해한다).
          .route("GET", "/api/agent/context-files", async () => {
            const root = workspace.root();
            const { loadSkillIndex } = await import("../skills/loader.js");
            const skills = await loadSkillIndex(root);
            return { root, skills, rules: workspace.rules() };
          })
          // O4 메시지 큐 — 실행 중에 들어온 입력은 거절하지 않고 순서대로 돈다.
          .route("GET", "/api/agent/queue", () => ({ items: agent.queueView() }))
          .route("POST", "/api/agent/queue/clear", () => agent.clearQueue())
          .route("POST", "/api/agent/queue/move", async (c) => {
            const body = (await readBody(c.req)) as { from?: number; to?: number };
            if (!agent.moveQueue(Number(body.from), Number(body.to))) {
              throw Object.assign(new Error("대기열 범위를 벗어났습니다"), { status: 400 });
            }
            return { ok: true, items: agent.queueView() };
          })
          // M3 재개. 취소한 턴은 체크포인트에 남고 **다음 턴에서 자동으로** 이어진다.
          // 문제는 그것이 눈에 보이지 않는다는 점이다 — 그래서 "있나?" 를 묻는 라우트로
          // 화면이 정직해진다(없음/있음 을 구분해서 반환한다).
          .route("GET", "/api/agent/resume", async () => agent.resumeInfo())
          .route("POST", "/api/agent/resume", async () => {
            // 진행 중일 때는 재개하지 않는다 — **동시에 두 턴** 이 되면 대화가 어긋난다.
            if (agent.turn.running) {
              throw Object.assign(new Error("진행 중인 턴이 있습니다 — 먼저 끝내거나 취소하십시오"), { status: 409 });
            }
            // 재개는 "사용자가 계속해 라고 말한 것" 으로 기록한다. 메시지를 조용히
            // 주입하면 대화에 사용자가 한 말이 아닌 줄이 들어간다(§5.10).
            const text = RESUME_PROMPT;
            session.noteUser(text);
            return agent.send(text);
          })
          .route("POST", "/api/agent/turn", async (c) => {
            const body = (await readBody(c.req)) as { text?: string };
            const text = String(body.text ?? "");
            // 사용자가 뭐라고 했는지가 세션의 핵심이다 — 보내기 **전에** 기록한다.
            if (text.trim()) session.noteUser(text);
            // 턴은 **기다린다** — HTTP 응답이 턴의 결과라야 이 라우트는 존재 이유가 없다.
            // 델타는 WS 로 흘린다(§2.3).
            return agent.send(text);
          })
          // ── §5.10 세션 ─────────────────────────────────────────────────────
          .route("GET", "/api/session/current", () => ({
            id: session.doc?.id ?? null,
            blocks: session.doc?.blocks ?? [],
            saved: session.saved,
            lastError: session.lastError,
          }))
          .route("GET", "/api/session/list", async () => ({ sessions: await session.list() }))
          .route("POST", "/api/session/save", async () => session.saveNow())
          // ── llama.cpp 상태 (최초 구동 판정) ─────────────────────────────────
          //
          // **판정만** 돌린다. 이 라우트에서 cmake 를 띄우거나 20GB 를 받으면 안 된다 —
          // 화면을 여는 동작이 설치를 시작하면 사용자는 무엇이 일어나는지 모른다.
          // 설치는 `harnesside doctor --install` 이 한다.
          .route("GET", "/api/llama/status", async () => {
            const { inspectLlama } = await import("../setup/firstRun.js");
            const seen = await inspectLlama({ home }).catch((e) => ({ situation: "unknown" as const, error: String(e) }));
            return {
              // 세 경우를 **그대로** 노출한다. 화면이 상태마다 다른 말을 해야 하므로
              // 여기서 문장 하나에 접어 버리지 않는다.
              situation: seen.situation,
              running: seen.situation === "running" ? seen.running : null,
              installed: seen.situation === "installed" ? seen.llama : null,
              // "설치할 수 있다" 는 약속이 아니라 **방법** 이다. 화면이 이 문장을
              // 그대로 보여주면 사용자가 무엇이 일어나는지 안다.
              remedy:
                seen.situation === "running"
                  ? "이미 실행 중인 서버를 사용합니다."
                  : seen.situation === "installed"
                    ? `${seen.llama!.source} 설치본이 있습니다 — 포트를 지정해 구동할 수 있습니다.`
                    : "설치되어 있지 않습니다. 'harnesside doctor --install' 로 이 머신에 맞춰 설치할 수 있습니다.",
            };
          })
          // ── §7 모델 (P11) ───────────────────────────────────────────────────
          .route("GET", "/api/models", async () => {
            const names = await readdir(modelsDir).catch(() => [] as string[]);
            const entries = await Promise.all(
              names
                .filter((n) => n.toLowerCase().endsWith(".gguf"))
                .map(async (n) => {
                  const st = await stat(join(modelsDir, n)).catch(() => null);
                  return { file: n, path: join(modelsDir, n), bytes: st?.size ?? 0 };
                })
            );
            return {
              dir: modelsDir,
              // **채택한 서버가 서빙 중인 모델 이름**도 돌려준다. 경로가 아닐 수 있다
              // — 그래서 이름과 경로를 **따로** 보낸다. 화면이 이 둘을 섞어
              // "파일 없음" 을 "모델 없음" 으로 읽게 하지 않는다.
              active: boot?.model?.path ?? null,
              servedModel: boot?.servedModel ?? null,
              // 채택 상태 — 경로가 없어도 **연결은 되어 있다** 는 사실.
              servedByAdopted: !!boot?.ports?.adopted,
              entries,
            };
          })
          // 검색+추천. **네트워크를 못 쓰면 그 사실을 말한다** — 빈 목록을 "결과 없음" 으로
          // 돌려주면 사용자는 모델이 없다고 믿는다.
          .route("GET", "/api/models/search", async (c) => {
            const q = c.query.get("q") ?? "";
            const localNames = await readdir(modelsDir).catch(() => [] as string[]);
            const models = await searchHub({ query: q || undefined, limit: 20 }).catch((e) => {
              ring.warn("models", `HuggingFace 검색 실패: ${String(e)}`, "server");
              return null;
            });
            if (models === null) {
              return {
                ok: false,
                detail: "HuggingFace 에 연결하지 못했습니다. 네트워크·방화벽을 확인하십시오.",
                dir: modelsDir,
                local: localNames.filter((n) => n.endsWith(".gguf")),
              };
            }
            // **크기를 채워야** 점수가 의미를 가진다(목록 API 에는 크기가 없다 —
            // 안 채우면 전부 100점 이 나온다. 실측).
            //
            // 트리 API 로 저장소당 **1 요청** 이므로 후보를 자르지 않는다(실측: 31개
            // 크기가 10 KB 응답으로 온다). 그래도 "얼마나 조회했고 뭘 몰랐는지" 를 돌려준다 —
            // 점수 0 인 항목이 남아 있으면 사용자가 이유를 알 수 있어야 한다.
            const sizes = await fillSizes(models);
            const scored = recommend(sizes.models, boot?.hardware ?? null, { localFiles: localNames });
            ring.info("models", `크기 조회 ${sizes.requests} 요청 · 트리 ${sizes.fromTree}건 · 개별 ${sizes.fromHead}건`, "server", {
              unknown: sizes.unknown.length,
            });
            return {
              ok: true,
              ...scored,
              dir: modelsDir,
              sizes: { requests: sizes.requests, fromTree: sizes.fromTree, fromHead: sizes.fromHead, unknown: sizes.unknown },
            };
          })
          .route("POST", "/api/models/download", async (c) => {
            const body = (await readBody(c.req)) as { repo?: string; file?: string; url?: string };
            if (!body.repo || !body.file) {
              throw Object.assign(new Error("repo 와 file 이 필요합니다"), { status: 400 });
            }
            const id = `${body.repo}/${body.file}`.replace(/[^\w.-]+/g, "_");
            const dest = modelPathFor(modelsDir, body.file);
            // 진행 상황은 WS 로. 라우트는 **결과** 를 준다(기다리는 동안 화면이 얼어 있다).
            const item = await downloader.download({
              id,
              url: body.url ?? `https://huggingface.co/${body.repo}/resolve/main/${body.file}`,
              destPath: dest,
            });
            return { item, path: dest };
          })
          .route("POST", "/api/models/cancel", async (c) => {
            const body = (await readBody(c.req)) as { id?: string };
            const item = downloader.cancel(String(body.id ?? ""));
            if (!item) throw Object.assign(new Error("진행 중인 다운로드가 없습니다"), { status: 404 });
            return { item };
          })
          .route("GET", "/api/models/downloads", () => ({ items: downloader.all() }))
          // ── 모델 교체 (§7.1 · §5.13.1) ──────────────────────────────────────
          // **"설치 성공 = 성공" 은 함정이다.** 새 모델이 실제로 응답해야 성공이고,
          // 아니면 이전 모델로 되돌린다(judgeSwap 의 규칙 그대로).
          .route("POST", "/api/models/activate", async (c) => {
            const body = (await readBody(c.req)) as { path?: string; confirm?: boolean };
            const path = String(body.path ?? "");
            if (!path) throw Object.assign(new Error("path 가 필요합니다"), { status: 400 });
            const st = await stat(path).catch(() => null);
            if (!st?.isFile()) throw Object.assign(new Error(`모델 파일이 없습니다: ${path}`), { status: 400 });
            if (body.confirm !== true) {
              // planSwap 의 경고를 그대로 사용한다 — 확인 다이얼로그의 내용.
              const sw = planSwap({
                from: boot?.model?.path ? { id: boot.model.path, path: boot.model.path, bytes: 0 } : null,
                to: { id: path, path, bytes: st.size },
                preserveOld: true,
                canRestartLlama: !!launcher,
              } as never);
              return { ok: false, needsConfirm: true, warnings: sw.warnings, steps: sw.steps };
            }

            const previous = boot?.model?.path ?? null;
            const sw = planSwap({
              from: previous ? { id: previous, path: previous, bytes: 0 } : null,
              to: { id: path, path, bytes: st.size },
              preserveOld: true,
              canRestartLlama: !!launcher,
            } as never);
            for (const w of sw.warnings) ring.warn("models", w, "server");

            const swap = await agent.swapModel({
              modelPath: path,
              stopChild: async () => {
                if (launcher) await launcher.stop();
              },
              spawn: async () => {
                // 새 경로로 다시 만든다. **이전 자식만** 죽였으므로 안전하다.
                launcher = new LlamaLauncher(
                  {
                    binPath: (boot?.llama?.binPath ?? "") as string,
                    modelPath: path,
                    host: "127.0.0.1",
                    port: boot?.ports?.llamaPort ?? 8080,
                    tuning: (boot?.tuning ?? DEFAULT_THRESHOLDS) as never,
                  },
                  { logger: { info: (o, m) => emit(`[llama] ${lineOf(o) ?? m}`), warn: (o, m) => emit(`[llama] ${lineOf(o) ?? m}`), error: (o, m) => emit(`[llama] ${lineOf(o) ?? m}`) } }
                );
                if (!boot?.llama) {
                  emit("[models] llama 바이너리를 모릅니다 — 재기동하지 못했습니다");
                  return false;
                }
                launcher.spawn();
                return launcher.waitUntilReady(120_000);
              },
            });

            if (!swap.ok) {
              // **되돌린다** — 되돌릴 곳이 없으면 사용자는 모델이 없는 상태로 남는다.
              if (previous && launcher) {
                const back = new LlamaLauncher(
                  {
                    binPath: (boot?.llama?.binPath ?? "") as string,
                    modelPath: previous,
                    host: "127.0.0.1",
                    port: boot?.ports?.llamaPort ?? 8080,
                    tuning: (boot?.tuning ?? DEFAULT_THRESHOLDS) as never,
                  },
                  {}
                );
                back.spawn();
                await back.waitUntilReady(60_000);
                emit(`[models] 이전 모델로 되돌렸습니다: ${previous}`);
              }
              ring.error("models", `모델 교체 실패: ${swap.reason}`, "server");
              return { ...swap, rolledBack: !!previous, previous };
            }
            if (boot) boot.model = { ...boot.model, path, reason: "사용자가 교체함" } as never;
            agent.invalidate();
            ring.info("models", `모델 교체 완료: ${path}`, "server");
            emit(`[models] 모델 교체 완료: ${path}`);
            return { ...swap, path };
          })
          // ── §9.1 업데이트 ─────────────────────────────────────────────────
          .route("GET", "/api/update", async () => ({ ...updates.get(), bundle: updates.bundleAssets().expected, local: await updates.local() }))
          .route("POST", "/api/update/check", async () => ({ ...(await updates.check()), bundle: updates.bundleAssets().expected }))
          .route("POST", "/api/update/plan", async () => updates.planApply())
          .route("POST", "/api/update/slot", async () => updates.makeSlot())
          .route("POST", "/api/update/download", async (c) => {
            const body = (await readBody(c.req)) as { index?: number; expectHash?: { algo: string; hex: string } };
            const st = updates.get();
            const asset = st.assets[Number(body.index ?? -1)];
            if (!asset) throw Object.assign(new Error("자산이 없습니다 — 먼저 확인하십시오"), { status: 400 });
            // R-5: **아카이브는 그대로 받고 풀지 않는다** — 여기서 트리를 만들지 않는다.
            // `downloadBundle` 가 매니페스트와 대조한 뒤 **슬롯 안**에만 트리를 만든다.
            // 검증 전에는 어떤 경로도 교체하지 않는다(§R-5.3).
            return updates.downloadAsset(asset, body.expectHash);
          })
          // ── R-5/R-3: 배포물을 **검증된 트리**로 준비한다 ───────────────────
          // 매니페스트 수신 → 아카이브 수신 → 해시 대조 → 풀기 → **목록 대조**.
          // 여기서 통과한 것만 `/api/update/apply` 의 입력이 될 수 있다.
          .route("POST", "/api/update/bundle", async (c) => {
            const body = (await readBody(c.req)) as { index?: number };
            const st = updates.get();
            // 인덱스가 없으면 **이 머신의 zip** 을 고른다. 있으면 그것을 쓰되,
            // 다른 플랫폼 zip 이면 `downloadBundle` 이 받기 전에 거부한다.
            const asset = body.index === undefined ? updates.bundleAssets().zip : st.assets[Number(body.index)];
            if (!asset) {
              throw Object.assign(new Error(`이 머신용 배포물(${updates.bundleAssets().expected})이 릴리스에 없습니다 — 먼저 확인하십시오`), { status: 400 });
            }
            const r = await updates.downloadBundle(asset);
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: 400 });
            ring.info("update", `update-bundle-verified — ${r.detail}`);
            return {
              ok: true,
              tree: r.tree,
              detail: r.detail,
              // **매니페스트 전체를 돌려준다.** 클라이언트는 그것을 **그대로** `/apply` 에
              // 되돌려 보내고, 서버가 **다시** 파싱·검증한다(`parseManifest`).
              // 경로가 아니라 내용이라 임의 파일 지정은 불가능하고, 재검증하므로
              // 손으로 바꾼 매니페스트는 자기 검증에서 떨어진다.
              manifest: r.manifest ?? null,
              treeSha256: r.manifest?.treeSha256 ?? null,
            };
          })
          // Raiser R-1: 의존성 사실. **추정으로 메우지 않는다**(구성 §13).
          .route("GET", "/api/update/deps", async () => {
            // 정본은 `UpdateService` 다 — 여기서 따로 판정하지 않는다(§14 두 정본 금지).
            return updates.dependencies();
          })
          // P13 apply route — 교체 + 마커. **자동 재시작은 하지 않는다.**
          //
          // 입력을 바꿨다(R-5): 예전엔 **자산 파일 하나**를 인자로 받았고 `stageSwap` 가
          // 그것을 실행 파일에 복사했다. 배포물은 `dist/` **트리**이므로, 경로는
          // `/api/update/bundle` 이 **검증을 통과한 트리 디렉터리**여야 한다.
          // 슬롯 밖의 경로는 거부한다 — 그게 곧 임의 파일 쓰기다.
          .route("POST", "/api/update/apply", async (c) => {
            const body = (await readBody(c.req)) as { tree?: string; manifest?: unknown; confirm?: boolean };
            if (body.confirm !== true) {
              throw Object.assign(new Error("적용하려면 confirm:true 로 명시적으로 확인하십시오"), { status: 400 });
            }
            const { decision } = await updates.planApply();
            if (!decision.ok) {
              throw Object.assign(new Error("APPLY_GUARD: " + decision.blockers.join(" / ")), { status: 409 });
            }
            const tree = String(body.tree ?? "");
            const resolved = resolve(tree);
            const rel = relative(updateSlotsDir, resolved);
            if (tree === "" || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
              throw Object.assign(new Error("슬롯 안에서 검증된 트리만 적용할 수 있습니다 — 먼저 /api/update/bundle 을 통과하십시오"), { status: 400 });
            }
            try {
              await stat(resolved);
            } catch {
              throw Object.assign(new Error("검증된 트리가 없습니다 — 먼저 배포물을 받으십시오"), { status: 400 });
            }
            const t0 = Date.now();
            // 매니페스트는 **경로가 아니라 내용** 으로 받는다 — 클라이언트가 경로를
            // 조작해 임의 파일을 쓰게 하지 않는다. 그래야 설치 루트에 **기록되는** 것이
            // 우리가 방금 **검증한** 그 매니페스트이다.
            //
            // 그리고 **다시 검증한다.** 클라이언트는 `/bundle` 응답을 그대로 돌려보내므로
            // 원래는 유효하다 — 하지만 그 사이에 아무도 못 고칠 이유는 없다. 재검증하면
            // 손으로 바꾼 매니페스트는 자기 검증(`parseManifest`)에서 떨어진다.
            let manifest: ReleaseManifest | null = null;
            if (body.manifest != null) {
              const parsed = typeof body.manifest === "object" ? parseManifest(JSON.stringify(body.manifest)) : null;
              if (!parsed || !parsed.ok) {
                const why = parsed && !parsed.ok ? parsed.error : "형식이 아닙니다";
                throw Object.assign(new Error(`매니페스트를 받아들일 수 없습니다: ${why} — 재검증 없이 교체하지 않습니다`), { status: 400 });
              }
              manifest = parsed.manifest;
            }
            const staged = await updates.stageSwap(resolved, manifest);
            const tookSec = (Date.now() - t0) / 1000;
            if (!staged.ok) throw Object.assign(new Error(staged.detail), { status: 500 });

            // R-2.1: 교체를 **실측**하고 저장한다. 다음부터 화면에 숫자가 보인다.
            // 첫 적용에서는 이 값이 없다 → 화면에 "아직 실측한 적이 없습니다" 가 나온다.
            try {
              writeFileSync(updateStatsFile, JSON.stringify({ lastApplySeconds: Math.round(tookSec * 10) / 10 }, null, 2), "utf8");
            } catch {
              /* 못 저장해도 교체는 성공이다 — 그저 다음에 숫자가 없을 뿐이다. */
            }

            // ── R-6.1: 마커에 **빌드 신원**을 함께 담는다 ──────────────────────
            //
            // 예전 마커에는 `asset`·`slot`·`swappedAt` 만 있었다. 그래서 다음 기동이
            // "어느 버전으로 떴는가" 를 **기록으로 남기지 못했다.**
            // 지금은 이 기동의 신원(`date`·`sha`)을 같이 적는다. 부팅 단계가 이
            // 마커를 소비할 때 **같은 신원인지** 비교하면, "교체된 파일" 과
            // "실제로 실행된 파일" 이 같은 대상이라는 **증거**가 남는다.
            const bi = readBuildInfo();
            // 교체한 트리의 해시 — `verifyInstalled` 가 **기동 시** 재계산한 값과
            // 비교할 대상. 여기를 안 적으면 다음 기동이 "무엇이 떴는가" 를 증명 못 한다.
            const treeSha256 = (await updates.verifyInstalled()).sha;
            const marker = {
              swappedAt: Date.now(),
              tree: resolved,
              slot: staged.slot ?? null,
              treeSha256,
              target: { version: bi.version, date: bi.date, sha: bi.sha, dirty: bi.dirty, builtAt: bi.builtAt },
            };
            await writeFile(updateMarker, JSON.stringify(marker, null, 2), "utf8");
            ring.info("update", "update-applied-pending-restart", "server", {
              slot: staged.slot ?? null,
              treeSha256: marker.treeSha256,
            });
            return {
              ok: true,
              slot: staged.slot,
              treeSha256: marker.treeSha256,
              // ── R-6.2: 없는 걸 있다고 말하지 않는다 ────────────────────────
              // 이 서버는 **자기 자신을 재시작할 수 없다.** 재기동·부팅 확인·자동
              // 롤백은 **상위 감시기(supervisor)** 가 해야 하고, 지금은 없다.
              // 그래서 사용자에게 정확히 무엇을 시켜야 하는지 말하고 끝낸다.
              next:
                "서버를 재시작하면 새 버전으로 기동합니다. 이 기동이 마커를 소비하면 적용이 확인된 것입니다. " +
                "기동하지 못하면 다음 실행 때 '업데이트 미확인' 으로 알립니다 — 자동으로 되돌리지는 않습니다(상위 감시기가 없습니다). " +
                "수동 복구: /api/update/rollback",
            };
          })
          .route("POST", "/api/update/rollback", async (c) => {
            const body = (await readBody(c.req)) as { confirm?: boolean };
            if (body.confirm !== true) {
              throw Object.assign(new Error("적용하려면 confirm:true 로 명시적으로 확인하십시오"), { status: 400 });
            }
            const r = await updates.rollback();
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.detail.includes("SLOT_MISSING") || r.detail.includes("슬롯이 없습니다") ? 409 : 500 });
            ring.info("update", "update-rolled-back", "server");
            return r;
          })
          .route("GET", "/api/update/verify", async () => {
            let marker: unknown = null;
            try {
              marker = JSON.parse(await readFile(updateMarker, "utf8"));
            } catch {
              marker = null;
            }
            return { marker, slots: updates.get().slots };
          })
          // ── M13 추천 알림 (§5.13.2) ────────────────────────────────────
          //
          // 판단(`notify.ts`)은 있었으나 닿는 경로가 없었다. 목록은 보이는 것만,
          // 결정(dismiss/silence)은 없는 id 면 404 — "처리했다" 고 말하지 않는다.
          .route("GET", "/api/notices", () => ({ notices: notices.list() }))
          .route("POST", "/api/notices/refresh", async () => {
            const { readdir } = await import("node:fs/promises");
            return notices.refreshModels(modelsDir, (p) => readdir(p), boot?.model?.path ?? null);
          })
          .route("POST", "/api/notices/:id/dismiss", async (c) => {
            const id = decodeURIComponent(c.params.id ?? "");
            if (!notices.dismiss(id)) throw Object.assign(new Error("이미 처리되었거나 존재하지 않는 알림입니다"), { status: 404 });
            return { ok: true, id };
          })
          .route("POST", "/api/notices/:id/silence", async (c) => {
            const id = decodeURIComponent(c.params.id ?? "");
            if (!(await notices.silence(id))) throw Object.assign(new Error("이미 처리되었거나 존재하지 않는 알림입니다"), { status: 404 });
            return { ok: true, id };
          });
        const { port: actual } = await http.start();
        // P13 적용 마커 소비 — 여기까지 부팅됐다는 것이 곧 새 실행 파일의 기동 확인이다.
        //
        // ── R-6.1/R-6.2: 여기서 **무엇을 확인하는가** ────────────────────────
        //
        // 예전엔 마커가 **있으면** 지우고 "확인됨" 이라고했다. 그런데 이 기동이
        // **어느 버전인지** 보지 않았다. 그래서 마커가 남아 있다는 사실이
        // "이전 부팅이 실패했다" 와 "사람이 되돌렸다" 를 **구분하지 못했다.**
        //
        // 지금은 세 가지를 본다:
        //   1) 지금 기동한 트리 해시가 마커에 적힌 값과 같은가 — 같으면 **이 기동이
        //      교체된 트리로 떴다.** 그게 "교체한 것" 과 "실행된 것" 의 일치 증거다.
        //   2) 마커의 대상 빌드와 지금 빌드의 신원이 다른가 — 다르면 **교체된 버전이
        //      한 번도 확인되지 않았다**(또는 사람이 되돌렸다).
        //   3) 그때 **되돌릴 곳**(슬롯)이 있는가 — 없으면 "되돌릴 수 없다" 고 **말한다.**
        //
        // **자동 롤백은 하지 않는다.** 이 서버는 자기 자신이 아니면 부팅 실패를 알 수 없고,
        // 재시작도 못 한다. 상위 감시기(supervisor) 가 없으므로 자동 복구는 **불가능**하고,
        // 없는 걸 있다고 말하지 않는다. 대신 **미확인 사실과 슬롯 경로를 확실히 남긴다.**
        try {
          const pending = JSON.parse(await readFile(updateMarker, "utf8")) as {
            tree?: string; slot?: string | null; swappedAt?: number;
            treeSha256?: string | null;
            target?: { version?: string; date?: string | null; sha?: string | null } | null;
          };
          const booted = await updates.verifyInstalled();
          const biNow = readBuildInfo();
          const sameBuild = !!(pending.target?.sha && biNow.sha && pending.target.sha === biNow.sha);
          const sameTree = !!(pending.treeSha256 && booted.sha && pending.treeSha256 === booted.sha);
          const confirmed = sameBuild && (pending.treeSha256 ? sameTree : true);

          if (confirmed) {
            await rm(updateMarker, { force: true });
            ring.info("update", `업데이트 적용 확인됨: ${pending.slot ?? "-"} · 트리 ${booted.sha?.slice(0, 7) ?? "미측정"}`, "server");
            emit(`[update] 적용 확인됨 — 트리 ${booted.sha?.slice(0, 7) ?? "미측정"} 로 기동했습니다.`);
          } else {
            // **마커를 지우지 않는다.** 무엇이 있었는지 모르게 지우면 적용 여부를
            // 알 수 없게 된다. 대신 **무엇이 달랐는지**를 말하고 UI 에 넘긴다.
            const why = [
              sameBuild ? null : `빌드 불일치 (교체된 빌드 ${pending.target?.sha ?? "미상"} ≠ 지금 ${biNow.sha ?? "미상"})`,
              pending.treeSha256 && !sameTree ? `트리 불일치 (기록 ${String(pending.treeSha256).slice(0, 7)}… ≠ 지금 ${booted.sha?.slice(0, 7) ?? "검증 실패"})` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            ring.info("update", `업데이트 미확인 — ${why || "사유를 특정할 수 없습니다"}`, "server");
            emit(`[update] 업데이트 미확인 — ${why || "사유를 특정할 수 없습니다"}. 슬롯이 있으면 /api/update/rollback 으로 되돌리십시오.`);
          }
        } catch {
          // 마커 없음 = 일반 부팅.
        }
        hub.publish({ type: "sys.logs", limits: ring.status } as never);
        // 컨텍스트 부팅 시 1회 계산 — 복원된 대화가 있으면 유휴 상태에서도 수치가 보인다.
        void agent.refreshContext().catch(() => {});
        return { ok: true, detail: `http://127.0.0.1:${actual} (토큰 인증 필수)` };
      },
      // [11] Chrome 기동 — GPU 모드를 **적용하고 검증까지** 하고 보고한다(§4.7.5).
      11: async ({ result: r }) => {
        // `--no-browser` / `--daemon` 은 **실제로 창을 띄우지 않아야 한다.**
        // 여기를 비워두고 항상 띄우면: 문서가 "llama 만 기동" 이라고 말하는 것과
        // 달리 창이 뜨고, GPU 를 먹고, CI 러너에는 X 서버가 없어서
        // "Missing X server or $DISPLAY" 로 죽는다(실제로 그랬다).
        // 데몬 모드(§3.7.2) 도 마찬가지 — 창 없는 게 정의이니까.
        //
        // 그래도 단계는 **실패로 표시하지 않는다**: 부팅은 성공했고 창만 없는 것이라
        // "기동 실패" 라고 하면 사용자는 서버가 죽었다고 오해한다.
        if (NO_BROWSER) {
          return {
            ok: true,
            detail: `${BROWSER_INTENT.reason} — Chrome 을 띄우지 않습니다(브라우저 GPU 예산 없음)`,
          };
        }
        const idePort = r.ports?.idePort ?? 7317;
        const mode = r.gpu?.mode ?? "off";
        // CDP 포트는 **사용자가 명시했을 때만** 넘긴다.
//
// 여기서 예전처럼 기본값 9222 를 넘기면 `BrowserLauncher` 가 그것을 "사용자가 지정한
// 포트" 로 보고, 다른 인스턴스가 쓰고 있어도 **포기하지 않고** 그대로 쓴다.
// 그 결과 남의 브라우저에 붙어 새 창이 뜬다(실측). undefined 를 넘겨야
// "비어 있으면 다음 포트로 간다" 가 동작한다.
const cdpEnv = process.env.HARNESSIDE_CDP_PORT;
const cdpPort = cdpEnv !== undefined && cdpEnv.trim() !== "" ? Number(cdpEnv) : undefined;
        browserLaunchAttempted = true;
        browser = new BrowserLauncher(
          {
            mode,
            cdpPort,
            idePort,
            // 토큰은 쿼리로만 실린다 — CDP 소켓에 실으면 /json/version 로 새고,
            // Origin/Host 검증은 별도로 건다(§3.6, §4.1).
            appUrl: `http://127.0.0.1:${idePort}/?t=${encodeURIComponent(tokenRec?.token ?? "")}`,
            noSandbox: process.env.HARNESSIDE_CHROME_NO_SANDBOX === "1",
            extraArgs: process.env.HARNESSIDE_CHROME_EXTRA_ARGS?.split(/\s+/).filter(Boolean) ?? [],
          },
          {
            // 수명주기 이벤트만 logger 로(스폰/종료/오류). 자식 줄은 onLine 이 담당한다 —
            // 두 경로로 보내면 같은 줄이 두 번 보인다.
            logger: (level, m, data) => {
              ring.append({
                ts: Date.now(),
                level: level === "error" ? "error" : level === "warn" ? "warn" : "info",
                scope: "browser",
                source: "chrome",
                message: m,
                data: (data ?? {}) as Record<string, unknown>,
              });
            },
            // 자식 로그는 **원문 그대로** 링에 남긴다. ERROR 같은 줄은 승격시킨다
            // (브라우저가 GPU 문제로 죽는 경우가 실제로 있다 — §5.12.1).
            onLine: (l) => {
              const isErr = /error|fatal|fail|oom/i.test(l);
              ring.append({
                ts: Date.now(),
                level: isErr ? "error" : "info",
                scope: "browser",
                source: "chrome",
                message: l,
              });
              if (isErr) {
                emit(`[chrome] ${l}`);
                lastChromeErr = l; // 단계 11 실패의 "왜"(Q-5)
              }
            },
          }
        );
        const res = await browser.launch();
        if (!res.flags.length) {
          return {
            ok: false,
            detail: "브라우저 바이너리를 찾지 못했습니다 — 설치 후 재시작 하세요 (창 없이 서버만 동작)",
            why: "google-chrome · google-chrome-stable · chromium · chromium-browser 실행 파일이 PATH 에 없음",
            next: `Ubuntu: sudo apt install chromium-browser (또는 google-chrome-stable) — 설치 없이 쓰려면 --no-browser 로 띄우고 브라우저에서 http://127.0.0.1:${idePort} 를 여세요`,
          };
        }
        if (!res.attached) {
          return {
            ok: false,
            detail: `Chrome 기동은 했지만 CDP(${res.cdpPort}) 에 붙지 못했습니다`,
            why: lastChromeErr,
            next: `CDP 포트 ${res.cdpPort} 를 다른 Chrome 이 쓰고 있는지 확인(ss -ltnp | grep :${res.cdpPort}) — 쓰고 있으면 HARNESSIDE_CDP_PORT 로 다른 포트를 지정해 다시 띄우세요`,
          };
        }
        // §4.4 S4 — **길게 붙어 있는** CDP 소켓. GPU 판정용 소켓은 열었다 닫으므로
        // "소켓이 죽었다" 는 신호가 생길 수 없다. 감시 소켓을 따로 붙여야 그 신호가 있다.
        const watching = await browser.watchCdp(res.cdpPort, ({ attempts }) => {
          emit(`[cdp] 재연결 ${attempts}회 실패 — CDP 연결 소실로 봅니다(§4.4 S4)`);
        });
        if (!watching) emit(`[cdp] 감시 소켓을 붙이지 못했습니다 (CDP ${res.cdpPort}) — S4 신호는 듣지 못합니다`);
        else emit(`[cdp] 감시 소켓 연결됨 — CDP 소실을 감시합니다(§4.4 S4)`);
        const v = res.verification;
        const verdict =
          mode !== "off" ? (v?.detail ?? "GPU 모드 적용") : v?.ok ? "GPU 비활성 확인됨" : `⚠ GPU 비활성 미확인 — ${v?.detail ?? "판정 실패"}`;
        emit(`[gpu] ${verdict}`);
        for (const line of res.rationale) emit(`       · ${line}`);
        return { ok: mode !== "off" || !!v?.ok, detail: `${res.flags.length}개 플래그 · ${verdict}` };
      },
      // [12] 루프 유지 — 자식 죽음·모드별 창 종료·유휴 정책을 감시한다(§4.4).
      12: async () => {
        watchdog = startWatchdog({
          mode,
          ring,
          isLlamaAlive: () => {
            if (!boot) return true; // 아직 부팅 중 — 자식이 아직 없을 뿐 죽은 게 아니다
            if (boot.ports?.adopted) return isAdoptedLlamaAlive();
            return !!launcher?.pid;
          },
          isChromeAlive: () => !!browser?.pid,
          // **"못 띄움" 과 "닫힘" 은 다른 사실이다.** 띄우려 했으나 실패한 상태를
          // `dead` 로 넘기면 워치독이 "창이 닫혔다" 고 읽고 서버를 죽인다 — 실제로
          // 그랬다(CDP 미첨부). 그 로그를 읽으면 "창이 안 떠서 서버가 죽었다" 로
          // 잘못 이해한다. 서버는 살아 있고 주소만 알려 주면 된다(요구 9 의 degrade).
          chromeState: () => {
            if (NO_BROWSER) return "alive";
            if (browser?.pid) return "alive";
            return browserLaunchAttempted ? "never-opened" : "alive";
          },
          // S3 — 마지막 클라이언트 이탈 후 경과 시간. `null` 은 판정 대상이 아니다.
          msSinceLastClientGone: () => hub?.msSinceLastClientGone() ?? null,
          // S4 — CDP 소켓이 재연결 2회 실패했는가.
          cdpState: () => browser?.cdp ?? "none",
          // §4.4 가 요구하는 유예 두 가지 중 (b) 정책 설정 여부는 여기서 확인된다.
          // (a) 진행 중 백그라운드 프로세스는 아직 배선 전이라 유예 사유로 명시한다.
          deferS3: () =>
            Number(process.env.HARNESSIDE_IDLE_SHUTDOWN_SEC ?? 0) > 0
              ? "daemon.idleShutdownSec 가 설정돼 있어 유휴 정책이 대신 판단합니다"
              : turnInProgress
                ? "진행 중인 턴이 있습니다"
                : null,
          // `--no-browser` / `--daemon` 은 **창을 띄우지 않는다**. 그러면 window 모드여도
          // "창이 닫혔다" 는 신호가 성립하지 않으므로, 창이 있었어야 하는지를 알려줘야 한다.
          // 이걸 빠뜨리면 워치독이 첫 tick 에 "창이 닫혔다" 고 판단해 데몬을 죽인다
          // (실제로 CI 부팅 스모크가 그렇게 죽었다 — llama 는 정상 응답 중이었다).
          expectChrome: !NO_BROWSER,
          clientConnected: () => (hub?.clientCount ?? 0) > 0,
          idleShutdownSec: Number(process.env.HARNESSIDE_IDLE_SHUTDOWN_SEC ?? 0),
          shutdown: (reason) => void shutdown(reason),
        });
        ring.info(
          "lifecycle",
          NO_BROWSER
            ? `서버가 대기 중입니다 (${mode} 모드 · 창 없음). 창이 없으니 닫힘 신호는 없고, ` +
                `llama-server 는 이 프로세스가 끝날 때까지 함께 돕니다.`
            : `서버가 대기 중입니다 (${mode} 모드). 창을 닫으면 ` +
                (mode === "daemon" ? "서버는 계속됩니다." : "llama-server 도 함께 종료됩니다(요구 9)."),
          "server"
        );
        return { ok: true, detail: `대기 중 (${mode} 모드)` };
      },
    },
    log: (l) => emit(l),
  });

  const llama = boot.llama;
  const model = boot.model;
  const tuning = boot.tuning;
  const ports = boot.ports;
  // 이미 떠 있던 서버를 **채택**했는가. 판정은 단계 6 이 한다(§6.2).
  // 예전엔 여기서 `tryAdopt(ports.llamaPort)` 로 다시 물었다. 그런데 그 포트는
  // planPorts 가 "비어 있다고 확인한" 포트라서 **닿을 수 없는 죽은 코드** 였다 —
  // 그래서 채택은 한 번도 일어나지 않았고, 대신 포트를 옮겨 두 번째 모델을 띄웠다.
  const adopted = ports?.adopted;

  // 채택한 경로에는 **로컬 모델도, llama 바이너리도, 튜닝도 필요 없다.** 우리가 띄우지
  // 않았기 때문이다. 여기서 그것을 요구하면 서버가 살아 있는 머신에서
  // "llama-server 또는 모델이 준비되지 않았습니다" 라고 거짓말을 하게 된다.
  if (!ports || (!adopted && (!llama || !model?.path || !tuning))) {
    emit("[warn] llama-server 또는 모델이 준비되지 않았습니다. 창은 계속 뜹니다(단계 9~12 미구현).");
    emit(`       모델 상태: ${model?.reason ?? "알 수 없음"}`);
    await holdLoop();
    await shutdown("no-model");
    return 0;
  }

  if (adopted) {
    // 스폰하지 않는다. 그래서 종료할 때도 이 서버는 건드리지 않는다 — 우리가 띄운
    // 것만 죽인다.
    emit(`[7] 기존 llama-server 를 채택했습니다: http://127.0.0.1:${adopted.port} (${adopted.model}) — 스폰하지 않습니다.`);
    emit("[8] 헬스체크: 채택한 서버 사용 (스폰 없음)");
  } else if (llama && model?.path && tuning && ports) {
  let lastLlamaErr: string | null = null;
  launcher = new LlamaLauncher(
    {
      binPath: llama.binPath,
      modelPath: model.path,
      host: "127.0.0.1",
      port: ports.llamaPort,
      tuning,
      browserReserveMiB: boot.gpu?.reserveMiB,
      gpuMode: boot.gpu?.mode,
    },
    {
      logger: {
        // 데몬에서는 사람이 이 줄을 본다 — o.line 을 버리면 "무엇인지" 없는 항목만 남는다.
        info: (o, m) => emit(`[llama] ${lineOf(o) ?? m}`),
        warn: (o, m) => emit(`[llama] ${lineOf(o) ?? m}`),
        error: (o, m) => emit(`[llama] ${lineOf(o) ?? m}`),
      },
      events: {
        onLine: (line, stream) => {
          emit(line);
          // 헬스체크 실패의 "왜"(Q-5) — 원인이 담긴 줄은 거의 항상 stderr 의 오류 줄이다.
          if (stream === "stderr" || /error|fail|oom|abort|bind|address/i.test(line)) lastLlamaErr = line;
        },
      },
    }
  );

  // 단계 [7] 스폰 → 단계 [8] 헬스체크
  const built = launcher.spawn();
  emit(`[7] llama-server 스폰: ${built.args.join(" ")}`);
  for (const r of built.rationale) emit(`    - ${r}`);

  const ready = await launcher.waitUntilReady(120_000);
  emit(`[8] 헬스체크: ${ready ? "준비 완료 (/v1/models 200)" : "실패 — 창은 계속 뜹니다"}`);
  if (!ready) {
    // 계획 단계(bootstrap)의 [8] 은 "준비될 수 있다" 였다 — **실제** 결과로 덮어 창(/api/bootstrap)도 같은 말을 하게 한다(Q-5).
    const spawnErr = launcher.error as NodeJS.ErrnoException | null;
    const why = spawnErr ? `${spawnErr.code ?? ""} ${spawnErr.message}`.trim() : lastLlamaErr;
    const port = ports.llamaPort;
    const next = spawnErr?.code === "ENOENT"
      ? `llama-server 실행 파일이 없습니다(${llama.binPath}) — HARNESSIDE_LLAMA_SERVER 로 경로를 지정하거나 \`harnesside doctor --install\``
      : /address already in use|bind/i.test(why ?? "")
        ? `포트 ${port} 를 이미 쓰는 프로세스를 확인하세요(ss -ltnp | grep :${port}) — 이미 띄운 llama-server 라면 그것을 쓰도록 이 서버를 다시 시작하세요`
        : /out of memory|oom|cuda/i.test(why ?? "")
          ? "VRAM 이 부족합니다 — 다른 GPU 프로세스를 끄거나 /reset 으로 이 머신에 맞게 다시 계산하세요"
          : `서버 로그에서 [llama] 줄을 확인하세요(harnesside logs) — 포트 ${port}`;
    const step8 = boot.steps.find((x) => x.n === 8);
    if (step8) Object.assign(step8, { ok: false, detail: "llama-server 가 준비되지 않았습니다(헬스체크 실패) — 창은 계속 뜹니다", why, next });
    for (const l of bootFailureLines({ n: 8, name: "헬스체크 대기", ok: false, detail: "", why, next })) emit(l);
  }
  } else {
    // 위 bail 조건과 같은 판정이다. 즉 여기에는 오로지 **두 판정이 서로 어긋난 경우**만
    // 도달한 하는 관치는 따단 패조이다.
    // "모델이 없는데 준비됐다" 고 읽히니까, 모순이라고 말한다.
    emit("[fatal] 내부 모순: 채택도 아니고 스폰 조건도 아니다 — 부팅 판정을 확인하세요.");
    return 1;
  }

  // 여기까지 왔다면 부팅이 끝났다(단계 1~12). 이후에는 **워치독이** 종료 시점을
  // 결정하고, 우리는 신호를 기다리기만 한다 — 종료 경로를 두 개 만들면 (§4.4 표에서
  // 이미 실패한 것) 어느 쪽이 실제로 쓰이는지 알 수 없다.
  if (NO_BROWSER) {
    const where = adopted ? `http://127.0.0.1:${adopted.port}` : launcher?.baseUrl ?? "(알 수 없음)";
    emit(`[info] --no-browser: llama ${where} 에서 대기합니다. Ctrl+C 로 종료.`);
  }
  await holdLoop();
  await shutdown(NO_BROWSER ? "no-browser" : "window-close");
  return 0;
}

/** SIGINT/SIGTERM 까지 대기. CPU 를 쓰지 않는다(데몬). */
function holdLoop(): Promise<void> {
  return new Promise(() => {
    /* resolve on signal only */
  });
}

/** 로거 payload 에서 자식 프로세스의 실제 줄을 꺼낸다. */
/**
 * 환경변수로 GPU 모드를 강제한다.
 *
 * **모르는 값은 조용히 무시하지 않는다** — 무시하면 "설정한 모드가 적용됐다" 고
 * believing 사용자가 정책과 다른 값으로 돌아가고, 검증도 통과해 버린다(§5.10).
 * 그래서 콘솔에 경고 한 줄을 남긴다.
 */
function gpuModeOf(v: string | undefined): "off" | "budgeted" | "full" | undefined {
  if (v === undefined || v === "") return undefined;
  if (v === "off" || v === "budgeted" || v === "full") return v;
  console.warn(`[gpu] HARNESSIDE_GPU_MODE=${v} 는 모드가 아닙니다 (off|budgeted|full) — 무시하고 정책으로 정합니다.`);
  return undefined;
}

function lineOf(o: unknown): string | undefined {
  if (o && typeof o === "object" && "line" in o) {
    const v = (o as { line?: unknown }).line;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/**
 * 채택한 서버의 생존 판정기.
 *
 * 워치독 tick 은 **동기** 라서 HTTP 를 그 자리에서 기다릴 수 없다. 그래서 값은
 * 캐시하고, 다시 보러 가는 요청은 백그라운드로 던진다. 첫 판정 전에는 "살아 있음" 을
 * 돌려준다 — 모르는 것을 죽었다로 기록하면 그건 **거짓 보고** 다(요구 9 의 degrade).
 *
 * `/v1/models` 로 묻는다. 포트/HTTP 가 곧 살아 있음의 기준이다 — 프로세스 **이름** 은
 * 위장되지만(§④ 표 21) 포트 응답은 그렇지 않다.
 */
function makeAdoptedProbe(baseUrl: string): () => boolean {
  let alive: boolean | null = null;
  let inflight = false;
  return () => {
    if (!inflight) {
      inflight = true;
      void detectModelAt(baseUrl)
        .then((m) => {
          alive = m !== null;
        })
        .catch(() => {
          alive = false;
        })
        .finally(() => {
          inflight = false;
        });
    }
    return alive ?? true;
  };
}

// 읽기 전용 명령은 부팅 없이 끝낸다(서버가 죽어도 상태를 알 수 있어야 한다).
if (await tryStandalone()) {
  // 처리 완료
} else {
  main()
    .then((code) => process.exit(code))
    .catch(async (e) => {
      // 부팅 실패도 로그로 남기고 0 이 아닌 값으로 끝낸다(데몬은 사람이 보지 않는다).
      emit(`[fatal] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(1);
    });
}

/** 재개 프롬프트 — 사용자가 "계속해" 라고 말한 것을 한 문장으로 남긴다. */
const RESUME_PROMPT = "이전 작업을 이어서 진행해 주십시오.";

/** 포트가 **응답** 하는가 — "내 것인지" 와 "떠 있는가" 를 나눠서 본다. */
async function isPortServing(p: number, timeoutMs = 1200): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
