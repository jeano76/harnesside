/**
 * 최초 구동 세 경우 **실측** (요구: llama.cpp 상태에 따른 분기).
 *
 * 유닛 테스트는 주입된 판단으로 돌아간다. 그것으로 충분하지 않은 지점이 하나 있다:
 * **"이미 떠 있는 서버" 판정이 실제 포트와 HTTP 응답으로 성립하는가.** 주입한
 * `detectServer` 로는 그걸 알 수 없다 — 실측이 아니면 채택 경로가 죽은 코드여도
 * 테스트는 통과한다(실제로 그랬다: adopt 경로).
 *
 * 그래서 이 스크립트는 **진짜 HTTP 서버** 를 띄워 세 경우를 실제로 만든다:
 *   1. 서버가 떠 있음  → 재사용(바이너리 설치 여부와 무관)
 *   2. 설치됨 · 미구동 → 그 포트로 구동 안내(빌드·다운로드 없음)
 *   3. 설치 없음      → 판정만 하고 아무것도 바꾸지 않음(allowInstall=false)
 *
 * **실행하지 않는 것**: cmake 빌드와 모델 다운로드. 3번에서 그것을 실제로 하면
 * 몇십 분과 수십 GB 를 쓴다. 그래서 3번은 `allowInstall: false` 로 판정만 확인하고,
 * "설치하면 무엇을 하는가" 는 유닛 테스트가 주입된 `run`/`fetch` 로 검증한다.
 */

import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

// **빌드 산출물을 쓴다.** `src/*.ts` 를 그대로 import 하면 이 스크립트가 타입스크립트
// 로더에 의존하게 되고, 그 로더가 없으면 "코드가 없다" 와 "실행 경로가 없다" 를
// 구분하지 못한다(실제로 그랬다 — 첫 실행이 ERR_MODULE_NOT_FOUND 로 끝났다).
// `npm run build` 가 만든 것을 검증하는 편이 **실제 배포물** 을 검증하는 편이다.
const { inspectLlama, planFirstRun } = await import("../dist/setup/firstRun.js");

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/** OpenAI 호환 `/v1/models` 로 답하는 **진짜** 서버. */
function fakeLlama(model) {
  const srv = createServer((req, res) => {
    if ((req.url ?? "") === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: model }] }));
    } else {
      res.writeHead(404).end();
    }
  });
  return srv;
}

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// ── 1. 이미 떠 있다 ──────────────────────────────────────────────────────────
console.log("\n1) 이미 실행 중인 llama-server");
{
  const srv = fakeLlama("measured-serving-model");
  const port = await listen(srv);
  try {
    // **기본 포트 목록을 실제로 물어야 한다** — 주입으로 건너뛰면 "8080 을 본다" 는
    // 사실 하나를 검증하지 않는다. 2·3번이 이 머신의 8080 때문에 'running' 이 된
    // 것처럼, 판정이 **무엇을 보고 결정했는지** 를 여기서 고정한다.
    const seen = await inspectLlama({ home: homedir(), ports: [port] });
    ok("판정이 'running'", seen.situation === "running", `실제: ${seen.situation}`);
    ok("endpoint 를 찾았다", seen.running?.baseUrl === `http://127.0.0.1:${port}`, seen.running?.baseUrl ?? "없음");
    ok("모델 이름을 읽었다", seen.running?.model === "measured-serving-model", seen.running?.model ?? "없음");

    const plan = await planFirstRun({
      home: homedir(),
      modelsDir: "/tmp/opencode/fr-models",
      llamaPort: port,
      // **allowInstall: true 인데도 아무것도 설치/다운로드하지 않아야 한다.**
      // 이것이 이 요구의 핵심이다 — 순서를 틀리면 20GB 를 쓴다(실측).
      allowInstall: true,
      log: () => {},
    });
    ok("설치·다운로드 없이 끝났다", plan.installed === null && plan.downloaded === null,
      `installed=${JSON.stringify(plan.installed)} downloaded=${JSON.stringify(plan.downloaded)}`);
    ok("기존 포트를 그대로 쓴다", plan.llamaPort === port, `${plan.llamaPort} != ${port}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// ── 2. 설치됨 · 미구동 ───────────────────────────────────────────────────────
console.log("\n2) 설치되어 있으나 구동되지 않음");
{
  const home = mkdtempSync(join(tmpdir(), "harnesside-fr-"));
  // `findLlamaServer` 의 실제 탐색 규칙을 따른다 — 다른 경로를 만들면 조용히 통과한다.
  const binDir = join(home, "llama.cpp", "build", "bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "llama-server");
  writeFileSync(binPath, "#!/bin/sh\necho 'version: measured-b4500'\n");
  chmodSync(binPath, 0o755);
  try {
    // 이 머신에는 8080 에 fake 서버가 떠 있다(개발용). 판정을 격리하려고 탐지를
    // 주입한다 — 그래야 **자기 경우만** 재현한다. 주입하지 않으면 "설치됨" 이 아니라
    // "이 머신에 서버가 있음" 을 검사하게 되고, 그건 어느 경로의 증거도 아니다.
    const plan = await planFirstRun({
      home,
      modelsDir: "/tmp/opencode/fr-models",
      detectServer: async () => null,
      allowInstall: true,
      run: async (f, a) => {
        // 이 파일만 실제로 돌린다. 다른 명령은 **실행하지 않는다**.
        if (f.endsWith("llama-server") && a[0] === "--version") {
          const { execFile } = await import("node:child_process");
          return new Promise((res) => execFile(f, a, (e, so) => res(e ? "" : String(so))));
        }
        throw new Error(`실행하면 안 되는 명령: ${f} ${a.join(" ")}`);
      },
      log: () => {},
    });
    ok("판정이 'installed'", plan.situation === "installed", `실제: ${plan.situation}`);
    // 이 머신의 8080 · 7317 이 차 있으므로 **비어 있는 포트로 옮겨지는 게 맞다.**
    // 지정하지 않으면 기본 포트(8080)를 쓰고, 차 있으므로 앞으로 걷는다.
    ok("사용 가능한 포트를 골랐다", plan.llamaPort > 0 && plan.llamaPort !== 8080, String(plan.llamaPort));
    ok("왜 옮겼는지 말한다", /옮겼습니다/.test(plan.reasons.join(" ")), plan.reasons.join(" | "));
    ok("바이너리를 찾았다", plan.llama?.binPath === binPath, plan.llama?.binPath ?? "없음");
    ok("빌드하지 않았다", plan.installed === null, JSON.stringify(plan.installed));
    ok("모델을 받지 않았다", plan.downloaded === null, JSON.stringify(plan.downloaded));
    ok("바이너리 버전을 확인했다", /measured-b4500/.test(plan.reasons.join(" ")), plan.reasons.join(" | "));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── 3. 설치 자체가 없음 ──────────────────────────────────────────────────────
console.log("\n3) 설치 자체가 없음 (판정만 — 빌드·다운로드 안 함)");
{
  const home = mkdtempSync(join(tmpdir(), "harnesside-fr-empty-"));
  try {
    let ranSomething = false;
    const plan = await planFirstRun({
      home,
      modelsDir: "/tmp/opencode/fr-models",
      allowInstall: false, // **설치하지 않는다** — 판단만 한다
      // 이 머신에 8080 fake 서버가 떠 있으므로, 판정을 격리한다. 주입하지 않으면
      // "설치 없음" 이 아니라 "이 머신에 서버가 있음" 을 검사하게 된다.
      detectServer: async () => null,
      // 환경도 격리한다 — llama-server 탐색은 PATH 와 `$HOME/.config/systemd/user` 유닛까지 본다
      // (Q-1/Q-3 로 합친 강한 판본, 2026-10-04). 실제 환경을 넘기면 이 머신의 설치를 찾아
      // "설치 없음" 이 아니라 "이 머신에 설치가 있음" 을 검사하게 된다(실측: source "systemd").
      env: { PATH: "", HOME: home },
      run: async () => {
        ranSomething = true;
        return "";
      },
      log: () => {},
    });
    ok("판정이 'missing'", plan.situation === "missing", `실제: ${plan.situation}`);
    ok("명령을 하나도 실행하지 않았다", !ranSomething, "allowInstall=false 인데 실행했다");
    ok("성공으로 보고하지 않는다", plan.ok === false);
    ok("설치 방법을 안내한다", /doctor --install/.test(plan.reasons.join(" ")), plan.reasons.join(" | "));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── 4. 주입 없이, 진짜 탐지만으로 ────────────────────────────────────────────
// 2·3번은 이 머신의 8080 fake 서버 때문에 `detectServer` 를 주입해 격리했다.
// 그래서 마지막에 **주입 없이** 다시 한 번 돌려, 판정이 실제로 포트를 보는지 본다.
// 이걸 빼면 "주입이 잘 되어 있다" 만 확인한 것이 된다.
console.log("\n4) 주입 없이 실제 포트로 판정 (탐지 자체를 검증)");
{
  const srv = fakeLlama("uninjected-model");
  const port = await listen(srv);
  try {
    const plan = await planFirstRun({ home: homedir(), modelsDir: "/tmp/opencode/fr-models", llamaPort: port, log: () => {} });
    ok("주입 없이도 running 을 잡는다", plan.situation === "running", `실제: ${plan.situation}`);
    ok("지정한 포트의 서버를 골랐다", plan.running?.baseUrl === `http://127.0.0.1:${port}`, plan.running?.baseUrl ?? "없음");
    ok("아무것도 설치하지 않았다", plan.installed === null && plan.downloaded === null);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

console.log(`\n${fail === 0 ? "모두 통과" : "실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
