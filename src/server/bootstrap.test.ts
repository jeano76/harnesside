/**
 * 부트스트랩 12단계 테스트 (§3.2, §10.2).
 *
 * 이 테스트가 지키는 것:
 * 1. **순서** — 12단계의 번호와 이름이 §3.2 와 같다. 순서가 깨지면 요구 9 가 깨진다.
 * 2. **degrade** — 앞 단계가 실패해도 뒤 단계가 멈추지 않는다(창은 반드시 떠야 한다).
 * 3. **단계 5 → 7 의 인과** — GPU 정책이 VRAM 예산 계산에 반영된다.
 * 4. dry-run 은 부수효과가 없다(스폰·빌드·네트워크를 하지 않는다).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, STEP_NAMES } from "./bootstrap.js";
import type { Hardware } from "../setup/hardware.js";

const MiB = 1024 * 1024;

function fakeHw(over: Partial<Hardware> = {}): Hardware {
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
    arch: "x64" as const,
    libc: "glibc" as const,
    ...over,
  } as Hardware;
}

async function sandbox(): Promise<{ root: string; models: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "harnesside-boot-"));
  const models = join(root, "models");
  await mkdir(models, { recursive: true });
  return { root, models, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const neverProbe = async () => "free" as const;

/** 진짜 서버 탐색은 주입한다. 안 주면 이 테스트가 "이 머신 8080" 을 검사한다. */
const noServer = async () => null;

test("12단계가 §3.2 의 번호·이름과 순서로 나열된다", async () => {
  const s = await sandbox();
  try {
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      dryRun: true,
    });
    assert.equal(r.steps.length, 12);
    assert.deepEqual(
      r.steps.map((x) => x.n),
      Array.from({ length: 12 }, (_, i) => i + 1)
    );
    assert.deepEqual(r.steps.map((x) => x.name), [...STEP_NAMES]);
    // 단계 5 는 GPU 정책, 단계 7 은 llama 기동 — 이 인과가 순서의 이유다.
    assert.match(STEP_NAMES[4], /GPU 정책/);
    assert.match(STEP_NAMES[6], /llama-server 기동/);
  } finally {
    await s.cleanup();
  }
});

test("dry-run 은 아무 부수효과도 만들지 않는다(모델/설정 건드리지 않음)", async () => {
  const s = await sandbox();
  try {
    const before = await bootstrap({ projectRoot: s.root, modelsDir: s.models, dryRun: true });
    assert.equal(before.steps.every((x) => x.detail.includes("dry-run")), true);
    assert.equal(before.llamaReady, false);
  } finally {
    await s.cleanup();
  }
});

test("모델이 없으면 뒤 단계도 멈추지 않는다 — 창은 떠야 한다(degrade)", async () => {
  const s = await sandbox();
  try {
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: neverProbe,
      detectServer: noServer,
      skipLlamaSpawn: true,
    });
    // 12단계가 모두 기록되었다 = 중단되지 않았다
    assert.equal(r.steps.length, 12);
    assert.equal(r.steps[3].ok, false, "모델 없음은 단계 4 의 실패");
    assert.equal(r.llamaReady, false);
    // 그래도 GPU 정책과 포트 계획은 계산된다 — 창이 뜨려면 이게 있어야 한다
    assert.ok(r.gpu, "GPU 정책은 모델이 없어도 결정되어야 한다");
    assert.ok(r.ports, "포트 계획은 모델이 없어도 되어야 한다");
  } finally {
    await s.cleanup();
  }
});

test("설정에 적힌 모델 경로가 최우선이다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.models, "Some-Other-7B-Q4_K_M.gguf"), "x");
    const chosen = join(s.models, "My-Custom-Model.gguf");
    await writeFile(chosen, "x");
    await mkdir(join(s.root, ".harnesside"), { recursive: true });
    await writeFile(join(s.root, ".harnesside", "config.yaml"), `model: ${chosen}\n`);

    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: neverProbe,
      detectServer: noServer,
      skipLlamaSpawn: true,
    });
    assert.equal(r.model?.path, chosen);
    assert.equal(r.model?.via, "config");
    assert.ok(r.steps[3].ok);
  } finally {
    await s.cleanup();
  }
});

test("설정에 없으면 Ornith 계열이 점수와 무관하게 1순위다(§7.2)", async () => {
  const s = await sandbox();
  try {
    // 다른 계열이 더 크고 더 많이 있어도 Ornith 가 이긴다
    await writeFile(join(s.models, "Llama-70B-Q4_K_M.gguf"), "x".repeat(10));
    await writeFile(join(s.models, "Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "x");
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: neverProbe,
      detectServer: noServer,
      skipLlamaSpawn: true,
    });
    assert.equal(r.model?.via, "priority-series");
    assert.ok(r.model?.path?.includes("Ornith"), `선택됨: ${r.model?.path}`);
  } finally {
    await s.cleanup();
  }
});

test("카드에 여유가 없으면 브라우저 GPU 가 off 이고 예약은 0", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.models, "Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "x".repeat(20 * 1024 * 1024));
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(), // free 285 MiB
      probe: neverProbe,
      detectServer: noServer,
      skipLlamaSpawn: true,
    });
    assert.equal(r.gpu?.mode, "off");
    assert.equal(r.gpu?.reserveMiB, 0);
    assert.ok(r.steps[4].detail.includes("모드 off"), r.steps[4].detail);
  } finally {
    await s.cleanup();
  }
});

test("단계 5(예약 0)는 단계 7 의 튜닝 계산에 반영된다 — 700 MiB 를 빼앗지 않는다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.models, "Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "x".repeat(20 * 1024 * 1024));
    // **llama 바이너리를 주입해야 한다.** 단계 [7] 은 `result.llama` 이 있을 때만
    // tuning 을 계산하는데, 그 값은 `findLlamaServer` 가 **실제 머신**에서 찾는다.
    // 이 머신엔 llama.cpp 가 빌드되어 있어 통과했고, 러너엔 없어서 tuning 이
    // `undefined` 가 되었다 — **머신을 테스트한 것** 이었다(CI 에서 처음 드러남).
    // `HARNESSIDE_LLAMA_SERVER` 는 그 탐색이 실제로 우선순위를 주는 변수다.
    const fakeLlama = join(s.root, "fake-llama-server");
    await writeFile(fakeLlama, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: neverProbe,
      detectServer: noServer,
      env: { ...process.env, HARNESSIDE_LLAMA_SERVER: fakeLlama },
      skipLlamaSpawn: true,
    });
    // 튜닝이 없으면 검증할 것이 없다. `?.` 로 조용히 undefined 가 되는 대신
    // **없으면 실패** 로 만들어, "왜 없었나" 를 볼 수 있게 한다.
    assert.ok(r.tuning, `튜닝이 없습니다 (단계: ${r.steps.map((s) => `${s.n}:${s.ok ? "ok" : "fail"}`).join(" ")})`);
    // off 모드이므로 "브라우저 VRAM 예약을 제외했다" 는 rationale 이 없어야 한다.
    // 있으면 브라우저 예산 0 인데도 빼앗는 계산 버그다.
    const leaked = r.tuning.rationale.some((x) => x.includes("브라우저 VRAM 예약"));
    assert.equal(leaked, false, r.tuning.rationale.join(" | "));
  } finally {
    await s.cleanup();
  }
});

test("IDE 포트와 llama 포트가 겹치지 않는다(부록 A)", async () => {
  const s = await sandbox();
  try {
    const taken = new Set<number>();
    const probe = async (p: number) => (taken.has(p) ? ("in-use" as const) : ("free" as const));
    taken.add(7317);
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe,
      detectServer: noServer,
      skipLlamaSpawn: true,
    });
    assert.ok(r.ports);
    assert.notEqual(r.ports!.llamaPort, r.ports!.idePort);
    assert.ok(r.ports!.moved.some((m) => m.what === "ide"), "충돌을 숨기지 않고 기록해야 한다");
  } finally {
    await s.cleanup();
  }
});

test("아직 구현되지 않은 단계는 '지났습니다'고 말하지 않는다", async () => {
  const s = await sandbox();
  try {
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: neverProbe,
      detectServer: noServer,
      skipLlamaSpawn: true,
    });
    const tail = r.steps.filter((x) => x.n >= 9);
    assert.equal(tail.length, 4);
    for (const st of tail) {
      assert.equal(st.pending, true, `${st.n} 단계가 pending 이어야 한다`);
      assert.equal(st.ok, false);
    }
  } finally {
    await s.cleanup();
  }
});

test("모든 단계에 소요 시간이 기록된다(느린 단계를 찾는 유일한 방법)", async () => {
  const s = await sandbox();
  try {
    const r = await bootstrap({
      projectRoot: s.root,
      modelsDir: s.models,
      hardware: fakeHw(),
      probe: neverProbe,
      detectServer: noServer,
      skipLlamaSpawn: true,
    });
    for (const st of r.steps) {
      assert.equal(typeof st.tookSeconds, "number", `${st.n} 단계`);
      assert.ok(st.tookSeconds >= 0);
    }
  } finally {
    await s.cleanup();
  }
});
