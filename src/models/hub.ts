/**
 * HuggingFace 검색 + 추천 (§7.2 · §7.3 · P11 · 요구 5).
 *
 * 이 파일이 규칙을 **지키는** 자리다. 세 가지가 서로 다르고, 하나라도 빠지면 사용자가
 * 모델을 잘못 고른다:
 *
 *  1. **Ornith 계열은 점수와 무관하게 1순위 고정** (§7.2). 이 프로젝트의 튜닝·압축
 *     계수가 그 계열에서 실측됐으므로, 다른 모델을 올리면 성능과 안정성이 **같이** 떨어진다.
 *  2. **적합 점수** (§7.3 의 식). VRAM/RAM 이 부족하면 "다 쓰고 CPU 로 남는다" 가 되므로
 *     그 부족분을 강하게 감점한다.
 *  3. **폴백은 조용히 하지 않는다.** 계열을 못 찾으면 **왜** 못 찾았는지 말한다
 *     (§7.2 "조용히 다른 모델을 1순위로 올리는 것은 금지").
 *
 * 네트워크는 **주입**한다. 기본값이 진짜 API 를 두드리는 게 맞지만, 테스트가 그걸 쓰면
 * 그 테스트는 "오늘의 HuggingFace 응답" 을 검증하게 된다(그리고 네트워크가 없으면
 * 조용히 통과한다). 실제로 그류의 버그가 이 저장소에 있다(CI 에서 처음 드러남).
 */

import type { Hardware } from "../setup/hardware.js";
import { PINNED_FAMILY, isUsableModel, parseModelFile } from "./manage.js";

/** §7.2: 우선 계열은 **데이터** 다(하드코딩 금지). 기본 배열에 Ornith 가 들어간다. */
export const DEFAULT_PRIORITY_SERIES = ["ornith-1.5-35b-a3b"];

export interface HubModel {
  id: string;
  repo: string;
  file: string;
  /** 전체 크기(바이트). 알 수 없으면 0 — 0 을 "작다" 로 읽지 않게 한다. */
  bytes: number;
  downloads: number;
  license: string | null;
  gguf: boolean;
  toolCalling: boolean | null;
  thinking: boolean | null;
}

export interface ScoredModel {
  model: HubModel;
  score: number;
  family: string;
  quant: string | null;
  /** §7.3: 추정치임을 **근거와 함께** 보여준다(과신 금지). */
  estimate: { vramGiB: number; ramGiB: number; tokensPerSec: number | null; why: string };
  /** §7.2 우선 계열인가 — 점수와 무관하게 고정 배치된다. */
  pinned: boolean;
  /** 왜 감점되었는지(사용자가 "왜 이게 1순위지?" 물으면 이걸로 답한다). */
  notes: string[];
}

const GiB = 1024 ** 3;

/** 양자화 크기 순서(작음 → 큼). §7.2 표. 모르는 양자화는 순서를 매기지 않는다. */
const QUANT_ORDER = ["Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L", "IQ3_M", "Q4_K_S", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "BF16", "F16"];

/** 양자화의 크기 순서. 모르면 `null` — 0 과 다르다(0 은 "맨 작음" 이라는 뜻이다). */
export function quantRank(quant: string | null): number | null {
  if (!quant) return null;
  const up = quant.toUpperCase();
  const i = QUANT_ORDER.findIndex((q) => up.includes(q));
  return i >= 0 ? i : null;
}

/**
 * 같은 계열에서 **이 머신에 들어갈 파일** 하나를 고른다(§7.2 표).
 *
 * 규칙: 크기를 아는 것 중에서 "들어가는 것 중 가장 큰 것"(속도가 가장 좋은 것)을 고르고,
 * **모두 안 들어가면 가장 작은 것** 을 고르되 **그 사실을 함께 말한다.** 조용히 큰 것을
 * 고르면 사용자는 76 GB BF16 을 받는다(실측: 이전 버전이 정확히 그랬다).
 */
export function pickForMachine<T>(
  cands: T[],
  freeVramGiB: number,
  get: (c: T) => { bytes: number; quant: string | null },
  kvGiB = 9.6
): { pick: T | null; reason: string } {
  if (!cands.length) return { pick: null, reason: "파일이 있는 계열이 없습니다" };
  const sized = cands.filter((c) => get(c).bytes > 0);
  if (!sized.length) {
    // 크기를 하나도 모르면 **가장 작은 양자화** 를 고른다(알려진 사실만으로).
    const byRank = [...cands].sort((a, b) => (quantRank(get(a).quant) ?? 99) - (quantRank(get(b).quant) ?? 99));
    return { pick: byRank[0], reason: "파일 크기를 확인하지 못했습니다 — 가장 작은 양자화를 골랐습니다" };
  }
  const fits = sized.filter((c) => get(c).bytes / GiB + kvGiB <= freeVramGiB);
  if (fits.length) {
    const best = [...fits].sort((a, b) => (quantRank(get(b).quant) ?? 0) - (quantRank(get(a).quant) ?? 0))[0];
    return { pick: best, reason: `여유 VRAM ${freeVramGiB.toFixed(1)}GiB 에 들어가는 가장 큰 양자화입니다` };
  }
  const smallest = [...sized].sort((a, b) => get(a).bytes - get(b).bytes)[0];
  return {
    pick: smallest,
    reason: `**어떤 파일도 ${freeVramGiB.toFixed(1)}GiB 에 들어가지 않습니다** — 가장 작은 것을 골랐습니다. 컨텍스트를 줄이거나 더 작은 양자화를 확인하십시오`,
  };
}

/**
 * GGUF 헤더를 전제로 한 추정치. 정확하지 않으므로 `≈` 로 표시해야 한다.
 *
 * §7.3 의 KV 식 `0.3GiB × (contextK/1024)` 은 **contextK 가 'K 토큰' 단위** 라는
 * 뜻으로 읽어야 한다 — 즉 **1K 토큰당 0.3 GiB**, 32k 면 약 9.6 GiB 다.
 * (contextK 를 32 라고 받고 1024 로 한 번 더 나누면 9.6 MiB 가 되어 1000배 틀린다.
 * 실제로 그렇게 읽었다가 "Q4 가 8 GiB 카드에 충분히 들어간다" 는 잘못된 추천이 나왔다.
 * 35B Q8 KV 를 대략 계산해도 32k 에서 8.6 GB 라 9.6 GiB 쪽이 맞다.)
 */
export function estimateMemory(bytes: number, contextK = 32): { vramGiB: number; ramGiB: number } {
  if (bytes <= 0) return { vramGiB: 0, ramGiB: 0 };
  const weights = bytes / GiB;
  const kv = 0.3 * contextK;
  return { vramGiB: weights + kv, ramGiB: weights + kv + 0.5 };
}

/**
 * §7.3 의 점수식. **부족분**을 감점하는 것이 핵심 — 모형은 크면 클수록 좋은 게 아니라
 * 이 머신에 **들어가면** 좋은 것이다.
 */
export function scoreModel(m: HubModel, hw: Pick<Hardware, "gpus"> | null, opts: { pinnedSeries?: string[]; contextK?: number } = {}): ScoredModel {
  const series = (opts.pinnedSeries ?? DEFAULT_PRIORITY_SERIES).map((s) => s.toLowerCase());
  const hay = `${m.id} ${m.file}`.toLowerCase();
  const pinned = series.some((s) => hay.includes(s));
  const { family, quant } = parseModelFile(m.file);
  const notes: string[] = [];

  const mem = estimateMemory(m.bytes, opts.contextK ?? 32);
  const freeVram = hw?.gpus?.[0]?.vramFreeBytes ? hw.gpus[0].vramFreeBytes / GiB : 0;
  const vramShort = Math.max(0, mem.vramGiB - (freeVram || mem.vramGiB)); // 0 = 정보 없음

  let score = 100;
  if (freeVram > 0) {
    score -= Math.min(60, vramShort * 12);
    if (vramShort > 0) notes.push(`VRAM ${vramShort.toFixed(1)}GiB 부족 — 일부를 CPU 로 처리합니다`);
  }
  // **"모름" 과 "0" 을 구분한다.** 없으면 0 으로 보고하면 모든 모델이 만점에 가산점을
  // 잃는다(실측: 점수가 0 으로 뭉개졌다 — 탐지 결과에 RAM 이 없을 뿐이다).
  const ramAvail = (hw as unknown as { ramAvailableBytes?: number } | null)?.ramAvailableBytes;
  if (typeof ramAvail === "number" && ramAvail > 0) {
    const short = Math.max(0, mem.ramGiB - ramAvail / GiB);
    if (short > 0) {
      score -= Math.min(25, short * 5);
      notes.push(`RAM ${short.toFixed(1)}GiB 부족`);
    }
  }
  if (m.toolCalling === true) score += 8;
  if (m.thinking === true) score += 4;
  score += Math.min(10, Math.log10(Math.max(1, m.downloads)) * 1.2);
  const banned = m.license ? /^(cc0|apache|mit|bsd|llama|qwen|gemma|falcon|mistral)$/i.test(m.license) : false;
  if (m.license && !banned) {
    score -= 50;
    notes.push(`라이선스 확인 필요 (${m.license})`);
  }
  if (m.bytes <= 0) notes.push("크기를 모릅니다 — 점수 비교가 정확하지 않습니다");

  // §7.2: 계열은 점수와 **무관하게** 고정한다. 점수를 뒤집어 올리는 게 아니라
  // 점수 계산 **밖**에서 별도 슬롯을 준다 — 그래야 "왜 1순위지?" 에 답할 수 있다.
  return {
    model: m,
    score: Math.round(Math.max(0, Math.min(100, score))),
    family,
    quant,
    estimate: {
      vramGiB: mem.vramGiB,
      ramGiB: mem.ramGiB,
      // 속도는 **측정된 값이 없다** — 경험칙으로 숫자를 지어내면 사용자가 시간을 낭비한다.
      tokensPerSec: null,
      why:
        m.bytes > 0
          ? `가중치 ${(m.bytes / GiB).toFixed(1)}GiB + KV 약 ${(0.3 * (opts.contextK ?? 32)).toFixed(1)}GiB(32k, Q8 기준) — 실측이 아니라 추정입니다`
          : "크기 미상 — 추정 불가",
    },
    pinned,
    notes,
  };
}

/**
 * 추천 목록을 만든다(§7.2 + §7.3).
 *
 * 반환값에 **`fallbackReason` 이 있는 이유**: 우선 계열을 못 찾았을 때 그 사실을
 * 숨기면 "왜 추천이 이거지?" 에 답할 수 없다. §7.2 가 명시적으로 금지한 때문이다.
 */
export function recommend(
  models: HubModel[],
  hw: Pick<Hardware, "gpus"> | null,
  opts: { pinnedSeries?: string[]; localFiles?: string[]; topN?: number } = {}
): { pinned: ScoredModel | null; top: ScoredModel[]; fallbackReason: string | null; pinnedNote: string | null } {
  const series = opts.pinnedSeries ?? DEFAULT_PRIORITY_SERIES;
  const scored = models
    .filter((m) => m.gguf || m.file.toLowerCase().endsWith(".gguf"))
    .map((m) => scoreModel(m, hw, { pinnedSeries: series }));
  const pinnedList = scored.filter((s) => s.pinned);
  // §7.2: 계열 안에서는 **점수가 아니라 이 머신에 들어가는 파일** 을 고른다.
  // 이전처럼 "가장 큰 파일" 을 고르면 8GiB 카드에 BF16(76 GB) 을 추천한다(실측).
  const freeVramGiB = (hw?.gpus?.[0]?.vramFreeBytes ?? 0) / GiB;
  const chosen = pickForMachine(pinnedList, freeVramGiB, (s) => ({ bytes: s.model.bytes, quant: s.quant }));
  const pinned = chosen.pick ?? null;
  const pinnedNote = pinned ? chosen.reason : null;

  const top = scored
    // §7.2: 우선 계열은 "상위 5개 슬롯에 서로 경쟁시키지 않는다" 고 명시돼 있다.
    // **고른 하나만 빼면 나머지 같은 계열이 슬롯을 차지한다** — 계열 전체를 뺀다.
    .filter((s) => !s.pinned)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topN ?? 5);

  let fallbackReason: string | null = null;
  if (!pinned) {
    const localPin = (opts.localFiles ?? []).some((f) => series.some((s) => f.toLowerCase().includes(s)));
    if (localPin) {
      // **로컬에 있는데 마켓에 없다** = 계정/레이트리밋/오프라인. 그 사실을 구분한다.
      fallbackReason = "우선 계열(Ornith)이 로컬에는 있지만 이번 검색 결과에 없습니다. 네트워크·계정 상태를 확인하십시오.";
    } else {
      fallbackReason = `${PINNED_FAMILY} 계열을 찾지 못했습니다. 점수순으로 보여드리지만 기본 추천은 아닙니다.`;
    }
  }
  return { pinned, top, fallbackReason, pinnedNote };
}

/**
 * HF API 응답 → `HubModel`. **모르는 모양은 버린다** — 추측으로 채우면 사용자가
 * 존재하지 않는 모델을 다운로드한다.
 *
 * 실제로 그랬다: 검색 응답에 `siblings` 가 없으면 `model.gguf` 라는 **존재하지 않는
 * 파일 이름** 을 지어냈고, HEAD 가 404 라 크기를 못 채워 전부 100점 이 나왔다.
 * 이제는 **실제 파일이 있는 것만** 돌려준다. 파일을 모르면 그 모델은 없는 셈이다.
 */
export function parseHubSearch(json: unknown): HubModel[] {
  if (!Array.isArray(json)) return [];
  const out: HubModel[] = [];
  for (const raw of json as Array<Record<string, unknown>>) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!id) continue;
    const files = Array.isArray(raw.siblings) ? (raw.siblings as Array<{ rfilename?: string }>) : [];
    const gguf = files.map((f) => String(f?.rfilename ?? "")).filter((f) => f.toLowerCase().endsWith(".gguf"));
    if (!gguf.length) continue; // **파일을 모르면 추천하지 않는다**
    const downloads = Number(raw.downloads ?? 0);
    const license =
      typeof raw.cardData === "object" && raw.cardData ? ((raw.cardData as { license?: string }).license ?? null) : null;
    const tags = Array.isArray(raw.tags) ? (raw.tags as string[]).map((t) => String(t).toLowerCase()) : [];
    for (const f of gguf) {
      out.push({
        id,
        repo: id,
        file: f.includes("/") ? f : `${id}/${f}`,
        bytes: 0, // 목록 API 에는 크기가 없다. HEAD 로 따로 알아낸다.
        downloads: Number.isFinite(downloads) ? downloads : 0,
        license,
        gguf: true,
        toolCalling: tags.includes("tool-use") || tags.includes("function-calling") ? true : null,
        thinking: tags.includes("reasoning") ? true : null,
      });
    }
  }
  return out;
}

/**
 * 검색 응답에 파일 목록이 없던 저장소만 **한 번씩** 다시 물어본다.
 *
 * 비싸므로 **적게**(기본 5개) 한다. 그래도 못 찾으면 그 저장소는 **버린다** — 추측하지 않는다.
 */
export async function expandMissingFiles(
  json: unknown,
  opts: { limit?: number; fetchImpl?: typeof fetch; baseUrl?: string } = {}
): Promise<HubModel[]> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? "https://huggingface.co";
  const repos = Array.isArray(json) ? (json as Array<Record<string, unknown>>) : [];
  const missing = repos
    .filter((r) => typeof r?.id === "string" && !Array.isArray(r.siblings))
    .slice(0, opts.limit ?? 5);
  if (!missing.length) return parseHubSearch(json);
  const enriched: Array<Record<string, unknown>> = [];
  await Promise.all(
    missing.map(async (r) => {
      try {
        const res = await f(`${base}/api/models/${r.id}`);
        enriched.push(res.ok ? ((await res.json()) as Record<string, unknown>) : r);
      } catch {
        enriched.push(r);
      }
    })
  );
  const seen = new Set(enriched.map((e) => String(e.id)));
  return parseHubSearch([...repos.filter((r) => !seen.has(String(r?.id))), ...enriched]);
}

/** 검색 — 주입 가능. `limit` 과 검색어를 서버에 넘긴다(HTTP API 검색이다). */
export async function searchHub(opts: {
  query?: string;
  author?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): Promise<HubModel[]> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? "https://huggingface.co/api/models";
  const p = new URLSearchParams();
  p.set("filter", "gguf");
  p.set("sort", "downloads");
  p.set("direction", "-1");
  p.set("limit", String(Math.min(50, Math.max(1, opts.limit ?? 20))));
  if (opts.query) p.set("search", opts.query);
  if (opts.author) p.set("author", opts.author);
  const res = await f(`${base}?${p.toString()}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HuggingFace 검색 실패: HTTP ${res.status}`);
  // 파일 목록이 빠진 저장소가 있어 **한 번 더 물어본다**(그래야 존재하지 않는
  // 파일 이름을 지어내지 않는다).
  return expandMissingFiles(await res.json(), { fetchImpl: f, baseUrl: opts.baseUrl ?? "https://huggingface.co" });
}

/**
 * **파일 크기를 채운다.** HF 의 목록 API 에는 크기가 없다 — 그래서 그대로 점수를 매기면
 * **모두 100점** 이 나온다(실측: 추천 5개가 전부 100). 비교가 되지 않는 추천은 추천이 아니다.
 *
 * HEAD 를 하나씩 보내 크기를 얻는다. **적게** 보낸다(기본 12개) — 그 이상은 마크를
 * 아끼려고 하는 사용자 입장에서 공격이 된다. 못 얻은 것은 **0 으로 남긴다**(추측 금지).
 */
export async function fillSizes(
  models: HubModel[],
  opts: { limit?: number; fetchImpl?: typeof fetch; baseUrl?: string } = {}
): Promise<HubModel[]> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? "https://huggingface.co";
  const need = models.filter((m) => m.bytes <= 0).slice(0, opts.limit ?? 12);
  const out = [...models];
  await Promise.all(
    need.map(async (m) => {
      try {
        // **URL 한 번만 조립한다.** `file` 에 저장소가 이미 들어 있을 수 있어서
        // 그대로 붙이면 경로가 두 번 반복되고 404 가 된다(실측: 크기를 못 채웠다).
        const rel = m.file.startsWith(`${m.repo}/`) ? m.file.slice(m.repo.length + 1) : m.file;
        const res = await f(`${base}/${m.repo}/resolve/main/${rel}`, { method: "HEAD", redirect: "follow" });
        const len = Number(res.headers.get("content-length") ?? 0);
        if (res.ok && Number.isFinite(len) && len > 0) m.bytes = len;
      } catch {
        // 못 얻으면 0 — "알 수 없음" 을 지어내지 않는다
      }
    })
  );
  return out;
}

/** 로컬 파일 하나가 우선 계열에 해당하는가 — "설치됨" 배지를 정한다. */
export function localMatchesPinned(file: string, series: string[] = DEFAULT_PRIORITY_SERIES): boolean {
  if (!isUsableModel(file)) return false;
  const lower = file.toLowerCase();
  return series.some((s) => lower.includes(s));
}
