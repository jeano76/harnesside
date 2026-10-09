import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashService } from "./slashService.js";

/**
 * `/models <n> confirm` 뒤에 **실측 보정이 돈다** — 그리고 테스트는 진짜 서버를 건드리지 않는다.
 *
 * ── 왜 이 테스트가 존재하는가 ───────────────────────────────────────────────
 * `/server restart` 에 보정을 붙이고 나니 빈틈이 남았다. `/models` 는 **예측값을
 * 계산하고 config 에 기록하는** 명령인데 거긴 보정이 없었다. 즉 급수구는 잠갔고
 * 우회 파이프가 열린 셈이었다. 사용자가 그걸 물어봐서 발견했다.
 *
 * 같은 이유로 `switchServer` 주입이 `/models` 경로에도 걸려야 한다. 처음에는
 * `/server` 쪽만 막아 두고 `switchModelAndServer` 를 직접 불렀다 — 주입은 어느 한쪽에만
 * 걸리고 다른 쪽은 그대로 **개발 박스의 진짜 llama-server 를 잡는다.**
 */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hs-models-"));
  await mkdir(join(root, ".harnesside"), { recursive: true });
  await writeFile(
    join(root, ".harnesside", "config.yaml"),
    JSON.stringify({
      backend: "openai-compatible",
      model: "/m/Ornith-1.5-9B-Q4_K_M.gguf",
      llama: { port: 18998, contextSize: 36864, threads: 6, gpuLayers: 32 },
    })
  );
  return root;
}

/** Runs the slash job to completion and returns the text. */
async function run(root: string, arg: string, opts: { report: unknown; calls: string[]; switchResult?: unknown }) {
  const svc = new SlashService({
    projectRoot: root,
    reportServer: async () => opts.report as never,
    // 준비(빌드·다운로드)도 주입한다 — 안 그러면 존재하지 않는 픽스처 모델을
    // 진짜로 내려받는다(2026-10-09 실측: 5.4 GiB · 2.8 MB/s · 타임아웃).
    // 측정은 없는 파일을 fast-fail 로 읽어 "측정할 수 없어" 로 끝난다.
    provision: async (o) => ({
      ok: true, port: o.port, binPath: "/bin/llama-server",
      modelPath: join(root, "missing-fixture.gguf"), lines: [],
    }),
    switchServer: async (o) => {
      opts.calls.push(`switch:-ngl${o.tuning.gpuLayers}:ctx${o.tuning.contextSize}`);
      return (opts.switchResult ?? {
        ok: true, port: o.port, ready: true, lines: ["새 모델이 응답합니다."],
        launched: { binPath: o.binPath, modelPath: o.modelPath, tuning: o.tuning },
      }) as never;
    },
  });
  const view = svc.start("models", arg);
  for (let i = 0; i < 2400 && !svc.get(view.id)?.done; i++) await new Promise((r) => setTimeout(r, 50));
  return svc.get(view.id)!.text;
}

/** A report for a live, attributable server — the shape the policy allows us to touch. */
const liveReport = {
  port: 18998, portDiscovered: false,
  owner: { kind: "ours", pid: 4242 },
  configuredModel: "/m/Ornith-1.5-9B-Q4_K_M.gguf",
  configuredBin: "/bin/llama-server",
  build: { binPath: "/bin/llama-server", canReadModel: true, rejectedForModel: [] },
  servers: [{ pid: 4242, port: 18998, cmdline: "llama-server -m /m/Ornith-1.5-9B-Q4_K_M.gguf --port 18998 -ngl 32 -c 36864" }],
  serverArgs: { modelPath: "/m/Ornith-1.5-9B-Q4_K_M.gguf", gpuLayers: 32, contextSize: 36864, threads: 6, threadsBatch: 11, cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttn: true },
  summary: "", restartPlan: "",
};

test("after a confirmed model switch, the new server is measured and recalibrated", async () => {
  const root = await project();
  const calls: string[] = [];
  const out = await run(root, "ornith-9b confirm", { report: liveReport, calls });
  assert.match(out, /실측해 최적값을 다시 계산/, "the measurement must be announced, not silent");
  // The fixture's model file does not exist, so the honest outcome is "cannot measure,
  // therefore change nothing" — and NO second restart. A second launch here would mean
  // calibration guessed at a size it never measured.
  assert.match(out, /측정할 수 없어 그대로 둡니다/, "an unmeasurable model must be left alone");
  assert.equal(calls.length, 1, `expected no relaunch without a measurement, got ${JSON.stringify(calls)}`);
});

test("a switch that fails is not followed by a calibration attempt", async () => {
  const root = await project();
  const calls: string[] = [];
  const out = await run(root, "ornith-9b confirm", {
    report: liveReport, calls,
    switchResult: { ok: false, port: 18998, ready: false, lines: ["새 모델로 서버를 띄우지 못했습니다: x"] },
  });
  assert.match(out, /띄우지 못/);
  assert.equal(calls.length, 1, "nothing is measured when there is no server to measure");
  assert.doesNotMatch(out, /실측해 최적값/, "a failed switch has nothing to measure");
});

test("the report the calibration uses is read AFTER the switch, never before", async () => {
  // `/models` does not read a report before the switch, so the ordering is the whole
  // invariant: the report must be obtained once the new server is up. Reading one from
  // before would describe the process the swap just killed, and calibration would
  // "correct" a server nobody is running.
  const root = await project();
  const order: string[] = [];
  const svc = new SlashService({
    projectRoot: root,
    reportServer: async () => {
      order.push("report");
      return liveReport as never;
    },
    provision: async (o) => ({
      ok: true, port: o.port, binPath: "/bin/llama-server",
      modelPath: join(root, "missing-fixture.gguf"), lines: [],
    }),
    switchServer: async (o) => {
      order.push("switch");
      return { ok: true, port: o.port, ready: true, lines: [], launched: { binPath: o.binPath, modelPath: o.modelPath, tuning: o.tuning } } as never;
    },
  });
  const v = svc.start("models", "ornith-9b confirm");
  for (let i = 0; i < 2400 && !svc.get(v.id)?.done; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(order, ["switch", "report"], "the switch must be observed before the report is read");
});

test("both switch paths go through the injected switcher — no path reaches the real process", async () => {
  // A regression test for the seam itself. If `/models` calls `switchModelAndServer`
  // directly again, this fails loudly instead of quietly restarting a live server on
  // whatever machine the suite runs on.
  const root = await project();
  const calls: string[] = [];
  await run(root, "ornith-9b confirm", { report: liveReport, calls });
  assert.ok(calls.length > 0, "the injected switcher was used, so no real server was touched");
});