#!/usr/bin/env node
/**
 * §4.4 종료 신호 **각각을 따로** 실측한다 (PROMPT §12 P12 판정 기준).
 *
 * 왜 하나씩 따로 재현해야 하는가: 한 번에 몰아서 하면 **하나가 다른 하나를 가린다.**
 * 실제로 그랬다 — 검증 스크립트가 자기 자신을 `pgrep` 로 잡아서 S2·S5 가 "안 죽음",
 * S4 가 "죽음" 으로 보고했다. 셋 다 거짓말이었고, 포트는 비어 있었다(§④ 표 21).
 *
 * 그래서 이 스크립트의 규칙은 세 가지다:
 *  1. **생존 판정은 포트/HTTP 다.** 프로세스 이름은 위장된다.
 *  2. **잡은 pid 가 진짜 서버인지** `/proc/<pid>/cmdline` 으로 확인한다.
 *  3. **각 시나리오는 자기 로그** 를 쓴다. 앞 로그로 부팅 완료를 기다리면
 *     실패한 시나리오의 원인을 볼 수 없다.
 *
 * 모델: **가짜 llama 서버**(`scripts/fake-llama-server.mjs`)를 쓴다. 여기서 재는 것은
 * "누가 무엇을 죽이는가" 이지 모델 품질이 아니다 — 20 GB 를 시나리오마다 로드할
 * 이유가 없다(그 경로는 실측된 OOM 이다).
 *
 * **미구현 신호는 SKIP 으로 적고 통과로 세지 않는다.** S3(하트비트 만료) · S4(CDP 소실 +
 * 재연결 실패) · S6(고아 데몬)은 **서버에 그 판정이 없다.** 창을 닫아서 흉내 내면
 * S1 을 두 번 재는 셈이라 통과했지만 아무것도 검증하지 않았다 — 통과를 늘리는 것보다
 * "재현 방법이 없다" 를 쓰는 편이 낫다.
 *
 * §4.4 의 신호 이름은 PROMPT 를 따른다(S1~S6). 예전 스크립트는 S1~S5 를 다른 것으로
 * 불렀다(S4 가 SIGHUP 이었다) — **라벨이 거짓말을 하면 기록이 거짓말을 한다.**
 *
 *   S1 Chrome 프로세스 exit · S2 CDP target detached · S3 웹 클라이언트 하트비트 만료
 *   S4 CDP 연결 소실 · S5 SIGINT/SIGTERM · S6 고아 데몬
 *
 * 사용법: `node scripts/verify-signals.mjs [--no-window] [--keep]`
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
// `readFile` 은 **promises** 쪽에서 가져온다. `node:fs` 의 sync API 를 promise 로
// 부르면 콜백 방식이 되어 조용히 잘못된 값이 온다(첫 실행이 "cb argument" 로 죽었다).
import { openSync } from "node:fs";
import { readFile, rm, mkdir, writeFile, stat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const exec = promisify(execFile);
const require_ = createRequire(import.meta.url);
const WebSocket = require_("ws");

const ROOT = process.cwd();
const TMP = "/tmp/opencode";
const NO_WINDOW = process.argv.includes("--no-window");
const KEEP = process.argv.includes("--keep");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDE_PORT = 7317;
const CDP_PORT = 9222;

async function mkdirp(p) {
  await mkdir(p, { recursive: true });
}

// ── 판정 함수 (모두 포트/HTTP 기준) ──────────────────────────────────────────

/** llama 가 서비스로 살아 있는가. `/v1/models` 200 이 정본이다. */
async function llamaAlive(port = 8080) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** IDE 서버가 살아 있는가(데몬 자체). */
async function daemonAlive(port = IDE_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** 잡은 pid 가 **정말 서버**인지. 아니면 모든 결과가 뒤집힌다(두 번 당한 실수). */
async function cmdlineOf(pid) {
  return readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
}

async function cdpTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return [];
  }
}

async function cdpSend(wsUrl, method, params = {}, id = 1) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  try {
    ws.send(JSON.stringify({ id, method, params }));
    await sleep(700);
  } finally {
    ws.close();
  }
}

// ── 결과 집계 ────────────────────────────────────────────────────────────────

const results = [];
function record(scenario, name, ok, detail = "") {
  results.push({ scenario, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${scenario} · ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 서버 기동/종료 ───────────────────────────────────────────────────────────

/**
 * `npx` 를 거치지 않는다. `npx tsx` 로 띄우면 잡히는 pid 는 npx 의 것이고 서버는 그
 * **자식** 이다 — 그러면 신호를 npx 에 보내는 셈이 되고, npx 가 죽으면 트리 전체가
 * 따라 죽는다. 즉 "SIGHUP 이 무시된다" 도 죽어 보이게 된다(실제로 그랬다).
 */
async function startDaemon(args, logFile) {
  await rm(join(ROOT, ".harnesside/state/instance.lock"), { force: true });
  const out = openSync(logFile, "w");
  const env = {
    ...process.env,
    // 가짜 llama 를 "llama-server" 로 쓰게 한다. 수명 신호만 재는 게 목적이라
    // 20 GB 모델을 두 번 로드할 이유가 없다.
    HARNESSIDE_LLAMA_SERVER: join(ROOT, "scripts", "fake-llama-server.mjs"),
    HARNESSIDE_MODELS_DIR: join(ROOT, ".ci-fake-models"),
  };
  const p = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/server/index.ts", ...args], {
    cwd: ROOT,
    env,
    stdio: ["ignore", out, out],
    detached: true,
  });
  p.unref();
  await sleep(1200);
  const cmd = await cmdlineOf(p.pid);
  if (!cmd.includes("src/server/index.ts")) {
    throw new Error(`pid ${p.pid} 가 서버가 아닙니다: ${cmd.replace(/\0/g, " ").slice(0, 120)}`);
  }
  return p.pid;
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(1000);
  }
  console.log(`    (${label} 대기 ${Math.round((Date.now() - t0) / 1000)}초 — 실패)`);
  return false;
}

/** 정리: **소유 inode** 로 포트를 비운다. 이름으로 잡으면 검증 셸 자신을 죽인다. */
async function cleanup(pid) {
  if (pid && (await pidAlive(pid))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 이미 없음 */
    }
  }
  await preflight("정리");
}

/**
 * 포트에 **누가** 붙잡고 있는지 찾는다.
 *
 * `pgrep -f` 로 찾지 않는다 — 명령 줄 문자열로 보면 **검증 셸 자신** 이 잡히고,
 * 그래서 이전 실험의 잔해를 못 치웠다(그 결과 8개 시나리오가 전부 "시작 전 llama 없음"
 * 에서 실패했다). 이름이 아니라 **소유 inode** 로 찾는다: 리소스가 정본이다.
 */
async function pidsOnPort(port) {
  const pids = new Set();
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  let inodes = "";
  try {
    inodes = await readFile("/proc/net/tcp", "utf8");
  } catch {
    return [];
  }
  const wanted = new Set();
  for (const line of inodes.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [local, , st] = [f[1], f[2], f[3]];
    if (st !== "0A") continue; // LISTEN
    if (local?.endsWith(`:${hexPort}`)) wanted.add(f[9]);
  }
  if (!wanted.size) return [];
  for (const d of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(d)) continue;
    const fds = await readdir(`/proc/${d}/fd`).catch(() => []);
    for (const fd of fds) {
      // `fd` 항목은 심볼릭 링크다. **읽는** 게 아니라 **해석**해야 한다 — 읽으면
      // "권한 없음" 이거나 fd 를 소비해 버린다.
      const link = await readlink(`/proc/${d}/fd/${fd}`).catch(() => "");
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && wanted.has(m[1])) {
        pids.add(Number(d));
        break;
      }
    }
  }
  return [...pids];
}

/**
 * 시작 전 포트를 비운다.
 *
 * **이 전제가 없으면 검증 자체가 무의미** 하다: 잔해가 남아 있으면 "이미 죽었다" 와
 * "방금 죽었다" 를 구분할 수 없다. 실제로 이 스크립트가 첫 실행에서 스스로 남긴 것을
 * 못 치워 전부 거짓 실패했다.
 */
async function preflight(label = "시작 전") {
  for (const p of [8080, IDE_PORT, CDP_PORT]) {
    for (const pid of await pidsOnPort(p)) {
      // **자기 자신과 부모는 절대 죽이지 않는다.** 포트 소유자 목록을 그대로 믿고
      // kill 하면 셸까지 죽는다 — 실제로 이 대화에서 그랬다(작업 중단).
      if (pid === process.pid || pid === process.ppid) {
        console.log(`  ${label}: 포트 ${p} 의 소유자가 나다(${pid}) — 건드리지 않는다`);
        continue;
      }
      console.log(`  ${label}: 포트 ${p} 를 pid ${pid} 가 붙잡고 있어 정리한다`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 이미 없음 */
      }
    }
  }
  await sleep(2000);
  for (const p of [8080, IDE_PORT]) {
    if (await llamaAlive(p) || (p === IDE_PORT && (await daemonAlive()))) {
      console.log(`  ${label}: 포트 ${p} 가 여전히 응답한다 — 다른 것을 조사해야 한다`);
    }
  }
}

async function setup() {
  await mkdirp(TMP);
  await preflight("정리");
  await mkdirp(join(ROOT, ".ci-fake-models"));
  // `chooseModel` 은 파일 **존재** 만 본다. 4 KiB 로 충분하다.
  const gguf = join(ROOT, ".ci-fake-models", "Ornith-1.5-35B-A3B-Q3_K_M.gguf");
  if (!(await stat(gguf).catch(() => null))) await writeFile(gguf, Buffer.alloc(4096));
}

// ── 시나리오 ─────────────────────────────────────────────────────────────────

/**
 * 시나리오 하나: 기동 → 부팅 대기 → 트리거 → 기대 결과 확인.
 *
 * `expect` 은 llama 와 데몬 **각각**에 대한 기대다. 하나만 보면 "죽어야 할 쪽이
 * 살아서" 또는 "살아야 할 쪽이 죽어서" 를 놓친다(그래서 adopt 실측도 둘 다 봤다).
 */
async function scenario(name, { args = [], expect, trigger, boot = "spawn" }) {
  console.log(`\n[${name}]`);
  // adopt 시나리오는 **먼저** "사용자의 서버" 를 띄운다. 그래야 데몬이 스폰하지 않는다.
  let adoptTarget = null;
  if (boot === "adopt") {
    const out = openSync("/tmp/opencode/adopt-llama.log", "w");
    const p = spawn(process.execPath, [join(ROOT, "scripts", "fake-llama-server.mjs"), "--port", "8080"], {
      cwd: ROOT,
      stdio: ["ignore", out, out],
      detached: true,
    });
    p.unref();
    adoptTarget = p.pid;
    if (!(await waitFor(() => llamaAlive(), 20_000, "adopt 대상 서버"))) {
      record(name, "adopt 대상 서버 기동", false, "8080 이 응답하지 않는다");
      return;
    }
    record(name, "adopt 대상 서버 기동 (사용자의 것)", true, `pid ${p.pid}`);
  }
  if (await llamaAlive() && boot !== "adopt") {
    // **이건 조용히 넘기지 않는다.** 잔해가 있으면 "이미 죽었다" 와 "방금 죽었다" 를
    // 구분할 수 없어서 그 이후 판정이 전부 무의미해진다. 원인을 밝히고 멈춘다.
    const owners = await pidsOnPort(8080);
    record(name, "시작 전 llama 없음", false, `포트 8080 이 이미 응답한다 (소유 pid ${owners.join(",") || "알 수 없음"})`);
    await cleanup(null);
    return;
  }
  const logFile = join(TMP, `signal-${name.replace(/[^A-Za-z0-9]+/g, "_")}.log`);
  let pid;
  try {
    pid = await startDaemon(args, logFile);
  } catch (e) {
    record(name, "서버 기동", false, String(e.message ?? e));
    return;
  }
  record(name, "서버 기동 (pid 가 진짜 서버임)", true, `pid ${pid}`);

  const booted = await waitFor(
    async () => /\[12\/12\]/.test(await readFile(logFile, "utf8").catch(() => "")),
    90_000,
    "12/12"
  );
  if (!booted) {
    record(name, "부팅 완료 (12/12)", false, logFile);
    await cleanup(pid);
    return;
  }
  const log = await readFile(logFile, "utf8");
  record(name, "부팅 완료 (12/12)", true, boot === "adopt" ? "adopt 경로" : "spawn 경로");
  record(
    name,
    "기록된 채택 여부가 기대와 일치",
    /기존 서버를 채택/.test(log) === (boot === "adopt"),
    /기존 서버를 채택/.test(log) ? "adopt" : "spawn"
  );
  if (boot === "spawn") {
    // **12/12 과 헬스체크는 순서가 반대다.** 스폰은 12단계 **이후** 일어난다 —
    // 실제로 그렇게 되어 있다. 12/12 에서 곧바로 로그를 읽으면 아직 안 쓰인 라인을
    // "헬스체크 실패" 로 읽는다(첫 실행이 전 시나리오에서 그렇게 거짓 실패했다).
    const ready = await waitFor(
      async () => /헬스체크: 준비 완료/.test(await readFile(logFile, "utf8").catch(() => "")),
      30_000,
      "헬스체크"
    );
    record(name, "스폰한 llama 응답 (헬스체크 200)", ready && (await llamaAlive()));
  } else {
    // adopt 경로에서는 **스폰하면 안 된다** — 8GiB 카드에서 두 번째 서버는 즉시 OOM.
    const spawned = /llama-server 스폰/.test(await readFile(logFile, "utf8").catch(() => ""));
    record(name, "스폰하지 않는다", !spawned, "adopt 인데 스폰했다 = OOM 경로");
  }

  await trigger(pid, logFile);

  // 판정: 각 기대를 **따로** 확인한다.
  const llamaOk = await waitFor(async () => (await llamaAlive()) === expect.llama, 25_000, `llama=${expect.llama}`);
  record(name, `llama ${expect.llama ? "생존" : "종료"}`, llamaOk, `포트 /v1/models`);
  if (expect.daemon !== undefined) {
    const daemonOk = await waitFor(async () => (await daemonAlive()) === expect.daemon, 20_000, `daemon=${expect.daemon}`);
    record(name, `데몬 ${expect.daemon ? "생존" : "종료"}`, daemonOk, `포트 ${IDE_PORT}/api/health`);
  }

  if (!KEEP) await cleanup(pid);
  // adopt 대상은 **우리 것이 아니다.** 검증이 끝나도 참조로만 정리한다(기록 남기고).
  if (adoptTarget) {
    if (KEEP) console.log(`  (adopt 대상 pid ${adoptTarget} 는 남겨 둔다)`);
    else {
      for (const p of await pidsOnPort(8080)) {
        if (p !== process.pid && p !== process.ppid) {
          try {
            process.kill(p, "SIGKILL");
          } catch {
            /* 이미 없음 */
          }
        }
      }
    }
  }
}

/** CDP 로 **타깃만** 닫는다 — Chrome 프로세스는 살아 있다 (S2). */
async function closePageTarget() {
  const page = (await cdpTargets()).find((t) => t.type === "page" && (t.url ?? "").includes(String(IDE_PORT)));
  if (!page) throw new Error("CDP 에 페이지가 없다 — 창을 못 닫는다");
  await cdpSend(page.webSocketDebuggerUrl, "Page.close");
}

/** CDP 로 창(브라우저)을 닫는다 (S1: Chrome 프로세스 종료). */
async function closeBrowser() {
  const page = (await cdpTargets()).find((t) => t.type === "page" && (t.url ?? "").includes(String(IDE_PORT)));
  if (!page) throw new Error("CDP 에 페이지가 없다 — 창을 못 닫는다");
  await cdpSend(page.webSocketDebuggerUrl, "Browser.close");
}

async function main() {
  await setup();
  console.log(`§4.4 종료 신호 각각을 실측한다 (모델: 가짜 llama · 창: ${NO_WINDOW ? "없음" : "있음"})\n`);

  if (NO_WINDOW) {
    // 창이 없으면 S1/S2/S4 를 재현할 수 없다 — 그래도 "안 죽는다" 는 확인된다.
    await scenario("창 없음 + SIGTERM", {
      args: ["--no-browser"],
      expect: { llama: false, daemon: false },
      trigger: async (pid) => process.kill(pid, "SIGTERM"),
    });
    return finish();
  }

  // S1 — Chrome 프로세스 exit (창 X). 요구 9 의 핵심: 창을 닫으면 llama 도 멈춘다.
  await scenario("S1 Chrome 프로세스 exit (창 X)", {
    expect: { llama: false, daemon: false },
    trigger: async () => {
      await closeBrowser();
    },
  });

  // S2 — CDP target detached. **프로세스는 살아 있고** 타깃만 떨어진다.
  // S1 과 다른 경로여야 한다 — 같은 것을 두 번 재면 두 개의 신호를 검증한 셈이 안 된다.
  await scenario("S2 CDP target detached (타깃만)", {
    expect: { llama: false, daemon: false },
    trigger: async () => {
      await closePageTarget();
    },
  });

  // S3 — 웹 클라이언트 하트비트 만료. **구현되어 있지 않다.**
  //
  // `heartbeatFresh()` 라는 순수 함수는 있지만(워치독 유예 판정용) **서버가 마지막
  // ping 시각을 추적하지 않는다.** 즉 이 신호를 만들어 낼 방법이 코드에 없다.
  // 창을 닫아서 흉내 내면(예전 스크립트가 그랬다) S1 을 두 번 재는 셈이라
  // 통과했지만 아무것도 검증하지 않았다 — 그래서 **여기서 멈추고 미구현으로 적는다.**
  console.log(`\n[S3 웹 클라이언트 하트비트 만료]\n  SKIP  미구현 — 마지막 ping 추적이 서버에 없다 (재현 방법이 없으면 통과로 세지 않는다)`);
  // S4 — CDP 연결 소실 + 재연결 2회 실패. 이것도 **구현되어 있지 않다.**
  console.log(`\n[S4 CDP 연결 소실]\n  SKIP  미구현 — CDP 소시에 재연결 정책이 없다. S1/S2 와 관측상 구분되지 않는다`);
  // S6 — 고아 데몬. 자식 전부 exit + 클라이언트 0. **구현되어 있지 않다.**
  console.log(`\n[S6 고아 데몬]\n  SKIP  미구현 — 워치독에 "자식 전부 죽음" 판정이 없다`);

  // S5 — 명시적 종료.
  await scenario("S5 SIGTERM (명시적 종료)", {
    expect: { llama: false, daemon: false },
    trigger: async (pid) => process.kill(pid, "SIGTERM"),
  });
  await scenario("S5b SIGINT (Ctrl+C)", {
    expect: { llama: false, daemon: false },
    trigger: async (pid) => process.kill(pid, "SIGINT"),
  });

  // S5 의 대칭 — 무시되어야 하는 신호. 여기서 죽으면 안 된다.
  await scenario("SIGHUP (터미널 종료 → 무시되어야 함)", {
    expect: { llama: true, daemon: true },
    trigger: async (pid) => {
      process.kill(pid, "SIGHUP");
      await sleep(3000);
    },
  });

  // ★ 가장 중요한 대조 — **같은 신호, 반대 결과.**
  // S1 은 "창을 닫으면 llama 가 죽는다" 를 봤다. 여기는 **adopt** 상태에서 같은 창
  // 닫기를 한다: 데몬은 죽어도 **사용자의 llama 는 살아야 한다.** 우리가 띄운 것만
  // 죽인다. 두 경로를 나눠 재지 않으면 "누가 죽였나" 를 알 수 없다.
  await scenario("adopt + 창 X (데몬은 죽고 사용자의 서버는 산다)", {
    boot: "adopt",
    expect: { llama: true, daemon: false },
    trigger: async () => {
      await closeBrowser();
    },
  });

  // §4.4 의 의도적 예외 — daemon 모드. **실측 가능한 형태** 로 적는다.
  //
  // "daemon 모드에서 창을 닫으면 S1~S3 이 발동하지 않는다" 를 그대로 재려면 창이 있어야
  // 하는데, **창은 정의상 없다** — `resolveBrowserIntent()` 가 `--daemon` 을 창 없음으로
  // 만든다(D3). 그래서 "창 닫기" 시나리오는 **재현 자체가 불가능**하고(불가능한 것을
  // 통과로 세면 안 된다), 대신 이 모드에서 **실제로 성립하는 불변식** 을 잰다:
  // CDP 포트가 열리지 않는다 + 창이 없으므로 창 종료 신호가 없다 + SIGTERM 은 먹는다.
  await scenario("daemon 모드 불변식 (창 없음 · SIGTERM 은 먹음)", {
    args: ["--daemon"],
    expect: { llama: false, daemon: false },
    trigger: async (pid, logFile) => {
      const log = await readFile(logFile, "utf8");
      const cdpOpen = (await cdpTargets()).length > 0;
      record("daemon 모드 불변식 (창 없음 · SIGTERM 은 먹음)", "CDP 포트가 열리지 않는다", !cdpOpen, `타깃 ${(await cdpTargets()).length}개`);
      record("daemon 모드 불변식 (창 없음 · SIGTERM 은 먹음)", "부팅 로그가 창 없음을 말한다", /Chrome 을 띄우지 않습니다/.test(log));
      process.kill(pid, "SIGTERM");
    },
  });

  finish();
}

async function chromePids() {
  const out = [];
  try {
    const { stdout } = await exec("pgrep", ["-f", `remote-debugging-port=${CDP_PORT}`], { timeout: 5000 });
    for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const pid = Number(line.split(/\s+/)[0]);
      // **검증 셸 자신** 을 걸러낸다 — 실제로 이걸로 셸이 죽은 적이 있다.
      if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
      const cmd = await cmdlineOf(pid);
      if (cmd.includes("chrome") || cmd.includes("chromium")) out.push(pid);
    }
  } catch {
    /* 없음 */
  }
  return out;
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  if (failed.length) {
    console.error(`\n실패:\n${failed.map((f) => `  - ${f.scenario} · ${f.name}: ${f.detail}`).join("\n")}`);
    process.exit(1);
  }
}

await main();
