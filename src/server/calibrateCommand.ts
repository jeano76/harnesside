/**
 * `/server calibrate [confirm]` — measure, plan, and (once confirmed) relaunch
 * with the measured plan, rolling back to the last working launch if it fails.
 *
 * Split from `planCalibration` (the arithmetic) so this file owns only the parts
 * that touch a machine: reading the card, stopping a server, starting one, and
 * putting the previous settings back. Every dependency is injected, which is what
 * makes the rollback path testable without ever starting a llama-server.
 *
 * ── Why the confirm step is not ceremony ──────────────────────────────────
 * Calibration stops a live server. `/server restart` sets the precedent this
 * project follows everywhere a live server is at stake: lay out the change, name
 * the exact command, and touch nothing until it arrives. A stray Enter must not
 * cost a session.
 *
 * ── Why the rollback is not optional ──────────────────────────────────────
 * The plan is derived from a reading taken while a DIFFERENT server held the
 * card. That reading can be stale (a browser grabbed VRAM a second later) or
 * simply wrong (a card whose reported free memory does not reflect what an
 * allocation will actually get). So a launch with the new plan is a TRIAL, and a
 * failed trial leaves the machine with no server at all unless we put the old one
 * back. `previous` is therefore not an optimisation detail — it is the thing that
 * makes trying safe.
 */

import { dirname } from "node:path";
import { loadConfig } from "../config.js";
import { detectHardware, findOwnLlamaServerPids, ownLlamaServerVramGiB, pickPrimaryGpu } from "../setup/hardware.js";
import { defaultReadGpuName, defaultReadVramFreeMiB } from "../setup/calibrate.js";
import { readModelMeta, readMoe } from "../setup/metaRead.js";
import { planCalibration, type CalibrationChange, type CalibrationReading } from "../setup/calibrateTuning.js";
import { diffServer, gateServerReplacement } from "../setup/serverPolicy.js";
import { switchModelAndServer, type ParsedServerArgs, type SwitchResult } from "../setup/modelSwitch.js";
import { recordServerState } from "../setup/modelSelect.js";
import type { ServerReport } from "../setup/serverReport.js";

const MiB = 1024 * 1024;

export interface CalibrateDeps {
  /** Everything the plan needs, measured from the live machine. */
  read: (report: ServerReport, modelPath: string) => Promise<CalibrationReading>;
  switchServer: (opts: {
    modelPath: string; port: number; binPath: string;
    tuning: ParsedServerArgs; calibrate?: boolean;
  }) => Promise<SwitchResult>;
  /** Persist what really launched, so the next boot starts from the measurement. */
  record: (state: { port: number; binPath: string; modelPath: string; tuning?: Record<string, unknown>; calibratedFor?: string }) => Promise<unknown>;
  /** Bring the session's client in line, when the launch succeeded. */
  sync?: (modelPath: string, o: { contextSize?: number }) => Promise<string[]> | string[];
}

export interface CalibrateInput {
  report: ServerReport;
  configBin?: string;
  confirmed: boolean;
  projectRoot?: string;
  /** The tuning the live server was launched with, when the caller knows it better
   *  than the report does — i.e. right after a restart, where the report's
   *  `serverArgs` describe the process that was just stopped. */
  running?: ParsedServerArgs;
}

export interface CalibrateOutcome {
  /** True when a server was relaunched with a different plan. */
  recalibrated: boolean;
  /** True when the trial launch failed and the previous settings were restored. */
  rolledBack: boolean;
  /** What was actually running when we started — the rollback target. */
  previous?: ParsedServerArgs;
  lines: string[];
}

export const CALIBRATE_CONFIRM_COMMAND = "/server calibrate confirm";

/** Renders a change list as `label: from → to`, the same shape `diffServer` uses,
 *  so a calibration preview and a restart preview read identically. */
export function formatChanges(changes: CalibrationChange[]): string[] {
  return changes.map((c) => `${c.label}: ${String(c.from)} → ${String(c.to)}`);
}

/**
 * Runs `/server calibrate`.
 *
 * Order matters and is load-bearing: measure → plan → gate → trial → record.
 * The measurement happens BEFORE the gate, so a preview tells the truth about what
 * would change rather than what the previous restart would have changed.
 */
export async function runServerCalibration(input: CalibrateInput, deps: CalibrateDeps): Promise<CalibrateOutcome> {
  const { report, confirmed } = input;
  const lines: string[] = [];
  const say = (l: string) => lines.push(l);

  const modelPath = report.configuredModel;
  if (!modelPath) return { recalibrated: false, rolledBack: false, lines: ["캘리브레이션하지 않습니다 — config 에 모델이 없습니다. /models 로 먼저 선택하세요."] };
  const binPath = report.build?.binPath ?? input.configBin;
  if (!binPath) return { recalibrated: false, rolledBack: false, lines: ["llama-server 실행 파일을 찾지 못했습니다. /models 로 모델을 다시 선택하세요."] };

  // The running server's own arguments: the truth about what is loaded now, and
  // the rollback target. Read from the command line rather than the config
  // because the server may predate the config (started by hand, or by an earlier
  // calibration whose record we are about to overwrite).
  // What is running RIGHT NOW. After a restart that is the launched tuning, not
  // `report.serverArgs` — that was parsed from the command line of the process the
  // restart already killed, so using it here means calibrating against a server
  // that no longer exists and "correcting" a value nobody is running.
  const previous: ParsedServerArgs | undefined = input.running ?? report.serverArgs;
  if (!previous) {
    say("캘리브레이션하지 않습니다 — 실행 중인 서버의 설정을 명령줄에서 읽지 못했습니다 (지금 뜨는 것을 무엇으로 바꾸는지 알 수 없습니다).");
    return { recalibrated: false, rolledBack: false, lines };
  }

  const measured = await deps.read(report, modelPath);
  const plan = planCalibration(previous, measured);

  for (const u of plan.unmeasured) say(`  · 측정 못 함: ${u}`);
  if (!plan.changed) {
    say(
      [
        plan.unmeasured.length > 0
          ? "[server] 측정할 수 없어 그대로 둡니다 — 바뀔 항목을 계산하지 않았습니다."
          : "[server] 이미 이 머신에서 최적입니다 — 재계산해도 바뀔 항목이 없습니다.",
        ...(plan.notes.length ? plan.notes.map((n) => `  · ${n}`) : []),
      ].join("\n")
    );
    return { recalibrated: false, rolledBack: false, previous, lines };
  }

  const changes = formatChanges(plan.changes);

  // Same gate as `/server restart`: one server, never a stranger's process, and a
  // confirmation before anything live is stopped.
  const gate = gateServerReplacement({
    owner: report.owner,
    port: report.port,
    servers: report.servers,
    changes,
    confirmed,
    confirmCommand: CALIBRATE_CONFIRM_COMMAND,
  });
  if (!gate.proceed) {
    say(
      [
        `[server] ${changes.length}개를 다시 잡을 수 있습니다 (계산값이 아니라 실제 카드·모델에서 잰 값):`,
        ...changes.map((c) => `  · ${c}`),
        ...plan.notes.map((n) => `  · ${n}`),
        "",
        ...gate.lines,
      ].join("\n")
    );
    return { recalibrated: false, rolledBack: false, previous, lines };
  }

  // ── The trial launch ───────────────────────────────────────────────────
  // The previous settings ride along: if this does not load, they are the launch
  // that is known to work, and `previous` is the only record of them once the
  // trial process is gone.
  const trialTuning: ParsedServerArgs = { ...previous, ...plan.tuning };
  say(`[server] ${changes.length}개를 반영해 다시 올립니다 (포트 ${report.port}).`);
  const sw = await deps.switchServer({
    modelPath, port: report.port, binPath, tuning: trialTuning,
    // `calibrate: false` on purpose. `calibrate.ts` would run its OWN downward
    // `--n-cpu-moe` trial on top of ours, which means a second restart inside a
    // restart — and on a dense model it does nothing at all, which is the case
    // this command exists for. The OOM retry inside it still runs, and that is
    // the part worth keeping.
    calibrate: false,
  });

  if (!sw.ok) {
    say(`  · 새 설정으로는 올라오지 못했습니다: ${sw.lines.slice(-1)[0] ?? "알 수 없는 오류"}`);
    say(`  · 직전에 동작하던 설정으로 되돌립니다 (-ngl ${previous.gpuLayers ?? "?"}, 컨텍스트 ${previous.contextSize?.toLocaleString() ?? "?"}).`);
    const back = await deps.switchServer({ modelPath, port: report.port, binPath, tuning: previous, calibrate: false });
    if (back.ok) {
      say("  · 되돌렸습니다 — 서버는 예전 설정으로 응답합니다. 설정은 바꾸지 않았습니다.");
      return { recalibrated: false, rolledBack: true, previous, lines };
    }
    // Both failed. Say so plainly and leave nothing recorded: a config claiming a
    // setting that is not running is worse than one that admits it is stale.
    say("  · 되돌리는 것도 실패했습니다 — 서버가 뜨지 않은 상태입니다. 로그를 확인해 주세요.");
    return { recalibrated: false, rolledBack: false, previous, lines };
  }

  if (input.projectRoot) {
    await deps
      .record({
        port: report.port, binPath, modelPath,
        tuning: sw.launched?.tuning ?? (trialTuning as unknown as Record<string, unknown>),
      })
      .catch(() => false);
  }
  const synced = await Promise.resolve(deps.sync?.(modelPath, { contextSize: trialTuning.contextSize }) ?? []);
  say(
    [
      `[server] ${changes.length}개를 반영했습니다.`,
      ...changes.map((c) => `  · ${c}`),
      ...synced.map((s) => `  · ${s}`),
    ].join("\n")
  );
  return { recalibrated: true, rolledBack: false, previous, lines };
}

/**
 * The real measurement: the card as it is RIGHT NOW, with our server still up.
 *
 * Ordering is deliberate. `ownVramMiB` is read while the server is running,
 * because that is the only moment the driver still attributes its pages to our
 * pid; read afterwards, the number is gone and the budget collapses.
 */
export async function measureForCalibration(
  report: ServerReport,
  modelPath: string,
  configBin: string | undefined,
  opts: {
    detect?: () => Promise<import("../setup/hardware.js").Hardware>;
    readFree?: () => Promise<number | undefined>;
    gpuName?: () => Promise<string | undefined>;
  } = {}
): Promise<CalibrationReading> {
  const detect = opts.detect ?? detectHardware;
  const readFree = opts.readFree ?? defaultReadVramFreeMiB;
  const gpuName = opts.gpuName ?? defaultReadGpuName;
  const hw = await detect();
  const gpu = pickPrimaryGpu(hw);
  const meta = await readModelMeta(modelPath);
  const moe = await readMoe(modelPath);
  const ownVramGiB = await ownLlamaServerVramGiB(
    await findOwnLlamaServerPids(configBin ? dirname(configBin) : undefined)
  );
  const [freeMiB, name] = await Promise.all([readFree(), gpuName()]);
  return {
    freeMiB,
    totalMiB: gpu ? Math.round(gpu.vramTotalBytes / MiB) : undefined,
    ownVramMiB: Math.round(ownVramGiB * 1024),
    gpuName: name ?? gpu?.name,
    modelBytes: meta.bytes,
    layers: meta.layers,
    kvElementsPerToken: meta.kvElementsPerToken,
    trainedContext: meta.trainedContext,
    moe,
    unifiedMemory: gpu?.unifiedMemory,
    cpuCount: hw.cpuCount,
  };
}

/** The `/server` config-shaped reader, kept next to the command so the wiring is
 *  one import and the config load is not duplicated in the slash service. */
export async function loadCalibrateConfig(projectRoot: string): Promise<unknown> {
  return (await loadConfig(projectRoot)).config;
}