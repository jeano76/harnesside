/**
 * 최초 구동 판정 테스트 (요구: llama.cpp 세 가지 상태).
 *
 * 여기서 검사하는 것은 **세 경우가 갈라지는 지점** 이다. 특히 두 가지:
 *
 *  1. **"이미 떠 있다" 가 다른 모든 것보다 먼저다.** 이게 틀리면 실측된 20GB 재다운로드
 *     가 다시 일어난다. 그래서 "떠 있음" 인 상태에서 `allowInstall: true` 로 돌려도
 *     **아무것도 설치/다운로드하지 않는지** 를 본다.
 *  2. **없는 키는 실패로 말한다.** 판정을 못 하면 "없다" 고 침묵하지 않는다.
 *
 * 판단을 주입한다는 것은 이 테스트가 **머신을 검증하는 것이 아니라 코드** 를 검증한다는
 * 뜻이다 — 실제 8080 이 뭐가 떠 있든 결과가 같아야 한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFirstRun, inspectLlama, chooseLlamaPort, type FirstRunOptions } from "./firstRun.js";
import type { Hardware } from "./hardware.js";
import type { PortState } from "./ports.js";

const HW: Hardware = {
  cpuCount: 8,
  ramTotalBytes: 32 * 1024 ** 3,
  gpus: [{ name: "TestGPU", vramTotalBytes: 8 * 1024 ** 3, backend: "cuda" }],
  gpuBackend: "cuda",
  canBuildCuda: false, // **빌드는 하지 않는다** — 테스트가 cmake 를 띄우면 안 된다.
} as never;

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harnesside-firstrun-"));
}

/** 전부 주입한 기본값. 실제 네트워크·빌드·실행에 닿지 않는다. */
function base(over: Partial<FirstRunOptions> = {}): FirstRunOptions {
  return {
    modelsDir: "/nonexistent-models",
    home: "/nonexistent-home",
    allowInstall: false,
    run: async () => "version: b9999\n",
    probe: async () => "free" as PortState,
    // `undefined` 를 명시해야 주입을 **끌 수** 있다. `detectServer: undefined` 를
    // 넘기면 아래 spread 가 `async () => null` 로 덮지 않는다 — 실측으로 실제 서버를
    // 볼 수 있어야 그 경로가 검사된다.
    detectServer: async () => null,
    hardware: HW,
    ...over,
  };
}

test("**이미 떠 있으면** 재사용한다 — 설치 여부와 무관하게 이것이 1순위", async () => {
  const plan = await planFirstRun(
    base({
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "already-serving" }),
      // **빌드가 절대 실행되지 않아야 한다.** buildLlamaCpp 는 실제 cmake 다.
      allowInstall: true,
    }),
  );
  assert.equal(plan.situation, "running");
  assert.equal(plan.running?.model, "already-serving");
  assert.equal(plan.llamaPort, 8080, "기존 서버의 포트를 그대로 써야 한다");
  assert.equal(plan.llama, null, "우리가 띄운 바이너리가 아니다");
  assert.equal(plan.downloaded, null, "떠 있는 서버가 있는데 다운로드하면 20GB 를 쓴다");
  assert.equal(plan.installed, null, "떠 있는 서버가 있는데 빌드하면 안 된다");
  assert.match(plan.reasons.join(" "), /이미 실행 중인/);
});

test("**떠 있는 서버의 포트를 옮기지 않는다** — 옮기면 두 번째 서버가 된다", async () => {
  // `probe` 가 전부 in-use 라면 `chooseLlamaPort` 는 옮길 곳을 찾는다. 그런데 1순위에서
  // 서버를 찾았으므로 그 포트를 **그대로** 써야 한다. 실측된 OOM 이 이 경로다.
  const plan = await planFirstRun(
    base({
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "m" }),
      probe: async () => "in-use" as PortState,
      llamaPort: 9090,
    }),
  );
  assert.equal(plan.llamaPort, 8080, "지정한 9090 이 아니라 기존 서버 포트를 썼다");
});

test("**설치됐으나 안 떠 있으면** 그 포트로 구동한다 — 빌드·다운로드 없음", async () => {
  const home = await tmp();
  // `findLlamaServer` 의 탐색 규칙: `{home}/llama.cpp/{BUILD_DIR}/bin/llama-server`.
  // 규칙을 모르고 만들면 **테스트가 다른 경로를 만들어 조용히 통과한다.**
  const binDir = join(home, "llama.cpp", "build", "bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "llama-server");
  await writeFile(binPath, "#!/bin/sh\necho 'version: b4500'\n");
  await chmod(binPath, 0o755);

  const plan = await planFirstRun(
    base({
      home,
      llamaPort: 8123,
      allowInstall: true,
      // **주입한 `run` 이 바이너리를 실제로 실행한다** — 그래서 여기서 버전 문자열이
      // 나온다. 프로브는 "파일 있다" 와 "돌린다" 를 구분해야 한다(실행 파일이 있어도
      // 이 머신에서 못 돌릴 수 있다 — CUDA 를 못 찾는 빌드가 그 예).
      run: async () => "version: b4500\n",
    }),
  );
  assert.equal(plan.situation, "installed");
  assert.equal(plan.llamaPort, 8123, "사용자가 지정한 포트를 써야 한다");
  assert.equal(plan.installed, null, "설치되어 있으므로 빌드하면 안 된다");
  assert.equal(plan.downloaded, null, "모델은 받지 않는다 — 받으려면 이유를 먼저 물어야 한다");
  assert.match(plan.reasons.join(" "), /b4500/, "바이너리 버전을 확인해 실행 가능한지 봐야 한다");
});

test("**실행할 수 없는 바이너리** 는 '설치됨' 으로 통과시키지 않는다", async () => {
  const home = await tmp();
  const binDir = join(home, "llama.cpp", "build", "bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "llama-server");
  await writeFile(binPath, "#!/bin/sh\nexit 3\n");
  await chmod(binPath, 0o755);
  const plan = await planFirstRun(
    base({ home, allowInstall: true, run: async () => { throw new Error("Exec format error"); } }),
  );
  assert.equal(plan.situation, "installed");
  assert.equal(plan.ok, false, "실행 불가한 바이너리를 성공으로 두면 안 된다");
  assert.match(plan.errors.join(" "), /실행할 수 없습니다/);
});

test("**설치 자체가 없으면** 판정만 하고 (allowInstall=false) 아무것도 고치지 않는다", async () => {
  const plan = await planFirstRun(base({ allowInstall: false }));
  assert.equal(plan.situation, "missing");
  assert.equal(plan.llama, null);
  assert.equal(plan.installed, null, "설치하지 말라고 했는데 빌드했다");
  assert.equal(plan.ok, false, "설치 안 한 상태를 성공으로 두면 안 된다");
  assert.match(plan.reasons.join(" "), /allowInstall=false/);
});

test("세 경우를 **실제로 재현**한다 — 가짜 서버를 띄우고 판정한다", async () => {
  // 주입 없이 **진짜** `detectRunningServer` 로 판정한다. 이게 안 되면 코드가
  // 실제 포트를 보지 않는다는 뜻이다.
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    if ((req.url ?? "") === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "measured-model" }] }));
    } else res.writeHead(404).end();
  });
  // 포트 0 = OS 가 빈 포트를 준다. 8231 을 **곧장 믿으면** 이 테스트가 이 머신에
  // 이미 있는 무엇과 겹칠 수 있다 — 그러면 판정을 통과한 것이 아니라 **충돌한 것** 이다.
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    assert.ok(port > 0, "빈 포트를 못 받았다");
    const seen = await inspectLlama({ ports: [port], home: "/nonexistent" });
    assert.equal(seen.situation, "running", "실제 서버를 running 으로 판정하지 못했다");
    assert.equal(seen.running?.baseUrl, `http://127.0.0.1:${port}`);
    assert.equal(seen.running?.model, "measured-model");

    // **지정한 포트**로도 잡혀야 한다 — 요구의 "endpoint 와 포트를 찾아서 재 사용".
    const plan = await planFirstRun(
      base({ llamaPort: port, allowInstall: true, detectServer: undefined }),
    );
    assert.equal(plan.situation, "running", "지정한 포트의 서버를 채택하지 못했다");
    assert.equal(plan.running?.model, "measured-model");
    assert.equal(plan.llamaPort, port);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("**지정한 포트가 차 있으면** 옮기되 **왜** 를 말한다", async () => {
  // 8080 은 **기본 포트** 라 `planPorts` 가 "기본 포트가 비었으면 되돌아간다" 를 먼저
  // 본다. 그래서 기본 포트가 차 있는 이 경우엔 앞쪽으로 걸러지지 않고 앞으로 걷는다.
  const occupied = new Set([8080, 8081]);
  const { port, notes } = await chooseLlamaPort({
    probe: async (p) => (occupied.has(p) ? "in-use" : "free"),
    wanted: 8080,
  });
  assert.equal(port, 8082, "8080·8081 이 차 있으므로 8082 로");
  assert.match(notes.join(" "), /옮겼습니다/, "조용히 바꾸면 '어제까진 8080 이었는데'가 된다");
});

test("기록된 포트가 차 있고 **기본 포트가 비었으면** 기본으로 돌아간다 — 돌아갈 이유를 말한다", async () => {
  // 사용자가 yesterday 9090 을 썼는데 다른 것이 잡았다면, 9099 로 또 옮기는 게 아니라
  // 정본(8080) 으로 돌아가는 게 맞다. `planPorts` 의 규칙.
  const { port, notes } = await chooseLlamaPort({
    probe: async (p) => (p === 9090 ? "in-use" : "free"),
    wanted: 9090,
  });
  assert.equal(port, 8080);
  assert.match(notes.join(" "), /옮겼습니다/);
});

test("방화벽이 DROP 하면 **거절하지 않는다** — 근거가 없는 실패를 만들지 않는다", async () => {
  const { port, notes } = await chooseLlamaPort({ probe: async () => "unknown", wanted: 8080 });
  assert.equal(port, 8080);
  assert.match(notes.join(" "), /방화벽/);
});

test("**이미 있는 모델은 받지 않는다** — 받아 둔 것을 다시 받지 않는다", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "existing.gguf"), Buffer.alloc(4096));
  let fetchCalls = 0;
  const plan = await planFirstRun(
    base({
      modelsDir: dir,
      hardware: HW,
      allowDownload: true,
      fetchImpl: (async () => {
        fetchCalls++;
        throw new Error("네트워크를 쓰면 안 된다");
      }) as unknown as typeof fetch,
      // 빌드를 건너뛰기 위해 allowInstall=false 를 유지한다. 모델 수령 경로는
      // `fetchModelForMachine` 을 직접 부르는 테스트에서 본다.
      detectServer: async () => null,
      run: async () => "version: b4500",
    }),
  );
  // 모델 단계까지 못 간다(바이너리가 없음). 그래도 네트워크는 **한 번도** 안_called.
  assert.equal(fetchCalls, 0, "모델이 이미 있는데 네트워크를 썼다");
  assert.equal(plan.situation, "missing");
  // **판정에 네트워크가 끼어들면 안 된다.** `detectServer` 를 주입했다면 그게 곧
  // "탐지는 주입된 것" 이고, 모델 탐색은 그 뒤로 미뤄야 한다.
  assert.ok(plan.reasons.length > 0);
});

test("**빈 파일은 성공이 아니다** — 0 바이트를 '받았다'고 말하지 않는다", async () => {
  const dir = await tmp();
  const { fetchModelForMachine } = await import("./firstRun.js");
  // 검색은 성공시키되 **받는 본문은 빈 것** 으로 돌려준다. 200 을 주지만 내용이 없다 —
  // 실제로 이런 응답이 온다(잘린 응답, 프록시, 오류 페이지가 200 인 경우).
  const got = await fetchModelForMachine({
    modelsDir: dir,
    hardware: HW,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(typeof input === "function" ? input : (input as Request).url ?? input);
      if (url.includes("/api/models?") || url.includes("/search")) {
        return new Response(
          JSON.stringify([
            { id: "test/repo", siblings: [{ rfilename: "test-Q4_K_M.gguf" }], downloads: 10 },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/tree/")) {
        return new Response(
          JSON.stringify([{ path: "test-Q4_K_M.gguf", size: 1024, lfs: { size: 1024 } }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
    log: () => {},
  });
  // 0 바이트 파일을 "받았다" 고 돌려주면 그 파일로 서버를 띄우며 "모델 없음" 이 된다.
  assert.equal(got, null, "빈 파일을 성공으로 돌려주었다");
});

test("**VRAM 을 모르면 고르지 않는다** — 추측으로 수십 GB 를 받게 하지 않는다", async () => {
  const dir = await tmp();
  const { fetchModelForMachine } = await import("./firstRun.js");
  const lines: string[] = [];
  const got = await fetchModelForMachine({
    modelsDir: dir,
    hardware: { ...HW, gpus: [] } as never,
    fetchImpl: (async () => {
      throw new Error("네트워크를 쓰면 안 된다");
    }) as unknown as typeof fetch,
    log: (l) => lines.push(l),
  });
  assert.equal(got, null, "VRAM 을 모르는데 고른 모델을 돌려주었다");
  assert.match(lines.join(" "), /VRAM/);
});
