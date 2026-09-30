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
  // **크기를 모르면 점수를 만들지 않는다.** 100점을 주면 "비교가 되었다" 고 읽히지만
  // 실제로는 아무것도 비교하지 않은 것이다(실측: 후보 5개가 전부 100점 — 목록이
  // 아무 말도 하지 않는 목록이 되어). 미산정이면 0 이고, UI 가 그 사실을 보자다.
  const scored = m.bytes > 0;
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
  if (m.bytes <= 0) {
    // **알려진 사실**(다운로드 수)만으로 순위를 매긴다. 나머지 점수는 0(미산정)이다.
    notes.push("크기를 모릅니다 — 점수 비교가 불가능합니다(다운로드 수 순으로 봅니다)");
  }

  // §7.2: 계열은 점수와 **무관하게** 고정한다. 점수를 뒤집어 올리는 게 아니라
  // 점수 계산 **밖**에서 별도 슬롯을 준다 — 그래야 "왜 1순위지?" 에 답할 수 있다.
  return {
    model: m,
    score: scored ? Math.round(Math.max(0, Math.min(100, score))) : 0,
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
    .sort((a, b) =>
      // 크기를 모르는 항목(점수 0)끼리는 **점수로 정렬하지 않는다** — 모두 0 이라
      // 동률이고, 동률 정렬은 실행마다 순서가 달라질 수 있다(§5.10 store.list 와 같은
      // 교훈). 알려진 사실(다운로드 수)만으로 매긴다.
      a.score === 0 && b.score === 0 ? b.model.downloads - a.model.downloads : b.score - a.score
    )
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
    // **.gguf 여부만으로는 충분하지 않다**(실측: 상위 2개가 `mmproj-*.gguf` 였다).
    // mmproj 는 비전 투영기이고, `-vocab.gguf` 는 토크나이저 조각이며, `.part`/`.tmp` 는
    // **중단된 다운로드의 잔해**다. 이들을 "모델"로 추천하면 사용자는 다운로드한 뒤
    // "이건 뭐지" 를 하게 된다. `isUsableModel` 이 그 판정의 **정본**이므로 여기서 쓴다
    // (알림 쪽의 IGNORE_PATTERNS 와 같은 목록을 두 번 만들지 않는다).
    const gguf = files
      .map((f) => String(f?.rfilename ?? ""))
      .filter((f) => f.toLowerCase().endsWith(".gguf"))
      .filter((f) => isUsableModel(f));
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
/**
 * 후보들의 크기를 채운다.
 *
 * **방법이 두 가지인데, 순서가 중요하다.**
 *
 *  1. **저장소 트리 API 한 번** — `/api/models/{repo}/tree/main?recursive=true` 는
 *     그 저장소의 **모든 파일을 정확한 크기와 함께** 준다(실측: 31개 gguf · 10 KB 응답).
 *     여기서 크기를 먼저 채우면 **후보 수와 무관하게 저장소당 1 요청** 이다.
 *  2. 그래도 모이는 것만 **HEAD 로 개별 조회** 한다. 한계는 두 개다: 이 경로는
 *     **리다이렉트 상대 경로**(file:/ )를 못 따라가고, 개별 요청이라 쿼터를 쓴다.
 *
 * 왜 이 순서인가: 예전에 후보 12개로 **잘라 두고** "정확도 vs 쿼터" 라는 트레이드오프를
 * 골랐다. 그런데 트리 API 한 번이면 그 트레이드오프가 **사라진다** — 12개 제한은
 * 조회 비용을 아끼려고 둔 것인데, 비용이 이미 없어졌으므로 **잘라 내는 근거도 없다.**
 * 후보가 50개여도 요청은 저장소 수만큼이다. 사용자에게 "왜 50번째는 점수가 0 이냐"고
 * 설명해야 하는 상황 자체를 없앤다(§5.10).
 *
 * 그래도 **개별 조회는 상한을 둔다** — 트리 API 가 404 인 저장소(가산 필터)가 여럿이면
 * 그때만 N 번의 HEAD 가 나가므로, 그 길로만 자른다.
 */
export interface FillSizesResult {
  models: HubModel[];
  /** 트리 API 로 채운 개수 — "알고 있음" 과 "모름" 의 경계를 수치로 말한다. */
  fromTree: number;
  /** 개별 HEAD 로 채운 개수. */
  fromHead: number;
  /** 끝까지 모르는 후보 — 점수 0(미산정) 로 남는다. */
  unknown: string[];
  /** 실제로 나간 요청 수. */
  requests: number;
}

export async function fillSizes(
  models: HubModel[],
  opts: { headLimit?: number; fetchImpl?: typeof fetch; baseUrl?: string } = {}
): Promise<FillSizesResult> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? "https://huggingface.co";
  let requests = 0;

  // 1) 저장소별 트리 1회. **같은 저장소는 한 번만** 요청한다.
  const repos = [...new Set(models.map((m) => m.repo).filter(Boolean))];
  const sizes = new Map<string, number>();
  await Promise.all(
    repos.map(async (repo) => {
      try {
        requests++;
        const res = await f(`${base}/api/models/${repo}/tree/main?recursive=true`, {
          headers: { accept: "application/json", "user-agent": "harnesside" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return;
        const list = (await res.json()) as unknown;
        if (!Array.isArray(list)) return;
        for (const raw of list as Array<Record<string, unknown>>) {
          const path = typeof raw?.path === "string" ? raw.path : "";
          // LFS 파일은 `lfs.size` 가 정본이고, 일반 파일은 `size`.
          const lfs = raw?.lfs as { size?: unknown } | undefined;
          const size = Number(lfs?.size ?? raw?.size ?? 0);
          if (path && Number.isFinite(size) && size > 0) sizes.set(`${repo}/${path}`, size);
        }
      } catch {
        // 못 얻으면 조용히 넘어간다 — 뒤의 개별 조회가 보완해 준다(여기서 실패해도 끝이 아니다).
      }
    })
  );

  // 2) 트리로도 모르는 것만 개별 조회. **URL 한 번만 조립한다.**
  //    `file` 에 저장소가 이미 들어 있을 수 있어 그대로 붙이면 경로가 두 번 반복되고 404 다(실측).
  const headLimit = opts.headLimit ?? 12;
  const out = models.map((m) => ({ ...m }));
  const stillUnknown: HubModel[] = [];
  let fromTree = 0;
  for (const m of out) {
    if (m.bytes > 0) continue;
    const rel = m.file.startsWith(`${m.repo}/`) ? m.file.slice(m.repo.length + 1) : m.file;
    const hit = sizes.get(`${m.repo}/${rel}`) ?? sizes.get(rel);
    if (hit) {
      m.bytes = hit;
      fromTree++;
      continue;
    }
    stillUnknown.push(m);
  }
  const toHead = stillUnknown.slice(0, headLimit);
  await Promise.all(
    toHead.map(async (m) => {
      try {
        requests++;
        const rel = m.file.startsWith(`${m.repo}/`) ? m.file.slice(m.repo.length + 1) : m.file;
        const res = await f(`${base}/${m.repo}/resolve/main/${rel}`, { method: "HEAD", redirect: "follow" });
        const len = Number(res.headers.get("content-length") ?? 0);
        if (res.ok && Number.isFinite(len) && len > 0) m.bytes = len;
      } catch {
        // 못 얻으면 그대로 둔다 — "알 수 없음" 을 0 으로 지어내지 않는다
      }
    })
  );

  return {
    models: out,
    fromTree,
    fromHead: out.filter((m, i) => m.bytes > 0 && models[i].bytes <= 0).length - fromTree,
    unknown: out.filter((m) => m.bytes <= 0).map((m) => m.file),
    requests,
  };
}

/** 로컬 파일 하나가 우선 계열에 해당하는가 — "설치됨" 배지를 정한다. */
export function localMatchesPinned(file: string, series: string[] = DEFAULT_PRIORITY_SERIES): boolean {
  if (!isUsableModel(file)) return false;
  const lower = file.toLowerCase();
  return series.some((s) => lower.includes(s));
}
