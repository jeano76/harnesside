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
import { writeCheckpoint } from "../compaction/checkpoint.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, access } from "node:fs/promises";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const DRY = flag("--dry");
const NO_BROWSER = flag("--no-browser") || flag("--daemon");

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
    }
    if (browser) {
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
        hub = new WsHub({ server: undefined as never, path: "/ws" });
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
            model: r.model?.path ?? null,
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
        const idePort = r.ports?.idePort ?? 7317;
        const mode = r.gpu?.mode ?? "off";
        const cdpPort = Number(process.env.HARNESSIDE_CDP_PORT ?? 9222);
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
          isLlamaAlive: () => !!launcher?.pid,
          isChromeAlive: () => !!browser?.pid,
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

  if (!llama || !model?.path || !tuning || !ports) {
    emit("[warn] llama-server 또는 모델이 준비되지 않았습니다. 창은 계속 뜹니다(단계 9~12 미구현).");
    emit(`       모델 상태: ${model?.reason ?? "알 수 없음"}`);
    await holdLoop();
    await shutdown("no-model");
    return 0;
  }

  // §6.2 adopt 원칙: 이미 정상인 llama-server 가 떠 있으면 **새로 띄우지 않는다.**
  // VRAM 8 GiB 환경에서 두 번째 서버를 띄우면 즉시 OOM 하고, 사용자는 원인을 모른다.
  const adopted = await tryAdopt(ports.llamaPort);
  if (adopted) {
    emit(`[7] 기존 llama-server 를 채택했습니다: http://127.0.0.1:${ports.llamaPort} (${adopted})`);
    emit("[8] 헬스체크: 채택한 서버 사용 (스폰 없음)");
    emit("[info] 창 기동(단계 11)은 P2 에서 구현됩니다. Ctrl+C 로 종료.");
    await holdLoop();
    await shutdown("adopted");
    return 0;
  }

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

  // 여기까지 왔다면 부팅이 끝났다(단계 1~12). 이후에는 **워치독이** 종료 시점을
  // 결정하고, 우리는 신호를 기다리기만 한다 — 종료 경로를 두 개 만들면 (§4.4 표에서
  // 이미 실패한 것) 어느 쪽이 실제로 쓰이는지 알 수 없다.
  if (NO_BROWSER) {
    emit(`[info] --no-browser: llama ${launcher.baseUrl} 에서 대기합니다. Ctrl+C 로 종료.`);
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
 * 이미 그 포트에 OpenAI 호환 서버가 살아 있는지 확인한다(§6.2 adopt).
 * 살아 있으면 모델명을 돌려준다 — "이 포트에 무언가 있다" 와 "정작 쓸 수 있다" 는 다르다.
 * 시간이 걸리면 안 되므로 짧은 타임아웃을 건다.
 */
async function tryAdopt(port: number, timeoutMs = 1500): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string }[] };
    return body?.data?.[0]?.id ?? "알 수 없는 모델";
  } catch {
    return null; // 응답 없음 = 없거나 죽어 있음
  } finally {
    clearTimeout(t);
  }
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
