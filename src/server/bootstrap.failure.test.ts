/**
 * 부팅 실패를 "어느 단계 · 무엇 · 왜 · 다음" 으로 말하는가 (Q-5, 2026-10-04).
 *
 * **실패를 실제로 만든다**: llama-server 를 못 찾는 환경(없는 경로를 주입 · PATH 비움 · 빈 HOME)과 모델 없는 폴더로
 * 부팅하고, 실패 단계마다 원본 한 줄(왜)과 다음 행동이 실제로 채워지는지·로그에 두 줄이 찍히는지 본다.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "./bootstrap.js";
import { describeBootFailure } from "../shared/bootFailure.js";
import type { Hardware } from "../setup/hardware.js";

const MiB = 1024 * 1024;
const hw = {
  cpuCount: 8, ramTotalBytes: 16 * 1024 * MiB, ramAvailableBytes: 8 * 1024 * MiB,
  gpus: [], gpuBackend: "none", hasCudaToolchain: false, canBuildCuda: false, tools: {},
  platform: "linux", arch: "x64", libc: "glibc",
} as unknown as Hardware;

test("llama·모델이 없는 부팅 — 3·4·8 단계가 왜·다음을 말하고 로그에도 두 줄이 찍힌다", async () => {
  const root = await mkdtemp(join(tmpdir(), "hs-bootfail-"));
  const models = join(root, "models");
  await mkdir(models, { recursive: true });
  const lines: string[] = [];
  try {
    const r = await bootstrap({
      projectRoot: root,
      modelsDir: models,
      hardware: hw,
      probe: async () => "free",
      detectServer: async () => null,
      skipLlamaSpawn: true,
      env: { PATH: "", HOME: join(root, "home"), HARNESSIDE_LLAMA_SERVER: join(root, "없는-llama-server") },
      log: (l: string) => lines.push(l),
    } as never);
    const by = (n: number) => r.steps.find((s) => s.n === n)!;
    for (const n of [3, 4, 8]) {
      const f = describeBootFailure(by(n));
      assert.ok(f, `${n}단계가 실패로 보이지 않는다: ${JSON.stringify(by(n))}`);
      assert.notEqual(f!.why, "확인 못 함", `${n}단계의 '왜' 가 비었다`);
      assert.doesNotMatch(f!.next, /확인 못 함/, `${n}단계의 '다음' 이 비었다`);
    }
    // 8단계의 '왜' 는 앞선 원인 단계를 가리킨다 — 지어낸 문장이 아니라 그 단계의 결과다.
    assert.match(describeBootFailure(by(8))!.why, /^3\/12 llama-server 탐색/);
    assert.match(describeBootFailure(by(8))!.next, /포트 \d+/);
    assert.ok(lines.some((l) => l.includes("· 왜:")) && lines.some((l) => l.includes("· 다음:")), `로그에 왜·다음 줄이 없다:\n${lines.join("\n")}`);
    // 성공한 단계는 실패 설명이 없다.
    assert.equal(describeBootFailure(by(1)), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
