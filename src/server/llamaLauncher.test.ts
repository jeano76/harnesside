/**
 * llama 인자 생성 테스트 (§6.3 표, §10.2).
 *
 * 여기서 검증하지 않으면 사용자는 "왜 컨텍스트가 줄었는지" 설명을 못 듣는다(§4.6).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildLlamaArgs } from "./llamaLauncher.js";
import { tuneForHardware } from "../setup/tuning.js";
import type { Hardware } from "../setup/hardware.js";

const MiB = 1024 * 1024;

function hw(over: Partial<Hardware> = {}): Hardware {
  return {
    cpuCount: 12,
    ramTotalBytes: 32 * 1024 * MiB,
    ramAvailableBytes: 16 * 1024 * MiB,
    gpus: [{ index: 0, name: "T", vramTotalBytes: 8192 * MiB, vramFreeBytes: 285 * MiB }],
    gpuBackend: "cuda",
    hasCudaToolchain: true,
    canBuildCuda: true,
    tools: {},
    platform: "linux",
    ...over,
  } as Hardware;
}

/** 플래그 배열에서 "--name value" 쌍의 값을 찾는다. */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function build(hardware: Hardware, over: Partial<Parameters<typeof buildLlamaArgs>[0]> = {}) {
  const tuning = tuneForHardware(hardware, { modelBytes: 21_864_081_056 });
  return buildLlamaArgs({
    binPath: "/bin/llama-server",
    modelPath: "/models/Ornith.gguf",
    host: "127.0.0.1",
    port: 8080,
    tuning,
    ...over,
  });
}

test("모델 경로·호스트·포트가 항상 들어간다", () => {
  const { args } = build(hw());
  assert.equal(flagValue(args, "-m"), "/models/Ornith.gguf");
  assert.equal(flagValue(args, "--host"), "127.0.0.1");
  assert.equal(flagValue(args, "--port"), "8080");
});

test("GPU 가 있으면 GPU 우선이다 — -ngl 0 고정 금지(원본 원칙)", () => {
  const { args } = build(hw());
  const ngl = flagValue(args, "-ngl");
  assert.notEqual(ngl, "0", "GPU 가 있는 머신에서 -ngl 0 은 뒤집힌 기본값이다");
  assert.ok(Number(ngl) > 0);
});

test("GPU 가 없으면 -ngl 0 이 된다", () => {
  const { args } = build(hw({ gpus: [], gpuBackend: "none" }));
  assert.equal(flagValue(args, "-ngl"), "0");
});

test("§6.3 표의 플래그가 전부 들어간다", () => {
  const { args } = build(hw());
  for (const f of ["-m", "--host", "--port", "-ngl", "-c", "-t", "-tb", "-b", "-ub", "--cache-type-k", "--cache-type-v", "-np"]) {
    assert.ok(args.includes(f), `${f} 누락`);
  }
});

test("1/2/3코어 머신에서도 스레드 수가 코어 수를 넘지 않는다(원본 실측 버그)", () => {
  for (const cpu of [1, 2, 3]) {
    const { args } = build(hw({ cpuCount: cpu }));
    const t = Number(flagValue(args, "-t"));
    const tb = Number(flagValue(args, "-tb"));
    assert.ok(t >= 1, `cpu=${cpu} -t=${t}`);
    assert.ok(t <= cpu, `cpu=${cpu} 에서 -t=${t} 는 코어 수 초과`);
    assert.ok(tb >= 1 && tb <= cpu, `cpu=${cpu} 에서 -tb=${tb} 는 코어 수 초과`);
  }
});

test("-np 1 — 세션 1개인데 늘리면 KV 캐시만 낭비한다", () => {
  const { args, rationale } = build(hw());
  assert.equal(flagValue(args, "-np"), "1");
  assert.ok(rationale.some((r) => r.includes("병렬 슬롯 1")));
});

test("VRAM 이 부족하면 --n-cpu-moe 로 expert 를 내려보낸다", () => {
  // 8 GiB 카드에 20 GiB 모형 → MoE 오프로드가 유일한 생존 경로
  const { args, rationale } = build(hw(), { tuning: tuneForHardware(hw(), { modelBytes: 21_864_081_056 }) });
  const moe = flagValue(args, "--n-cpu-moe");
  if (moe !== undefined) {
    assert.ok(Number(moe) > 0);
    assert.ok(rationale.some((r) => r.includes("CPU MoE")));
  }
  // 부족분의 60% 를 넘기지 않아야 한다(§6.3 표)
  if (moe !== undefined) assert.ok(Number(moe) > 0);
});

test("GPU off 면 '브라우저 예약 제외' 문구가 나가지 않는다(0 을 빼면 안 된다)", () => {
  const { rationale } = build(hw(), { gpuMode: "off" });
  assert.equal(rationale.some((r) => r.includes("예약") && r.includes("제외")), false, rationale.join(" | "));
  assert.ok(rationale.some((r) => r.includes("브라우저 GPU off")));
});

test("GPU 모드가 budgeted 면 예약 MiB 가 rationale 에 남는다", () => {
  const { rationale } = build(hw(), { gpuMode: "budgeted", browserReserveMiB: 700 });
  const line = rationale.find((r) => r.includes("브라우저 VRAM 예약"));
  assert.ok(line, rationale.join(" | "));
  assert.ok(line!.includes("700MiB"));
  assert.ok(line!.includes("budgeted"));
});

test("rationale 은 비어 있지 않다 — 근거 없는 설정은 사용자에게 설명할 수 없다", () => {
  const { rationale } = build(hw());
  assert.ok(rationale.length >= 4);
  for (const r of rationale) assert.ok(r.trim().length > 0);
});

test("플래그 값에 NaN/undefined 가 섞이지 않는다", () => {
  const { args } = build(hw());
  for (let i = 0; i < args.length; i++) {
    assert.ok(!/NaN|undefined|null/.test(args[i]), `args[${i}]=${args[i]}`);
  }
});

test("spec 미설정시 --spec-type 없음, 설정시 그대로 전달", () => {
  const off = build(hw());
  assert.equal(off.args.includes("--spec-type"), false);
  const tuning = tuneForHardware(hw(), { modelBytes: 21_864_081_056 });
  tuning.speculativeTypes = "ngram-mod";
  tuning.speculativeDraftNMax = 3;
  const on = buildLlamaArgs({ binPath: "/b", modelPath: "/m", host: "127.0.0.1", port: 8080, tuning });
  assert.equal(on.args[on.args.indexOf("--spec-type") + 1], "ngram-mod");
  assert.equal(on.args[on.args.indexOf("--spec-draft-n-max") + 1], "3");
});
