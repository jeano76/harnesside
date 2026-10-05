import { test } from "node:test";
import assert from "node:assert/strict";
import { runServerCalibration, formatChanges, CALIBRATE_CONFIRM_COMMAND, type CalibrateDeps } from "./calibrateCommand.js";
import type { ServerReport } from "../setup/serverReport.js";
import type { ParsedServerArgs, PortOwner, SwitchResult } from "../setup/modelSwitch.js";
import type { CalibrationReading } from "../setup/calibrateTuning.js";

const MiB = 1024 * 1024;
const GiB = 1024 ** 3;

/**
 * The measured fixture, matching `calibrateTuning.test.ts`: a real load on the box
 * the regression was reported from (RTX 2070 SUPER, 8 GiB, Ornith 9B Q4_K_M).
 * `freeMiB: 2023` is what nvidia-smi reported while `-ngl 32 -c 36864` was up.
 */
function report(over: Partial<ServerReport> = {}): ServerReport {
  return {
    port: 8080, portDiscovered: false,
    owner: { kind: "ours", pid: 216966 } as PortOwner,
    configuredModel: "/m/Ornith-1.5-9B-Q4_K_M.gguf",
    configuredBin: "/bin/llama-server",
    serverArgs: { modelPath: "/m/Ornith-1.5-9B-Q4_K_M.gguf", contextSize: 36864, gpuLayers: 32, threads: 6, threadsBatch: 11, cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttn: true },
    servers: [{ pid: 216966, port: 8080, cmdline: "llama-server -m /m/x.gguf --port 8080" }],
    build: { binPath: "/bin/llama-server", canReadModel: true, rejectedForModel: [] },
    summary: "", restartPlan: "",
    ...over,
  };
}

/** The measurement behind the reported `-ngl: 999 → 32` regression: our own server
 *  holds 7200 MiB, 900 MiB is free, so a fresh launch has 8100 of an 8192 card. */
const measured: CalibrationReading = {
  freeMiB: 2023, totalMiB: 8192, ownVramMiB: 5588, gpuName: "NVIDIA-GeForce-RTX-2070-SUPER",
  modelBytes: 5780090816, layers: 33, kvElementsPerToken: 16384, trainedContext: 262144,
  moe: false, cpuCount: 12,
};

type Behaviour = (tuning: ParsedServerArgs) => { ok: boolean };

function deps(behaviour: Behaviour = () => ({ ok: true })) {
  // ONE array, created here and both captured and returned — the earlier version
  // closed over an optional parameter, so the recorded calls went nowhere and the
  // assertions below passed on an empty list.
  const calls: string[] = [];
  const log = (c: string) => { calls.push(c); };
  const d: CalibrateDeps = {
    read: async () => measured,
    switchServer: async (o) => {
      log(`switch:-ngl${o.tuning.gpuLayers}:ctx${o.tuning.contextSize}:t${o.tuning.threads}`);
      const r = behaviour(o.tuning);
      return {
        ok: r.ok, port: o.port, ready: r.ok,
        lines: r.ok ? ["ok"] : ["llama-server 가 준비되지 않았습니다: cudaMalloc failed: out of memory"],
        launched: r.ok ? { binPath: o.binPath, modelPath: o.modelPath, tuning: o.tuning } : undefined,
      } as SwitchResult;
    },
    record: async () => { log("record"); },
    sync: async () => { log("sync"); return []; },
  };
  return { d, calls };
}

test("without confirm nothing is stopped: the changes are laid out and the command is named", async () => {
  const { d, calls } = deps();
  const out = await runServerCalibration({ report: report(), confirmed: false }, d);
  assert.equal(out.recalibrated, false);
  assert.deepEqual(calls, [], "no server is touched before confirm");
  assert.match(out.lines.join("\n"), /-ngl: 32 → 999/);
  assert.match(out.lines.join("\n"), new RegExp(CALIBRATE_CONFIRM_COMMAND.replace(/\//g, "\\/")));
});

test("with confirm the plan is launched, recorded and the session synced", async () => {
  const { d, calls } = deps();
  const out = await runServerCalibration({ report: report(), confirmed: true, projectRoot: "/p" }, d);
  assert.equal(out.recalibrated, true);
  assert.equal(out.rolledBack, false);
  assert.match(calls[0]!, /switch:-ngl999/, "the measured plan, not the recorded one");
  assert.ok(calls.includes("record"), "what launched is recorded, so the next boot starts from the measurement");
  assert.ok(calls.includes("sync"), "the session follows the new server");
});

test("a trial that will not load is rolled back to the settings that were working", async () => {
  // Only the full offload fails — exactly the OOM the rollback exists for. The
  // relaunch of `-ngl 32` (what was up a moment ago) still works.
  const { d, calls } = deps((t) => ({ ok: (t.gpuLayers ?? 0) !== 999 }));
  const out = await runServerCalibration({ report: report(), confirmed: true }, d);
  assert.equal(out.recalibrated, false);
  assert.equal(out.rolledBack, true);
  assert.deepEqual(
    calls,
    ["switch:-ngl999:ctx90112:t6", "switch:-ngl32:ctx36864:t6"],
    "the rollback relaunches the previous tuning, not a recomputed one"
  );
  assert.match(out.lines.join("\n"), /되돌렸습니다/);
});

test("a rollback that also fails records nothing — a config must not claim a setting that is not running", async () => {
  const { d, calls } = deps(() => ({ ok: false }));
  const out = await runServerCalibration({ report: report(), confirmed: true, projectRoot: "/p" }, d);
  assert.equal(out.rolledBack, false);
  assert.ok(!calls.includes("record"), "nothing is written when no server is up");
  assert.match(out.lines.join("\n"), /서버가 뜨지 않은 상태/);
});

test("a foreign process on the port is never stopped, even with confirm", async () => {
  const { d, calls } = deps();
  const out = await runServerCalibration({ report: report({ owner: { kind: "foreign", pid: 9 } }), confirmed: true }, d);
  assert.equal(out.recalibrated, false);
  assert.deepEqual(calls, []);
});

test("two live servers are listed rather than reconciled", async () => {
  const { d, calls } = deps();
  const out = await runServerCalibration({
    report: report({ servers: [
      { pid: 1, port: 8080, cmdline: "llama-server -m /m/a.gguf --port 8080" },
      { pid: 2, port: 8084, cmdline: "llama-server -m /m/b.gguf --port 8084" },
    ] }),
    confirmed: true,
  }, d);
  assert.deepEqual(calls, []);
  assert.match(out.lines.join("\n"), /2개/);
});

test("an already-optimal server is left alone and says so", async () => {
  const { d, calls } = deps();
  // "Already optimal" means the MEASUREMENT is from the optimal configuration, not
  // that the numbers happen to look tidy: `-ngl 999 -c 90112` was measured to hold
  // 6,984 MiB and leave 628 MiB, and re-measuring that state must propose nothing.
  const optimal: ParsedServerArgs = { modelPath: "/m/x.gguf", contextSize: 90112, gpuLayers: 999, threads: 6, threadsBatch: 11, cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttn: true };
  const d2: CalibrateDeps = { ...d, read: async () => ({ ...measured, freeMiB: 628, ownVramMiB: 6984 }) };
  const out = await runServerCalibration({ report: report({ serverArgs: optimal }), confirmed: true }, d2);
  assert.equal(out.recalibrated, false);
  assert.deepEqual(calls, []);
  assert.match(out.lines.join("\n"), /최적/);
});

test("an unmeasurable machine is reported as unmeasured, not as 'already optimal'", async () => {
  const { d, calls } = deps();
  const d2: CalibrateDeps = { ...d, read: async () => ({ ...measured, freeMiB: undefined }) };
  const out = await runServerCalibration({ report: report(), confirmed: true }, d2);
  assert.deepEqual(calls, []);
  assert.match(out.lines.join("\n"), /측정할 수 없어/);
});

test("no model in the config: nothing is calibrated and nothing is stopped", async () => {
  const { d, calls } = deps();
  const out = await runServerCalibration({ report: report({ configuredModel: undefined }), confirmed: true }, d);
  assert.equal(out.recalibrated, false);
  assert.deepEqual(calls, []);
  assert.match(out.lines.join("\n"), /\/models/);
});

test("no running server to read: refuses rather than guessing what is loaded", async () => {
  const { d, calls } = deps();
  const out = await runServerCalibration({ report: report({ serverArgs: undefined }), confirmed: true }, d);
  assert.equal(out.recalibrated, false);
  assert.deepEqual(calls, []);
});

test("after a restart, calibration reads the LAUNCHED tuning, not the dead process's command line", async () => {
  // The regression this guards: `report.serverArgs` is parsed from the command line
  // of the process the restart already killed. Calibrating against it would see
  // `-ngl 32`, decide it is wrong, and restart a server that is already running
  // `-ngl 999` correctly — an extra bounce that changes nothing, every time.
  const { d, calls } = deps();
  const d2: CalibrateDeps = { ...d, read: async () => ({ ...measured, freeMiB: 628, ownVramMiB: 6984 }) };
  const out = await runServerCalibration(
    {
      report: report({ serverArgs: { modelPath: "/m/x.gguf", gpuLayers: 32, contextSize: 36864, threads: 6 } }),
      running: { modelPath: "/m/x.gguf", gpuLayers: 999, contextSize: 90112, threads: 6 },
      confirmed: true,
    },
    d2
  );
  assert.deepEqual(calls, [], "999/90112 is what is up, and it is what the measurement says — nothing to do");
  assert.match(out.lines.join("\n"), /최적/);
});

test("formatChanges renders the same shape the restart preview uses", () => {
  assert.deepEqual(
    formatChanges([{ label: "-ngl", from: 32, to: 999 }, { label: "컨텍스트", from: 36864, to: 32768 }]),
    ["-ngl: 32 → 999", "컨텍스트: 36864 → 32768"]
  );
});