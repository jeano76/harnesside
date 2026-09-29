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
import { HttpServer } from "./httpServer.js";
import { issueToken } from "../auth/token.js";
import { writeCheckpoint } from "../compaction/checkpoint.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, access } from "node:fs/promises";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const DRY = flag("--dry");
const NO_BROWSER = flag("--no-browser") || flag("--daemon");

/** 데몬은 사람이 보지 않는다. stdout 은 파일/파이프로 새므로 한 줄씩만 쓴다(§3.7.1). */
function emit(line: string) {
  process.stdout.write(`${line}\n`);
}

function stateDir(projectRoot: string): string {
  return join(projectRoot, ".harnesside", "state");
}

async function main(): Promise<number> {
  const projectRoot = process.cwd();
  const home = homedir();
  const modelsDir = process.env.HARNESSIDE_MODELS_DIR ?? join(home, ".harnesside", "models");
  await mkdir(stateDir(projectRoot), { recursive: true });

  if (DRY) {
    const r = await bootstrap({ projectRoot, modelsDir, dryRun: true });
    for (const s of r.steps) emit(`${String(s.n).padStart(2)}. ${s.name}`);
    return 0;
  }

  let lock: InstanceLock | null = null;
  let launcher: LlamaLauncher | null = null;
  let boot: BootstrapResult | null = null;
  let http: HttpServer | null = null;

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
    if (http) {
      await http.close().catch(() => {});
      emit("[shutdown] HTTP/WS 종료 완료");
    }
    if (lock) await lock.release();
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
        http = new HttpServer({
          token: tokenRec,
          port,
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
          }));
        const { port: actual } = await http.start();
        return { ok: true, detail: `http://127.0.0.1:${actual} (토큰 인증 필수)` };
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

  if (NO_BROWSER) {
    emit(`[info] --no-browser: llama ${launcher.baseUrl} 에서 대기합니다. Ctrl+C 로 종료.`);
    await holdLoop();
    await shutdown("no-browser");
    return 0;
  }

  emit("[info] 창 기동(단계 11)은 P2 에서 구현됩니다. 이 동안은 서버만 살아 있습니다.");
  await holdLoop();
  await shutdown("window-close");
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

main()
  .then((code) => process.exit(code))
  .catch(async (e) => {
    // 부팅 실패도 로그로 남기고 0 이 아닌 값으로 끝낸다(데몬은 사람이 보지 않는다).
    emit(`[fatal] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  });
