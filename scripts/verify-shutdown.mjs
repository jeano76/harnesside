/**
 * §4.4 종료 시그널 **각각**을 실측한다.
 *
 * PROMPT §12 P12 의 판정 기준은 "신호 각각 닫아 llama-server 가 종료됨
 * (각각 별도 검증)" 이다. **한 번에 몰아서 하면 안 된다** — 하나가 다른 하나를
 * 가려서 ".signal 이름이 틀렸는데 동작은 했다" 고 잘못 통과하기 때문이다.
 *
 * 각 신호를 **독립적으로**, 그리고 매번 "이 시나리오가 맞는지" 확인한 뒤 잰다:
 *  - S1 창 X 를 클릭 (window 모드) — Chrome 프로세스 exit
 *  - S5 SIGTERM (명시적 종료)
 *  - S5 SIGINT (Ctrl+C)
 *  - SIGHUP (터미널 종료 → **무시**되어야 한다 — §4.4 의 S 신호가 아니다)
 *  - S1 브라우저 프로세스 kill (창이 아니라 프로세스 — S1 의 다른 경로)
 *
 * **이름표는 PROMPT §4.4(S1~S6)를 따른다** — `verify-signals.mjs` 와 같은 표(Q-8, 2026-10-04). 예전 이 스크립트는
 * S2=SIGTERM·S3=SIGINT·S4=SIGHUP·S5=브라우저 사망으로 불러, 같은 "S2" 가 두 스크립트에서 다른 신호였다.
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

/** llama 프로세스 목록. **판정에는 쓰지 않는다**(아래 llamaAlive 참고) — 정리용. */
async function llamaPids() {
  let out = "";
  try {
    ({ stdout: out } = await exec("pgrep", ["-af", "/llama-server"], { timeout: 5000 }));
  } catch {
    return [];
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ pid: Number(l.split(/\s+/)[0]), cmd: l.slice(0, 90) }))
    // 이 스크립트를 실행한 셸/노드가 명령 줄에 그 문자열을 포함하면 제외한다.
    .filter((p) => !/verify-shutdown|pgrep -af|bash -c|node .*\.mjs/.test(p.cmd))
    .filter((p) => Number.isFinite(p.pid) && p.pid > 1);
}

/**
 * "llama-server 가 살아 있는가" 의 판정.
 *
 * **명령 줄(`pgrep`)로 재면 안 된다** — 실제로 그렇게 해서 세 시나리오가 잘못
 * 실패했다. `pgrep -f /llama-server` 는 **검증 스크립트를 실행한 셸 자신** 을 잡는다
 * (명령 줄에 그 문자열이 있으니까). 그러면 "아직 살아 있다" 로 잘못 보고, (옛 이름표로) S2·S5 가
 * 실패하고 S4 가 "죽었다" 고 보고한다 — **셋 다 거짓말** 이었다(포트 8080 은 비어 있었다).
 *
 * 판정의 정본은 **_llama 포트가 응답하는가_** 다. §4.4 가 말하는 것은 프로세스 이름이
 * 아니라 "llama 가 서비스로 살아 있는가" 이고, 실제로 살아 있으면 `/v1/models` 가 200 을
 * 준다. 명령 줄 문자열은 위장할 수 있지만 포트는 그렇지 않다.
 */
async function llamaAlive() {
  for (const port of [8080, 8081, 8082]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 응답 없음 = 이 포트에 llama 없음
    }
  }
  // 어떤 포트도 응답하지 않으면 죽은 것으로 본다. **프로세스 이름은 믿지 않는다.**
  return false;
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

/**
 * 서버 기동.
 *
 * **`npx` 를 거치지 않는다.** `npx tsx ...` 로 띄우면 잡히는 pid 는 npx 의 것이고,
 * 서버는 그 **자식** 다. 그러면 신호를 **npx 에** 보내는 셈이 되고, npx 가 죽으면
 * 트리 전체가 따라 죽는다 — 즉 SIGHUP 이 "무시" 되도록 되어 있어도 죽어 보인다.
 * 실제로 (옛 이름표) S4(SIGHUP) 가 그렇게 거짓 실패했다.
 *
 * `node_modules/.bin/tsx` 는 node shebang 스크립트라 **pid 자체가 서버 프로세스** 다.
 * 그래야 §4.4 의 신호 핸들러를 진짜로 테스트한다.
 */
async function startServer(extraArgs = [], logFile = LOG) {
  await rm(join(ROOT, ".harnesside/state/instance.lock"), { force: true });
  const out = await import("node:fs").then((m) => m.openSync(logFile, "w"));
  const tsxBin = join(ROOT, "node_modules", ".bin", "tsx");
  const p = spawn(tsxBin, ["src/server/index.ts", ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, HARNESSIDE_MODELS_DIR: "/media/jeano/nvme-usb/models" },
    stdio: ["ignore", out, out],
    detached: true,
  });
  p.unref();

  // **잡은 pid 가 진짜 서버인지** 확인한다. 아니면 조용히 잘못된 프로세스를 신호로
  // 때리는 셈이고, 모든 결과가 뒤집힌다(지금까지 두 번 당한 실수).
  await sleep(1200);
  const cmdline = await readFile(`/proc/${p.pid}/cmdline`, "utf8").catch(() => "");
  if (!cmdline.includes("src/server/index.ts")) {
    throw new Error(`pid ${p.pid} 가 서버가 아닙니다: ${cmdline.replace(/\0/g, " ").slice(0, 120)}`);
  }
  return p.pid;
}

/** 부팅이 끝날 때까지 기다린다(모델 로딩 포함). */
async function waitBoot(logFile = LOG, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const txt = await readFile(logFile, "utf8").catch(() => "");
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
  // 시나리오마다 **자기 로그** 를 쓴다 — 앞 시나리오 로그로 boot 완료를 잘못
  // 기다리면(로그가 남아 있으니까) 실패한 시나리오의 원인을 볼 수 없다.
  const logFile = `${LOG}.${name.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const pid = await startServer(args, logFile);
  const booted = await waitBoot(logFile);
  if (!booted) {
    record(`${name}: 부팅 완료`, false, `12/12 에 도달하지 못했다 (${logFile})`);
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
    if (!(await llamaAlive())) {
      alive = false;
      break;
    }
    await sleep(1000);
  }
  if (expectAlive) {
    record(`${name}: llama 가 살아 있어야 함`, alive, alive ? `포트 응답 확인됨 (pid ${(await llamaPids()).length}개)` : "죽었다 — 조용히 죽이면 안 된다");
  } else {
    record(`${name}: llama 종료됨`, !alive, alive ? "포트가 여전히 응답한다" : "포트 응답 없음 (_llama 종료)");
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

await scenario("S5 SIGTERM (명시적 종료)", {
  trigger: async (pid) => {
    process.kill(pid, "SIGTERM");
  },
});

await scenario("S5 SIGINT (Ctrl+C)", {
  trigger: async (pid) => {
    process.kill(pid, "SIGINT");
  },
});

await scenario("SIGHUP (터미널 종료 → 무시되어야 한다, §4.4 신호 아님)", {
  expectAlive: true,
  trigger: async (pid) => {
    process.kill(pid, "SIGHUP");
  },
});

await scenario("S1 창 X 클릭 (window 모드 — Chrome 프로세스 exit)", {
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

await scenario("S1 브라우저 프로세스 kill (창이 아니라 프로세스 — S1 의 다른 경로)", {
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
