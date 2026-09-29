/**
 * 워크스페이스 이동 (§8.3 · 요구 13).
 *
 * "디렉토리 이동 = 워크스페이스 이동" 이 세 가지를 **한꺼번에** 바꾼다:
 *   1. 파일 트리 루트
 *   2. **에이전트의 작업 루트(baseDir)** — 도구 호출의 상대경로 기준
 *   3. rule/skill 로딩 대상 (`.harnesside/rules/`, `CLAUDE.md`, `AGENTS.md`)
 *
 * 셋 중 하나만 바꾸면 **조용히 잘못된 곳으로 쓰게 된다.** 예를 들어 트리만 바꾸면
 * 화면은 새 프로젝트인데 에이전트는 옛 폴더에 파일을 만든다 — 사용자가 직접 파일을
 * 열어봐야 알아챌 수 있는 유일한 순간이다. 그래서 전환은 **원자적**이어야 하고, 검증은
 * "셋이 전부 바뀌었나" 다.
 *
 * 세션 연속성 정책(§8.3): 대화·체크포인트는 **유지**하되, 새 루트에서 온 결과임을
 * 컨텍스트에 명시한다. 모델이 이전 경로를 계속 쓰기 때문이다.
 */

import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, resolve, join, sep } from "node:path";

export interface WorkspaceFingerprint {
  root: string;
  name: string;
  /** 감지된 프로젝트 종류. 액션 활성화의 근거가 된다. */
  kind: ProjectKind[];
  /** 이 루트에서 로드해야 할 규칙/스킬 파일 (존재하는 것만). */
  rules: { path: string; bytes: number }[];
  /** .git 이 있는가 — 저장소 이탈 경고의 근거. */
  git: boolean;
  packageManager: string | null;
  buildHint: string | null;
}

export type ProjectKind = "node" | "python" | "rust" | "go" | "java" | "dotnet" | "unknown";

const MARKERS: { kind: ProjectKind; file: string; pm?: string; build?: string }[] = [
  { kind: "node", file: "package.json", pm: "npm" },
  { kind: "python", file: "requirements.txt", build: "pytest" },
  { kind: "python", file: "pyproject.toml", pm: "uv", build: "pytest" },
  { kind: "rust", file: "Cargo.toml", pm: "cargo", build: "cargo test" },
  { kind: "go", file: "go.mod", build: "go test ./..." },
  { kind: "java", file: "pom.xml", pm: "maven", build: "mvn test" },
  { kind: "java", file: "build.gradle", pm: "gradle", build: "gradle test" },
  { kind: "dotnet", file: "*.csproj", build: "dotnet test" },
];

/** §8.3: 새 루트에서 다시 로드해야 할 규칙/스킬. 순서가 **우선순위** 다. */
export const RULE_FILES = [
  ".harnesside/rules.md",
  ".harnesside/rules/*.md",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
];

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function expandGlob(dir: string, pattern: string): Promise<string[]> {
  const [prefix, suffix] = pattern.split("*");
  const base = prefix ? resolve(dir, prefix) : resolve(dir);
  if (!(await exists(base))) return [];
  try {
    const names = await readdir(base);
    return names
      .filter((n) => n.endsWith(suffix))
      .sort() // **정렬이 있어야 규칙 적용 순서가 매 실행마다 같다**
      .map((n) => join(base, n));
  } catch {
    return [];
  }
}

/**
 * 워크스페이스 지문. 트리 루트·baseDir·규칙을 **한 번에** 결정한다.
 * 셋을 따로따로 구하면 그 사이에 루트가 바뀌어 서로 다른 프로젝트의 조각이 섞인다.
 */
export async function fingerprint(root: string): Promise<WorkspaceFingerprint> {
  const abs = resolve(root);
  const name = abs.split(sep).filter(Boolean).pop() ?? abs;
  const kinds = new Set<ProjectKind>();
  let packageManager: string | null = null;
  let buildHint: string | null = null;
  for (const m of MARKERS) {
    if (m.file.includes("*")) {
      if ((await expandGlob(abs, m.file)).length) {
        kinds.add(m.kind);
        buildHint ??= m.build ?? null;
      }
      continue;
    }
    if (await exists(join(abs, m.file))) {
      kinds.add(m.kind);
      packageManager ??= m.pm ?? null;
      buildHint ??= m.build ?? buildHint;
    }
  }
  if (kinds.size === 0) kinds.add("unknown");

  const rules: { path: string; bytes: number }[] = [];
  for (const pat of RULE_FILES) {
    const targets = pat.includes("*") ? await expandGlob(abs, pat) : [join(abs, pat)];
    for (const t of targets.sort()) {
      try {
        const st = await readFile(t);
        rules.push({ path: t, bytes: st.byteLength });
      } catch {
        // 읽을 수 없는 규칙 파일은 조용히 건너뛴다 — 없으면 없는 것이 맞다
      }
    }
  }

  return {
    root: abs,
    name,
    kind: [...kinds].sort(),
    rules,
    git: (await exists(join(abs, ".git"))) || (await exists(join(abs, ".git", "HEAD"))),
    packageManager,
    buildHint,
  };
}

export interface WorkspaceSwitch {
  from: WorkspaceFingerprint;
  to: WorkspaceFingerprint;
  /** 열린 탭 중 새 루트 밖에 있는 것 — 전부 닫히거나 경로를 다시 잡아야 한다. */
  orphanedTabs: string[];
  /** 이전 루트에서 온 도구 결과가 세션에 남아 있는가(§8.3 연속성 정책). */
  carriesPriorContext: boolean;
  /** 사용자에게 말해야 할 것. 비어 있으면 조용히 전환된 것이다. */
  warnings: string[];
  /** 세션/체크포인트는 유지한다(§8.3). */
  preserveSession: true;
}

/**
 * 전환 전에 **무엇이 바뀌는지** 계산한다. §8.3 은 확인 다이얼로그를 요구하므로,
 * 이 결과가 그 다이얼로그의 내용이다.
 */
export function planSwitch(from: WorkspaceFingerprint, to: WorkspaceFingerprint, openTabs: string[]): WorkspaceSwitch {
  const orphanedTabs = openTabs.filter((t) => !isInside(to.root, t));
  const warnings: string[] = [];

  if (orphanedTabs.length) {
    warnings.push(
      `열린 탭 ${orphanedTabs.length}개가 새 작업 폴더 밖에 있습니다: ${orphanedTabs.slice(0, 3).join(", ")}${orphanedTabs.length > 3 ? " 외" : ""}. 탭은 닫히고 새 루트 기준으로 다시 열립니다.`,
    );
  }
  const fromKinds = from.kind.filter((k) => k !== "unknown");
  const toKinds = to.kind.filter((k) => k !== "unknown");
  if (fromKinds.length && toKinds.length && !fromKinds.some((k) => toKinds.includes(k))) {
    warnings.push(
      `프로젝트 종류가 ${fromKinds.join("/")} 에서 ${toKinds.join("/")} 로 달라집니다. 도구의 실행 명령이 바뀝니다.`,
    );
  }
  if (from.git && !to.git) {
    warnings.push("이전 폴더는 Git 저장소였지만 새 폴더는 아닙니다. 커밋·diff 기능이 꺼집니다.");
  }
  if (!from.git && to.git) {
    warnings.push("새 폴더는 Git 저장소입니다. 변경 파일 목록이 보입니다.");
  }
  if (to.kind.includes("unknown")) {
    warnings.push("알 수 없는 프로젝트 종류입니다. 테스트 실행 액션이 비활성화됩니다.");
  }
  if (to.rules.length === 0) {
    warnings.push("새 폴더에 규칙 파일(CLAUDE.md 등)이 없습니다.");
  }

  return {
    from,
    to,
    orphanedTabs,
    // §8.3: 대화는 유지하되, 새 루트에서 온 결과임을 명시해야 모델이 이전 경로를
    // 계속 쓰지 않는다. 이 플래그가 그 주입을 지시한다.
    carriesPriorContext: true,
    warnings,
    preserveSession: true,
  };
}

/** 경로가 루트 안인지 — 문자열 비교가 아니라 경로 연산으로 판정한다(§3.4 교훈). */
export function isInside(root: string, p: string): boolean {
  const r = resolve(root);
  const a = isAbsolute(p) ? resolve(p) : resolve(join(r, p));
  return a === r || a.startsWith(r + sep);
}

/**
 * 경로 재작성: 이전 루트의 상대 경로를 새 루트로 옮긴다.
 * 새 루트 밖에 있는 경로는 **옮기지 않고 표시만 바꾼다** — 조용히 다른 파일을
 * 가리키게 만드는 것보다 "이 경로는 새 폴더에 없습니다" 가 낫다.
 */
export function rebasePath(path: string, fromRoot: string, toRoot: string): { path: string; ok: boolean } {
  const abs = isAbsolute(path) ? resolve(path) : resolve(join(fromRoot, path));
  if (!isInside(fromRoot, abs)) return { path, ok: false };
  const rel = abs.slice(resolve(fromRoot).length).replace(/^[\\/]/, "");
  if (!rel) return { path: toRoot, ok: true };
  const next = join(toRoot, rel);
  return isInside(toRoot, next) ? { path: next, ok: true } : { path, ok: false };
}

/** §8.3: 새 루트에서 온 결과를 기존 세션에 남길 때 붙이는 문장. */
export function contextBoundaryNote(from: WorkspaceFingerprint, to: WorkspaceFingerprint): string {
  return `[워크스페이스 변경] 작업 루트가 ${from.root} 에서 ${to.root} 로 바뀌었습니다. 이후 도구 결과는 ${to.root} 기준입니다. 이전 경로(${from.root} 아래)는 더 이상 유효하지 않으므로 상대경로로만 새 파일을 가리키십시오.`;
}
