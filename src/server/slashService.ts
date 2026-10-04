/**
 * 슬래시 `/models` · `/server` · `/reset` — 구 TUI(2026-10-04 삭제)의 `onSlashCommand` 를 **같은 내용**으로
 * 서버에서 실행한다 (setup·backend 모듈은 Q-1 로 `src/setup/`·`src/backend/` 에 합쳤다).
 *
 * 오래 걸리는 일(모델 내려받기·서버 재시작)이 있어서 요청 하나로 끝내지 않는다:
 * `start()` 가 작업을 만들고, 화면이 `get()` 으로 **지금까지의 출력**을 가져간다.
 * 끝나기 전에 결과를 지어내지 않는다 — `done` 이 `true` 일 때만 끝난 것이다.
 *
 * 서버를 내리거나 설정을 덮어쓰는 단계는 구 TUI와 똑같이 **두 번째 명령**
 * (`/models <n> confirm` · `/server restart confirm` · `/reset confirm`)이 있어야만 실행된다.
 * 미리보기만 하는 경로는 아무것도 바꾸지 않는다.
 */

import { dirname } from "node:path";
import { stat } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { ensureLocalStack } from "../setup/bootstrap.js";
import { describeReset, describeInForce } from "../setup/resetDiff.js";
import { previewReset } from "../setup/resetPreview.js";
import { evaluateAll, evaluateFit, findRung, formatModelTable, usableVramGiB } from "../setup/modelMetrics.js";
import { selectModel, recordServerState } from "../setup/modelSelect.js";
import { describeGpuPlan } from "../setup/gpuReport.js";
import { isMoeModel, readGgufKvShape } from "../setup/ggufMeta.js";
import { probeModelCompatibility } from "../setup/llamaCpp.js";
import { detectHardware, findOwnLlamaServerPids, ownLlamaServerVramGiB } from "../setup/hardware.js";
import { tuneForHardware } from "../setup/tuning.js";
import { switchModelAndServer, detectPortOwner, resolveLiveServerPort, parseLlamaServerArgs } from "../setup/modelSwitch.js";
import { reportServer } from "../setup/serverReport.js";
import { runServerRestart, gateModelSwitch } from "../setup/serverCommand.js";
import { provisionForSwitch } from "../setup/provision.js";
import { formatProgress, type TransferProgress } from "../setup/download.js";
import { baseName } from "../shared/path.js";

export const SERVER_SLASH_KEYS = ["models", "server", "reset"] as const;
export type ServerSlashKey = (typeof SERVER_SLASH_KEYS)[number];

export interface SlashJobView {
  id: string;
  key: string;
  /** 지금까지의 출력. 진행 막대는 마지막 한 줄로 **제자리에서** 갱신된다. */
  text: string;
  done: boolean;
  ok: boolean;
}

interface Job {
  id: string;
  key: string;
  lines: string[];
  /** 다시 그려지는 한 줄(내려받기 진행). 끝나면 `lines` 로 넘어간다. */
  transient: string;
  done: boolean;
  ok: boolean;
}

export interface SlashServiceOptions {
  projectRoot: string;
  /**
   * 서버가 실제로 바뀐 뒤 **세션을 새 서버에 맞춘다** (구 TUI의 `syncSessionToServer`).
   * 맞추지 않으면 에이전트는 옛 모델 이름으로 요청한다. 보여줄 줄을 돌려준다.
   */
  onModelSwitched?: (modelPath: string, contextSize?: number) => Promise<string[]> | string[];
}

function recordedTuning(config: unknown) {
  const llama = ((config as { llama?: Record<string, unknown> })?.llama ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    contextSize: num(llama.contextSize) ?? 8192,
    threads: num(llama.threads) ?? 4,
    gpuLayers: num(llama.gpuLayers) ?? 0,
    threadsBatch: num(llama.threadsBatch),
    batchSize: num(llama.batchSize),
    ubatchSize: num(llama.ubatchSize),
    cpuMoeLayers: num(llama.cpuMoeLayers),
    parallel: num(llama.parallel),
    flashAttn: typeof llama.flashAttn === "boolean" ? llama.flashAttn : undefined,
    cacheTypeK: typeof llama.cacheTypeK === "string" ? llama.cacheTypeK : undefined,
    cacheTypeV: typeof llama.cacheTypeV === "string" ? llama.cacheTypeV : undefined,
    calibratedFor: typeof llama.calibratedFor === "string" ? llama.calibratedFor : undefined,
  };
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}

export class SlashService {
  private jobs = new Map<string, Job>();
  private seq = 0;

  constructor(private readonly opts: SlashServiceOptions) {}

  /** 같은 서버 명령이 **이미 돌고 있으면** 새로 시작하지 않는다 — 서버 두 개를 동시에 만지지 않는다. */
  start(key: ServerSlashKey, argument: string): SlashJobView {
    const running = [...this.jobs.values()].find((j) => !j.done);
    if (running) {
      return this.view(running, `[${running.key}] 이미 실행 중인 작업이 있어 새로 시작하지 않았습니다. 끝난 뒤 다시 실행하세요.`);
    }
    const job: Job = { id: `slash-${Date.now()}-${++this.seq}`, key, lines: [], transient: "", done: false, ok: true };
    this.jobs.set(job.id, job);
    // 오래된 작업은 치운다 — 무한히 쌓지 않는다.
    for (const id of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - 20))) this.jobs.delete(id);
    void this.run(job, key, argument).catch((e) => {
      this.push(job, `[${key} 실패] ${errText(e)}`);
      job.ok = false;
    }).finally(() => {
      this.endTransient(job);
      job.done = true;
    });
    return this.view(job);
  }

  get(id: string): SlashJobView | null {
    const j = this.jobs.get(id);
    return j ? this.view(j) : null;
  }

  private view(j: Job, extra?: string): SlashJobView {
    const parts = [...j.lines, ...(j.transient ? [j.transient] : []), ...(extra ? [extra] : [])];
    return { id: j.id, key: j.key, text: parts.join("\n"), done: j.done || !!extra, ok: j.ok && !extra };
  }

  private push(j: Job, text: string) {
    this.endTransient(j);
    j.lines.push(text);
  }
  private endTransient(j: Job) {
    if (j.transient) {
      j.lines.push(j.transient);
      j.transient = "";
    }
  }
  /** `onProgress` 팩토리 — 갱신마다 **한 줄을 다시 그린다**(내려받기 한 번에 수천 줄이 쌓이지 않게). */
  private progress(j: Job) {
    return (_default: (p: TransferProgress) => void) => (p: TransferProgress) => {
      j.transient = formatProgress(p);
    };
  }

  private async run(j: Job, key: ServerSlashKey, argument: string): Promise<void> {
    const projectRoot = this.opts.projectRoot;
    const { config } = await loadConfig(projectRoot);
    const say = (t: string) => this.push(j, t);
    if (key === "models") return this.models(j, config, argument, say);
    if (key === "server") return this.server(j, config, argument, say);
    return this.reset(j, config, argument, say);
  }

  // ── /models ───────────────────────────────────────────────────────────────
  private async models(j: Job, config: unknown, argument: string, say: (t: string) => void) {
    const projectRoot = this.opts.projectRoot;
    const [arg, ...rest] = argument.trim().split(/\s+/).filter(Boolean);
    const confirmed = rest[0] === "confirm";
    const hw = await detectHardware();
    const liveNow = await resolveLiveServerPort((config as any)?.llama?.port);
    const ownVramGiB = await ownLlamaServerVramGiB(liveNow.servers.map((x) => x.pid));
    const replacing = liveNow.servers.length > 0;
    const reports = evaluateAll(hw, undefined, { ownServerVramGiB: ownVramGiB });

    if (!arg) {
      const { lines } = formatModelTable(reports, { afterReplace: replacing });
      const cur = liveNow.servers[0] ? parseLlamaServerArgs(liveNow.servers[0].cmdline) : undefined;
      say(
        [
          `[models] 이 머신 기준 — 사용 가능 VRAM ${usableVramGiB(hw, ownVramGiB).toFixed(1)} GiB, RAM ${(hw.ramTotalBytes / 1024 ** 3).toFixed(0)} GiB`,
          ...(replacing
            ? [
                `  · 지금 실행 중: ${baseName(cur?.modelPath ?? "?")} (포트 ${liveNow.servers[0].port}, VRAM ${ownVramGiB.toFixed(1)} GiB 사용` +
                  `${cur?.gpuLayers !== undefined ? `, -ngl ${cur.gpuLayers}` : ""}${cur?.cpuMoeLayers ? `, --n-cpu-moe ${cur.cpuMoeLayers}` : ""})`,
                "  · 아래 판정은 지금 상태가 아니라 **교체 후** 기준입니다: 선택하면 이 서버를 종료(확인 후)하고,",
                "    같은 llama.cpp 서버(빌드)로 모델만 바꿔 재시작합니다 — 종료로 돌려받는 VRAM 을 새 모델이 쓸 수 있는 것으로 계산했습니다.",
              ]
            : []),
          "",
          ...lines,
          "",
          "선택하려면 아래 입력창에 /models <번호> 를 보내세요. 서버가 떠 있으면 변경 내용을 보여주고, /models <번호> confirm 으로 확정해야 교체합니다.",
        ].join("\n")
      );
      return;
    }

    const n = Number(arg);
    const byIndex = Number.isInteger(n) && n >= 1 && n <= reports.length ? reports[n - 1] : null;
    const byName = byIndex ? null : findRung(arg);
    const report = byIndex ?? (byName ? evaluateFit(byName, hw, { ownServerVramGiB: ownVramGiB }) : null);
    if (!report) {
      say(`[models] '${arg}' 를 찾지 못했습니다. /models 로 목록을 보고 번호나 이름을 입력하세요.`);
      return;
    }
    const rung = report.rung;
    if (report.fit === "no") {
      say(`[models] 선택하지 않습니다 — ${rung.label} 은(는) 이 머신에서 실행되지 않습니다.\n  ${report.verdict}`);
      return;
    }

    const binDir = (config as any)?.llama?.binPath ? dirname(String((config as any).llama.binPath)) : undefined;
    const oldServerVramGiB = await ownLlamaServerVramGiB(await findOwnLlamaServerPids(binDir));
    const moe = await isMoeModel({ activeParamB: rung.activeParamB, dense: rung.activeParamB === undefined });
    const tuning = tuneForHardware(hw, { modelBytes: rung.sizeBytes, ownServerVramGiB: oldServerVramGiB, moe });

    const result = await selectModel({ projectRoot, rung, tuning });
    const head = [
      `[models] ${rung.label} (${rung.quant}) 로 교체했습니다.`,
      result.previousModel && result.previousModel !== result.modelPath ? `  · 이전 모델: ${result.previousModel}` : "",
      `  · 기록된 경로: ${result.modelPath}`,
      report.fit === "stream" ? `  · ${report.verdict}` : "",
      `  · ${result.llama.detail}`,
    ];

    // 실행 중인 서버를 바꾸려면 명시적 `confirm` 이 필요하다(선택 자체는 이미 기록됐다).
    {
      const gate = await gateModelSwitch(
        { port: result.port, modelPath: result.modelPath, tuning, arg, confirmed },
        { resolvePort: (r) => resolveLiveServerPort(r), detectOwner: (p) => detectPortOwner(p) }
      );
      if (!gate.proceed) {
        say([...head, ...gate.lines.map((l) => `  · ${l}`), "  · 선택은 config 에 기록되어 있습니다."].join("\n"));
        return;
      }
    }

    let binPath = result.llama.binPath;
    let modelPath = result.modelPath;
    let switchTuning = tuning;

    if (!binPath || !result.presentOnDisk) {
      if (!result.presentOnDisk && !confirmed) {
        const sizeGiB = rung.sizeBytes / 1024 ** 3;
        say(
          [
            ...head,
            `  · 모델 파일이 아직 없습니다 — 내려받으면 약 ${sizeGiB.toFixed(1)} GiB 가 필요합니다.`,
            `    지금 받으려면 /models ${arg} confirm 을 보내세요.`,
            "    취소하려면 아무것도 하지 마세요 (설정에는 이미 기록되어 있습니다).",
          ].join("\n")
        );
        return;
      }
      say([...head, `  · 서버를 준비합니다 (빌드·설치·다운로드) — ${result.llama.detail}`].join("\n"));
      const provisioned = await provisionForSwitch({
        projectRoot,
        modelFilename: baseName(result.modelPath),
        port: result.port,
        hardware: hw,
        log: (line) => say(`  · ${line}`),
        onProgress: this.progress(j),
      });
      this.endTransient(j);
      if (!provisioned.ok || !provisioned.binPath || !provisioned.modelPath) {
        j.ok = false;
        say(
          [
            ...head,
            "  · 준비하지 못해 서버는 그대로 둡니다:",
            ...provisioned.lines.map((l) => `    ${l}`),
            "    설정에는 선택이 기록되어 있으니, 문제를 고친 뒤 다음 실행이 이어서 준비합니다.",
          ].join("\n")
        );
        return;
      }
      binPath = provisioned.binPath;
      modelPath = provisioned.modelPath;
      switchTuning = provisioned.tuning ?? tuning;
    }

    // 같은 llama.cpp, 모델만 교체: 실행 중인 서버의 빌드가 새 모델을 읽을 수 있으면 그것을 재사용한다.
    {
      const live = (await resolveLiveServerPort(result.port)).servers.find((x) => x.port === result.port) ?? (await resolveLiveServerPort(result.port)).servers[0];
      const liveExe = live?.exe;
      if (liveExe && liveExe !== binPath) {
        if (await stat(liveExe).then((st) => st.isFile(), () => false)) {
          const compat = await probeModelCompatibility(liveExe, modelPath).catch(() => ({ ok: false }) as { ok: boolean });
          if (compat.ok) {
            say(`  · 실행 중인 서버와 같은 llama.cpp 를 그대로 씁니다 (모델만 교체): ${liveExe}`);
            binPath = liveExe;
          }
        }
      }
    }
    say(`  · 새 모델을 올리기 위해 기존 서버를 종료하고 VRAM 을 비웁니다 (포트 ${result.port}).`);
    const sw = await switchModelAndServer({
      modelPath,
      port: result.port,
      binPath,
      tuning: switchTuning,
      calibrate: true,
      retune: async () => {
        const hw2 = await detectHardware();
        const kv2 = await readGgufKvShape(modelPath);
        const moeNow = await isMoeModel({ path: modelPath, activeParamB: rung.activeParamB, dense: rung.activeParamB === undefined });
        const bytesNow = (await stat(modelPath).catch(() => undefined))?.size || rung.sizeBytes;
        const t2 = tuneForHardware(hw2, { modelBytes: bytesNow, moe: moeNow, kvElementsPerToken: kv2?.elementsPerToken, trainedContext: kv2?.contextLength, modelLayers: kv2?.layers });
        return { tuning: t2, lines: describeGpuPlan(hw2, t2) };
      },
    });
    if (sw.ok && sw.launched) {
      await recordServerState(projectRoot, {
        port: sw.port, binPath: sw.launched.binPath, modelPath: sw.launched.modelPath,
        tuning: sw.launched.tuning as Record<string, unknown>,
        calibratedFor: sw.calibration?.calibratedFor,
      }).catch(() => false);
    }
    const synced = sw.ok ? await Promise.resolve(this.opts.onModelSwitched?.(modelPath, switchTuning.contextSize) ?? []) : [];
    if (!sw.ok) j.ok = false;
    say([...head, ...sw.lines.map((l) => `  · ${l}`), ...synced.map((l) => `  · ${l}`)].join("\n"));
  }

  // ── /server ───────────────────────────────────────────────────────────────
  private async server(j: Job, config: unknown, argument: string, say: (t: string) => void) {
    const projectRoot = this.opts.projectRoot;
    const arg = argument.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    const report = await reportServer({ config: config as Record<string, any>, projectRoot });

    if (arg === "restart" || arg === "restart confirm") {
      const sa = report.serverArgs;
      const configHasTuning = typeof (config as any)?.llama?.contextSize === "number";
      const recorded = configHasTuning || !sa
        ? recordedTuning(config)
        : ({
            ...recordedTuning(config),
            ...Object.fromEntries(Object.entries(sa).filter(([k, v]) => v !== undefined && k !== "modelPath" && k !== "port")),
          } as ReturnType<typeof recordedTuning>);
      const out = await runServerRestart(
        { report, configBin: (config as any)?.llama?.binPath, tuning: recorded, confirmed: arg === "restart confirm" },
        {
          switchServer: (o) => switchModelAndServer(o),
          record: (st) => recordServerState(projectRoot, st),
          sync: async (m, o) => Promise.resolve(this.opts.onModelSwitched?.(m, o?.contextSize) ?? []),
          describePlan: async (t) =>
            describeGpuPlan(await detectHardware(), {
              gpuLayers: t.gpuLayers ?? 0,
              contextSize: t.contextSize ?? 8192,
              cpuMoeLayers: t.cpuMoeLayers ?? 0,
            }),
        }
      );
      say(`[server] ${out.lines.join("\n")}`);
      return;
    }

    say(
      [
        `[server] ${report.summary}`,
        report.configuredModel ? "" : "  · config 에 모델이 없습니다 — /models 로 선택하세요.",
        report.build && !report.build.canReadModel ? `  · ${report.build.rejectedForModel.join(", ")} 는 이 양자화를 읽지 못합니다.` : "",
        "",
        `[server] 재시작 시: ${report.restartPlan}`,
        "  · 지금 재시작하려면 /server restart (변경 내용을 보여주고 /server restart confirm 으로 확정)",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  // ── /reset ────────────────────────────────────────────────────────────────
  private async reset(j: Job, config: unknown, argument: string, say: (t: string) => void) {
    const projectRoot = this.opts.projectRoot;
    const arg = argument.trim().toLowerCase();
    if (arg !== "confirm") {
      const llama = (config as any)?.llama ?? {};
      const hwNow = await detectHardware();
      const binDirNow = llama.binPath ? dirname(String(llama.binPath)) : undefined;
      const preview = await previewReset({
        config: config as any,
        hardware: hwNow,
        ownServerVramGiB: await ownLlamaServerVramGiB(await findOwnLlamaServerPids(binDirNow)),
      }).catch(() => undefined);
      say(
        [
          "[reset] 현재 GPU·VRAM·RAM 기준으로 llama 설정을 다시 계산합니다 (미리보기 — 아직 아무것도 바꾸지 않았습니다).",
          "  · 지금 설정: 모델 " + String((config as any)?.model ?? "(없음)"),
          "  ·           컨텍스트 " + Number(llama.contextSize ?? 0).toLocaleString() + " 토큰, 스레드 " + String(llama.threads ?? "?"),
          preview && !preview.repicksModel
            ? preview.changes.length > 0
              ? "  · 적용하면 바뀔 항목:\n" + preview.changes.map((c) => `      - ${c}`).join("\n")
              : "  · 적용해도 바뀔 항목이 없습니다 (이미 이 머신에 맞는 값)."
            : "  · 설정된 모델 파일이 없어 적용 시 이 머신에 맞는 모델을 새로 고릅니다.",
          "  · 직접 입력한 값(apiKey·verify·browser·compaction)은 그대로 유지됩니다.",
          "  · /models 로 직접 고른 모델은, 파일이 있고 이 머신에서 구동 가능하면 유지됩니다.",
          "  · 실행 중인 서버는 건드리지 않습니다 — 적용은 /server restart (확인 후).",
          "  · 세션 중이므로 모델은 내려받지 않습니다 (필요하면 /models 로 받습니다).",
          "",
          "실행하려면 /reset confirm 을 보내세요. 취소하려면 아무것도 하지 마세요.",
        ].join("\n")
      );
      return;
    }
    say("[reset] 지금 시스템의 GPU·VRAM·메모리를 확인하고 설정을 재계산합니다…");
    const report = await ensureLocalStack({
      projectRoot,
      force: true,
      log: (line) => say(`[reset] ${line}`),
      onProgress: this.progress(j),
    });
    this.endTransient(j);
    const changed = describeReset(config as Record<string, unknown>, report.config);
    const inForce = describeInForce(report.config);
    say(
      changed.length > 0
        ? `[reset] 완료. 바뀐 항목 ${changed.length}개:\n${changed.map((c) => `  · ${c}`).join("\n")}\n` +
            `[reset] 적용된 설정\n${inForce.map((c) => `  · ${c}`).join("\n")}\n` +
            "설정만 갱신했습니다. 실행 중인 서버에 적용하려면 /server 로 차이를 확인하고 /server restart 를 실행하세요."
        : "[reset] 현재 시스템에 이미 최적이었습니다. 바뀐 항목이 없습니다.\n" +
            `[reset] 적용된 설정\n${inForce.map((c) => `  · ${c}`).join("\n")}\n` +
            "재시작할 필요도 없습니다."
    );
  }
}
