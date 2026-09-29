/**
 * §4.4 종료 시그널 **각각**을 실측한다.
 *
 * PROMPT §12 P12 의 판정 기준은 "신호 S1~S5 각각 닫아 llama-server 가 종료됨
 * (각각 별도 검증)" 이다. **한 번에 몰아서 하면 안 된다** — 하나가 다른 하나를
 * 가려서 ".signal 이름이 틀렸는데 동작은 했다" 고 잘못 통과하기 때문이다.
 *
 * 각 신호를 **독립적으로**, 그리고 매번 "이 시나리오가 맞는지" 확인한 뒤 잰다:
 *  - S1 창 X 를 클릭 (window 모드)
 *  - S2 SIGTERM (명시적 종료)
 *  - S3 SIGINT (Ctrl+C)
 *  - S4 SIGHUP (터미널 종료 → **무시**되어야 한다)
 *  - S5 브라우저가 죽음 (창이 아니라 프로세스)
 *
 * 판정: `pgrep -af llama-server` 가 **빈 결과** 여야 한다. 프로세스가 살아 있으면 실패.
 *
 * 주의: 이 스크립트는 llama 를 **실제로 죽인다.** 되살아나는 걸 감지하면 실패로 보고한다.
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);
const ROOT = process.cwd();
const LOG = "/tmp/opencode/p12.log";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * llama 프로세스 탐지.
 *
 * `pgrep -af llama-server` 는 **자기 자신**(이 스크립트를 실행한 셸)을 잡는다 — 명령
 * 줄에 문자열이 들어 있으니까. 그러면 "아직 살아 있다" 고 잘못 판정하고 모든 시나리오가
 * 실패한다. 그래서 **실제 바이너리 경로** 로 매칭하고, 자기 자신은 확실히 뺀다.
 */
const LLAMA_BIN = "/llama-server";

async function llamaPids() {
  let out = "";
  try {
    ({ stdout: out } = await exec("pgrep", ["-af", LLAMA_BIN], { timeout: 5000 }));
  } catch {
    return []; // 없음
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ pid: Number(l.split(/\s+/)[0]), cmd: l.slice(0, 90) }))
    // 셸/스크립트가 같은 문자열을 포함하면 제외한다.
    .filter((p) => !/verify-shutdown|pgrep -af|bash -c/.test(p.cmd))
    .filter((p) => Number.isFinite(p.pid) && p.pid > 1);
}

async function harnessPids() {
  try {
    const { stdout } = await exec("pgrep", ["-af", "tsx src/server/index.ts"], { timeout: 5000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => Number(l.split(/\s+/)[0]))
      .filter((pid) => pid !== process.pid && pid > 1 && !/verify-shutdown|bash -c|pgrep/.test(pid === 0 ? "" : String(pid)));
  } catch {
    return [];
  }
}

async function startServer(extraArgs = []) {
  await rm(join(ROOT, ".harnesside/state/instance.lock"), { force: true });
  const out = await import("node:fs").then((m) => m.openSync(LOG, "w"));
  const p = spawn("npx", ["tsx", "src/server/index.ts", ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, HARNESSIDE_MODELS_DIR: "/media/jeano/nvme-usb/models" },
    stdio: ["ignore", out, out],
    detached: true,
  });
  p.unref();
  return p.pid;
}

/** 부팅이 끝날 때까지 기다린다(모델 로딩 포함). */
async function waitBoot(timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const txt = await readFile(LOG, "utf8").catch(() => "");
    if (/\[12\/12\]/.test(txt)) return true;
    await sleep(2000);
  }
  return false;
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("P12 §4.4 — 종료 경로 각각을 독립적으로 실측\n");

// 시작 전: 남아 있는 프로세스를 정리한다(되살아오면 실패로 기록된다).
for (const p of await llamaPids()) {
  try {
    process.kill(p.pid, "SIGKILL");
  } catch {
    /* 이미 없음 */
  }
}
for (const p of await harnessPids()) {
  try {
    process.kill(p.pid, "SIGKILL");
  } catch {
    /* 이미 없음 */
  }
}
await sleep(3000);

/** 시나리오 하나를 실행한다: 기동 → 부팅 대기 → 트리거 → 종료 확인. */
async function scenario(name, { args = [], trigger, expectAlive = false, graceMs = 25_000 }) {
  console.log(`\n[${name}]`);
  const before = (await llamaPids()).length;
  if (before > 0) {
    record(`${name}: 시작 전 llama 없음`, false, `${before}개 살아 있음 — 이전 실험이 정리되지 않았다`);
    return;
  }
  const pid = await startServer(args);
  const booted = await waitBoot();
  if (!booted) {
    record(`${name}: 부팅 완료`, false, "12/12 에 도달하지 못했다");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    return;
  }
  record(`${name}: 부팅 완료 (12/12)`, true, `llama ${(await llamaPids()).length}개`);

  await trigger(pid);
  const t0 = Date.now();
  let alive = true;
  while (Date.now() - t0 < graceMs) {
    if ((await llamaPids()).length === 0) {
      alive = false;
      break;
    }
    await sleep(1000);
  }
  if (expectAlive) {
    record(`${name}: llama 가 살아 있어야 함`, alive, alive ? `${(await llamaPids()).length}개 유지` : "죽었다 — 조용히 죽이면 안 된다");
  } else {
    record(`${name}: llama 종료됨`, !alive, alive ? `${(await llamaPids()).length}개가 아직 살아 있다` : "0개");
  }
  // 정리
  for (const p of await llamaPids()) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
  await sleep(2000);
}

await scenario("S2 SIGTERM (명시적 종료)", {
  trigger: async (pid) => {
    process.kill(pid, "SIGTERM");
  },
});

await scenario("S3 SIGINT (Ctrl+C)", {
  trigger: async (pid) => {
    process.kill(pid, "SIGINT");
  },
});

await scenario("S4 SIGHUP (터미널 종료 → 무시되어야 한다)", {
  expectAlive: true,
  trigger: async (pid) => {
    process.kill(pid, "SIGHUP");
  },
});

await scenario("S1 창 X 클릭 (window 모드)", {
  trigger: async () => {
    // CDP 로 창을 닫는다. **프로세스 신호가 아니라 창 이벤트** 다 — 다른 경로다.
    const list = await (await fetch("http://127.0.0.1:9222/json/list").catch(() => ({ json: async () => [] }))).json();
    const page = list.find?.((t) => t.type === "page" && (t.url ?? "").includes("7317"));
    if (!page) {
      record("S1: 창을 찾음", false, "CDP 에 페이지가 없다");
      return;
    }
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    // Page.close 는 창을 닫는다 — SIGTERM 과 다른 경로
    ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
    await new Promise((r) => setTimeout(r, 1200));
    ws.close();
  },
});

await scenario("S5 브라우저 프로세스 종료 (창이 아니라 프로세스)", {
  trigger: async () => {
    const { exec: ex } = await import("node:child_process");
    ex("pkill", ["-f", "chrome.*--app=http://127.0.0.1:7317"], () => undefined);
    // 폴백: CDP 포트(=9222)를 쓰는 모든 chrome
    ex("bash", ["-lc", "for p in $(pgrep -f 'remote-debugging-port=9222'); do kill $p; done"], () => undefined);
  },
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (failed.length) {
  console.error(`\n실패:\n${failed.map((f) => `  - ${f.name}: ${f.detail}`).join("\n")}`);
  process.exit(1);
}
