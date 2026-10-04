/**
 * 브라우저 GPU 정책 결정 (§4.7.2)
 *
 * 왜 이 파일이 별도로 있는가: "브라우저를 GPU 없이 띄운다"는 결정은 한 곳에서만
 * 내려야 한다. §4.6(VRAM 예산)과 §4.7(플래그)이 서로 다른 값을 읽으면 서로를
 * 무력화하고, 사용자에게는 "설정함"과 "동작함"이 어긋난 상태로 보인다.
 *
 * 실측 근거(2026-09-29, RTX 2070 SUPER 8192 MiB, llama-server 이미 7278 MiB 점유):
 * GPU off 플래그로 띄운 Chrome 의 VRAM 증가량은 +10 MiB 이고 nvidia-smi 상에는
 * chrome 항목이 아예 없다. 반대로 GPU 를 켜면 남은 285 MiB 로 컴포지터 버퍼를
 * 얻을 수 없다. 따라서 free VRAM 이 빠듯할수록 off 가 정답이다.
 *
 * 순수 함수 + 주입 가능한 설정 — 유닛 테스트가 머신이 아니라 코드를 검증한다.
 */

import type { Hardware } from "./hardware.js";

/** 브라우저의 GPU 정책. */
export type GpuMode = "off" | "budgeted" | "full";

export interface GpuPolicyConfig {
  /** 사용자가 명시한 값이 있으면 판정을 건너뛴다(사용자 우선). */
  forced?: GpuMode;
  /**
   * 모델이 GPU 에서 점유할 것으로 예상되는 바이트. VRAM 예산 계산과
   * 같은 입력을 쓴다 — 이 값이 다르면 모드와 예산이 어긋난다.
   */
  modelBytes?: number;
  /**
   * `budgeted` 로 올라가기 위한 최소 여유 VRAM (기본 1.5 GiB).
   * 이 값 미만을 여유로 인정하면 브라우저가 모델을 죽인다(측정된 실패).
   */
  budgetedHeadroomMiB?: number;
}

export interface GpuDecision {
  mode: GpuMode;
  /** 브라우저가 카드에서 예약해야 하는 MiB. `off` 는 0 이다(§4.6 표). */
  reserveMiB: number;
  /** 왜 이 모드인지. 설정 화면과 `/api/gpu` 가 그대로 노출한다. */
  rationale: string[];
  /** 결정에 사용한 실측값 — 근거가 없으면 "왜냐"에 답할 수 없다. */
  measured: {
    vramTotalMiB: number;
    vramFreeMiB: number;
    modelMiB: number;
    headroomMiB: number;
  };
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const DEFAULT_HEADROOM_MIB = 1536; // 1.5 GiB

/** `off` 일 때 브라우저가 예약하는 VRAM. 실측 +10 MiB → 예산은 0 으로 둔다. */
export const OFF_RESERVE_MIB = 0;

/**
 * GPU 모드를 가용 VRAM 구간별로 정한다. §4.6 의 표와 같은 수치이며,
 * 표와 어긋나면 안 되므로(두 곳이 같은 사실을 말해야 한다) 값을 여기서 한 번만 쓴다.
 */
export function browserVramBudgetMiB(vramTotalMiB: number, mode: GpuMode): number {
  if (mode === "off") return OFF_RESERVE_MIB;
  if (vramTotalMiB <= 6 * 1024) return 1200;
  if (vramTotalMiB <= 10 * 1024) return 700;
  if (vramTotalMiB <= 16 * 1024) return 400;
  return 250;
}

export function decideGpuMode(hw: Hardware, cfg: GpuPolicyConfig = {}): GpuDecision {
  const rationale: string[] = [];
  const primary = hw.gpus[0] ?? null;
  const vramTotalMiB = Math.floor((primary?.vramTotalBytes ?? 0) / MiB);
  // 페이퍼 사양이 아니라 실측 free 를 쓴다(§3.2 [5]·§4.6).
  const vramFreeMiB = Math.floor((primary?.vramFreeBytes ?? 0) / MiB);
  const modelMiB = Math.floor((cfg.modelBytes ?? 0) / MiB);
  const headroomMiB = cfg.budgetedHeadroomMiB ?? DEFAULT_HEADROOM_MIB;

  // 모델이 GPU 를 쓰는가: llama.cpp 는 GPU 가 있으면 기본으로 GPU 우선이다(§6.3).
  // gpuLayers 0 이 되는 유일한 경우는 GPU 가 아예 없을 때다.
  const modelUsesGpu = primary !== null;

  let mode: GpuMode;
  if (cfg.forced) {
    mode = cfg.forced;
    rationale.push(`설정에 지정된 GPU 모드를 따릅니다: ${mode}`);
  } else if (!modelUsesGpu) {
    mode = "full";
    rationale.push("GPU 가 없으므로 브라우저 GPU 정책이 불필요합니다(모델도 CPU 전용).");
  } else if (vramFreeMiB - modelMiB >= headroomMiB) {
    mode = "budgeted";
    rationale.push(
      `카드 여유가 충분합니다(실측 free ${vramFreeMiB} MiB − 모델 ${modelMiB} MiB = ` +
        `${vramFreeMiB - modelMiB} MiB ≥ ${headroomMiB} MiB). 브라우저가 예산 내에서 GPU 를 씁니다.`
    );
  } else {
    mode = "off";
    rationale.push(
      `카드에 여유가 없습니다(실측 free ${vramFreeMiB} MiB − 모델 ${modelMiB} MiB = ` +
        `${vramFreeMiB - modelMiB} MiB < ${headroomMiB} MiB). 브라우저 GPU 를 끕니다.`
    );
    rationale.push(
      "이 판단은 측정 기반입니다: 같은 머신에서 GPU off 로 띄운 Chrome 의 VRAM 증가량은 +10 MiB 이었고, " +
        "GPU 를 켠 상태에서는 남은 VRAM 으로 컴포지터 버퍼를 얻을 수 없어 모델이 죽습니다."
    );
  }

  return {
    mode,
    reserveMiB: browserVramBudgetMiB(vramTotalMiB, mode),
    rationale,
    measured: { vramTotalMiB, vramFreeMiB, modelMiB, headroomMiB },
  };
}

/** GiB 표기(설정 화면·rationale 용). 0 은 "예약 없음" 으로 읽히게 한다. */
export function formatReserve(reserveMiB: number): string {
  if (reserveMiB <= 0) return "예약 없음 (0 MiB)";
  return reserveMiB >= 1024 ? `${(reserveMiB / 1024).toFixed(1)} GiB` : `${reserveMiB} MiB`;
}
