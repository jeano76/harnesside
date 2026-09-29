/**
 * 설정 계약 (§6.4) — 병합·출처·원자적 쓰기·마이그레이션·시크릿 분리.
 *
 * 이 파일이 존재하는 이유는 **하나의 실수 방지**다: 원본 `config.ts` 의 중첩 객체
 * 병합 버그 — 부분 병합이 누락 필드를 통째로 날렸다. 사용자는 "설정을 바꿨는데
 * 값이 안 먹는다" 를 만나고 원인을 찾지 못했다. 그래서 병합은 **재귀**로 하고,
 * **어느 계층에서 온 값인지**를 값과 함께 보관한다(§5.13 의 "출처 표시" 의 서버 측 근거).
 */

import { readFile, writeFile, rename, mkdir, chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const SCHEMA_VERSION = 2;

export type ValueSource = "default" | "global" | "project" | "env" | "manual";

export interface Sourced<T = unknown> {
  value: T;
  /** 이 값이 어느 계층에서 왔는가. 화면에 그대로 보여준다. */
  source: ValueSource;
  /** 수동 조정 여부 — 수동으로 바꿨다면 자동 결정을 멈춘다(§6.3). */
  manual?: boolean;
}

export type Plain = Record<string, unknown>;

/**
 * 출처 트리 — 값 구조를 그대로 따라간다. 최상위 키에 문자열 하나를 붙이는 설계는
 * 중첩 설정의 출처를 잃게 만든다(§5.13).
 */
export type SourceTree = { [key: string]: ValueSource | SourceTree };

/** 재귀 병합. `base` 를 고치지 않는다. 배열은 덮어쓴다(병합하면 뜻이 사라진다). */
export function deepMerge<T extends Plain>(base: T, override: Plain): T {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue; // 명시적 undefined 는 "없음" 이 아니라 "기본값 유지"
    const prev = out[k];
    if (isPlain(prev) && isPlain(v)) {
      out[k] = deepMerge(prev, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 값 구조를 따라 출처를 채운다 — 리프마다 계층 이름이 붙는다 (§6.4 우선순위). */
function fill(data: Plain, source: ValueSource): SourceTree {
  const out: SourceTree = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = isPlain(v) ? fill(v as Plain, source) : source;
  }
  return out;
}

/**
 * 중첩된 출처 트리를 `a.b.c` 경로의 리프 항목으로 편탄화한다.
 * **리프만** 본다 — 최상위 객체에 붙은 source 는 화면에 의미가 없고, 실제로 궁금한 것은
 * `gpu.mode` 가 어디서 왔냐다(§5.13). 리프만 안 뽑으면 중첩 설정 전부가 "출처 없음" 으로 보인다.
 */
export function flattenSources(
  sources: SourceTree,
  prefix = ""
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sources)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out.push(describeSource(v, path));
    } else if (isPlain(v)) {
      out.push(...flattenSources(v as SourceTree, path));
    }
  }
  return out;
}

/** 화면 표시용: 사람이 읽는 한 줄. */
export function describeSource(s: ValueSource, key: string): string {
  switch (s) {
    case "default":
      return `${key}: 기본값`;
    case "global":
      return `${key}: 전역 설정에서`;
    case "project":
      return `${key}: 이 프로젝트에서 재정의`;
    case "env":
      return `${key}: 환경변수에서`;
    case "manual":
      return `${key}: 수동 조정 (자동 갱신 안 함)`;
  }
}

export interface LoadConfigOptions {
  /** `~/.harnesside/` — 머신 전역. */
  globalConfigPath?: string;
  /** `<workspace>/.harnesside/config.yaml` — 커밋되는 것. */
  projectConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  defaults?: Plain;
  readFileImpl?: (p: string) => Promise<string>;
}

export interface LoadedConfig {
  values: Plain;
  sources: SourceTree;
  /** 사람이 읽는 출처 설명 목록. 설정 화면이 이걸로 "출처" 열을 채운다. */
  originLines: string[];
  warnings: string[];
  schemaVersion: number;
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const read = opts.readFileImpl ?? ((p: string) => readFile(p, "utf8"));
  const env = opts.env ?? process.env;
  const warnings: string[] = [];

  const readYaml = async (path: string | undefined, label: string): Promise<Plain> => {
    if (!path) return {};
    try {
      const raw = await read(path);
      const parsed = parseYaml(raw) as unknown;
      if (parsed === null || parsed === undefined) return {};
      if (!isPlain(parsed)) {
        warnings.push(`${label} 설정이 객체가 아닙니다(무시했습니다): ${path}`);
        return {};
      }
      return parsed;
    } catch (e) {
      // 설정 파일이 깨져도 부팅은 계속된다 — "설정 오류로 서버가 안 뜸" 이 되면 안 된다.
      warnings.push(`${label} 설정을 읽지 못했습니다(기본값으로 진행): ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  };

  const defaults = opts.defaults ?? {};
  const globalData = await readYaml(opts.globalConfigPath, "전역");
  const projectData = await readYaml(opts.projectConfigPath, "프로젝트");

  // 환경변수: HARNESSIDE_<중첩경로> (HARNESSIDE_GPU_MODE → gpu.mode)
  const envData: Plain = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^HARNESSIDE_(.+)$/.exec(k);
    if (!m) continue;
    const path = m[1].toLowerCase().split("_");
    let cur = envData;
    for (let i = 0; i < path.length - 1; i++) {
      cur[path[i]] = isPlain(cur[path[i]]) ? (cur[path[i]] as Plain) : {};
      cur = cur[path[i]] as Plain;
    }
    cur[path[path.length - 1]] = coerce(v as string);
  }

  const { values, sources } = (() => {
    let acc: Plain = { ...defaults };
    const src: SourceTree = fill(defaults, "default");
    for (const [data, source] of [
      [globalData, "global"],
      [projectData, "project"],
      [envData, "env"],
    ] as const) {
      const s2 = fill(data as Plain, source as ValueSource);
      for (const [k, v] of Object.entries(data as Plain)) {
        if (v === undefined) continue;
        if (isPlain(v) && isPlain(acc[k])) {
          const inner = mergeSourced(acc[k] as Plain, src[k] as SourceTree, v, s2[k] as SourceTree);
          acc[k] = inner.v;
          src[k] = inner.s;
        } else if (isPlain(v)) {
          // **새로 등장하는 하위 트리** — 객체 하나에 source 문자열만 붙이면 그 안의 리프가
          // 전부 출처를 잃는다(§5.13 의 "모든 설정에 출처 표시" 가 깨진다).
          acc[k] = deepMerge({}, v);
          src[k] = s2[k];
        } else {
          acc[k] = v;
          src[k] = source as ValueSource;
        }
      }
    }
    return { values: acc, sources: src };
  })();

  // 스키마 마이그레이션 — 구 버전을 읽으면 자동 변환하고 **알 수 없는 키는 보존**한다.
  const declaredVersion = Number(values.schemaVersion ?? 0);
  const { values: migrated, notes } = migrate(values, declaredVersion);
  for (const n of notes) warnings.push(n);

  const originLines = flattenSources(sources);

  return { values: migrated, sources, originLines, warnings, schemaVersion: declaredVersion };
}

function mergeSourced(
  acc: Plain,
  accSrc: SourceTree,
  over: Plain,
  overSrc: SourceTree
): { v: Plain; s: SourceTree } {
  const v = deepMerge(acc, over);
  const s: SourceTree = { ...accSrc };
  for (const [k, val] of Object.entries(overSrc)) {
    if (typeof val === "string") {
      s[k] = val;
    } else if (isPlain(val)) {
      const prev = s[k];
      s[k] =
        isPlain(prev) && isPlain(over[k])
          ? mergeSourced(
              prev as Plain,
              prev as SourceTree,
              over[k] as Plain,
              val
            ).s
          : val; // 새로 생긴 하위 트리는 리프별로 출처를 갖는다
    }
  }
  return { v, s };
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * 마이그레이션. **알 수 없는 키를 버리지 않는다** — 앞으로 추가될 키를 사용자가
 * 날리면 안 되기 때문이다(§6.4).
 */
export function migrate(values: Plain, from: number): { values: Plain; notes: string[] } {
  const out = { ...values };
  const notes: string[] = [];
  if (from === SCHEMA_VERSION) return { values: out, notes };
  if (from === 0) {
    // 구 형식: 최상위 `model`/`baseUrl` → `llama.modelPath` / `llama.baseUrl`
    if (typeof out.model === "string") {
      out.llama = { ...(isPlain(out.llama) ? out.llama : {}), modelPath: out.model };
      delete out.model;
      notes.push("구 설정의 `model` 을 `llama.modelPath` 로 옮겼습니다.");
    }
    if (typeof out.baseUrl === "string") {
      out.llama = { ...(isPlain(out.llama) ? out.llama : {}), baseUrl: out.baseUrl };
      delete out.baseUrl;
      notes.push("구 설정의 `baseUrl` 을 `llama.baseUrl` 로 옮겼습니다.");
    }
    if (isPlain(out.laya)) {
      out.server = { ...(isPlain(out.server) ? out.server : {}), laya: out.laya };
      delete out.laya;
      notes.push("구 설정의 `laya` 를 `server.laya` 로 옮겼습니다.");
    }
    notes.push("설정 스키마를 v1 → v2 로 변환했습니다.");
  }
  out.schemaVersion = SCHEMA_VERSION;
  return { values: out, notes };
}

/** 원자적 쓰기: 임시 파일 → fsync → rename. 전원 차단으로 설정이 깨지면 부팅이 불가능해진다. */
export async function saveConfig(path: string, values: Plain, opts: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const text = stringifyYaml(values, { lineWidth: 0 });
  const fh = await import("node:fs/promises").then((fs) => fs.open(tmp, "w", 0o600));
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync(); // rename 전에 실제 디스크에 내림 — 없으면 tmp 와 본문이 갈라진다
  } finally {
    await fh.close();
  }
  if (opts.mode) await chmod(tmp, opts.mode);
  await rename(tmp, path);
}

/**
 * 시크릿은 설정 파일에 두지 않는다(§6.4). PAT 등은 `credentials.json`(0600).
 * 토큰 패턴을 스캔해 "설정에 토큰이 들어갔다" 는 것을 경고로 만든다.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "GitHub PAT", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "OpenAI", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "HuggingFace", re: /hf_[A-Za-z0-9]{20,}/ },
  { name: "AWS", re: /AKIA[0-9A-Z]{16}/ },
];

export function findSecrets(text: string): { name: string; line: number }[] {
  const hits: { name: string; line: number }[] = [];
  text.split("\n").forEach((line, i) => {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) hits.push({ name: p.name, line: i + 1 });
    }
  });
  return hits;
}

export interface CredentialStore {
  read: (service: string) => Promise<string | null>;
  write: (service: string, secret: string) => Promise<void>;
}

export function createCredentialStore(path: string): CredentialStore {
  return {
    async read(service) {
      try {
        const parsed = parseYaml(await readFile(path, "utf8")) as Record<string, string>;
        return parsed?.[service] ?? null;
      } catch {
        return null;
      }
    },
    async write(service, secret) {
      let current: Record<string, string> = {};
      try {
        current = (parseYaml(await readFile(path, "utf8")) as Record<string, string>) ?? {};
      } catch {
        // 없으면 새로 만든다
      }
      current[service] = secret;
      await saveConfig(path, current, { mode: 0o600 });
      if (existsSync(path)) await chmod(path, 0o600).catch(() => {});
    },
  };
}
