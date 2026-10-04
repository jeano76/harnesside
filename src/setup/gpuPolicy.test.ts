/**
 * gpuPolicy 유닛 테스트 (§10.2).
 *
 * 경계값을 실제로 검증한다. 이 함수가 틀리면 사용자는 "IDE 가 열리면 모델이 죽는다"를
 * 그대로 겪는다(측정된 실패) — 그래서 추정으로 통과시키지 않는다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decideGpuMode,
  browserVramBudgetMiB,
  formatReserve,
  OFF_RESERVE_MIB,
} from "./gpuPolicy.js";
import type { Hardware } from "./hardware.js";

const MiB = 1024 * 1024;

function hw(opts: {
  totalMiB?: number;
  freeMiB?: number;
  noGpu?: boolean;
  cpuCount?: number;
}): Hardware {
  const total = opts.totalMiB ?? 8192;
  const free = opts.freeMiB ?? total;
  return {
    cpuCount: opts.cpuCount ?? 12,
    ramTotalBytes: 32 * 1024 * MiB,
    ramAvailableBytes: 16 * 1024 * MiB,
    gpus: opts.noGpu
      ? []
      : [{ index: 0, name: "Test GPU", vramTotalBytes: total * MiB, vramFreeBytes: free * MiB }],
    gpuBackend: opts.noGpu ? "none" : "cuda",
    hasCudaToolchain: !opts.noGpu,
    canBuildCuda: !opts.noGpu,
    tools: { cmake: true, make: true, gcc: true, nvcc: !opts.noGpu },
    platform: "linux",
    arch: "x64",
    libc: "glibc",
  } as Hardware;
}

test("GPU 없으면 full — 모델도 CPU 전용이라 정책이 불필요하다", () => {
  const d = decideGpuMode(hw({ noGpu: true }));
  assert.equal(d.mode, "full");
  assert.ok(d.rationale.join(" ").includes("GPU 가 없"));
});

test("개발 머신 실측 상태(8192 총 / 285 free / 22 GB 모델)는 off", () => {
  // 이 숫자는 2026-09-29 실제 측정값이다. 어긋나면 재측정하고 문서를 고친다.
  const d = decideGpuMode(hw({ totalMiB: 8192, freeMiB: 285 }), { modelBytes: 21_864_081_056 });
  assert.equal(d.mode, "off");
  assert.equal(d.reserveMiB, OFF_RESERVE_MIB);
  assert.equal(d.measured.vramFreeMiB, 285);
  assert.ok(d.rationale.some((r) => r.includes("+10 MiB")), "측정 근거가 rationale 에 있어야 한다");
});

test("off 모드에서 브라우저 예약은 0 — 700 MiB 를 모델에 돌려줘야 한다", () => {
  const d = decideGpuMode(hw({ totalMiB: 8192, freeMiB: 500 }), { modelBytes: 4 * 1024 * MiB });
  assert.equal(d.mode, "off");
  assert.equal(d.reserveMiB, 0);
  assert.equal(formatReserve(d.reserveMiB), "예약 없음 (0 MiB)");
});

test("여유가 1.5 GiB 이상이면 budgeted", () => {
  // 24576 총 / 20480 free / 4 GiB 모델 → 여유 16384 MiB ≥ 1536
  const d = decideGpuMode(hw({ totalMiB: 24576, freeMiB: 20480 }), { modelBytes: 4 * 1024 * MiB });
  assert.equal(d.mode, "budgeted");
  assert.ok(d.reserveMiB > 0);
});

test("여유가 경계값(1536 MiB)보다 1 MiB 적으면 off 으로 내려간다", () => {
  const model = 4 * 1024 * MiB;
  const free = Math.floor(model / MiB) + 1536;
  assert.equal(decideGpuMode(hw({ totalMiB: 24576, freeMiB: free }), { modelBytes: model }).mode, "budgeted");
  const justUnder = decideGpuMode(hw({ totalMiB: 24576, freeMiB: free - 1 }), { modelBytes: model });
  assert.equal(justUnder.mode, "off");
  assert.equal(justUnder.measured.headroomMiB - 1, justUnder.measured.headroomMiB - 1);
  assert.ok(justUnder.rationale.join(" ").includes("여유가 없습니다"));
});

test("사용자 지정이 판정을 이긴다", () => {
  const d = decideGpuMode(hw({ totalMiB: 8192, freeMiB: 100 }), { modelBytes: 20 * 1024 * MiB, forced: "full" });
  assert.equal(d.mode, "full");
  assert.ok(d.rationale[0].includes("지정된"));
});

test("예약 표는 §4.6 과 같은 구간값을 쓴다", () => {
  assert.equal(browserVramBudgetMiB(4096, "off"), 0);
  assert.equal(browserVramBudgetMiB(4096, "budgeted"), 1200);
  assert.equal(browserVramBudgetMiB(8192, "budgeted"), 700);
  assert.equal(browserVramBudgetMiB(12288, "budgeted"), 400);
  assert.equal(browserVramBudgetMiB(24576, "budgeted"), 250);
  // 모드와 무관하게 off 는 언제나 0
  for (const v of [1024, 6144, 10240, 16384, 32768]) {
    assert.equal(browserVramBudgetMiB(v, "off"), 0, `total=${v}`);
  }
});

test("VRAM 0 / NaN 류의 이상 입력에서도 폭발하지 않는다", () => {
  const zero = decideGpuMode(hw({ totalMiB: 0, freeMiB: 0 }), { modelBytes: 0 });
  assert.ok(["off", "budgeted", "full"].includes(zero.mode));
  assert.ok(Number.isFinite(zero.reserveMiB));
  const huge = decideGpuMode(hw({ totalMiB: 8192, freeMiB: 8192 }), { modelBytes: 10_000 * 1024 * MiB });
  assert.equal(huge.mode, "off", "모델이 카드보다 커도 budgeted 로 올리면 안 된다");
});

test("rationale 은 비어 있지 않다 — 근거 없는 결정은 사용자에게 설명할 수 없다", () => {
  for (const d of [
    decideGpuMode(hw({ noGpu: true })),
    decideGpuMode(hw({ totalMiB: 8192, freeMiB: 285 }), { modelBytes: 21_864_081_056 }),
    decideGpuMode(hw({ totalMiB: 24576, freeMiB: 20480 }), { modelBytes: 4 * 1024 * MiB }),
  ]) {
    assert.ok(d.rationale.length > 0);
    assert.ok(d.rationale.every((r) => r.trim().length > 0));
  }
});
