/**
 * IDE 처럼 파일을 보이게 하는 최소 신택스 하이라이터.
 *
 * ── 왜 직접 만들었나 ────────────────────────────────────────────────────────
 * 의존성에 하이라이터가 없다(`@xterm` · `marked` 뿐). 네트워크 설치를 요구하는
 * 선택지를 이 프로그램이 갖지 않은 이유는 하나다 — **로컬 전용**이고, 채팅이
 * 로컬 llama-server 로 나간다. 여기서 외부 패키지를 깔면 그게 순식간에 깨진다.
 *
 * 그래서 **작은 하이라이터**를 쓴다. 이 저장소에서 실제로 다루는 언어만:
 * TypeScript/JavaScript · JSON · YAML · Markdown · Python · 셸 · CSS/HTML.
 *
 * ── 정직한 한계(감추지 않는다) ──────────────────────────────────────────────
 * 이건 **파서가 아니다.** 정규식 토크나이저이고 그래서:
 *  - 주석 안의 문자열을 구분하지 못한다("이게 주석입니다" 처럼 보이는 문자열).
 *  - 중첩된 템플릿 리터럴을 완전하게 처리하지 못한다.
 *  - 모르는 확장은 **색을 칠하지 않는다** — 그리고 화면에 그것을 **말한다**.
 *
 * 마지막이 중요하다. 모르는 언어를 **일반 텍스트로 조용히** 보여주면 사용자는
 * "하이라ighting 이 안 되네" 라고Program 오류를 찾으러 여기저기 돌아다닌다. 대신
 * "이 형식은 색칠하지 않습니다 (미지원: .foo)" 라고 말하는 게 낫다.
 * 같은 이유로 **줄 번호와 탭 폭 정렬**은 지원/미지원과 무관하게 항상 준다 — 그건
 * 하이라이터가 아니라 IDE 가-reading 이다.
 */

export type Language =
  | "typescript"
  | "json"
  | "yaml"
  | "markdown"
  | "python"
  | "shell"
  | "css"
  | "html"
  | "text";

/** 확장자 → 언어. **모르면 `text`** — 그리고 그것을 말해야 하므로 호출부가 이름을 쓴다. */
export function languageFor(path: string): Language {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "typescript";
  if (ext === "json") return "json";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (ext === "py") return "python";
  if (["sh", "bash", "zsh", "fish"].includes(ext)) return "shell";
  if (ext === "css") return "css";
  if (["html", "htm"].includes(ext)) return "html";
  return "text";
}

/** 화면에 보여줄 이름. 내부 식별자를 사용자에게 내놓지 않는다(§5.8). */
export const LANGUAGE_LABEL: Record<Language, string> = {
  typescript: "TypeScript",
  json: "JSON",
  yaml: "YAML",
  markdown: "Markdown",
  python: "Python",
  shell: "셸",
  css: "CSS",
  html: "HTML",
  text: "일반 텍스트",
};

/** 사람이 읽는 색. 어두운 테마 기준 — 배경을 기준으로 정하지 않으면 판독이 안 된다. */
const C = {
  keyword: "#ff7b72",
  string: "#a5d6ff",
  number: "#79c0ff",
  comment: "#8b949e",
  function: "#d2a8ff",
  type: "#7ee787",
  punct: "#8b949e",
  property: "#79c0ff",
  plain: "#c9d1d9",
} as const;

export type TokenKind = keyof typeof C | "property";

/** 한 줄 → 토큰. 순서대로 이어 붙이면 원문이 된다(보존이 최우선). */
export interface Token {
  kind: TokenKind;
  text: string;
}

/** 정규식 하나를 토큰 목록에 굽는다. 매칭되지 않은 구간은 `plain` 으로 남는다. */
interface Rule {
  re: RegExp;
  kind: TokenKind;
}

const TS_RULES: Rule[] = [
  { re: /^\/\/.*$/, kind: "comment" },
  { re: /^\/\*[\s\S]*?\*\//, kind: "comment" },
  { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/, kind: "string" },
  {
    re: /\b(?:import|export|from|default|const|let|var|function|class|extends|implements|interface|type|enum|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|void|this|super|null|undefined|true|false|as|satisfies|readonly|public|private|protected|static|get|set)\b/,
    kind: "keyword",
  },
  { re: /\b(?:string|number|boolean|void|any|unknown|never|object|symbol|bigint|Record|Partial|Readonly|Array|Promise)\b/, kind: "type" },
  { re: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/i, kind: "number" },
  { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/, kind: "function" },
  { re: /[{}()[\];,.:?]|=>|[=+\-*/%<>!&|^~]+/, kind: "punct" },
];

const SHELL_RULES: Rule[] = [
  { re: /^\s*#.*$/, kind: "comment" },
  { re: /"(?:[^"\\]|\\.)*"|'[^']*'/, kind: "string" },
  { re: /^\s*(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source)\b/, kind: "keyword" },
  { re: /\$\{?[A-Za-z_][\w]*\}?|\$\(|\$?`/, kind: "type" },
  { re: /\b(?:cd|ls|cat|grep|rm|mkdir|git|npm|npx|node|pnpm|yarn|python3?|curl|sudo|echo|export|chmod|kill|ps|ss|pgrep|tar)\b/, kind: "function" },
  { re: /(?:^|\s)--?[A-Za-z][\w-]*/, kind: "punct" },
  { re: /\b\d+\b/, kind: "number" },
];

const PY_RULES: Rule[] = [
  { re: /^\s*#.*$/, kind: "comment" },
  { re: /"""[\s\S]*?"""|'''[\s\S]*?'''/, kind: "string" },
  { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, kind: "string" },
  {
    re: /\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|lambda|yield|pass|global|nonlocal|assert|async|await|and|or|not|in|is|None|True|False)\b/,
    kind: "keyword",
  },
  { re: /\b(?:int|str|float|bool|list|dict|set|tuple|bytes|object|type)\b/, kind: "type" },
  { re: /\b[A-Za-z_][\w]*(?=\s*\()/, kind: "function" },
  { re: /\b\d[\d_]*(?:\.\d+)?\b/, kind: "number" },
  { re: /[{}()[\];,.:@]|[=+\-*/%<>!&|^~]+/, kind: "punct" },
];

const CSS_RULES: Rule[] = [
  { re: /\/\*[\s\S]*?\*\//, kind: "comment" },
  { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, kind: "string" },
  { re: /--[\w-]+/, kind: "type" },
  { re: /@[a-z-]+/, kind: "keyword" },
  { re: /\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/, kind: "number" },
  { re: /[.#]?[A-Za-z][\w-]*(?=[^;{}]*\{)/, kind: "function" },
  { re: /[a-z-]+(?=\s*:)/, kind: "property" },
  { re: /[{}();:,]/, kind: "punct" },
];

const RULES: Record<Language, Rule[]> = {
  typescript: TS_RULES,
  json: [
    { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/, kind: "property" },
    { re: /"(?:[^"\\]|\\.)*"/, kind: "string" },
    { re: /\b(?:true|false|null)\b/, kind: "keyword" },
    { re: /-?\b\d[\d.eE+-]*\b/, kind: "number" },
    { re: /[{}[\],:]/, kind: "punct" },
  ],
  yaml: [
    { re: /^\s*#.*$/, kind: "comment" },
    { re: /"(?:[^"\\]|\\.)*"|'[^']*'/, kind: "string" },
    { re: /^\s*-?\s*[A-Za-z_][\w.-]*(?=\s*:)/, kind: "property" },
    { re: /\b(?:true|false|null|yes|no|on|off)\b/, kind: "keyword" },
    { re: /\b\d[\d_]*(?:\.\d+)?\b/, kind: "number" },
    { re: /[-:[\]{},|>&*#?]/, kind: "punct" },
  ],
  markdown: [
    { re: /^#{1,6} .*$/, kind: "keyword" },
    { re: /```[\s\S]*?```/, kind: "string" },
    { re: /`[^`]+`/, kind: "string" },
    { re: /\*\*[^*]+\*\*/, kind: "type" },
    { re: /\[[^\]]*\]\([^)]*\)/, kind: "function" },
    { re: /^\s*>.*$/, kind: "comment" },
    { re: /^\s*[-*+]\s/, kind: "punct" },
  ],
  python: PY_RULES,
  shell: SHELL_RULES,
  css: CSS_RULES,
  html: [
    { re: /<!--[\s\S]*?-->/, kind: "comment" },
    { re: /<\/?[A-Za-z][\w-]*/, kind: "keyword" },
    { re: /"(?:[^"\\]|\\.)*"|'[^']*'/, kind: "string" },
    { re: /\b[A-Za-z-]+(?==)/, kind: "property" },
    { re: /[/>]/, kind: "punct" },
  ],
  text: [],
};

/**
 * 한 줄을 토큰으로.
 *
 * **원문을 그대로 보존한다** — 토큰을 이어 붙인 결과가 입력과 정확히 같아야 한다.
 * 여기서 한 글자라도 잃으면 "하이라이터가 코드를 망가뜨렸다" 가 되며, 그건
 * 하이라이트보다 훨씬 나쁜 실패다.
 */
export function tokenizeLine(line: string, lang: Language): Token[] {
  const rules = RULES[lang];
  if (!rules.length) return [{ kind: "plain", text: line }];
  const out: Token[] = [];
  let rest = line;
  let guard = 0;
  // 무한 루프 방어: 규칙이 빈 문자열을 매칭하면 여기서 멈추지 않는다.
  while (rest.length > 0 && guard++ < 500) {
    let best: { idx: number; len: number; kind: TokenKind } | null = null;
    for (const r of rules) {
      const m = r.re.exec(rest);
      // **앞쪽 우선, 같으면 긴 쪽** — 짧은 규칙이 긴 것을 잘라먹으면 코드가 깨진다.
      if (m && m.index >= 0 && (best === null || m.index < best.idx || (m.index === best.idx && m[0].length > best.len))) {
        best = { idx: m.index, len: m[0].length, kind: r.kind };
      }
    }
    if (!best || best.len === 0) {
      out.push({ kind: "plain", text: rest });
      break;
    }
    if (best.idx > 0) out.push({ kind: "plain", text: rest.slice(0, best.idx) });
    out.push({ kind: best.kind, text: rest.slice(best.idx, best.idx + best.len) });
    rest = rest.slice(best.idx + best.len);
  }
  return out.length ? out : [{ kind: "plain", text: line }];
}

export function colorFor(kind: TokenKind): string {
  return (C as Record<string, string>)[kind] ?? C.plain;
}

/** 몇 줄까지 색칠할까. 5천 줄 넘으면 느려지고, 사용자는 그 아래를 안 읽는다. */
export const MAX_HIGHLIGHT_LINES = 3000;

/** 읽기 좋은 폭. 이보다 긴 줄은 가로로 넘기고 **자르지 않는다**(코드에서 자르면 안 된다). */
export const MIN_GUTTER = 3;
export const gutterWidthFor = (lineCount: number): number => Math.max(MIN_GUTTER, String(lineCount).length);
