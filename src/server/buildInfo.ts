/**
 * 빌드 신원 — **날짜 + 해시**(R-1).
 *
 * 이 파일이 버전·빌드 정보의 **정본**이다. `version.ts` 와 `updateService.ts` 는
 * **읽기만** 한다. 값이 세 곳에 있으면 하나가 반드시 뒤처진다.
 *
 * ── 왜 두 층인가 (PROMPT_RELEASE_SELFUPDATE.md §0.1) ────────────────────────
 *
 *   릴리스 식별자  0.1.0              ← package.json. 정본. `isNewer` 가 본다.
 *   빌드 신원      2026.10.05-08c4467  ← 여기. 화면·로그·검증이 본다.
 *
 * 날짜 버전을 **정체성**으로 쓰지 않는다. `version.ts` 가 날짜 형식을 지운 이유
 * ("같은 날 두 번 내면 구분이 안 된다")는 그대로 맞기 때문이다 — 그래서 SemVer 를
 * 정본으로 남기고, 날짜+해시는 **증명하는 값**으로만 쓴다.
 *
 * ── 주입 방식: 빌드가 코드를 **굽는다** ──────────────────────────────────────
 *
 * 런타임에 `git` 을 실행해 커밋을 물으면 **설치된 배포물에서 git 저장소가 없다.**
 * 그 순간 `sha` 는 "확인 못 함" 이 되고, 확인했다는 사실이 없다.
 * 그래서 `scripts/gen-build-info.mjs` 가 빌드 시점에 `buildInfo.json` 을 **옆에** 굽고,
 * 우리는 그 파일을 읽기만 한다.
 *
 * 위치 규칙: `src/server/` 와 `dist/server/` 는 둘 다 패키지 루트에서 두 단계
 * 아래라 **같은 상대 경로**가 맞는다(`version.ts` 와 같은 규칙).
 *
 * ── 이 값이 증명하는 것 / 증명하지 못하는 것 (§0.2) ─────────────────────────
 *
 *   증명한다      이 바이너리가 어느 커밋에서, 어느 시각(UTC)에 빌드되었는가.
 *                 배포물 바이트가 `manifest.json` 이 선언한 것과 같은가.
 *   증명하지 못한다  그 바이트가 **신뢰할 수 있는지**. 코드 서명이 없다 — 해시값은
 *                 공격자가 자기 악성코드와 함께 다시 계산할 수 있다.
 *   의존한다      빌드 머신의 시계(`date`), 그리고 `dirty=false` 라는 주장
 *                 (깨끗한 트리라는 건 이 파일이 아니라 **git** 이 증명한다).
 */

import { readFileSync } from "node:fs";

export interface BuildInfo {
  /** 릴리스 식별자 — SemVer. `isNewer` 가 이 값을 본다. */
  version: string;
  /** 빌드일 (UTC `YYYYMMDD`). 로컬 타임존이 아니다 — 재현성의 원수다. */
  date: string | null;
  /** 커밋 SHA 앞 7자리. */
  sha: string | null;
  /** 더티 트리에서 빌드했는가. `null` = **모른다**(git 이 없다). */
  dirty: boolean | null;
  /** 빌드 시각 (epoch ms). */
  builtAt: number | null;
  /** 값이 **주입**되었는가. false = 개발 실행(또는 파일이 없다). */
  stamped: boolean;
  /** 사람이 읽는 한 줄 — 화면·로그용. 단정하지 않는다. */
  label: string;
}

/** 이 값들이 전부 없으면 **아무것도 아는 것이 아니다.** 그렇게 말한다. */
const UNKNOWN: BuildInfo = {
  version: "확인 못 함",
  date: null,
  sha: null,
  dirty: null,
  builtAt: null,
  stamped: false,
  label: "개발 실행 (빌드 신원 없음)",
};

/**
 * 주입 파일의 위치를 **한 곳**에서 정한다.
 *
 * 여기서 정하지 않으면 "개발 중" 과 "설치됨" 이 다른 파일을 보게 되고,
 * 그 차이를 아무도 설명할 수 없다.
 */
export function buildInfoUrl(moduleUrl: string = import.meta.url): URL {
  return new URL("./buildInfo.json", moduleUrl);
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildLabel(v: string, date: string | null, sha: string | null, dirty: boolean | null): string {
  if (!date && !sha) return v;
  // **뒤에 뭐가 붙는지 모르게** 한 줄로 이으면 화면에서 읽을 수 없다.
  // 그래서 로그는 `date sha`, 화면은 필드로 나눈다(R-2.3).
  // dirty 는 `false` 일 때 아무것도 안 붙인다 — 깨끗한 게 기본이고, 이상할 때만 말한다.
  const dirtyMark = dirty === true ? " (더티)" : "";
  return `${v} · ${date ?? "날짜 모름"}-${sha ?? "해시 모름"}${dirtyMark}`;
}

/**
 * 주입 파일 **하나**를 읽는다. 순수 함수라 테스트가 파일을 직접 만든다.
 *
 * 파싱에 실패하면 조용히 UNKNOWN 이 아니다 — **`stamped:false` 인 것은 사실**이고,
 * 그 사실이 "개발 실행" 과 "주입 파일이 깨졌다" 를 구분해 준다.
 */
export function loadBuildInfo(file: string | URL | null, fallbackVersion: string): BuildInfo {
  if (file === null) return { ...UNKNOWN, version: fallbackVersion };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ...UNKNOWN, version: fallbackVersion };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // **깨진 주입 파일은 조용히 넘어가면 안 된다.** `stamped:false` 라고 표시될 뿐이고,
    // 그때 CI 가 이 경우를 실패로 잡게 한다(gen-build-info.mjs 가 자기 출력을 검증한다).
    return { ...UNKNOWN, version: fallbackVersion, label: "빌드 신원 파일이 깨졌습니다 (개발 실행 아님)" };
  }
  if (typeof json !== "object" || json === null) return { ...UNKNOWN, version: fallbackVersion };

  const o = json as Record<string, unknown>;
  const version = isStr(o.version) ? o.version : fallbackVersion;
  const date = isStr(o.date) ? o.date : null;
  const sha = isStr(o.sha) ? o.sha : null;
  const dirty = typeof o.dirty === "boolean" ? o.dirty : null;
  const builtAt = num(o.builtAt);
  // **주입된 파일이 없으면 확정하지 않는다.** 두 값이 다 없는데 확정하면 거짓이다.
  const stamped = date !== null || sha !== null;
  if (!stamped) return { ...UNKNOWN, version, label: "빌드 신원 값이 비어 있습니다 (개발 실행 아님)" };
  return { version, date, sha, dirty, builtAt, stamped, label: buildLabel(version, date, sha, dirty) };
}

let cached: BuildInfo | null = null;

/** 정본 접근자. 한 번 읽고 캐시한다 — 호출마다 파일시스템을 읽지 않는다. */
export function readBuildInfo(): BuildInfo {
  if (cached) return cached;
  // `version.ts` 와 같은 상대 경로 규칙: 둘 다 패키지 루트에서 두 단계 아래.
  let version = UNKNOWN.version;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (isStr(pkg.version)) version = pkg.version;
  } catch {
    /* package.json 을 못 읽으면 "확인 못 함" 그대로 — 지어내지 않는다. */
  }
  cached = loadBuildInfo(buildInfoUrl(), version);
  return cached;
}

/** 테스트용 — 캐시를 비운다. 서버에서는 부팅에 한 번만 호출된다. */
export function resetBuildInfoCache(): void {
  cached = null;
}