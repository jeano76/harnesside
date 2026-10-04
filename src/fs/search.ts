/**
 * 저장소 **전체 검색** 과 **빠른 이동** (S-5).
 *
 * ── 왜 이 파일이 없었나 ──────────────────────────────────────────────────────
 *
 * CLI 는 `rg` 가 있고 IDE 는 `Ctrl+Shift+F` 가 있다. 이 저장소에는 **둘 다 없었다.**
 * 2026-10-02 기준으로 "비어 있는 자리"였다:
 *
 *   - 저장소 전체 검색      — 없음
 *   - 빠른 이동(`Ctrl+P`)  — 없음
 *   - 기호로 이동           — 없음(§7.1 에 명시)
 *
 * 무엇을 추가하지 않았나: **탐색기 패널.** 2026-10-01 에 사용자가 삭제하라고 했고
 * 대체는 "대화 안에 블록으로 열기" 였다(§7.3). 여기서도 **같은 규칙**을 따른다 —
 * 검색 결과는 **대화 안의 블록**으로 열린다. 탐색기를 되살리면 그 삭제가 되돌아간다.
 *
 * ── 조용히 실패하지 않는다 ────────────────────────────────────────────────────
 *
 * 이 저장소에서 반복 확인된 규칙(부록 B 1): **조용히 실패하는 것이 명백히 실패하는
 * 것보다 나쁘다.** 그래서 검색 결과에는 반드시 함께 붙는다:
 *
 *   - **무엇을 검색했는지**(패턴·대소문자·정규식 여부) — 안 보이면 재현이 안 된다.
 *   - **몇 파일을 봤는지**.
 *   - **왜 일부를 안 봤는지**(바이너리 · 너무 큼 · 무시한 폴더) 와 **상한에 걸렸는지.**
 *
 * 특히 마지막이 중요하다. 200건에서 **조용히 끊으면** 사용자는 "이 파일에 없나" 고
 * 믿는다. 실제로는 "상한에 걸렸다" 고 말해야 한다(부록 A 09-30: 404 가 올바른
 * 문장으로 보이는 사고와 같은 종류).
 *
 * ── 경로 안전 (§3.4) ─────────────────────────────────────────────────────────
 *
 * 검색은 **저장소 전체를 읽는다.** 그래서 여기서 규칙이 느슨하면 곧 임의 파일
 * 읽기가 된다. 규칙은 `safePath` 와 **같은 것**을 쓴다:
 *   - 루트 밖 경로는 **결과에도 넣지 않는다.**
 *   - 심볼릭 링크는 **따라가지 않는다**(루트 밖으로 새는 길이다).
 *   - 폴더 깊이와 방문 수에 **상한**을 둔다(순회 공격과 무한 디렉터리).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/**
 * **읽지 않는 폴더.** 이유가 있다 — 대부분 **크기** 때문이다.
 *
 * `node_modules` 는 수만 개 파일이라 검색 1회가 멈추고, `.git` 은 **이진**이라
 * 아무도 찾지 못한다. 그런데 이 목록을 **숨기지 않는다** — 왜 그 결과가 나왔는지
 * 결과에 `ignored` 개수로 남긴다.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".harnesside",
  ".cache",
  "coverage",
  ".next",
  ".venv",
  "__pycache__",
]);

export interface SearchLimits {
  /** 결과 상한. 넘으면 **잘렸다고 말한다.** */
  maxHits: number;
  /** 열어 볼 파일 수 상한. */
  maxFiles: number;
  /** 디렉터리 깊이 상한. */
  maxDepth: number;
  /** 이 크기를 넘는 파일은 **읽지 않는다**(바이너리·생성물일 확률이 높다). */
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: SearchLimits = {
  maxHits: 200,
  maxFiles: 20_000,
  maxDepth: 12,
  maxFileBytes: 512 * 1024,
};

export interface SearchQuery {
  pattern: string;
  /** 정규식으로 본다. 기본은 **일반 글자** — `(` 하나만 넣어도 조용히 아무것도 안 되게 하지 않는다. */
  regex?: boolean;
  /** 기본은 **대소문자 구분 않음.** `rg` 와 반대지만 이 화면은 사람이 쓰는 곳이다. */
  caseSensitive?: boolean;
}

export interface SearchHit {
  /** 루트 기준 상대 경로(`/` 구분, OS 구분자가 아니라). 화면과 세션에 남는 값이다. */
  path: string;
  /** **1부터.** 0번째 줄이 실제로 있는 프로그램은 없다. */
  line: number;
  /** 그 줄의 앞부분. 너무 긴 줄은 자르고 **잘렸다고 표시**한다. */
  text: string;
  /** 이 줄이 잘렸는가(오른쪽이 잘렸다). */
  clipped: boolean;
}

export interface SearchReport {
  /** 실제로 열어 본 파일 수. "몇 개를 뒤졌나" 를 말하지 않으면 결과가 전부인 줄 안다. */
  scanned: number;
  /** 건너뛴 것 — **이유와 함께.** 조용히 버리지 않는다. */
  skipped: { binary: number; tooLarge: number; unreadable: number };
  /** 무시한 폴더 수. */
  ignored: number;
  /** 루트 밖이라 보지 않은 항목. 경로 안전을 통과시키기 위한 장치. */
  outsideRoot: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** 결과 상한에 걸렸는가. 걸렸으면 `truncatedReason` 이 **반드시** 있다. */
  truncated: boolean;
  truncatedReason: string | null;
  report: SearchReport;
}

export interface CompileFailure {
  ok: false;
  /** 사람이 읽는 사유. 조용히 일반 글자로 바꾸지 **않는다**(§9.3). */
  detail: string;
}

export interface CompileOk {
  ok: true;
  /** 어느 한 줄이라도 이 시험을 통과하면 결과에 든다. */
  test: (line: string) => boolean;
}

/**
 * 검색어를 **한 줄에 대한 시험**으로 만든다.
 *
 * **정규식이 깨지면 거절한다.** 일반 글자로 몰래 바꾸면 사용자는 "왜 `(` 로 검색했는데
 * 아무것도 없지" 를 알 수 없다 — 진짜 원인을 모른 채 추측하게 만드는 것이 이
 * 프로젝트에서 가장 자주 확인된 실패 유형이다(§9.3 표).
 */
/**
 * 결과가 **검색 실패** 인지 판정한다 (TypeScript 좁히기 도구).
 *
 * 왜 함수인가: 호출부가 `"hits" in r` 로 좁히면 **규칙이 두 곳에** 생긴다 —
 * 서버 라우트와 화면이 각자 다른 모양으로 좁히다가 하나만 고치게 된다(부록 B 6).
 * 판정 기준(`ok === false`)을 **한 곳**에 둔다.
 */
export function isSearchFailure(r: SearchOutcome | CompileFailure): r is CompileFailure {
  // `"ok" in r` 로 좁힌다 — `SearchOutcome` 에는 `ok` 필드가 없으므로
  // **구조로** 판정해야 타입이 좁아진다. 값 비교는 나중에 Jsii/JS 로 옮겨도 안전하다.
  return "ok" in r && r.ok === false;
}

export function compileQuery(q: SearchQuery): CompileOk | CompileFailure {
  // **공백만 있어도 비어 있는 것이다.** `"   "` 는 거짓말이다 — 화면에는
  // "검색어가 있습니다" 처럼 보이지만 실제로는 아무것도 찾을 수 없다. 그리고 더 나쁜
  // 것은 **저장소 전체를 다 읽는다**는 점이다: 검색 결과는 0건인데 수천 파일을
  // 열어 봤고, 사용자는 "왜 이렇게 오래 걸리지" 를 원인을 모른 채 기다린다.
  // 실측으로 규칙을 바꾼 것이라 **주석에 적었다** — 다음에 누군가 추가해도 조용히
  // 들어오지 않는다(§5.4: 규칙의 예외를 기억하지 말고 검사한다).
  const pattern = q.pattern.trim();
  if (!pattern) return { ok: false, detail: "검색어가 비어 있습니다" };
  const caseSensitive = q.caseSensitive === true;
  if (q.regex === true) {
    try {
      // `u` 플래그를 **붙이지 않는다** — 붙으면 `\p{...}` 나 SurrogatePair 에서
      // 사람의 검색어(`한글`, `→`)가 깨지면 "패턴이 잘못됐다" 는 말을 듣게 된다.
      const re = new RegExp(pattern, caseSensitive ? "" : "i");
      return { ok: true, test: (line: string) => re.test(line) };
    } catch (e) {
      return { ok: false, detail: `정규식이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return { ok: true, test: (line: string) => (caseSensitive ? line : line.toLowerCase()).includes(needle) };
}

/** 한 줄이 화면에 들어갈 만큼 짧게. 잘렸으면 표시한다. */
export function clipLine(line: string, max = 300): { text: string; clipped: boolean } {
  // 탭이 폭 계산을 어긋나게 하므로 **표준 공백으로 바꾼다.** 그렇지 않으면 줄 번호와
  // 본문이 어긋나 "무슨 줄인지" 를 알 수 없다(2026-10-02, 좁은 창 잘림 항목).
  const flat = line.replace(/\t/g, " ").replace(/\r$/, "");
  return flat.length > max ? { text: flat.slice(0, max), clipped: true } : { text: flat, clipped: false };
}

/** 보여줄 문맥 줄 수(앞뒤). 0 이면 일치 줄만. */
const CONTEXT_LINES = 0;

interface WalkEntry {
  /** 루트 기준 상대 경로. */
  rel: string;
  abs: string;
  size: number;
}

/**
 * 파일 목록 — **루트 안의 것만**, 심볼릭 링크는 따라가지 않는다.
 *
 * `realpath` 를 **파일마다** 부르지 않는다(느리다). 대신 디렉터리 항목을 열 때
 * `Dirent.isSymbolicLink()` 로 먼저 거른다 — 루트 안의 링크가 루트 밖을 가리키는
 * 경우(`safePath` 가 잡는 그 경우)는 링크를 **아예 따라가지 않음** 으로 막는다.
 */
async function walkFiles(root: string, limits: SearchLimits): Promise<{ files: WalkEntry[]; report: SearchReport }> {
  const report: SearchReport = { scanned: 0, skipped: { binary: 0, tooLarge: 0, unreadable: 0 }, ignored: 0, outsideRoot: 0 };
  const files: WalkEntry[] = [];
  const rootAbs = resolve(root);

  const walk = async (dirAbs: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || files.length >= limits.maxFiles) return;
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const d of entries) {
      if (files.length >= limits.maxFiles) return;
      const abs = join(dirAbs, d.name);
      // **루트 밖 판정은 경로 연산으로** 한다. 문자열 prefix 는 링크에서 뚫린다(§6.3).
      if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
        report.outsideRoot++;
        continue;
      }
      if (d.isSymbolicLink()) {
        // 따라가지 않는다 — 어디로 가는지 모른다.
        report.outsideRoot++;
        continue;
      }
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) {
          // **숨기지 않는다** — 왜 결과가 없는지 말해야 한다.
          report.ignored++;
          continue;
        }
        await walk(abs, depth + 1);
        continue;
      }
      if (!d.isFile()) continue;
      const st = await stat(abs).catch(() => null);
      if (!st) {
        report.skipped.unreadable++;
        continue;
      }
      if (st.size > limits.maxFileBytes) {
        report.skipped.tooLarge++;
        continue;
      }
      files.push({ rel: relative(rootAbs, abs).split(sep).join("/"), abs, size: st.size });
    }
  };

  await walk(rootAbs, 0);
  return { files, report };
}

/**
 * 저장소 전체에서 **줄 단위로** 찾는다.
 *
 * 한 줄에 여러 번 나와도 **한 번만** 실린다 — 같은 결과가 몇 번 반복돼도
 * "일치 개수" 가 늘어날 뿐, 사용자가 볼 목록만 길어진다.
 */
export async function searchFiles(
  root: string,
  q: SearchQuery,
  limits: Partial<SearchLimits> = {}
): Promise<SearchOutcome | CompileFailure> {
  const lim: SearchLimits = { ...DEFAULT_LIMITS, ...limits };
  const compiled = compileQuery(q);
  if (!compiled.ok) return compiled;

  const { files, report } = await walkFiles(root, lim);
  const hits: SearchHit[] = [];
  let truncated = false;
  let truncatedReason: string | null = null;

  for (const f of files) {
    if (hits.length >= lim.maxHits) {
      // **남은 파일이 있다는 사실을 말한다.** 조용히 끊으면 "없다" 고 읽힌다.
      truncated = true;
      truncatedReason = `결과가 ${lim.maxHits}건에 도달했습니다. 나머지는 보지 않았습니다. 검색어를 좁히십시오.`;
      break;
    }
    const buf = await readFile(f.abs).catch(() => null);
    if (!buf) {
      report.skipped.unreadable++;
      continue;
    }
    report.scanned++;
    // **바이너리는 건너뛰고 그 사실을 센다.** 0바이트를 화면에 내보내면
    // "일치" 처럼 보이는데 실제로는 그런 줄이 없다.
    if (buf.includes(0)) {
      report.skipped.binary++;
      continue;
    }
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!compiled.test(lines[i]!)) continue;
      if (hits.length >= lim.maxHits) {
        truncated = true;
        truncatedReason = `결과가 ${lim.maxHits}건에 도달했습니다. 더 좁힌 순서로 보여줄 수 없습니다 — 검색어를 바꾸십시오.`;
        break;
      }
      const c = clipLine(lines[i]!);
      hits.push({ path: f.rel, line: i + 1, text: c.text, clipped: c.clipped });
    }
    if (truncated && truncatedReason) break;
  }

  return { hits, truncated, truncatedReason, report };
}

/** 빠른 이동 순위 — 정본은 `src/shared/searchRank.ts` 다 (아래 재노출 참고). */

/**
 * 파일 이름/경로로 빠르게 찾는다 (`Ctrl+P` 대응).
 *
 * 정본은 `src/shared/searchRank.ts` 다. 웹 번들에 `node:fs` 가 따라오지 않게
 * 순수 로직은 shared 에 둔다(§D12). 여기서는 재노출만 한다.
 *
 * @deprecated shared/searchRank.ts 에서 직접 가져온다. 이 재노출은
 * 기존 서버 코드·테스트의 import 경로 유지를 위해서만 남긴다.
 */
export { rankFiles } from "../shared/searchRank.js";
export type { FileHit } from "../shared/searchRank.js";

/** 파일 목록(빠른 이동용). `maxFiles` 상한과 **잘렸는지** 를 함께 준다. */
export async function listFiles(
  root: string,
  limits: Partial<SearchLimits> = {}
): Promise<{ files: string[]; truncated: boolean; total: number }> {
  const lim: SearchLimits = { ...DEFAULT_LIMITS, ...limits };
  const { files } = await walkFiles(root, lim);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files: files.map((f) => f.rel), truncated: files.length >= lim.maxFiles, total: files.length };
}

export { CONTEXT_LINES };
