/**
 * Is this model ALREADY on the machine? If so it is used where it is — no download, no copy.
 *
 * The previous reuse checks looked in one place each: the exact path in the config, the
 * exact filename in the models directory, and same-size-same-quant in that same directory.
 * Models are not kept in one place (this machine has them under `~/models` and on
 * `/media/<user>/<disk>/models/<family>/`), so a model that was a minute away on another
 * disk was downloaded again, 5 to 20 GB at a time.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { modelFamilyOf, pickPinnedCandidate, type ModelCandidate } from "./modelCatalog.js";
import { readGgufFingerprint, sameFingerprint, type GgufFingerprint } from "./ggufMeta.js";
import { baseName } from "../shared/path.js";

export interface LocalGguf {
  path: string;
  sizeBytes: number;
}

/** Walks `dirs` (depth-bounded, dot-directories skipped) and lists the .gguf files in them.
 *  Bounded on both axes because this runs inside a slash command on a real filesystem; a
 *  miss only means a download is proposed, a hang would be worse. `.part` files and the
 *  downloader's own staging folders are never candidates: they are unfinished by definition. */
export async function scanModels(
  dirs: string[],
  opts: { depth?: number; budget?: number; readdirImpl?: typeof readdir; statImpl?: typeof stat } = {}
): Promise<LocalGguf[]> {
  const rd = opts.readdirImpl ?? readdir;
  const st = opts.statImpl ?? stat;
  const budget = { left: opts.budget ?? 600 };
  const seen = new Set<string>();
  const out: LocalGguf[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (seen.has(dir) || budget.left-- <= 0) return;
    seen.add(dir);
    let entries;
    try {
      entries = await rd(dir, { withFileTypes: true });
    } catch {
      return; // absent or unreadable
    }
    for (const e of entries) {
      if (e.isFile() && /\.gguf$/i.test(e.name)) {
        try {
          out.push({ path: join(dir, e.name), sizeBytes: (await st(join(dir, e.name))).size });
        } catch {
          /* vanished between listing and stat */
        }
      }
    }
    if (depth <= 0) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) await walk(join(dir, e.name), depth - 1);
    }
  };

  for (const d of dirs) await walk(d, opts.depth ?? 2);
  return out;
}

/** The quant tag of a filename (`Q4_K_M`, `Q2_K`, …), or null. */
export function quantTag(filename: string): string | null {
  const base = filename.replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/, "");
  const m = /-(Q\d_0(?:_g\d+)?|Q\d_K(?:_[SML]|_XL)?|IQ\d_\w+|BF16|F16|F32)$/i.exec(base);
  return m ? m[1].toUpperCase() : null;
}

/**
 * A local file that IS this candidate, or null.
 *
 *  1. The same filename at (at least) the published size. Smaller is an incomplete copy and
 *     is never reused; a larger one is accepted (the Hub republishes under the same name
 *     with a different byte count, and a working model must not be replaced for that).
 *  2. A different name with EXACTLY the published size and the same quant — the Hub and the
 *     disk disagree about names constantly (`Ornith-1.5-35B-…` vs `…-35B-A3B-…`).
 *
 * Not hashed: this is the file the user already runs. Hashing 20 GB at every launch to
 * "prove" it is the one they already trust costs minutes and can only ever delete a model
 * that works.
 */
export function pickReusable(candidate: { filename: string; sizeBytes: number }, local: LocalGguf[]): LocalGguf | null {
  const base = (p: string) => baseName(p);
  const exact = local
    .filter((f) => base(f.path).toLowerCase() === candidate.filename.toLowerCase())
    .filter((f) => !candidate.sizeBytes || f.sizeBytes >= candidate.sizeBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  if (exact) return exact;
  const want = quantTag(candidate.filename);
  if (!candidate.sizeBytes || !want) return null;
  return local.find((f) => f.sizeBytes === candidate.sizeBytes && quantTag(base(f.path)) === want) ?? null;
}

/**
 * For a model chosen by NAME with no Hub listing to hand (the `/models` table): any local
 * file of the same family, in the quant the downloader itself would have fetched. Reuses the
 * downloader's own preference order, so "what we would download" and "what we reuse" agree.
 */
export function pickFamilyMatch(filename: string, local: LocalGguf[]): LocalGguf | null {
  const family = modelFamilyOf(filename).toLowerCase();
  const asCandidates: ModelCandidate[] = local
    .filter((f) => modelFamilyOf(baseName(f.path) ?? "").toLowerCase() === family)
    .map((f) => ({ repo: "local", filename: baseName(f.path), sizeBytes: f.sizeBytes, url: f.path }));
  const pick = pickPinnedCandidate(asCandidates, filename);
  if (!pick) return null;
  return local.find((f) => baseName(f.path) === pick.filename && f.sizeBytes === pick.sizeBytes) ?? null; // by name, not by "/" suffix: Windows paths use "\\"
}

/**
 * The family with the MoE size marker removed: `Ornith-1.5-35B-A3B` and
 * `Ornith-1.5-35B` are the same model renamed, but `modelFamilyOf` keeps the
 * marker and reports them as different families. Used ONLY as a prefilter for
 * the header-fingerprint check below — never as a verdict by itself.
 */
export function familyRootOf(filename: string): string {
  return modelFamilyOf(filename).replace(/-A\d+B$/i, "").toLowerCase();
}

/** How far a same-weights file's size may drift from the published size and still match. */
export const SAME_WEIGHTS_SIZE_TOLERANCE = 0.02;

export interface SameWeightsHit {
  path: string;
  sizeBytes: number;
  /** User-facing: why a differently-named, differently-sized file is trusted. */
  reason: string;
}

/**
 * A local file that IS the candidate's weights under another name.
 *
 * The tiers before this one (`pickReusable`) demand an exact byte size for a
 * different filename — and the Hub republishes quants with a new name AND a
 * new size (`Ornith-1.5-35B-A3B-Q4_K_M.gguf` 21,864,081,056 B →
 * `Ornith-1.5-35B-Q4_K_M.gguf` 21,713,463,040 B: same 753 tensors, same
 * hyper-parameters, different per-tensor quant mix). Exact-size matching then
 * re-downloads 21.7 GB the machine already has.
 *
 * This tier instead compares headers: the local file's against the candidate's
 * own (`candidateFingerprint`, read with a Range request for the first MB of the
 * Hub file). Same quant tag, same family root and a size within tolerance only
 * decide which files earn a header read, so a disk full of unrelated models
 * costs no I/O beyond the listing; the fingerprint comparison is the verdict.
 *
 * When the candidate's header cannot be read (offline, Range refused) the
 * comparison is impossible and the file is NOT reused — unless the caller says
 * `allowUnverified` (it cannot download anyway), in which case the weaker
 * evidence is stated in `reason`.
 *
 * `readFingerprint` and `candidateFingerprint` are injected for tests.
 */
export async function findSameWeightsModel(
  candidate: { filename: string; sizeBytes: number },
  local: LocalGguf[],
  opts: {
    readFingerprint?: (path: string) => Promise<GgufFingerprint>;
    sizeTolerance?: number;
    /** The candidate's own header fingerprint, or null when it cannot be read. Called at most once. */
    candidateFingerprint?: () => Promise<GgufFingerprint | null>;
    /** Reuse a plausible file even when the candidate's header could not be compared. */
    allowUnverified?: boolean;
  } = {}
): Promise<SameWeightsHit | null> {
  if (!candidate.sizeBytes) return null;
  const wantQuant = quantTag(candidate.filename);
  if (!wantQuant) return null;
  const wantFamily = familyRootOf(candidate.filename);
  const tolerance = opts.sizeTolerance ?? SAME_WEIGHTS_SIZE_TOLERANCE;
  const read = opts.readFingerprint ?? readGgufFingerprint;
  let wanted: Promise<GgufFingerprint | null> | undefined;
  const wantFingerprint = (): Promise<GgufFingerprint | null> =>
    (wanted ??= (opts.candidateFingerprint ? opts.candidateFingerprint().catch(() => null) : Promise.resolve(null)));
  const prefetched = new Map<string, GgufFingerprint>();
  const fingerprintOf = async (path: string): Promise<GgufFingerprint> => {
    const hit = prefetched.get(path);
    if (hit) return hit;
    const fp = await read(path).catch(() => ({ arch: "", conclusive: false }) as GgufFingerprint);
    prefetched.set(path, fp);
    return fp;
  };
  for (const f of local) {
    const name = baseName(f.path) ?? "";
    if (name.toLowerCase() === candidate.filename.toLowerCase()) continue; // exact names belong to pickReusable
    if (quantTag(name) !== wantQuant) continue;
    if (familyRootOf(name) !== wantFamily) continue;
    if (Math.abs(f.sizeBytes - candidate.sizeBytes) / candidate.sizeBytes > tolerance) continue;
    const fp = await fingerprintOf(f.path);
    if (!fp.conclusive || fp.blockCount === undefined) continue;
    const want = await wantFingerprint();
    const verified = !!want && want.conclusive;
    if (verified && !sameFingerprint(fp, want as GgufFingerprint)) continue;
    if (!verified && !opts.allowUnverified) continue;
    const sizePct = (((f.sizeBytes - candidate.sizeBytes) / candidate.sizeBytes) * 100).toFixed(1);
    const head = `${fp.arch}·${fp.blockCount ?? "?"}층·텐서 ${fp.tensorCount ?? "?"}개`;
    return {
      path: f.path,
      sizeBytes: f.sizeBytes,
      reason: verified
        ? `동일 가중치로 판단되는 기존 파일 재사용: ${name} (${(f.sizeBytes / 1024 ** 3).toFixed(1)} GiB, ` +
          `게시 크기 대비 ${sizePct}%). 받을 파일의 헤더와 비교해 ${head} 일치를 확인했습니다.`
        : `기존 파일 재사용(헤더 미확인): ${name} (${(f.sizeBytes / 1024 ** 3).toFixed(1)} GiB, 게시 크기 대비 ${sizePct}%). ` +
          `받을 파일의 헤더를 읽지 못해 이름·양자화·크기와 이 파일 헤더(${head})로만 판단했습니다.`,
    };
  }
  return null;
}
