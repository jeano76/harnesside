/**
 * adopt 경로 테스트 — "이미 떠 있는 llama-server 를 **채택**한다" (§6.2, D8).
 *
 * 왜 이게 제일 중요한 테스트인가: 이 경로는 **한 번도 실행된 적이 없다.**
 * 주석에는 "adopt 한다" 고 적혀 있었고 `tryAdopt()` 도 있었지만, 그 함수가 두드리던
 * 포트는 `planPorts` 가 "**비어 있다고 확인한**" 포트였다. 그래서 답이 나올 수 없었고,
 * 실제로는 8080 에 정상 서버가 있어도 8081 로 옮겨 두 번째 모델을 띄웠다 —
 * 실측된 OOM(`cudaMalloc failed`, 1476 MiB 요청 / 321 MiB 여유) 과 정확히 같은 경로.
 *
 * 그래서 여기서 지키는 것은 세 가지다:
 *  1. **탐지가 포트 계획보다 먼저** 일어난다 (순서가 바뀌면 adopt 는 죽은 코드다).
 *  2. 채택했으면 **포트를 옮기지 않는다** — 옮긴 기록(`moved`)까지 거짓이면 안 된다.
 *  3. 채택했으면 **스폰하지 않는다**, 그리고 **죽이지 않는다**. 우리가 띄운 것만 죽인다.
 *
 * 전부 주입으로 한다. 기본값은 진짜로 127.0.0.1 을 두드리는데, 그대로 쓰면 이 테스트가
 * "개발자 머신의 8080" 을 검증하게 된다(CI 에서 뒤집혔던 버그와 같은 종류).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, type DetectServer } from "./bootstrap.js";
import { COMMON_PORTS, LLAMA_PORT, type PortState } from "../setup/ports.js";
import type { Hardware } from "../setup/hardware.js";

const MiB = 1024 * 1024;

function fakeHw(): Hardware {
  return {
    cpuCount: 12,
    ramTotalBytes: 32 * 1024 * MiB,
    ramAvailableBytes: 16 * 1024 * MiB,
    gpus: [{ index: 0, name: "Test", vramTotalBytes: 8192 * MiB, vramFreeBytes: 285 * MiB }],
    gpuBackend: "cuda",
    hasCudaToolchain: true,
    canBuildCuda: true,
    tools: {},
    platform: "linux",
  } as Hardware;
}

async function sandbox(): Promise<{ root: string; models: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "harnesside-adopt-"));
  const models = join(root, "models");
  await mkdir(models, { recursive: true });
  return { root, models, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 포트 집합에 대해 "이 포트만 사용 중" 이라고 답하는 프로브. */
const busyWith = (...busy: number[]) => async (p: number): Promise<PortState> => (busy.includes(p) ? "in-use" : "free");

test("이미 떠 있는 서버가 있으면 채택하고 **포트를 옮기지 않는다**", async () => {
  const s = await sandbox();
  try {
    // 8080 이 사용 중이다 = 바로 그 포트에 서버가 떠 있다는 뜻이다.
    // 이 프로브가 "in-use" 라고 답하는데도 8080 을 그대로 쓰는 것이 정답이다.
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: busyWith(LLAMA_PORT),
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "Ornith-1.5-35B-A3B-Q3_K_M.gguf" }),
      skipLlamaSpawn: true,
    });

    assert.equal(r.ports?.llamaPort, LLAMA_PORT, "사용 중인 포트를 그대로 쓴다 — 옮기면 두 번째 서버를 띄우게 된다");
    assert.deepEqual(r.ports?.adopted, { port: LLAMA_PORT, model: "Ornith-1.5-35B-A3B-Q3_K_M.gguf" });
    assert.deepEqual(
      r.ports?.moved,
      [],
      "옮기지 않았는데 옮긴 기록이 있으면 그건 거짓이다 — 부팅 로그가 사람을 속인다"
    );
    assert.match(r.steps[5].detail, /채택/, "단계 6 이 왜 이 포트를 썼는지 말해야 한다");
  } finally {
    await s.cleanup();
  }
});

test("탐지 결과의 포트를 그대로 쓴다 — 설정된 포트가 아니어도", async () => {
  const s = await sandbox();
  try {
    // 흔한 포트(11434, Ollama 규약)에만 서버가 있는 경우. 설정값(8080)이 아니어도
    // 그 서버를 쓰는 게 맞다 — 8080 은 비어 있으니까 새로 띄워도 되지만,
    // 이미 떠 있는 게 있으면 그걸 쓴다(§6.2 adopt, never re-spawn).
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: busyWith(11434),
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:11434", model: "llama3" }),
      skipLlamaSpawn: true,
    });
    assert.equal(r.ports?.llamaPort, 11434);
    assert.equal(r.ports?.adopted?.port, 11434);
    assert.deepEqual(r.ports?.moved, []);
  } finally {
    await s.cleanup();
  }
});

test("탐지 순서는 **설정된 포트가 먼저**, 중복은 한 번만", async () => {
  const s = await sandbox();
  try {
    const asked: number[][] = [];
    const record: DetectServer = async (_h, ports) => {
      asked.push([...ports]);
      return null;
    };
    await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: busyWith(),
      detectServer: record,
      skipLlamaSpawn: true,
      ports: { llamaPort: 9000 },
    });
    assert.equal(asked.length, 1, "한 번의 탐색으로 모두 본다 — 같은 포트를 두 번 두드리지 않는다");
    assert.equal(asked[0][0], 9000, "설정된 포트가 1순위");
    assert.deepEqual(asked[0], [9000, ...COMMON_PORTS], "그 다음이 흔한 포트들");
    assert.equal(new Set(asked[0]).size, asked[0].length, "중복 포트가 있으면 '몇 개를 봤나' 를 셀 수 없다");
  } finally {
    await s.cleanup();
  }
});

test("서버가 없으면 기존처럼 포트 계획을 쓴다 — 채택 표시가 남지 않는다", async () => {
  const s = await sandbox();
  try {
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: busyWith(LLAMA_PORT), // 다른 무언가가 붙잡고 있다
      detectServer: async () => null, // OpenAI 호환 응답은 없다
      skipLlamaSpawn: true,
    });
    assert.notEqual(r.ports?.llamaPort, LLAMA_PORT, "돌아가지 않는 포트는 그대로 두지 않는다");
    assert.ok(r.ports?.moved.some((m) => m.what === "llama"), "이동 사실은 기록한다");
    assert.equal(r.ports?.adopted, undefined, "채택하지 않았는데 채택으로 남기면 종료할 때 남의 서버를 죽인다");
  } finally {
    await s.cleanup();
  }
});

test("채택했으면 **스폰하지 않는다** — 모델도 바이너리도 없어도 된다", async () => {
  const s = await sandbox();
  try {
    // 살아 있는 서버가 있는 머신에 .gguf 가 없을 수 있다. 이 경우에 "모델 없음" 으로
    // 보고하면 실제로는 준비된 서버가 있는데 창에는 실패라고 뜬다.
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models, // 비어 있음
      hardware: fakeHw(),
      probe: busyWith(LLAMA_PORT),
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "Ornith" }),
      skipLlamaSpawn: true,
    });
    assert.equal(r.model?.path ?? null, null, "로컬 모델 파일이 없는 것이 사실이다");
    assert.match(r.steps[6].detail, /스폰하지 않음/, "단계 7 이 스폰하지 않았음을 말해야 한다");
    assert.equal(r.tuning, undefined, "띄우지 않을 프로세스의 플래그를 만들어 두면 '이 플래그로 돈다' 고 읽힌다");
    assert.equal(r.llamaReady, true, "이미 응답하는 서버가 있으면 준비된 상태다");
    assert.equal(r.steps[7].ok, true);
  } finally {
    await s.cleanup();
  }
});

test("채택 여부는 **주입이 없다면 진짜로 찾는다** — 기본값이 빈 구현이 아니다", async () => {
  // 반대로 "기본값이 아무것도 안 하는 함수" 였다면 이 경로가 조용히 죽는다.
  // 규칙이 있는데 아무도 안 쓰면 없는 것보다 나쁘다(§④ 버그 28).
  const s = await sandbox();
  try {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./bootstrap.ts", import.meta.url), "utf8")
    );
    assert.match(src, /opts\.detectServer \?\? defaultDetectRunningServer/, "주입이 없으면 진짜 탐지기를 써야 한다");
    assert.match(src, /const defaultDetectRunningServer: DetectServer = \(host, ports\) => detectRunningServer\(host, ports\)/);
  } finally {
    await s.cleanup();
  }
});

test("IDE 포트는 채택한 llama 포트와 겹치지 않는다", async () => {
  const s = await sandbox();
  try {
    // 채택 경로에서 planPorts 는 llama 프로브를 건너뛴다. 그 때문에 IDE 쪽 예약
    // (firstFree 의 `reserved`) 이 실수로 빠지지 않았는지 본다.
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: busyWith(7317), // IDE 포트만 사용 중
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "Ornith" }),
      skipLlamaSpawn: true,
    });
    assert.equal(r.ports?.llamaPort, 8080);
    assert.notEqual(r.ports?.idePort, 8080, "모델 서버에 브라우저 포트를 주면 안 된다");
    assert.ok(r.ports?.moved.some((m) => m.what === "ide"), "IDE 포트 이동은 기록한다");
  } finally {
    await s.cleanup();
  }
});

test("모델 파일이 있어도 채택이 우선한다 — 8GiB 카드에서 두 개는 OOM 이다(실측)", async () => {
  const s = await sandbox();
  try {
    // 로컬에 모델이 있어도 **이미 떠 있는 서버를 채택**한다. 두 번째를 띄우지 않는다.
    // 실제로 이 경로에서 `cudaMalloc failed` 가 났고(1476 MiB 요청 / 321 MiB 여유),
    // 원인은 "모델이 있는데도 두 번째를 띄웠다" 였다.
    await writeFile(join(s.models, "Ornith-1.5-35B-A3B-Q3_K_M.gguf"), "x".repeat(1024));
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      env: { ...process.env, HARNESSIDE_LLAMA_SERVER: "unused-when-adopted" },
      probe: busyWith(LLAMA_PORT),
      detectServer: async () => ({ baseUrl: "http://127.0.0.1:8080", model: "Ornith" }),
      skipLlamaSpawn: true,
    });
    assert.ok(r.model?.path, "모델은 선택된다 — 그래도 스폰은 하지 않는다");
    assert.equal(r.ports?.adopted?.model, "Ornith");
    assert.equal(r.tuning, undefined, "스폰하지 않을 경로에서 스폰용 튜닝을 만들지 않는다");
  } finally {
    await s.cleanup();
  }
});
