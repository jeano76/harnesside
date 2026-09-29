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
import { HttpServer, readBody } from "./httpServer.js";
import { defaultPaths, initDaemonLogging, clearInstance, writeInstance, type DaemonMode } from "./daemon.js";
import { teeChild } from "./logWatcher.js";
import type { LogLevel, LogSource } from "./logRing.js";
import { safeListDir, safeReadFile, safeWriteFile } from "../fs/safePath.js";
import { gitStatus, gitShowHead } from "./gitDiff.js";
import { MetricsSampler } from "./metrics.js";
import { WorkspaceWatcher } from "./fsWatcher.js";
import { BrowserLauncher } from "./browserLauncher.js";
import { WsHub } from "./wsHub.js";
import { startWatchdog, type Watchdog } from "./watchdog.js";
import { issueToken } from "../auth/token.js";
import { detectModelAt } from "../backend/detect.js";
import { writeCheckpoint } from "../compaction/checkpoint.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, access } from "node:fs/promises";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const DRY = flag("--dry");
// "창을 띄워야 하는가" 의 **정본은 browserIntent.ts** 다. 여기서 또 판단하면
// 두 진실원이 되고, 실제로 그랬다 — 플래그 변수는 있었는데 단계 11 이 안 봤다.
const BROWSER_INTENT = resolveBrowserIntent(argv);
const NO_BROWSER = !BROWSER_INTENT.launch;

/** 데몬 상태 출력 — 한 줄씩만. 화면 출력(커서 이동·바)은 절대 하지 않는다(§3.7.1). */
function emit(line: string) {
  process.stdout.write(`${line}\n`);
}

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
  const metrics = new MetricsSampler();
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

  let lock: InstanceLock | null = null;
  let launcher: LlamaLauncher | null = null;
  let boot: BootstrapResult | null = null;
  let http: HttpServer | null = null;
  let browser: BrowserLauncher | null = null;
  let hub: WsHub | null = null;
  let watchdog: Watchdog | null = null;
  let adoptedProbe: (() => boolean) | null = null;
  /** 창을 띄우려 한 적이 있는가. `never-opened` 판정의 전제다. */
  let browserLaunchAttempted = false;
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
      await writeCheckpoint(stateDir(projectRoot), { reason } as never);
      emit("[shutdown] 체크포인트 기록 완료");
    } catch (e) {
      emit(`[shutdown] 체크포인트 실패(무시하고 계속): ${String(e)}`);
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
  process.on("uncaughtException", (e) => {
    emit(`[fatal] 처리되지 않은 예외: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (e) => {
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

  const webDir = join(projectRoot, "dist", "web");
  let tokenRec: Awaited<ReturnType<typeof issueToken>> | null = null;

  boot = await bootstrap({
    projectRoot,
    modelsDir,
    hardware: undefined,
    allowBuild: false,
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
            version: "0.1.0",
          }))
          .route("GET", "/api/gpu", () => ({ ...r.gpu, llama: r.ports?.llamaPort, ide: port }))
          .route("GET", "/api/bootstrap", () => ({
            steps: r.steps.map((s) => ({ n: s.n, name: s.name, ok: s.ok, detail: s.detail, pending: !!s.pending, tookSeconds: s.tookSeconds })),
            tuning: r.tuning?.rationale ?? [],
          }))
          .route("GET", "/api/system/version", () => ({
            version: "0.1.0",
            llama: r.llama?.source ?? null,
            // 채택한 경로에서는 **서버가 스스로 말한 모델 이름** 이 진짜다.
            // 로컬 파일 경로는 그 서버가 지금 serve 하는 것과 다를 수 있다.
            model: r.ports?.adopted?.model ?? r.model?.path ?? null,
            gpuMode: r.gpu?.mode ?? null,
          }))
          // §8.2 파일 API — 경로 안전이 이 라우트 **앞에서** 처리된다(§3.4).
          .route("GET", "/api/fs/tree", async (c) => {
            const r = await safeListDir(c.query.get("path") || ".", { root: projectRoot });
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-found" ? 404 : 403 });
            return r.value;
          })
          .route("GET", "/api/fs/file", async (c) => {
            const r = await safeReadFile(c.query.get("path") || "", { root: projectRoot });
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-found" ? 404 : 403 });
            return r.value;
          })
          .route("PUT", "/api/fs/file", async (c) => {
            const body = (await readBody(c.req)) as { path?: string; content?: string; baseVersion?: number };
            if (typeof body.path !== "string" || typeof body.content !== "string") {
              throw Object.assign(new Error("path 와 content 가 필요합니다"), { status: 400 });
            }
            const r = await safeWriteFile(body.path, body.content, {
              root: projectRoot,
              baseVersion: body.baseVersion,
              readOnlyPaths: [join(projectRoot, ".harnesside")],
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
          // §5.5 계측. **계측하지 않는다** — 마지막 샘플만 돌려준다.
          .route("GET", "/api/metrics", () => ({
            latest: metrics.ring.latest,
            series: metrics.ring.series((m) => m.cpu.overall),
            size: metrics.ring.size,
          }))
          // §5.2 Git 변경 소스(HEAD ↔ 워킹트리). 실패는 "변경 없음" 과 구분해 말한다.
          .route("GET", "/api/git/status", async () => {
            const r = await gitStatus(projectRoot);
            if (!r.ok) throw Object.assign(new Error(r.detail), { status: r.reason === "not-a-repo" ? 400 : 500 });
            return r.value;
          })
          .route("GET", "/api/git/head", async (c) => {
            const p = c.query.get("path") || "";
            const r = await gitShowHead(projectRoot, p);
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
          });
        const { port: actual } = await http.start();
        hub.publish({ type: "sys.logs", limits: ring.status } as never);
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
        const cdpPort = Number(process.env.HARNESSIDE_CDP_PORT ?? 9222);
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
              if (isErr) emit(`[chrome] ${l}`);
            },
          }
        );
        const res = await browser.launch();
        if (!res.flags.length) {
          return { ok: false, detail: "브라우저 바이너리를 찾지 못했습니다 — 설치 후 재시작 하세요 (창 없이 서버만 동작)" };
        }
        if (!res.attached) {
          return { ok: false, detail: `Chrome 기동은 했지만 CDP(${res.cdpPort}) 에 붙지 못했습니다` };
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
      events: { onLine: (line) => emit(line) },
    }
  );

  // 단계 [7] 스폰 → 단계 [8] 헬스체크
  const built = launcher.spawn();
  emit(`[7] llama-server 스폰: ${built.args.join(" ")}`);
  for (const r of built.rationale) emit(`    - ${r}`);

  const ready = await launcher.waitUntilReady(120_000);
  emit(`[8] 헬스체크: ${ready ? "준비 완료 (/v1/models 200)" : "실패 — 창은 계속 뜹니다"}`);
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
