import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashService } from "./slashService.js";

/**
 * `/server calibrate` reaches the calibration path, and nothing else does.
 *
 * Only the ROUTING is under test. What the measurement decides is
 * `calibrateTuning.test.ts`'s job and what the relaunch does on failure is
 * `calibrateCommand.test.ts`'s — neither needs a real card. What is genuinely
 * easy to get wrong here, and therefore worth pinning, is that the argument
 * reaches the right branch at all: `/server` on its own is a status report, and a
 * typo in the subcommand name degrades into that report **while looking like it
 * worked** — which is the failure this project's commands are written to avoid.
 *
 * ── Why the report AND the switch are injected ─────────────────────────────
 * These commands stop a running server. The first version of this file let
 * `reportServer` scan the real machine, and `/server calibrate confirm` in it would
 * then have found whatever llama-server the developer happened to be running and
 * **restarted it with whatever the test machine's card measured**. That is
 * `hardware.ts`'s own warning — "tests that probed it for real were testing the
 * machine, not the code" — arriving exactly where the consequence is a dead
 * session instead of a wrong number. Both seams are therefore overridden, and a
 * test that ever forgets to override one fails loudly instead of reaching out.
 */

async function project(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hs-cal-"));
  await mkdir(join(root, ".harnesside"), { recursive: true });
  await writeFile(join(root, ".harnesside", "config.yaml"), JSON.stringify(config));
  return root;
}

/** Nothing listening on the port, so every command takes the "nothing to do" path
 *  without consulting a process. No `pgrep`, no `ss`, no `nvidia-smi`. */
const idleReport = {
  port: 18999, portDiscovered: false,
  owner: { kind: "none" as const },
  servers: [],
  configuredModel: undefined,
  summary: "포트 18999 · 서버 없음 (포트 비어 있음)",
  restartPlan: "config 에 모델이 없습니다. /models 로 먼저 선택하세요.",
};

const cfg = { backend: "openai-compatible", model: "/m/x.gguf", llama: { port: 18999, contextSize: 8192, threads: 4 } };

const run = async (arg: string) => {
  const root = await project(cfg);
  const svc = new SlashService({
    projectRoot: root,
    reportServer: async () => idleReport as never,
    switchServer: async (o) => { throw new Error(`switchServer must not be reached in this test (port ${o.port})`); },
  });
  const view = svc.start("server", arg);
  for (let i = 0; i < 200 && !svc.get(view.id)?.done; i++) await new Promise((r) => setTimeout(r, 25));
  return svc.get(view.id)!.text;
};

test("/server alone stays a status report and mentions calibrate as a separate step", async () => {
  const out = await run("");
  assert.match(out, /\[server\]/);
  assert.match(out, /\/server restart/);
  assert.match(out, /\/server calibrate/, "the calibration step has to be discoverable from the status report");
  assert.doesNotMatch(out, /캘리브레이션하지 않습니다/, "the bare command must not start calibrating");
});

test("`/server calibrate` is routed to calibration, not treated as a status report", async () => {
  const out = await run("calibrate");
  // With no model configured there is nothing to calibrate, and the refusal must
  // come from the calibration path — that is the routing assertion.
  assert.match(out, /캘리브레이션/);
  assert.doesNotMatch(out, /재시작 시:/, "it must not have fallen through to the restart preview");
});

test("`/server calibrate confirm` is recognised as the confirming form", async () => {
  const out = await run("calibrate confirm");
  assert.match(out, /캘리브레이션/);
  assert.doesNotMatch(out, /재시작 시:/);
});

test("an unknown `/server` subcommand reports the status rather than guessing", async () => {
  const out = await run("recalibrate");
  assert.match(out, /재시작 시:/, "an unrecognised word falls through to the report, which is the safe reading");
});