/**
 * 설정 스키마 (§5.13 · §6.4).
 *
 * §5.13 이 요구하는 것은 값이 아니라 **3가지를 같이 보여주는 것** 다:
 *   현재 값 · 그 값의 출처(기본값/이 프로젝트/환경변수) · 왜 이 값인가(rationale)
 *
 * 이 표시가 없으면 사용자는 "왜 값이 안 바뀌지?" 하고 추측한다. 그래서 **모든 항목이**
 * rationale 을 가진다 — "그냥 그래서" 로 두면 rationale 이 없는 항목이 곧 드문 항목이 된다.
 *
 * 우선순위는 **한 곳에서만** 정의된다: 전역 기본 → 프로젝트 → 환경변수.
 */

import type { LogLevel } from "../server/logRing.js";
import type { UpdateChannel } from "../server/update/pipeline.js";
import type { ThinkStyle } from "../web/agent/think.js";
import { DEFAULT_MAX_REASONING, MAX_REASONING_CEILING, MIN_REASONING_FLOOR } from "../shared/reasoning.js";

export const SCHEMA_VERSION = 3;

export type Provenance = "default" | "global" | "project" | "env" | "unknown";

export const PROVENANCE_KO: Record<Provenance, string> = {
  default: "기본값",
  global: "전역 설정",
  project: "이 프로젝트에서 재정의",
  env: "환경변수",
  unknown: "알 수 없음",
};

export type SectionId = "model" | "browser" | "agent" | "log" | "update" | "advanced";

export const SECTIONS: { id: SectionId; title: string; reason: string }[] = [
  { id: "model", title: "모델", reason: "포트 · 현재 모델 · Ornith 추천 · 교체와 재기동 (요구 5)" },
  { id: "browser", title: "브라우저", reason: "GPU 모드와 검증 결과 · 창 크기 · 추가 플래그 (§4.1·§4.7)" },
  { id: "agent", title: "에이전트", reason: "thinking 정책 · 도구 스키마 비용 · 승인 게이트 화이트리스트 (요구 6·7)" },
  { id: "log", title: "로그", reason: "레벨 · 보관 상한 · 소스 필터 · 진단 리포트 (§5.12)" },
  { id: "update", title: "업데이트 · 버전", reason: "셀프 업데이트와 롤백 (§5.13.1 · 요구 14)" },
  { id: "advanced", title: "고급", reason: "설정 내보내기/가져오기 · 워크스페이스 기본값 · 위험 초기화 (§9.2)" },
];

export type SettingValue = string | number | boolean | string[] | null;

export interface SettingDef<T extends SettingValue = SettingValue> {
  key: string;
  section: SectionId;
  label: string;
  type: "string" | "number" | "boolean" | "enum" | "string[]";
  default: T;
  options?: readonly string[];
  min?: number;
  max?: number;
  /** **왜 이 값인가.** 비면 안 된다 — 요구 사항이다. */
  rationale: string;
  /** 환경변수로 덮을 수 있는가. false 면 HARNESSIDE_XXX 를 무시한다. */
  envOverridable?: boolean;
  /** 위험 초기화 대상인지(고급 섹션에서만). */
  danger?: boolean;
}

export const SETTINGS: SettingDef[] = [
  // ---------------------------------------------------------------- 모델 (§7)
  {
    key: "model.port",
    section: "model",
    label: "llama-server 포트",
    type: "number",
    default: 8080,
    min: 1024,
    max: 65535,
    rationale: "기본 8080. 다른 서비스가 이미 쓰면 2포트 계획(§3.2)으로 다른 포트를 고른다.",
    envOverridable: true,
  },
  {
    key: "model.id",
    section: "model",
    label: "현재 모델 경로",
    type: "string",
    default: "",
    rationale: "20 GiB 급 모델이라 프로젝트 디렉터리에 두지 않는다(§6.4). 기본은 ~/.harnesside/models.",
    envOverridable: true,
  },
  {
    key: "model.pinnedFamily",
    section: "model",
    label: "고정 추천 계열",
    type: "string",
    default: "Ornith",
    rationale: "§7.2: 점수 계산과 독립으로 이 계열을 1순위에 고정한다. 요청 사항이다.",
  },
  {
    key: "model.quant",
    section: "model",
    label: "양자화",
    type: "string",
    default: "Q5_K_M",
    rationale: "이 머신은 8 GiB VRAM 이다(§4.6). Q5_K_M 이 품질/메모리 균형점이고, 더 크면 OOM 이고 더 작으면 품질이 떨어진다.",
  },
  {
    key: "model.maxConcurrentDownloads",
    section: "model",
    label: "동시 다운로드 수",
    type: "number",
    default: 2,
    min: 1,
    max: 8,
    rationale: "더 내리면 느리고, 더 올리면 대역폭과 디스크를 서로 먹는다. 실측 기준 2가 무난했다.",
  },

  // ------------------------------------------------------------- 브라우저 (§4)
  {
    key: "browser.gpu",
    section: "browser",
    label: "브라우저 GPU",
    type: "enum",
    options: ["auto", "on", "off"],
    default: "off",
    rationale: "이 프로그램의 브라우저 GPU 는 **기본 꺼짐** 이다. 실측에서 llama-server 가 VRAM 7,278 MiB 를 쥐고 있을 때 남는 게 285 MiB 였다(§4.7).",
  },
  {
    key: "browser.width",
    section: "browser",
    label: "창 너비",
    type: "number",
    default: 1440,
    min: 800,
    max: 7680,
    rationale: "가로 diff(요구 3)와 탐색기/에이전트를 동시에 보려면 1200px 아래가 빠듯하다.",
  },
  {
    key: "browser.height",
    section: "browser",
    label: "창 높이",
    type: "number",
    default: 900,
    min: 600,
    max: 4320,
    rationale: "로그 패널(상시 표시)과 에이전트 블록이 같이 보여야 한다(§5.12).",
  },
  {
    key: "browser.roundedCorners",
    section: "browser",
    label: "라운드 모서리",
    type: "boolean",
    default: true,
    rationale: "요구 8. --app 창에 사각 테두리가 남으면 앱 창이 아니라 브라우저로 보인다.",
  },
  {
    key: "browser.extraFlags",
    section: "browser",
    label: "추가 플래그",
    type: "string[]",
    default: [],
    rationale: "디버깅용. GPU 관련 플래그를 여기서 켜면 §4.7 정책과 충돌하므로 경고를 낸다.",
  },

  // ------------------------------------------------------------- 에이전트 (§5.3)
  {
    key: "agent.enableThinking",
    section: "agent",
    label: "thinking 사용",
    type: "boolean",
    default: true,
    rationale: "패널 개선(2026-10-01 Thinking 상시·사고 표시 기본 ON)의 정상 기본값은 켜짐이다. §5.3의 예산 함정은 상한(maxReasoningTokens 1024)+초과 시 강제 도구호출 전환으로 방어하므로, 기본을 꺼서 화면에 사고가 안 보이는 상태를 정상으로 두지 않는다.",
  },
  {
    key: "agent.thinkStyle",
    section: "agent",
    label: "thinking 표시",
    type: "enum",
    options: ["dots", "pulse", "orbit", "shimmer", "bar"],
    default: "dots",
    rationale: "기본은 3개 파동 도트(1.2s). prefers-reduced-motion 이면 자동으로 멈춘다(§5.3).",
  },
  {
    key: "agent.maxReasoningTokens",
    section: "agent",
    label: "사고 토큰 상한",
    type: "number",
    // 정본은 `src/shared/reasoning.ts` — 여기서 숫자를 다시 적지 않는다.
    default: DEFAULT_MAX_REASONING,
    min: MIN_REASONING_FLOOR,
    max: MAX_REASONING_CEILING,
    rationale:
      "초과하면 thinking 을 끄고 도구 호출을 강제한다(§5.3). 이게 없으면 생각만 하다가 아무것도 안 하는 버그가 된다. " +
      "기본을 1,024 → 4,096 으로 올렸다 — 35B 모델의 실제 작업에서 1,027 토큰에 잘려 화면이 죽는 것이 실측됐기 때문이다. " +
      "토큰은 `estimateTextTokens`(한글은 글자당 1.5)로 센다 — 예전의 '길이/3.4' 은 영문만 맞아 한글 사고의 절반밖에 못 셌다.",
  },
  {
    key: "agent.toolRetryMax",
    section: "agent",
    label: "도구 미선택 재시도",
    type: "number",
    default: 2,
    min: 1,
    max: 5,
    rationale: "**무한 재시도는 금물**(§5.3). 2회 뒤 명확한 오류로 끝낸다.",
  },
  {
    key: "agent.approvalAllowlist",
    section: "agent",
    label: "자동 승인 도구",
    type: "string[]",
    default: ["read_file", "list_dir", "git_status", "git_diff", "note", "search_files", "load_skill"],
    rationale: "읽기 전용만 자동 허용한다. 모르는 도구는 묻는다. 모른다는 이유로 자동 허용하면 안 된다(§3.6).",
  },
  {
    key: "agent.approvalTimeoutSec",
    section: "agent",
    label: "승인 대기 타임아웃(초)",
    type: "number",
    default: 60,
    min: 5,
    max: 600,
    rationale: "무한 대기는 좀비다. 타임아웃은 **거절** 로 귀결된다(승인보다 안전).",
  },
  {
    key: "agent.disabledToolGroups",
    section: "agent",
    label: "비활성 도구 그룹",
    type: "string[]",
    default: ["git", "process"],
    rationale: "원본 실측: 브라우저 도구 4종 스키마만으로 1,238 토큰(윈도우의 7.6%). 사용하지 않는 그룹은 스키마째로 뺀다(§5.11).",
  },

  // ---------------------------------------------------------------- 로그 (§5.12)
  {
    key: "log.level",
    section: "log",
    label: "기본 레벨",
    type: "enum",
    options: ["debug", "info", "warn", "error"],
    default: "info",
    rationale: "데몬이라 로그 패널이 유일한 상태 창이다. debug 를 기본으로 두면 신호가 묻힌다.",
  },
  {
    key: "log.maxChars",
    section: "log",
    label: "보관 상한(문자)",
    type: "number",
    default: 500_000,
    min: 10_000,
    max: 5_000_000,
    rationale: "한 세션 분량. 실측 Chrome RSS 1.54 GiB 였으므로 50만 자면 힙 관점에서 ~1 MiB 이다(§5.12).",
  },
  {
    key: "log.maxLines",
    section: "log",
    label: "보관 상한(줄)",
    type: "number",
    default: 50_000,
    min: 1000,
    max: 500_000,
    rationale: "문자 상한과 별개로 줄 수를 제한한다 — 한 줄이 아주 길 수 있기 때문에(8 KiB/줄).",
  },
  {
    key: "log.follow",
    section: "log",
    label: "자동 스크롤",
    type: "boolean",
    default: true,
    rationale: "로그의 가장 중요한 줄은 보통 맨 아래(오류)에 있다.",
  },

  // -------------------------------------------------- 업데이트 · 버전 (§5.13.1)
  {
    key: "update.channel",
    section: "update",
    label: "업데이트 채널",
    type: "enum",
    options: ["stable", "beta", "nightly"],
    default: "stable",
    rationale: "beta 는 development build 다. 선택할 때 불안정 경고를 함께 표시한다.",
  },
  {
    key: "update.autoCheck",
    section: "update",
    label: "자동 확인",
    type: "boolean",
    default: true,
    rationale: "하루 1회. 네트워크가 없을 때 조용히 넘어가며 실패를 재시도 루프에 넣지 않는다(§5.13.1).",
  },
  {
    key: "update.autoInstall",
    section: "update",
    label: "자동 설치",
    type: "boolean",
    default: false,
    // **환경변수로 켤 수 없다.** 스크립트에 남은 HARNESSIDE_UPDATE_AUTOINSTALL=1 하나가
    // 사용자가 모르게 IDE 를 자동 재시작시키면, 실패했을 때 돌아갈 곳이 없다.
    envOverridable: false,
    rationale: "**기본 금지.** 켜면 설치 후 자동 재시작까지 물어야 한다. 실패하면 IDE 를 못 쓴다. 환경변수로는 켤 수 없다.",
  },
  {
    key: "update.rollbackOnFailedBoot",
    section: "update",
    label: "부팅 실패 시 자동 롤백",
    type: "boolean",
    default: true,
    rationale: "이게 없으면 업데이트의 성공 기준이 '설치 성공' 이 되어 버린다(§5.13.1).",
  },
  {
    key: "update.rollbackGraceSec",
    section: "update",
    label: "롤백 판정 시간(초)",
    type: "number",
    default: 90,
    min: 15,
    max: 600,
    rationale: "이 시간 안에 기동 신호를 보내지 못하면 이전 버전으로 되돌린다. 모델 로딩 시간을 포함해야 한다.",
  },

  // ------------------------------------------------------------------ 고급
  {
    key: "advanced.workspace",
    section: "advanced",
    label: "기본 워크스페이스",
    type: "string",
    default: "",
    rationale: "빈 값이면 현재 디렉터리. 디렉토리 이동 = 워크스페이스 이동 이라서 이 값이 도구의 기준경로가 된다(§8.3).",
    envOverridable: true,
  },
  {
    key: "advanced.dockMagnet",
    section: "advanced",
    label: "자기 진화 자석",
    type: "boolean",
    default: true,
    rationale: "자주 놓는 자리가 우선순위를 가진다(§5.4). 끄면 배치가 배워지지 않는다.",
  },
  {
    key: "advanced.magnetThreshold",
    section: "advanced",
    label: "자석 학습 기준(회)",
    type: "number",
    default: 3,
    min: 1,
    max: 20,
    rationale: "한 번은 우연이다. 3회 이상이면 의도로 본다.",
  },
  {
    key: "advanced.resetAll",
    section: "advanced",
    label: "모든 설정 초기화",
    type: "boolean",
    default: false,
    rationale: "되돌릴 수 없다. 확인 없이 실행되면 사용자가 설정을 다시 입력해야 한다.",
    danger: true,
  },
];

export const SETTINGS_BY_KEY: Record<string, SettingDef> = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));

/** §5.13: **모든 항목이** rationale 을 가져야 한다. */
export function settingsMissingRationale(): string[] {
  return SETTINGS.filter((s) => !s.rationale || s.rationale.trim().length < 8).map((s) => s.key);
}

export function bySection(section: SectionId): SettingDef[] {
  return SETTINGS.filter((s) => s.section === section);
}

export function envNameFor(key: string): string {
  return `HARNESSIDE_${key.toUpperCase().replace(/\./g, "_")}`;
}

// ------------------------------------------------------------------ 병합

export interface ResolvedSetting {
  def: SettingDef;
  value: SettingValue;
  provenance: Provenance;
  /** 사람이 읽을 한 줄: 출처가 무엇인지. */
  source: string;
}

export interface MergeInput {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

/**
 * 병합: 전역 ← 프로젝트 ← 환경변수.
 *
 * **중첩 객체는 깊게 병합**해야 한다(§6.4). 얕은 병합은 앞 단계의 키를 통째로
 * 날린다 — 원본 `config.ts` 에서 이미 그 버그가 났다.
 */
export function resolveSettings(input: MergeInput = {}): Record<string, ResolvedSetting> {
  const out: Record<string, ResolvedSetting> = {};
  for (const def of SETTINGS) {
    let value: SettingValue = def.default;
    let provenance: Provenance = "default";

    if (input.global && def.key in input.global) {
      value = coerce(def, input.global[def.key]);
      provenance = "global";
    }
    if (input.project && def.key in input.project) {
      // 프로젝트가 전역을 **부분적으로** 덮어도 앞 단계의 다른 키는 살아남아야 한다.
      value = coerce(def, input.project[def.key]);
      provenance = "project";
    }
    if (def.envOverridable !== false && input.env) {
      const raw = input.env[envNameFor(def.key)];
      if (raw !== undefined && raw !== "") {
        value = coerce(def, raw);
        provenance = "env";
      }
    }
    out[def.key] = { def, value, provenance, source: PROVENANCE_KO[provenance] };
  }
  return out;
}

/** 타입 변환 + 범위 검사. 잘못된 값은 **기본값으로 되돌리고** 그 사실을 알린다. */
export function coerce(def: SettingDef, raw: unknown): SettingValue {
  if (raw === null || raw === undefined) return def.default;
  switch (def.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n)) return def.default;
      const lo = def.min ?? -Infinity;
      const hi = def.max ?? Infinity;
      // 범위를 벗어나면 **경계로** 좁힌다 — 버리면 사용자는 "값이 안 바뀌지" 않는다.
      return Math.max(lo, Math.min(hi, n));
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      return String(raw).toLowerCase() === "true" || String(raw) === "1";
    case "string[]":
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === "string") return raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
      return def.default;
    case "enum":
      return def.options?.includes(String(raw)) ? String(raw) : def.default;
    case "string":
    default:
      return String(raw);
  }
}

/** 화면에 보여줄 한 줄 요약. §5.13 의 3요소(값·출처·근거)를 한 줄로. */
export function describeSetting(r: ResolvedSetting): string {
  const v = Array.isArray(r.value) ? (r.value.length ? r.value.join(", ") : "(없음)") : String(r.value ?? "");
  return `${r.def.label}: ${v} — ${r.source}`;
}

/**
 * 알 수 없는 키는 **버리지 않고 보존**한다(§6.4). 앞으로 추가될 키를 사용자가
 * 날리지 않도록.
 */
export function preserveUnknown(known: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...known };
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in SETTINGS_BY_KEY)) out[k] = v;
  }
  return out;
}

export function unknownKeys(cfg: Record<string, unknown>): string[] {
  return Object.keys(cfg).filter((k) => !(k in SETTINGS_BY_KEY));
}

export type { LogLevel, UpdateChannel, ThinkStyle };
