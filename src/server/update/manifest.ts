/**
 * 릴리스 매니페스트 — **검증 단위와 교체 단위를 같게** 만드는 파일 (R-5).
 *
 * ── 이 파일이 없으면 무엇이 고장인가 (R-5 실측) ──────────────────────────────
 *
 * 배포물은 `dist/` **전체 트리**다. `dist/server/index.js` 가 `dist/agent/loop.js`
 * 를 import 하므로, entry 파일 하나만 갈아끼우면 **나머지 파일은 옛 버전 그대로다.**
 * → 부팅은 성공하고 **옛 로직으로 도는** 상태가 된다. 해시도 통과한다. 조용히 틀어진다.
 *
 * 그런데 `stageSwap` 는 파일 하나를 다뤘고, `local()` 이 보고하는 설치 해시도
 * `entry` 파일 **하나**의 해시였다. 즉 **검증하는 것과 교체하는 것이 다른 것**이었다.
 * 그것이 이 모듈이 존재하는 이유다.
 *
 * ── 규약 ────────────────────────────────────────────────────────────────────
 *
 *  1. **매니페스트는 자기 자신을 검증한다.** `treeSha256` 은 `files` 로부터 다시
 *     만들어 비교한다. 손으로 고친 매니페스트는 로드 단계에서 떨어진다.
 *  2. **경로는 모두 상대 정규형**이어야 한다. `..`·절대경로·드라이브 표기는 파싱
 *     단계에서 거부한다(풀기 **전에**).
 *  3. **해시만 맞으면 충분하지 않다.** 빠진 파일은 해시가 아니라 **파일 목록**으로
 *     잡는다. 없는 파일은 부팅 실패로만 나타난다(§R-5.1).
 *  4. **정본은 하나다.** 쓰기(교체)와 읽기(검증) 모두 여기서 만든 값을 쓴다.
 *     두 곳에서 규칙을 따로 만들면 반드시 어긋난다.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** 매니페스트 형식 버전. **1 이다** — 바뀌면 배포물이 아니라 계약이 바뀐 것이다. */
export const MANIFEST_VERSION = 1;

export interface ManifestFile {
  /** 배포물 안에서의 상대 경로. 항상 `/` 로 정규화한다. */
  path: string;
  /** sha256 (소문자 hex 64자). */
  sha256: string;
  bytes: number;
  /** 실행 권한 (POSIX). 없으면 0o644 — **없다고 임의로 0o755 를 주지 않는다.** */
  mode: number;
}

export interface ReleaseManifest {
  manifestVersion: number;
  /** 빌드 신원(R-1). 배포물이 어느 커밋·어느 시각에서 나왔는가. */
  build: { version: string; date: string | null; sha: string | null; dirty: boolean | null; builtAt: number | null };
  /** 이 배포물을 담은 자산의 해시. */
  asset: { name: string; sha256: string; bytes: number };
  files: ManifestFile[];
  /** 파일 목록에서 만든 트리 해시 — **진입 파일 하나로는 만들 수 없다.** */
  treeSha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 경로 표기를 `/` 로 정규화한다 — Windows 빌드와 Linux 빌드가 같은 해시를 내야 한다. */
export function normRel(p: string): string {
  return p.split(sep).join("/").replace(/^\.\//, "");
}

/** 상대 정규형인가 — `..`·절대경로·드라이브 표기·빈 조각을 모두 막는다. */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.includes("\\")) return false;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return false;
  return true;
}

/**
 * 트리 해시 — **`files` 만으로** 만든다. 경로순으로 정렬해 **재현 가능**하게 한다.
 *
 * 정렬하지 않으면 파일을 나열하는 순서만 달라도 해시가 바뀌고, 그건 **같은 배포물**이다.
 * 이 값이 "설치 해시" 로 보고되므로(R-5.2) 정렬은 선택이 아니라 조건이다.
 */
export function computeTreeSha(files: Array<{ path: string; sha256: string }>): string {
  const lines = [...files]
    .map((f) => `${normRel(f.path)} ${f.sha256}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(lines.join("\n") + "\n");
}

export type ParseResult = { ok: true; manifest: ReleaseManifest } | { ok: false; error: string };

/**
 * 매니페스트를 **엄격하게** 읽는다.
 *
 * 느슨하면 위험하다: 필드가 빠져도 통과한 매니페스트는 **검증 없는 검증**이 되고,
 * 그건 검증하는 것보다 나쁘다(§R-2 규칙: 모르는 것을 아는 것처럼 쓰지 않는다).
 */
export function parseManifest(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `매니페스트가 JSON 이 아닙니다: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof json !== "object" || json === null) return { ok: false, error: "매니페스트가 객체가 아닙니다" };
  const o = json as Record<string, unknown>;

  if (o.manifestVersion !== MANIFEST_VERSION) {
    return { ok: false, error: `매니페스트 형식이 다릅니다(기대 ${MANIFEST_VERSION}, 받은 ${String(o.manifestVersion)})` };
  }
  if (!Array.isArray(o.files) || o.files.length === 0) {
    return { ok: false, error: "매니페스트에 파일 목록이 없거나 비어 있습니다 — 검증할 것이 없습니다" };
  }

  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const raw of o.files as unknown[]) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "파일 항목이 객체가 아닙니다" };
    const f = raw as Record<string, unknown>;
    const p = typeof f.path === "string" ? normRel(f.path) : "";
    if (!isSafeRelPath(p)) return { ok: false, error: `안전하지 않은 경로입니다: ${String(f.path)}` };
    if (seen.has(p)) return { ok: false, error: `경로가 중복됩니다: ${p}` };
    seen.add(p);
    if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) return { ok: false, error: `해시 형식이 아니다: ${p}` };
    if (typeof f.bytes !== "number" || !Number.isFinite(f.bytes) || f.bytes < 0) return { ok: false, error: `크기가 아니다: ${p}` };
    files.push({ path: p, sha256: f.sha256, bytes: f.bytes, mode: typeof f.mode === "number" ? f.mode : 0o644 });
  }

  const b = (typeof o.build === "object" && o.build !== null ? o.build : {}) as Record<string, unknown>;
  const asset = (typeof o.asset === "object" && o.asset !== null ? o.asset : {}) as Record<string, unknown>;
  const manifest: ReleaseManifest = {
    manifestVersion: MANIFEST_VERSION,
    build: {
      version: typeof b.version === "string" ? b.version : "확인 못 함",
      date: typeof b.date === "string" ? b.date : null,
      sha: typeof b.sha === "string" ? b.sha : null,
      dirty: typeof b.dirty === "boolean" ? b.dirty : null,
      builtAt: typeof b.builtAt === "number" && Number.isFinite(b.builtAt) ? b.builtAt : null,
    },
    asset: {
      name: typeof asset.name === "string" ? asset.name : "",
      sha256: typeof asset.sha256 === "string" && HEX64.test(asset.sha256) ? asset.sha256 : "",
      bytes: typeof asset.bytes === "number" ? asset.bytes : 0,
    },
    files,
    treeSha256: typeof o.treeSha256 === "string" ? o.treeSha256 : "",
  };

  // ── 자기 검증 ────────────────────────────────────────────────────────────
  // **선언된 트리 해시가 파일 목록과 맞는가.** 손으로 고친 매니페스트는 여기서 떨어진다.
  const recomputed = computeTreeSha(files);
  if (manifest.treeSha256 !== recomputed) {
    return { ok: false, error: `매니페스트의 트리 해시가 파일 목록과 다릅니다 (선언 ${manifest.treeSha256.slice(0, 12)}… / 계산 ${recomputed.slice(0, 12)}…). 매니페스트가 손으로 바뀌었거나 목록이 잘렸습니다` };
  }
  return { ok: true, manifest };
}

export interface VerifyResult {
  ok: boolean;
  /** 확인한 파일 수. */
  checked: number;
  /** 선언되었는데 **없는** 파일. */
  missing: string[];
  /** 있는데 **해시가 다른** 파일. */
  mismatched: Array<{ path: string; expected: string; actual: string }>;
  /** 목록에 **없는데** 있는 파일 — 옛 버전이 남은 흔적일 수 있다. */
  extra: string[];
  /** 사람이 읽는 한 줄. */
  detail: string;
}

export interface VerifyIo {
  /** 상대경로 → 바이트. 실패하면 throw 해도 되고 null 을 줘도 된다. */
  read(rel: string): Buffer | null;
  /** 디렉터리 안의 상대경로 목록(재귀). */
  list(root: string): string[];
}

export function fsVerifyIo(root: string): VerifyIo {
  return {
    read(rel) {
      try {
        return readFileSync(join(root, rel));
      } catch {
        return null;
      }
    },
    list(dir) {
      const out: string[] = [];
      const walk = (d: string, prefix: string) => {
        let entries: string[];
        try {
          entries = readdirSync(d);
        } catch {
          return;
        }
        for (const name of entries) {
          const abs = join(d, name);
          const rel = prefix ? `${prefix}/${name}` : name;
          let st;
          try {
            st = statSync(abs);
          } catch {
            continue;
          }
          // 디렉터리와 심볼릭 링크는 **목록의 파일**이 아니다. 심볼릭 링크는
          // 따라가면 루트 밖을 셀 수 있다 — 따라가지 않는다.
          if (st.isDirectory()) walk(abs, rel);
          else if (st.isFile()) out.push(rel);
        }
      };
      walk(dir, "");
      return out;
    },
  };
}

/**
 * 트리를 매니페스트와 대조한다.
 *
 * **세 가지를 모두 본다**: 없는 파일 / 해시가 다른 파일 / 목록에 없는 파일.
 * 해시만 보면 세 번째를 못 잡고, 목록만 보면 두 번째를 못 잡는다.
 * 둘 다 조용히 통과하면 그 실패는 **부팅**에서만 나타난다.
 *
 * `ignore` 는 **매니페스트 자신**이다. 매니페스트는 배포물에 함께 실리지만 자기
 * 해시를 자기 안에 쓸 수는 없다(닭이 먼저냐 달걀이 먼저냐). 그래서 트리 해시에서
 * 제외하고, 여기서도 목록의 "남는 파일" 에서 제외한다 — 그렇지 않으면 **정상 배포물이
 * 항상 실패**하고, 그 실패를 고치려면 검증을 느슨하게 만들어야 한다.
 */
export function verifyTree(
  manifest: ReleaseManifest,
  io: VerifyIo,
  rootForList = "",
  opts: { ignore?: string[] } = {}
): VerifyResult {
  const ignore = new Set((opts.ignore ?? []).map(normRel));
  const missing: string[] = [];
  const mismatched: VerifyResult["mismatched"] = [];
  let checked = 0;
  for (const f of manifest.files) {
    const buf = io.read(f.path);
    if (buf === null) {
      missing.push(f.path);
      continue;
    }
    checked++;
    if (buf.byteLength !== f.bytes) {
      mismatched.push({ path: f.path, expected: `${f.sha256.slice(0, 12)}…`, actual: `크기 ${buf.byteLength} != ${f.bytes}` });
      continue;
    }
    const actual = sha256(buf);
    if (actual !== f.sha256) mismatched.push({ path: f.path, expected: `${f.sha256.slice(0, 12)}…`, actual: `${actual.slice(0, 12)}…` });
  }

  const declared = new Set(manifest.files.map((f) => f.path));
  const present = io.list(rootForList);
  const extra = present.filter((p) => !ignore.has(normRel(p)) && !declared.has(normRel(p)));

  const ok = missing.length === 0 && mismatched.length === 0 && extra.length === 0;
  const parts: string[] = [`${checked}/${manifest.files.length}개 확인`];
  if (missing.length) parts.push(`${missing.length}개 없음`);
  if (mismatched.length) parts.push(`${mismatched.length}개 해시 불일치`);
  if (extra.length) parts.push(`${extra.length}개 목록에 없음`);
  return { ok, checked, missing, mismatched, extra, detail: parts.join(" · ") };
}

/** 실패 사유를 사람이 읽을 한 줄로. **어느 파일인지** 있어야 한다. */
export function verifyDetail(v: VerifyResult, limit = 3): string {
  if (v.ok) return `검증 통과 — ${v.detail}`;
  const bits: string[] = [];
  for (const m of v.missing.slice(0, limit)) bits.push(`없음: ${m}`);
  for (const m of v.mismatched.slice(0, limit)) bits.push(`불일치: ${m.path} (기대 ${m.expected} / 실제 ${m.actual})`);
  for (const e of v.extra.slice(0, limit)) bits.push(`목록에 없음: ${e}`);
  return `검증 실패 — ${v.detail} · ${bits.join(" · ")}`;
}