/**
 * CLI 마다 다른 슬래시 명령을 **동적으로** 모은다 (`PROMPT_TMUX_CLI.md` T-14).
 *
 * 출처 셋을 섞되 **섞였다는 사실을 말한다**:
 *  1. 내장 명령 — CLI 가 기계가 읽게 내놓지 않아 `shared/cliProviders.ts` 의 **버전 붙은 표**다.
 *     설치된 버전이 표를 확인한 버전과 다르면 `stale` 로 알린다.
 *  2. 사용자 정의 명령·스킬 — CLI 가 읽는 폴더를 **스캔**한다(파일이 정본이라 항상 최신이다).
 *  3. 플러그인이 주는 명령은 **스캔하지 않는다**(설치 구조가 CLI·버전마다 달라 추측하지 않는다).
 *
 * 화면 긁기(`/help` 를 보내고 읽기)는 하지 않는다 — 입력 경로를 둘로 만들고 깨지기 쉽다.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { CLI_PROVIDER_BY_ID, type CliProvider } from "../shared/cliProviders.js";

export interface CliCommandEntry {
  /** 슬래시 없이. 하위 폴더는 `:` 로(`team/review.md` → `team:review`). */
  name: string;
  description: string;
  source: "builtin" | "custom";
  /** 화면에 보일 출처 이름(예: "프로젝트 명령"). */
  label: string;
}

export interface CliCommandList {
  provider: string;
  commands: CliCommandEntry[];
  /** 내장 표를 확인한 버전. `null` 이면 확인하지 못한 표다. */
  builtinsVersion: string | null;
  installedVersion: string | null;
  /** 표의 버전과 설치 버전이 다르거나 표를 확인하지 못했다 — "오래됐을 수 있음". */
  stale: boolean;
  notes: string[];
}

const MAX_FILES = 300;
const MAX_DEPTH = 4;

async function walk(dir: string, exts: string[], depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, exts, depth + 1, out);
    else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(p);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

/** `---` 프론트매터에서 키 하나. 멀티라인 값은 첫 줄만(설명 한 줄이면 충분하다). */
export function frontmatterValue(text: string, key: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(m[1]!);
  return line ? unquote(line[1]!) || null : null;
}

/** TOML 의 `description = "..."` (단순 한 줄 값만). */
export function tomlDescription(text: string): string | null {
  const m = /^description\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m.exec(text);
  return m ? (m[1] ?? m[2] ?? "").replace(/\\"/g, '"') : null;
}

function firstLine(text: string): string {
  const body = text.replace(/^---[\s\S]*?\r?\n---\r?\n?/, "");
  const l = body.split(/\r?\n/).map((x) => x.trim()).find((x) => x && !x.startsWith("#"));
  return (l ?? "").slice(0, 160);
}

const clip = (s: string) => (s.length > 160 ? s.slice(0, 157) + "…" : s);

async function scanDir(base: string, kind: "md" | "toml" | "skill", label: string): Promise<CliCommandEntry[]> {
  const out: CliCommandEntry[] = [];
  if (kind === "skill") {
    const dirs = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const text = await readFile(join(base, d.name, "SKILL.md"), "utf8").catch(() => null);
      if (text === null) continue;
      out.push({ name: frontmatterValue(text, "name") ?? d.name, description: clip(frontmatterValue(text, "description") ?? firstLine(text)), source: "custom", label });
    }
    return out;
  }
  const ext = kind === "md" ? ".md" : ".toml";
  for (const file of await walk(base, [ext])) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    // 하위 폴더는 이름 공간이다: team/review.md → team:review
    const rel = relative(base, file).slice(0, -ext.length).split(sep).join(":");
    const desc = kind === "md" ? (frontmatterValue(text, "description") ?? firstLine(text)) : (tomlDescription(text) ?? "");
    out.push({ name: rel, description: clip(desc), source: "custom", label });
  }
  return out;
}

export interface ListOptions {
  /** 작업 폴더(프로젝트 명령의 기준). */
  cwd: string;
  /** 테스트용 홈 대체. */
  home?: string;
  installedVersion?: string | null;
}

export function versionMatches(builtinsVersion: string | null | undefined, installed: string | null): boolean {
  if (!builtinsVersion || !installed) return false;
  return installed === builtinsVersion || installed.startsWith(`${builtinsVersion} `) || installed.startsWith(`${builtinsVersion}.`);
}

export async function listCliCommands(provider: CliProvider | undefined, o: ListOptions): Promise<CliCommandList | null> {
  if (!provider) return null;
  const home = o.home ?? homedir();
  const notes: string[] = [];
  const commands: CliCommandEntry[] = [];
  const builtinsVersion = provider.builtinsVersion ?? null;
  for (const b of provider.builtins ?? []) commands.push({ name: b.name, description: b.description ?? "", source: "builtin", label: "내장 명령" });
  for (const d of provider.customDirs ?? []) {
    const base = d.dir.startsWith("~/") ? join(home, d.dir.slice(2)) : resolve(o.cwd, d.dir);
    for (const c of await scanDir(base, d.kind, d.label)) {
      // 같은 이름이 이미 있으면 **사용자 정의가 가린다**(CLI 도 프로젝트 > 사용자 > 내장 순).
      const i = commands.findIndex((x) => x.name === c.name);
      if (i >= 0) commands.splice(i, 1);
      commands.push(c);
    }
  }
  if (provider.id === "claude") notes.push("플러그인이 주는 명령(/플러그인:이름)은 목록에 없습니다 — 입력은 그대로 CLI 로 전달됩니다.");
  if (provider.builtins?.length && !provider.customDirs?.length) notes.push(`${provider.label} 의 사용자 정의 명령·스킬 위치를 확인하지 못해 스캔하지 않습니다(미확인) — 입력은 그대로 CLI 로 전달됩니다.`);
  if (!provider.builtins?.length) notes.push(`${provider.label} 의 내장 명령은 확인하지 못했습니다(미확인) — 사용자 정의 명령만 보입니다.`);
  const stale = !versionMatches(builtinsVersion, o.installedVersion ?? null);
  if (builtinsVersion === null && provider.builtins?.length) notes.push("내장 명령 표는 공개 문서 기준이며 설치된 CLI 로 확인하지 못했습니다.");
  else if (stale && provider.builtins?.length) notes.push(`내장 명령 표는 ${builtinsVersion} 기준입니다 — 설치된 버전(${o.installedVersion ?? "확인 못 함"})과 다를 수 있습니다.`);
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { provider: provider.id, commands, builtinsVersion, installedVersion: o.installedVersion ?? null, stale, notes };
}

export { CLI_PROVIDER_BY_ID };
