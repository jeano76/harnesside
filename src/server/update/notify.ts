/**
 * 추천 알림 (§5.13.2) — HF 새 모델 · llama.cpp 빌드 변경.
 *
 * 이 기능이 위험한 지점은 **노이즈** 다. 좋은 알림 하나를 만들려면 그보다 중요한
 * 조건(노이즈 규칙·silence)을 먼저 만족해야 한다. 그래서 판단과 표시가 분리돼 있고,
 * 판단 결과에 **무시 규칙(silence)** 이 붙는다.
 *
 *HF 는 감시가 어렵다: 파일 목록만으로는 "이게 새 양자화인지" 알 수 없다.
 * 그래서 **파일 기준**(mtime·크기 해시) 으로 변경을 감지하고, 적합도 판정과 함께
 * 알린다. **내용을 안 읽는다** — 수십 GB 를 읽으면 알림 하나가 부하가 된다.
 */

import { stat } from "node:fs/promises";
import { join, basename } from "node:path";

/** §5.13.2: 이 파일들에 대해서만 알린다. 나머지는 노이즈다. */
export const RELEVANT_SUFFIX = /\.gguf$/i;
export const IGNORE_PATTERNS = [/mmproj/i, /-vocab\.gguf$/i, /\.part$/i, /incomplete/i];

/** llama.cpp 빌드 변경: 실행 중인 binary 기준(소스 리빌드 시 튜닝/GPU 모드 재적용 경고). */
export type LlamaSignal = "binary-changed" | "source-rebuilt" | "flags-stale";

export interface ModelCandidate {
  file: string;
  bytes: number;
  mtimeMs: number;
  /** 파일 기준 지문. 내용 해시(수십 GB 를 읽지 않는다). */
  fingerprint: string;
}

export interface RecommendationNotice {
  id: string;
  kind: "model" | "llama";
  title: string;
  body: string;
  /** 적합도 0~100. 낮으면 알릴 이유가 약하다. */
  fit: number;
  at: number;
  /** 이 알림을 무시하면 같은 항목은 다시 알리지 않는다. */
  silenceKey: string;
  /** 경고성 — 실패를 다루는 알림은 조용한 토스트가 아니라 배너(§5.13.1). */
  severity: "info" | "warn" | "action";
}

/** 적합도: 기존 이름/양자화가 무엇이든 **같은 계열** 이면 상위. */
export function fitScore(current: { family: string; quant: string | null }, cand: { family: string; quant: string | null }): number {
  if (cand.family === current.family) {
    // 같은 계열 + 더 높은 양자화면 더 좋다고 본다(실측: 큰 것이 빠르다).
    if (current.quant && cand.quant) {
      if (cand.quant > current.quant) return 95;
      if (cand.quant === current.quant) return 80;
      return 60;
    }
    return 85;
  }
  // 다른 계열은 존재하지만, "추천" 이라기엔 근거가 약하다.
  return 30;
}

/** 양자화 등급 비교 (문자열이 아니라 순서). "Q5_K_M" > "Q4_K_M" 이어야 한다. */
const QUANT_RANK: [RegExp, number][] = [
  [/IQ\d/i, 90],
  [/Q6/i, 70],
  [/Q5/i, 60],
  [/Q4/i, 50],
  [/Q3/i, 40],
  [/Q2/i, 30],
  [/F16/i, 20],
  [/F32/i, 10],
];

export function quantRank(q: string | null): number {
  if (!q) return 0;
  for (const [re, n] of QUANT_RANK) if (re.test(q)) return n;
  return 0;
}

/** 파일명에서 계열과 양자화를 뽑는다. 추측이 아니라 **규칙** 으로. */
export function parseModelName(file: string): { family: string; quant: string | null; mmproj: boolean } {
  const name = basename(file);
  const mmproj = /mmproj/i.test(name);
  // 양자화 태그는 **대문자로 정규화**한다. 파일명이 `f16` 이든 `F16` 이든 같은
  // 양자화인데 소문자로 남으면 문자열 비교가 틀어지고, "같은 모델" 판정이 깨진다.
  const quantRaw = name.match(/[IQF]\d+[_A-Z0-9]*/i)?.[0] ?? null;
  const quant = quantRaw ? quantRaw.toUpperCase() : null;
  // 계열: 양자화/확장자를 뗀 부분. "Ornith-30B-Q5_K_M.gguf" → "Ornith-30B"
  //
  // **뒤에 남는 구분자를 반드시 턴다.** 양자화를 떼면 "Ornith-30B-" 가 남는데,
  // 이 꼬리표가 있으면 계열 문자열이 "Ornith-30B" 와 **다르다** — 적합도 판정이
  // 통째로 0 이 되어 추천 알림이 조용히 사라진다(실제로 그렇게 났다).
  const family = name
    .replace(/\.gguf$/i, "")
    .replace(/[IQF]\d+[_A-Z0-9]*$/i, "")
    .replace(/[-_.]+$/, "")
    .replace(/[-_.]?gguf$/i, "")
    .trim();
  return { family: family || name, quant, mmproj };
}

/** 무시되어야 하는 파일인지. 노이즈는 여기서 제거한다. */
export function isNoise(file: string): boolean {
  if (!RELEVANT_SUFFIX.test(file)) return true;
  return IGNORE_PATTERNS.some((re) => re.test(file));
}

export interface WatchState {
  seen: Map<string, string>;
  silenced: Set<string>;
}

export function newWatchState(): WatchState {
  return { seen: new Map(), silenced: new Set() };
}

/**
 * 디렉터리 한 번 훑기. **내용을 읽지 않는다** — stat 만 쓴다.
 * 수십 GB 의 GGUF 를 해시하면 "알림 하나가 30초" 가 된다.
 */
export async function scanModels(dir: string, list: (p: string) => Promise<string[]>): Promise<ModelCandidate[]> {
  let names: string[];
  try {
    names = await list(dir);
  } catch {
    return [];
  }
  const out: ModelCandidate[] = [];
  for (const n of names) {
    if (isNoise(n)) continue;
    const full = join(dir, n);
    const st = await stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    // 파일 기준 지문: 크기 + mtime(밀리초). 목록 비교용으로는 충분하고,
    // **같은 내용을 다시 알리지 않는다** (mtime 이 같으면 무시).
    out.push({ file: n, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), fingerprint: `${st.size}:${Math.round(st.mtimeMs)}` });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * 새 파일 감지 → 추천 알림. **한 번만** 알린다: 같은 지문은 이미 본 것으로 처리한다.
 */
export function detectNewModels(
  state: WatchState,
  candidates: ModelCandidate[],
  current: { family: string; quant: string | null },
  now = Date.now(),
  minFit = 60
): RecommendationNotice[] {
  const notices: RecommendationNotice[] = [];
  for (const c of candidates) {
    const prev = state.seen.get(c.file);
    if (prev === c.fingerprint) continue; // 같은 지문 = 새 것이 아니다
    state.seen.set(c.file, c.fingerprint);

    const { family, quant, mmproj } = parseModelName(c.file);
    if (mmproj) continue;
    const fit = fitScore(current, { family, quant });
    if (fit < minFit) continue; // 근거 없는 추천은 노이즈다
    const key = `model:${c.file}:${c.fingerprint}`;
    if (state.silenced.has(key)) continue; // 무시한 항목은 **재발하지 않는다**

    notices.push({
      id: key,
      kind: "model",
      title: `새 모델 발견: ${c.file}`,
      body: `${family}${quant ? ` (${quant})` : ""} · ${(c.bytes / 1024 ** 3).toFixed(1)} GiB · 현재 모델(${current.family})과 동일 계열입니다.`,
      fit,
      at: now,
      silenceKey: key,
      severity: fit >= 90 ? "action" : "info",
    });
  }
  return notices;
}

/** llama.cpp 빌드 변경 감지. */
export function detectLlama(
  state: WatchState,
  info: { binaryMtimeMs: number; binarySize: number; flags: string[]; expectedFlags: string[] },
  now = Date.now()
): RecommendationNotice[] {
  const out: RecommendationNotice[] = [];
  const fp = `${info.binarySize}:${Math.round(info.binaryMtimeMs)}`;
  const prev = state.seen.get("llama:binary");
  if (prev !== fp) {
    const first = prev === undefined;
    state.seen.set("llama:binary", fp);
    if (!first) {
      const key = `llama:binary:${fp}`;
      if (!state.silenced.has(key)) {
        out.push({
          id: key,
          kind: "llama",
          title: "llama-server 바이너리가 바뀌었습니다",
          body: `실행 중인 바이너리의 기준이 ${new Date(info.binaryMtimeMs).toLocaleString("ko-KR")} 로 갱신되었습니다. 서버를 재시작해야 새 빌드가 반영됩니다.`,
          fit: 100,
          at: now,
          silenceKey: key,
          severity: "action",
        });
      }
    }
  }

  // 소스 리빌드 시 **튜닝/GPU 모드가 무효화**된다 — 이건 조용히 두면 안 된다.
  const missing = info.expectedFlags.filter((f) => !info.flags.includes(f));
  if (info.flags.length > 0 && missing.length) {
    const key = `llama:flags:${missing.join(",")}`;
    if (!state.silenced.has(key)) {
      out.push({
        id: key,
        kind: "llama",
        title: "llama-server 플래그가 현재 설정과 다릅니다",
        body: `누락된 플래그: ${missing.join(" ")}. 소스 리빌드로 튜닝·GPU 모드가 초기화되었습니다. 서버 재시작 시 자동 재적용됩니다.`,
        fit: 90,
        at: now,
        silenceKey: key,
        severity: "warn",
      });
    }
  }
  return out;
}

/** 무시(silence). 같은 항목은 **다시 알리지 않는다**. */
export function silence(state: WatchState, notice: RecommendationNotice): void {
  state.silenced.add(notice.silenceKey);
}

export function silenceAllOfKind(state: WatchState, kind: RecommendationNotice["kind"]): number {
  let n = 0;
  for (const key of [...state.silenced]) {
    if (key.startsWith(`${kind}:`)) {
      state.silenced.add(key);
      n++;
    }
  }
  return n;
}

/**
 * 백그라운드 체크 규칙(§5.13.2): **유휴 시에만** · 429 백오프 · 오프라인 조용 통과.
 * "조용히 통과" 가 중요하다 — 실패를 배너로 띄우면 사용자가 버그로 오인한다.
 */
export interface CheckPolicy {
  idleOnly: boolean;
  minIntervalMs: number;
  backoffOn429: boolean;
  offlinePassesQuietly: true;
}

export const DEFAULT_CHECK: CheckPolicy = { idleOnly: true, minIntervalMs: 60 * 60 * 1000, backoffOn429: true, offlinePassesQuietly: true };

export interface CheckDecision {
  run: boolean;
  /** 조용히 넘어가야 하는 이유 — 배너가 아니라 로그 한 줄. */
  quiet?: "too-soon" | "busy" | "offline";
  nextDelayMs?: number;
}

export function shouldCheck(p: CheckState, policy: CheckPolicy = DEFAULT_CHECK, now = Date.now()): CheckDecision {
  if (p.offline) {
    // 오프라인 조용 통과. 배너를 띄우면 "뭐가 잘못됐지" 하고 사용자가 찾아온다.
    return { run: false, quiet: "offline" };
  }
  if (policy.idleOnly && !p.idle) return { run: false, quiet: "busy" };
  if (now - p.lastCheckAt < policy.minIntervalMs) {
    return { run: false, quiet: "too-soon", nextDelayMs: policy.minIntervalMs - (now - p.lastCheckAt) };
  }
  return { run: true };
}

export interface CheckState {
  lastCheckAt: number;
  offline: boolean;
  idle: boolean;
  rateLimitUntil: number;
}

export function newCheckState(): CheckState {
  return { lastCheckAt: 0, offline: false, idle: true, rateLimitUntil: 0 };
}

export function onRateLimited(s: CheckState, now = Date.now()): CheckState {
  // 429 를 재시도 루프에 넣지 않는다 — **기다린다**.
  return { ...s, rateLimitUntil: now + 60 * 60 * 1000, lastCheckAt: now };
}

export function onOffline(s: CheckState): CheckState {
  return { ...s, offline: true };
}

export function onOnline(s: CheckState): CheckState {
  return { ...s, offline: false };
}

/** 알림 목록을 사용자 눈높이 순으로. 배너(경고·조치)를 먼저, 조용한 것은 뒤로. */
export function sortNotices(list: RecommendationNotice[]): RecommendationNotice[] {
  const rank = { action: 0, warn: 1, info: 2 } as const;
  return [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || b.fit - a.fit || b.at - a.at);
}

/** 배너는 조용한 토스트가 아니다(§5.13.1) — 사용자가 놓치면 업데이트를 못 한다. */
export function needsBanner(n: RecommendationNotice): boolean {
  return n.severity !== "info";
}
