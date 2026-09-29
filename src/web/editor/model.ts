/**
 * 파일/에디터 도메인 로직 (§8.2 · §5.1).
 *
 * Monaco 를 직접 붙이기 전에 **판단이 필요한 부분**을 여기서 다 분리한다:
 * 언어 판정, 큰 파일 처리, 저장 충돌, 탭 상태. Monaco 는 렌더러일 뿐이고
 * 이 규칙들은 렌더러가 바뀌어도 그대로여야 한다(§1.5: lazy load).
 */

export type EditorKind = "code" | "markdown" | "json" | "image" | "binary" | "readonly";

export interface FileInfo {
  path: string;
  size: number;
  name: string;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown",
  yaml: "yaml", yml: "yaml",
  sh: "shell", bash: "shell", zsh: "shell",
  py: "python", rs: "rust", go: "go",
  java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cc: "cpp", cs: "csharp", php: "php", rb: "ruby", swift: "swift",
  html: "html", css: "css", scss: "scss", less: "less", vue: "html",
  sql: "sql", xml: "xml", toml: "ini", ini: "ini", conf: "ini",
  dockerfile: "dockerfile", env: "ini", gitignore: "ini",
};

export function languageOf(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext] ?? "plaintext";
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface OpenPlan {
  kind: EditorKind;
  language: string;
  /** 화면에 싣지 않고 자리표시자만 보여줄지(큰 파일은 앞부분만 로드). */
  truncate: boolean;
  content: string;
  omittedLines: number;
  readOnly: boolean;
  reason: string;
}

/**
 * 열 때 무엇을 보여줄지 결정한다. **빈 화면 금지**(§8.2) — 못 열면 이유를 말한다.
 */
export function planOpen(info: FileInfo, raw: string, opts: { readOnlyPaths?: string[]; inHarnessDir?: boolean } = {}): OpenPlan {
  const name = info.name.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const language = languageOf(info.path);

  if (IMAGE_EXT.has(ext) && ext !== "svg") {
    return { kind: "image", language, truncate: false, content: "", omittedLines: 0, readOnly: true, reason: "이미지" };
  }
  // NUL 바이트가 있으면 텍스트가 아니다(§3.4 와 같은 판정).
  if (raw.includes("\u0000")) {
    return {
      kind: "binary",
      language,
      truncate: false,
      content: "",
      omittedLines: 0,
      readOnly: true,
      reason: `바이너리 파일입니다 (${formatBytes(info.size)})`,
    };
  }

  const readOnly = (opts.readOnlyPaths?.some((p) => info.path.startsWith(p)) ?? false) || opts.inHarnessDir === true;
  const lines = raw.split("\n");
  const MAX_LINES = 50_000;
  if (lines.length > MAX_LINES || info.size > MAX_EDITABLE_BYTES) {
    const head = lines.slice(0, MAX_LINES).join("\n");
    return {
      kind: "code",
      language,
      truncate: true,
      content: head,
      omittedLines: lines.length - MAX_LINES,
      readOnly: true,
      reason: `${lines.length.toLocaleString("ko-KR")}줄 — 앞 ${MAX_LINES.toLocaleString("ko-KR")}줄만 표시합니다(읽기 전용). 전체는 편집기로 열지 않습니다.`,
    };
  }

  return {
    kind: language === "markdown" ? "markdown" : "code",
    language,
    truncate: false,
    content: raw,
    omittedLines: 0,
    readOnly,
    reason: readOnly ? "읽기 전용 경로입니다" : "",
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export interface Tab {
  path: string;
  name: string;
  dirty: boolean;
  baseVersion: number;
  readOnly: boolean;
  kind: EditorKind;
  preview?: string;
}

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: "conflict"; server: { content: string; version: number } }
  | { ok: false; reason: "outside-workspace" | "too-large" | "read-only"; detail: string };

/**
 * 저장 판정. **무음 덮어쓰기는 금지**(§3.4) — baseVersion 이 다르면 409 + 서버본문.
 */
export function decideSave(input: {
  tab: Tab;
  content: string;
  serverVersion?: number;
  outsideWorkspace?: boolean;
}): SaveResult {
  if (input.tab.readOnly) return { ok: false, reason: "read-only", detail: "읽기 전용입니다" };
  if (input.outsideWorkspace) return { ok: false, reason: "outside-workspace", detail: "워크스페이스 밖입니다" };
  if (new TextEncoder().encode(input.content).length > MAX_EDITABLE_BYTES) {
    return { ok: false, reason: "too-large", detail: `5 MiB 를 초과합니다 (${formatBytes(new TextEncoder().encode(input.content).length)})` };
  }
  const serverVersion = input.serverVersion ?? input.tab.baseVersion;
  if (serverVersion !== input.tab.baseVersion) {
    // 충돌: 조용히 덮으면 사용자가 다른 편집(또는 외부 편집)을 잃는다.
    return { ok: false, reason: "conflict", server: { content: "", version: serverVersion } };
  }
  return { ok: true, version: serverVersion + 1 };
}

export interface LayoutState {
  tabs: Tab[];
  active?: string;
  order: string[];
}

export function openTab(state: LayoutState, tab: Tab, opts: { preview?: boolean } = {}): LayoutState {
  const existing = state.tabs.find((t) => t.path === tab.path);
  if (existing) {
    // 이미 열려 있으면 포커스만 옮긴다. **중복 탭을 만들면 같은 파일이 두 군데에서 수정된다.**
    return { ...state, active: tab.path };
  }
  const next: Tab = opts.preview ? { ...tab, preview: "미리보기" } : tab;
  return { ...state, tabs: [...state.tabs, next], active: tab.path, order: [...state.order, tab.path] };
}

export function closeTab(state: LayoutState, path: string): LayoutState {
  const idx = state.order.indexOf(path);
  const tabs = state.tabs.filter((t) => t.path !== path);
  const order = state.order.filter((p) => p !== path);
  let active = state.active;
  if (active === path) {
    // 닫힌 자리에 인접한 탭으로 포커스를 옮긴다 — 없으면 마지막 탭.
    active = order[Math.min(idx, order.length - 1)];
  }
  return { ...state, tabs, order, active };
}

/** 저장하지 않은 변경이 있는지 — 종료 전에 반드시 확인한다(요구 7). */
export function dirtyTabs(state: LayoutState): Tab[] {
  return state.tabs.filter((t) => t.dirty);
}
