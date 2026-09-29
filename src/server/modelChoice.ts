/**
 * 모델 결정 (단계 [4], §7.2)
 *
 * 규칙은 세 겹이다:
 * 1) 설정에 적힌 경로가 있으면 그것이 정답이다. 사용자의 명시적 선택을 점수로 뒤집지 않는다.
 * 2) 없으면 로컬 스캔 → **우선 계열(기본 Ornith) 매칭**을 점수보다 먼저 적용한다(§7.2).
 * 3) 그것도 없으면 계열/양자화 표로 VRAM 에 맞는 것을 *제안만* 한다. 자동 다운로드는 하지 않는다.
 *
 * "제안만"이 중요한 이유: 첫 부팅이 네트워크 없음으로 막히면 사용자는 이 프로그램이
 * 그 자체로 동작하지 않는다고 판단한다. 로컬에 있는 것으로 완결되어야 한다(§7.2).
 */

import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { readFile } from "node:fs/promises";

export interface ModelChoice {
  /** 실제로 사용할 파일 경로. 없으면 null — 그래도 reason 은 항상 채워진다. */
  path: string | null;
  /** 사람이 읽는 근거. 부팅 로그와 설정 화면에 그대로 노출된다. */
  reason: string;
  /** 어떤 규칙이 이 선택을 만들었는지. */
  via: "config" | "priority-series" | "none";
  /** 후보가 있었지만 선택되지 않은 것(설정 화면에서 제안). */
  suggestions: { name: string; why: string }[];
}

export interface ChooseModelOptions {
  projectRoot: string;
  modelsDir: string;
  /** §7.2 의 `models.prioritySeries`. 기본은 Ornith 계열이어야 한다. */
  prioritySeries?: string[];
  /** 0 이면 양자화 표를 적용하지 않는다(선택지만 보여준다). */
  vramTotalBytes?: number;
  /** 설정 파일을 직접 넘겨 테스트할 때 쓴다. */
  configModelPath?: string;
  exists?: (p: string) => Promise<boolean>;
  listDir?: (dir: string) => Promise<string[]>;
}

const DEFAULT_SERIES = ["ornith-1.5-35b-a3b"];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, "-");
}

/** §7.2 양자화 표. 이 수치는 실제 파일 크기이며, 문서와 어긋나면 **문서를 고친다**. */
export const QUANT_TABLE: { minVramGiB: number; quant: string; approxGiB: number }[] = [
  { minVramGiB: 26, quant: "Q5_K_M", approxGiB: 23.6 },
  { minVramGiB: 22, quant: "Q4_K_M", approxGiB: 20.4 },
  { minVramGiB: 18, quant: "Q4_K_S", approxGiB: 19.0 },
  { minVramGiB: 17, quant: "Q3_K_XL", approxGiB: 16.6 },
  { minVramGiB: 16, quant: "IQ3_M", approxGiB: 16.2 },
];

export function suggestQuant(vramTotalGiB: number): { quant: string; fits: boolean } {
  const row = QUANT_TABLE.find((r) => vramTotalGiB >= r.minVramGiB);
  if (row) return { quant: row.quant, fits: true };
  return { quant: QUANT_TABLE[QUANT_TABLE.length - 1].quant, fits: false };
}

async function defaultListDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readConfiguredModelPath(projectRoot: string): Promise<string | undefined> {
  // §6.4: 설정은 전역 < 프로젝트 < 환경변수 순으로 병합된다. 여기서는 프로젝트
  // 설정 한 곳만 본다 — 병합은 loadConfig() 가 이미 한다.
  const candidates = [
    join(projectRoot, ".harnesside", "config.yaml"),
    join(projectRoot, "config.yaml"),
  ];
  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8");
      const m = raw.match(/^\s*(?:model|modelPath)\s*:\s*(.+)$/m);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "");
        if (v) return v;
      }
    } catch {
      // 없으면 다음 후보
    }
  }
  return undefined;
}

export async function chooseModel(opts: ChooseModelOptions): Promise<ModelChoice> {
  const series = (opts.prioritySeries ?? DEFAULT_SERIES).map(normalize);
  const exists = opts.exists ?? (async (p: string) => (await stat(p).catch(() => null))?.isFile() ?? false);
  const listDir = opts.listDir ?? defaultListDir;
  const suggestions: { name: string; why: string }[] = [];

  // 1) 설정에 적힌 경로가 우선이다.
  const configured = opts.configModelPath ?? (await readConfiguredModelPath(opts.projectRoot));
  if (configured && (await exists(configured))) {
    return {
      path: configured,
      reason: `설정에 지정된 모델을 사용합니다: ${basename(configured)}`,
      via: "config",
      suggestions,
    };
  }
  if (configured) {
    suggestions.push({ name: basename(configured), why: "설정에 지정되어 있으나 파일이 없습니다" });
  }

  // 2) 로컬 스캔 → 우선 계열 매칭을 점수보다 먼저 한다.
  const names = await listDir(opts.modelsDir);
  const ggufs = names.filter((n) => n.toLowerCase().endsWith(".gguf"));
  const matched = ggufs.filter((n) => series.some((s) => normalize(n).includes(s)));

  if (matched.length > 0) {
    // 계열 안에서는 "가장 큰 것"이 기본이다(품질 우선). 단, 카드에 확실히 들어올
    // 크기인지는 VRAM 표로 확인해 이유에 적는다.
    matched.sort((a, b) => b.length - a.length);
    const best = matched[0];
    return {
      path: join(opts.modelsDir, best),
      reason: `우선 계열(§7.2 ${series[0]}) 로컬 파일을 사용합니다: ${best}`,
      via: "priority-series",
      suggestions: matched.slice(1).map((n) => ({ name: n, why: "같은 계열의 다른 양자화" })),
    };
  }

  // 3) 계열 파일이 없다. 점수순 추천은 **제안만** 한다(자동 받지 않는다).
  const others = ggufs.filter((n) => !normalize(n).includes("ornith"));
  for (const g of ggufs.filter((n) => normalize(n).includes("ornith"))) {
    suggestions.push({ name: g, why: "Ornith 계열이나 설정 경로와 불일치" });
  }
  const vramGiB = (opts.vramTotalBytes ?? 0) / 1024 ** 3;
  const s = suggestQuant(vramGiB);
  suggestions.unshift({
    name: `Ornith-1.5-35B-A3B-${s.quant}.gguf`,
    why: s.fits
      ? `카드 VRAM ${vramGiB.toFixed(1)}GiB 에 맞는 양자화입니다(§7.2 표)`
      : `카드 VRAM ${vramGiB.toFixed(1)}GiB 에는 이 계열이 큽니다. 그래도 1순위는 Ornith 로 유지합니다(§7.2)`,
  });

  if (others.length > 0) {
    return {
      path: null,
      reason: `우선 계열 파일이 없습니다. 로컬에 있는 다른 모델 ${others.length}개를 확인하세요(자동 교체하지 않습니다).`,
      via: "none",
      suggestions,
    };
  }

  return {
    path: null,
    reason: `모델이 없습니다. ${opts.modelsDir} 에 .gguf 를 두거나 설정에서 경로를 지정하세요.`,
    via: "none",
    suggestions,
  };
}
