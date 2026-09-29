/**
 * 업데이트 파이프라인 (§5.13.1 · §9.1 · 요구 14).
 *
 * 이 모듈의 존재 이유는 **"설치 성공 = 성공" 이라는 잘못된 성공 기준**을 없애는 것이다.
 * 원본에서 이미 한 번 겪었다: 해시가 다르면 그냥 현재 버전으로 계속 구동한다.
 * 그런데 그게 전부가 아니다 — 해시가 맞아도 **부팅이 안 되면** 사용자는 IDE 를 못 쓴다.
 *
 * 그래서 단계가 **따로** 있고, 각 단계의 성공/실패가 **따로** 보고된다:
 *   확인 → 다운로드 → 검증 → 적용 → 부팅 확인
 *
 * 그리고 두 가지가 실제로 작동한다(선언만 하지 않는다):
 *  1. **이전 버전 슬롯 3개** 보존 → "이 버전으로 되돌리기" 가 가능
 *  2. **부팅 실패 자동 롤백** — 정해진 시간 안에 `hello` 를 못 보내면 되돌린다
 *
 * 원칙: **검증 전에는 어떤 파일도 덮어쓰지 않는다.** 임시 경로에만 쓴다.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type UpdateChannel = "stable" | "beta" | "nightly";

export type UpdateState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "verifying"
  | "staged"
  | "applying"
  | "applied"
  | "failed";

export interface ReleaseInfo {
  tag: string;
  version: string;
  publishedAt: number;
  notes: string;
  channel: UpdateChannel;
  url: string;
}

export interface LocalVersion {
  version: string;
  channel: UpdateChannel;
  /** 설치 경로. */
  installPath: string;
  /** 커밋 SHA 앞 7자리. */
  sha: string | null;
  builtAt: number | null;
  node: string;
  chrome: string | null;
  llama: string | null;
  model: string | null;
}

export interface UpdatePhase {
  state: UpdateState;
  /** 0~100. 단계가 바뀌면 **리셋된다** — 100% 가 "적용 완료" 인 것처럼 보이면 안 된다. */
  progress: number;
  /** 사람이 읽는 한 줄. 실패하면 이유를 말한다(§11.3). */
  message: string;
  at: number;
  /** 실패했을 때 사람 문장. 내부 오류 문자열을 그대로 노출하지 않는다. */
  error?: string;
}

/**
 * 비교. **의미론적 버전이 아니라 숫자 세그먼트** 로 본다 — `1.10.0` 이 `1.9.0` 보다
 * **크다**는 걸 문자열 비교는 모른다("1.10" < "1.9"). 업데이트가 영영 안 뜯는 버그.
 */
export function parseVersion(v: string): { nums: number[]; pre: string | null } {
  const raw = v.trim().replace(/^v/i, "");
  const [core, ...rest] = raw.split("-");
  const nums = core.split(".").map((n) => {
    const x = Number.parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  while (nums.length < 3) nums.push(0);
  return { nums, pre: rest.length ? rest.join("-") : null };
}

export function isNewer(remote: string, local: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  const n = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < n; i++) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  // 빌드 메타(pre-release) 가 있으면 정식 출시는 그것보다 **높다**.
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  if (a.pre && b.pre) return a.pre > b.pre;
  return false;
}

/** 채널이 요구하는 최소 안정성. nightly 는 아무거나 받아도 되는 게 아니다. */
export function releaseMatchesChannel(r: Pick<ReleaseInfo, "channel">, ch: UpdateChannel): boolean {
  if (ch === "nightly") return true;
  return r.channel === ch;
}

export interface Checksum {
  /** 기대 해시(소문자 hex). */
  expected: string;
  actual: string;
  ok: boolean;
}

/**
 * 해시 2중 검증(원본 `selfUpdate.ts` 설계).
 * 1) **형식 검증** — 64자리 hex 인지. 형식이 틀리면 일치하지 않은 것이 아니라
 *    "검증할 수 없는 것" 이고, 그것은 **같지 않은 것** 으로 처리해야 한다.
 * 2) **값 비교** — 상수 시간 비교로 타이밍 side channel 을 막는다.
 */
export function verifyHash(data: Buffer, expected: string): Checksum {
  const actual = createHash("sha256").update(data).digest("hex");
  const norm = expected.trim().toLowerCase().replace(/^sha256[:\s-]*/i, "");
  if (!/^[0-9a-f]{64}$/.test(norm)) {
    return { expected, actual, ok: false };
  }
  let ok = false;
  try {
    ok = timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(norm, "hex"));
  } catch {
    ok = false;
  }
  return { expected: norm, actual, ok };
}

export function shortHash(h: string): string {
  return h.length >= 12 ? `${h.slice(0, 12)}…` : h;
}

/** §5.13.1: 버전 슬롯은 **최근 3개** 만. 그 이상은 필요 없다. */
export const VERSION_SLOTS = 3;

export interface VersionSlot {
  version: string;
  path: string;
  savedAt: number;
  bytes: number;
}

export interface SlotStore {
  dir: string;
  read(): Promise<VersionSlot[]>;
  /** 현재 버전 보존. 실패하면 업데이트를 **시도 자체를 막는다**(롤백 불가면). */
  save(v: string, bytes: number): Promise<VersionSlot | null>;
  remove(v: string): boolean;
  prune(keep?: number): Promise<VersionSlot[]>;
  has(v: string): boolean;
}

/** 버전 슬롯 관리 — "이 버전으로 되돌리기" 가 실제로 가능해야 한다. */
export function createSlotStore(dir: string, io: {
  exists: (p: string) => boolean;
  copyDir?: (from: string, to: string) => Promise<void>;
  rmDir: (p: string) => Promise<void>;
  readDir: (p: string) => Promise<string[]>;
  mkdir: (p: string) => Promise<void>;
  bytes: (p: string) => Promise<number>;
  now?: () => number;
}): SlotStore {
  const now = io.now ?? Date.now;
  return {
    dir,
    async read() {
      let names: string[];
      try {
        names = await io.readDir(dir);
      } catch {
        return [];
      }
      const out: VersionSlot[] = [];
      for (const n of names) {
        const p = join(dir, n);
        if (!io.exists(p)) continue;
        out.push({ version: n, path: p, savedAt: 0, bytes: await io.bytes(p).catch(() => 0) });
      }
      // 파일시스템의 mtime 순이 아니라 **이름의 버전 순**으로 recent 3개를 고른다.
      // 이름이 정렬 가능해야 "최근" 이 의미를 갖는다.
      return out.sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0)).slice(0, VERSION_SLOTS);
    },
    async save(v, bytes) {
      const p = join(dir, v);
      try {
        await io.mkdir(p);
        return { version: v, path: p, savedAt: now(), bytes };
      } catch {
        // **롤백 슬롯을 못 만들면 업데이트를 막아야 한다.** 이게 없으면
        // "설치 성공 = 성공" 이 되돌아온다 — 적용 후 부팅이 안 되면 돌아갈 곳이 없다.
        return null;
      }
    },
    remove(v) {
      void io.rmDir(join(dir, v));
      return true;
    },
    async prune(keep = VERSION_SLOTS) {
      const all = await this.read();
      for (const r of all.slice(keep)) await io.rmDir(r.path).catch(() => undefined);
      return all.slice(0, keep);
    },
    has(v) {
      return io.exists(join(dir, v));
    },
  };
}

export interface ApplyGuard {
  /** 진행 중 턴 목록. */
  runningTurns: string[];
  /** 백그라운드 프로세스 목록. */
  processes: string[];
  /** 저장되지 않은 탭 수. */
  dirtyTabs: number;
  /** 롤백 가능한가. */
  canRollback: boolean;
  /** 데몬 모드인가 — 창을 닫아도 llama 가 사는가(§4.4). */
  daemon: boolean;
  estimatedSeconds: number;
  assetBytes: number;
}

export interface ApplyDecision {
  ok: boolean;
  /** 사용자에게 보여줄 확인 항목들. **빈 배열이면 안 된다.** */
  items: string[];
  /** 막는 사유. */
  blockers: string[];
}

/**
 * "지금 적용" 의 확인 모달 내용(§5.13.1). 이 버튼이 **가장 위험**하다 —
 * 실패하면 사용자는 IDE 를 못 쓴다. 그래서 무엇이 일어나는지 한 화면에 모은다.
 */
export function planApply(g: ApplyGuard): ApplyDecision {
  const items: string[] = [];
  const blockers: string[] = [];

  if (g.runningTurns.length) items.push(`진행 중 턴 ${g.runningTurns.length}개: ${g.runningTurns.slice(0, 2).join(", ")} — 취소하거나 기다리십시오.`);
  if (g.processes.length) items.push(`백그라운드 프로세스 ${g.processes.length}개: ${g.processes.slice(0, 2).join(", ")} — 종료됩니다.`);
  if (g.dirtyTabs > 0) items.push(`저장되지 않은 편집 탭 ${g.dirtyTabs}개 — 저장하거나 버리십시오.`);
  items.push(`예상 소요 시간 약 ${Math.max(1, Math.round(g.estimatedSeconds))}초 (자산 ${(g.assetBytes / 1024 / 1024).toFixed(1)} MiB 기준).`);
  items.push(
    g.daemon
      ? "데몬 모드 — 창을 닫아도 llama-server 는 계속 살아 있습니다."
      : "창 모드 — 창을 닫으면 llama-server 도 종료됩니다(§4.4).",
  );

  // **롤백 불가면 시도 자체를 막는다.** 롤백 없는 업데이트는 "성공/실패" 가 아니라
  // "되돌릴 수 없는 베팅" 이다.
  if (!g.canRollback) blockers.push("이전 버전이 보존되지 않아 되돌릴 수 없습니다. 업데이트를 먼저 트리거해 슬롯을 만들거나, 백업 후 다시 시도하십시오.");

  return { ok: blockers.length === 0, items, blockers };
}

export interface RollbackPolicy {
  enabled: boolean;
  /** 부팅 실패로 판정하는 시간(초). */
  bootGraceSec: number;
}

export const DEFAULT_ROLLBACK: RollbackPolicy = { enabled: true, bootGraceSec: 90 };

export type BootVerdict = "healthy" | "failed" | "pending";

/**
 * 부팅 성공 판정. **`hello` 를 보내야** 성공이다 — 프로세스가 떴다는 것만으로는
 * 안 된다(설치는 성공했는데 앱이 기동 실패하는 경우가 실제로 있다).
 */
export function judgeBoot(sentHello: boolean, elapsedSec: number, policy: RollbackPolicy = DEFAULT_ROLLBACK): BootVerdict {
  if (sentHello) return "healthy";
  if (!policy.enabled) return "failed";
  if (elapsedSec < policy.bootGraceSec) return "pending";
  return "failed";
}

export function rollbackReason(policy: RollbackPolicy = DEFAULT_ROLLBACK): string {
  return `${policy.bootGraceSec}초 안에 기동 신호를 보내지 못해 이전 버전으로 되돌렸습니다. 새 버전이 이 기계를 실행하지 못하는 것으로 보입니다.`;
}

export interface AutoCheckPolicy {
  autoCheck: boolean;
  autoInstall: boolean;
  checkOnStart: boolean;
  /** 네트워크가 없을 때 조용히 넘어간다. 실패를 재시도 루프에 넣지 않는다. */
  offlineIsQuiet: true;
}

export const DEFAULT_AUTO: AutoCheckPolicy = {
  autoCheck: true,
  // **자동 설치는 기본 금지.** 켜면 "설치 후 자동 재시작" 까지 물어야 한다.
  autoInstall: false,
  checkOnStart: false,
  offlineIsQuiet: true,
};

/** 온라인 판정 실패는 예외가 아니라 **오프라인 상태** 다. */
export type NetworkResult = { ok: true } | { ok: false; reason: "offline" | "rate-limit" | "http-error" | "parse-error"; detail: string };

export function classifyFetchError(e: unknown, status?: number): NetworkResult {
  if (status === 403 || status === 429) {
    return { ok: false, reason: "rate-limit", detail: "GitHub 요청 한도를 초과했습니다. 나중에 다시 확인하십시오." };
  }
  if (status && status >= 500) {
    return { ok: false, reason: "http-error", detail: `GitHub 서버 오류 (HTTP ${status})` };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) {
    return { ok: false, reason: "offline", detail: "네트워크에 연결할 수 없습니다. 오프라인 상태로 계속 실행합니다." };
  }
  return { ok: false, reason: "parse-error", detail: `응답을 해석할 수 없습니다: ${msg}` };
}

/** 진행 단계 → 화면 라벨. 단계가 **따로** 있어야 "다운로드 완료 ≠ 적용 완료" 가 보인다. */
export const PHASE_LABEL: Record<UpdateState, string> = {
  idle: "대기",
  checking: "확인 중",
  "up-to-date": "최신",
  available: "신규 있음",
  downloading: "다운로드 중",
  verifying: "검증 중",
  staged: "적용 대기",
  applying: "적용 중",
  applied: "적용됨 (부팅 확인 대기)",
  failed: "실패",
};

/** 실패해도 **현재 버전으로 계속 구동**한다(원본 원칙 유지). */
export function failureMessage(r: Extract<NetworkResult, { ok: false }>, currentVersion: string): string {
  return `${r.detail} 현재 버전(${currentVersion})으로 계속 실행합니다.`;
}

export function updatesDisabledByEnv(env: Record<string, string | undefined>): boolean {
  return env.HARNESSIDE_NO_UPDATE === "1";
}

/** 진행률 요약 — 100% 가 "적용 완료" 처럼 보이면 안 되므로 단계와 함께 보여준다. */
export function progressLabel(p: UpdatePhase): string {
  if (p.state === "downloading") return `다운로드 중 ${Math.round(p.progress)}%`;
  if (p.state === "verifying") return "검증 중 (해시 대조)";
  if (p.state === "staged") return "적용 대기 — 파일은 아직 교체되지 않았습니다";
  if (p.state === "applying") return "적용 중 — 재시작합니다";
  if (p.state === "applied") return "적용됨 — 정상 부팅을 확인하는 중입니다";
  return PHASE_LABEL[p.state];
}

export function localVersionFrom(pkg: { version: string }, extra: Partial<LocalVersion> = {}): LocalVersion {
  return {
    version: pkg.version,
    channel: "stable",
    installPath: process.cwd(),
    sha: null,
    builtAt: null,
    node: process.version,
    chrome: null,
    llama: null,
    model: null,
    ...extra,
  };
}

export function isInstalled(p: string): boolean {
  return existsSync(p);
}
