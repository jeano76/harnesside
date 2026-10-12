/**
 * 기호 정의·참조 — TS LanguageService 연동 (§7.1 2단계).
 *
 * 1단계(`shared/symbols.ts`)는 정규식 텍스트 스캔이라 같은 파일 아웃라인까지만
 * 된다. 타입 해석(임포트 건너뛰기·정확한 정의 위치)은 여기서 한다.
 *
 * ── 왜 LanguageService인가 ─────────────────────────────────────────────
 * 정규식으로 "정의"를 지어내면 사용자는 틀린 줄로 점프한다(§7.1: 추측 금지).
 * 컴파일러가 모르면 **빈 목록**을 준다 — 없는 채로 둔다.
 *
 * ── 왜 캐시가 없나 ────────────────────────────────────────────────────
 * 요청마다 서비스를 만든다. 200파일·5만줄 규모에서 클릭 1회당 수백ms다.
 * 캐시를 두면 mtime 무효화·메모리 소유권이 생기는데, 이 호출은 사람이
 * 토큰을 눌렀을 때만 일어난다(핫 패스가 아니다). 정확성이 먼저다.
 *
 * ── `typescript` 가 없을 때 ────────────────────────────────────────────
 * `typescript` 는 devDependency다. `npm i -g` 설치본에는 없을 수 있다.
 * 정적 import 로 묶으면 그 설치본이 부팅부터 깨진다. 그래서 동적 import +
 * 실패 시 `{available:false}` — 화면은 "텍스트 기준" 으로 남는다.
 */

import { join, relative, resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { safeResolve } from "../fs/safePath.js";
import { listFiles } from "../fs/search.js";

export interface SymbolLoc {
  /** 루트 기준 상대 경로(`/` 구분). 화면·세션에 남는 값이다. */
  path: string;
  /** 1-based. 0번째 줄은 없다. */
  line: number;
  /** 1-based 열. */
  col: number;
  name: string;
  kind: string;
}

export type SymbolOutcome =
  | { available: true; locations: SymbolLoc[] }
  | { available: false; reason: string };

const SUPPORTED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_PROGRAM_FILES = 500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEFS = 20;
const MAX_REFS = 50;

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

export function isSupportedSymbolFile(path: string): boolean {
  return SUPPORTED.has(extOf(path));
}

/** 1-based 줄/열 → 0-based 오프셋. 범위 밖이면 null(조용히 0으로 꺾지 않는다). */
export function lineColToOffset(content: string, line: number, col: number): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) return null;
  const lines = content.split("\n");
  if (line > lines.length) return null;
  const text = lines[line - 1]!;
  // col 은 문자 단위. line.length+1(줄 끝)까지 허용 — 토큰 뒤를 눌러도 된다.
  if (col > text.length + 1) return null;
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i]!.length + 1;
  return off + (col - 1);
}

/** 0-based 오프셋 → 1-based 줄/열. */
export function offsetToLineCol(content: string, offset: number): { line: number; col: number } {
  const o = Math.max(0, Math.min(offset, content.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < o; i++) {
    if (content[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: o - lineStart + 1 };
}

async function loadTs(): Promise<typeof import("typescript") | null> {
  try {
    return await import("typescript");
  } catch {
    return null;
  }
}

interface FileEntry {
  abs: string;
  content: string;
}

async function collectProgramFiles(root: string, targetAbs: string): Promise<FileEntry[]> {
  const listed = await listFiles(root);
  const rels = listed.files.filter((f) => isSupportedSymbolFile(f)).slice(0, MAX_PROGRAM_FILES);
  const seen = new Set<string>();
  const out: FileEntry[] = [];
  const push = async (abs: string) => {
    const norm = resolve(abs);
    if (seen.has(norm)) return;
    seen.add(norm);
    const st = await stat(norm).catch(() => null);
    if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) return;
    const buf = await readFile(norm).catch(() => null);
    if (!buf || buf.includes(0)) return;
    out.push({ abs: norm, content: buf.toString("utf8") });
  };
  for (const rel of rels) await push(join(root, rel));
  // 대상이 목록에 잘렸어도 반드시 포함 — 없으면 자기 정의도 못 찾는다.
  await push(targetAbs);
  return out;
}

function insideRoot(rootAbs: string, abs: string): boolean {
  const norm = resolve(abs);
  return norm === rootAbs || norm.startsWith(rootAbs + sep);
}

function toRel(rootAbs: string, abs: string): string {
  return relative(rootAbs, resolve(abs)).split(sep).join("/");
}

async function locate(
  root: string,
  inputPath: string,
  line: number,
  col: number,
  mode: "definition" | "references"
): Promise<SymbolOutcome> {
  const rootAbs = resolve(root);
  const resolved = await safeResolve(inputPath, { root });
  if (!resolved.ok) {
    const status = resolved.reason === "not-found" ? 404 : 403;
    throw Object.assign(new Error(resolved.detail), { status });
  }
  const targetAbs = resolved.value;
  if (!isSupportedSymbolFile(targetAbs)) {
    return { available: false, reason: `타입 해석을 지원하지 않는 형식입니다: ${inputPath} (텍스트 기준 아웃라인만 사용)` };
  }

  const ts = await loadTs();
  if (!ts) {
    return { available: false, reason: "타입 해석기가 없습니다 (typescript 미설치) — 텍스트 기준 아웃라인만 사용" };
  }

  const files = await collectProgramFiles(rootAbs, targetAbs);
  const target = files.find((f) => resolve(f.abs) === resolve(targetAbs));
  if (!target) {
    throw Object.assign(new Error(`파일이 없습니다: ${inputPath}`), { status: 404 });
  }
  const offset = lineColToOffset(target.content, line, col);
  if (offset === null) {
    throw Object.assign(new Error(`줄·열이 범위를 벗어났습니다: ${line}:${col}`), { status: 400 });
  }

  const options: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    strict: false,
    esModuleInterop: true,
    skipLibCheck: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const versions = new Map(files.map((f) => [resolve(f.abs), "0"] as const));
  const snapshots = new Map(files.map((f) => [resolve(f.abs), ts.ScriptSnapshot.fromString(f.content)] as const));
  const names = files.map((f) => resolve(f.abs));
  const host: import("typescript").LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => names,
    getScriptVersion: (f) => versions.get(resolve(f)) ?? "0",
    getScriptSnapshot: (f) => {
      const s = snapshots.get(resolve(f));
      if (s) return s;
      return undefined;
    },
    getCurrentDirectory: () => rootAbs,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => snapshots.has(resolve(f)),
    readFile: (f) => files.find((e) => resolve(e.abs) === resolve(f))?.content,
    readDirectory: () => [],
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  const cap = mode === "definition" ? MAX_DEFS : MAX_REFS;

  if (mode === "definition") {
    const defs = ls.getDefinitionAtPosition(targetAbs, offset) ?? [];
    const locs: SymbolLoc[] = [];
    for (const d of defs) {
      if (!insideRoot(rootAbs, d.fileName)) continue;
      const entry = files.find((e) => resolve(e.abs) === resolve(d.fileName));
      const text = entry?.content ?? (await readFile(d.fileName, "utf8").catch(() => ""));
      if (!text) continue;
      const lc = offsetToLineCol(text, d.textSpan.start);
      locs.push({ path: toRel(rootAbs, d.fileName), line: lc.line, col: lc.col, name: d.name, kind: d.kind });
      if (locs.length >= cap) break;
    }
    return { available: true, locations: locs };
  }

  const syms = ls.getReferencesAtPosition(targetAbs, offset) ?? [];
  const locs: SymbolLoc[] = [];
  // TS 5.9 의 getReferencesAtPosition 은 DocumentSpan[] 을 돌려준다
  // (구 findReferences 의 ReferencedSymbol[] 가 아니다). 이름·종류는
  // 요청 자리 식별자로 메운다 — 위치는 컴파일러 값이다.
  // 커서가 식별자 한가운데여도 앞뒤를 붙여 온 이름을 쓴다 ("extractS" 같은 토막 금지).
  const before = target.content.slice(0, offset).match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";
  const after = target.content.slice(offset).match(/^[\w$]*/)![0];
  const ident = before + after;
  for (const r of syms as unknown as import("typescript").DocumentSpan[]) {
    if (!insideRoot(rootAbs, r.fileName)) continue;
    const entry = files.find((e) => resolve(e.abs) === resolve(r.fileName));
    const text = entry?.content ?? (await readFile(r.fileName, "utf8").catch(() => ""));
    if (!text) continue;
    const lc = offsetToLineCol(text, r.textSpan.start);
    locs.push({ path: toRel(rootAbs, r.fileName), line: lc.line, col: lc.col, name: ident, kind: "reference" });
    if (locs.length >= cap) break;
  }
  return { available: true, locations: locs };
}

export function getDefinition(
  root: string,
  path: string,
  line: number,
  col: number
): Promise<SymbolOutcome> {
  return locate(root, path, line, col, "definition");
}

export function getReferences(
  root: string,
  path: string,
  line: number,
  col: number
): Promise<SymbolOutcome> {
  return locate(root, path, line, col, "references");
}
