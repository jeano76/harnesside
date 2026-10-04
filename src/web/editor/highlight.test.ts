/**
 * `editor/highlight.ts` — 하이라이터 유닛 (2026-10-05 · ②).
 *
 * 왜 이 파일이 없었나: 하이라이터는 **"있으면 좋고 없으면 아무도 모르는"** 층이었다.
 * diff · inline · model · autosave 에는 유닛이 있는데 221줄짜리 색칠기는 없었다.
 * 그 공백을 메우면서 **실제 버그가 하나 나왔다**(아래 "압축된 한 줄").
 *
 * 이 테스트가 지키는 불변식, 순서대로:
 *  1. **원문 보존** — 토큰을 이어 붙이면 입력과 정확히 같다. 색칠기가 글자를 잃으면
 *     사용자는 "파일에 없던 내용" 을 보게 된다. 하이라이트보다 나쁜 실패.
 *  2. **무한 루프 없음** — 빈 문자열을 매칭하는 규칙이 생겨도 브라우저가 멈추지 않는다.
 *  3. **확장자 → 언어** 매핑과, **모르는 형식은 `text`** 로 떨어지는 사실.
 *  4. **지원하지 않는다고 말한다** — 조용히 칠하지 않는다(호출부가 이름을 쓴다).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGE_LABEL,
  MIN_GUTTER,
  MAX_HIGHLIGHT_LINES,
  MAX_TOKEN_PASSES,
  colorFor,
  gutterWidthFor,
  languageFor,
  tokenizeLine,
  type Language,
} from "./highlight.js";

const LANGS: Language[] = ["typescript", "json", "yaml", "markdown", "python", "shell", "css", "html", "text"];

/** 사람이 만든 표본 — 퍼즈로 못 잡는 "의도된 모양" 을 담는다. */
const SAMPLES: Array<[Language, string]> = [
  ["typescript", `import { readFile } from "node:fs/promises";\n// 주석\nconst n: number = 0x1f;`],
  ["typescript", "const s = `a${b}c`; // 뒤 주석"],
  ["typescript", "/** 블록 주석 */ export default class A<T> extends B {}"],
  ["json", `{"a": 1, "b": [true, null], "c": {"d": "e"}}`],
  ["yaml", `# 주석\nname: 값\nlist:\n  - 1\n  - two`],
  ["markdown", "# 제목\n\n- 목록\n`코드` **굵게** [링크](http://x)"],
  ["python", `def f(x: int) -> str:\n    """문서"""\n    return f"{x!r}"`],
  ["shell", `#!/usr/bin/env bash\nset -eu\nfor f in *.md; do echo "-- $f"; done`],
  ["css", ":root { --x: 1px; }\n.c:hover > a[href^='#'] { color: #fff; }"],
  ["html", `<!-- 주석 --><div class="x" data-y='1'>본문<br/></div>`],
  ["text", "아무 색칠도 하지 않는 줄"],
];

const joined = (toks: Array<{ text: string }>) => toks.map((t) => t.text).join("");

// ── 1. 원문 보존 ────────────────────────────────────────────────────────────

test("**토큰을 이어 붙이면 원문과 정확히 같다** (모든 언어 · 모든 줄)", () => {
  for (const [lang, text] of SAMPLES) {
    const lines = text.split("\n");
    const rebuilt = lines.map((l) => joined(tokenizeLine(l, lang))).join("\n");
    assert.equal(rebuilt, text, `${lang} 에서 글자가 바뀌었다`);
  }
});

test("**빈 줄 · 공백 줄 · 들여쓰기**도 그대로 (화면에서 줄이 밀리면 안 된다)", () => {
  for (const s of ["", " ", "  ", "\t", "    ", " \t "]) {
    assert.equal(joined(tokenizeLine(s, "typescript")), s, `공백 줄이 바뀌었다: ${JSON.stringify(s)}`);
  }
});

test("**원본에 없는 문자를 만들어내지 않는다** — 주석 안의 문자열도 원문 그대로", () => {
  const tricky = [
    '// 이게 "문자열" 입니다',
    '/* a */ const x = 1 /* b */',
    "# 'not a string'",
    "/* * / */",
    "<!-- <div> -->",
    'const a = "it\'s";',
  ];
  for (const s of tricky) {
    assert.equal(joined(tokenizeLine(s, "typescript")), s);
    assert.equal(joined(tokenizeLine(s, "html")), s);
  }
});

// ── 압축된 한 줄 — **실제로 깨졌던 지점** ──────────────────────────────────

test("**압축된 한 줄에서도 글자가 전부 보인다** (실측으로 고친 결함의 회귀 검사)", () => {
  // 2026-10-05 실측: 반복 상한(500회)에 닿으면 남은 글자를 버리고 반환해서,
  // 14,290자짜리 압축 CSS 에서 **12,800자가 조용히 사라졌다.**
  const css = Array.from({ length: 900 }, (_, i) => `.c${i}{color:red}`).join("");
  const out = joined(tokenizeLine(css, "css"));
  assert.equal(out.length, css.length, `${css.length - out.length}자가 유실됐다`);
  assert.equal(out, css);
  // 다른 언어·다른 길이에서도 같은 안전장치가 작동하는지 본다.
  const js = "var a=1;".repeat(800);
  assert.equal(joined(tokenizeLine(js, "typescript")), js);
});

test("상한에 닿아도 **토큰 수는 유한**하다 (무한 루프 안전장치는 살아 있다)", () => {
  const css = Array.from({ length: 900 }, (_, i) => `.c${i}{color:red}`).join("");
  const toks = tokenizeLine(css, "css");
  assert.ok(toks.length > 0);
  // 한 번의 반복이 토큰을 **최대 2개**(앞쪽 `plain` + 매칭) 낼 수 있으므로 상한의 두 배가
  // 경계다. 이 값을 넘으면 반복 상한이 실제로 작동하지 않는 것이다.
  const maxTokens = MAX_TOKEN_PASSES * 2 + 2;
  assert.ok(
    toks.length <= maxTokens,
    `토큰 ${toks.length}개 — 상한(${MAX_TOKEN_PASSES}회)이 지켜지지 않는다`,
  );
  // **상한에 닿은 경로가 실제로 실행되었는지** 본다 — 위 유계선만으로는 아무것도 증명 못 한다.
  // 닿으면 남은 글자가 **한 덩어리의 `plain`** 으로 붙는다. 마지막 토큰이 그 증거다.
  const last = toks[toks.length - 1]!;
  assert.equal(last.kind, "plain", "마지막 토큰이 plain 이 아니다 — 상한 경로를 타지 않았다");
  assert.ok(last.text.length > 0, "붙은 나머지가 비었다 — 그 경로는 실제로 타지 않았다");
});

// ── 2. 확장자 → 언어 ────────────────────────────────────────────────────────

test("확장자 매핑 — **알려진 확장자**는 이름이 있는 언어로", () => {
  const cases: Array<[string, Language]> = [
    ["a.ts", "typescript"], ["a.tsx", "typescript"], ["a.js", "typescript"], ["a.jsx", "typescript"],
    ["a.mjs", "typescript"], ["a.cjs", "typescript"], ["a.json", "json"], ["a.yaml", "yaml"],
    ["a.yml", "yaml"], ["a.md", "markdown"], ["a.markdown", "markdown"], ["a.py", "python"],
    ["a.sh", "shell"], ["a.bash", "shell"], ["a.zsh", "shell"], ["a.fish", "shell"],
    ["a.css", "css"], ["a.html", "html"], ["a.htm", "html"],
  ];
  for (const [p, want] of cases) assert.equal(languageFor(p), want, `${p} → ${want} 이어야 한다`);
});

test("**모르는 확장자는 `text`** — 그리고 그 이름이 '일반 텍스트' 다 (조용히 칠하지 않는다)", () => {
  for (const p of ["a.rs", "a.go", "a.java", "a.rb", "a.c", "a.cpp", "a.sql", "Makefile", "a.toml", "a.exe", "a.png"]) {
    assert.equal(languageFor(p), "text", `${p} 를 임의의 언어로 분류했다`);
  }
  assert.equal(LANGUAGE_LABEL[languageFor("a.rs")], "일반 텍스트");
  // 대소문자는 무시한다 — `.RS` 도 같은 답이어야 한다.
  assert.equal(languageFor("A.RS"), "text");
  assert.equal(languageFor("A.TS"), "typescript");
});

test("`text` 는 **토큰 하나**로 준다 — 색칠하지 않되 글자는 온전하다", () => {
  const s = "const x = 1; // 색칠하지 않는다";
  const toks = tokenizeLine(s, "text");
  assert.equal(toks.length, 1);
  assert.equal(toks[0]!.kind, "plain");
  assert.equal(toks[0]!.text, s);
});

// ── 3. 색 매핑은 정본에서 ──────────────────────────────────────────────────

test("색은 **한 벌**만 있다 — 없는 종류는 본문색으로 떨어진다 (0 이나 undefined 아님)", () => {
  assert.equal(colorFor("keyword"), "#ff7b72");
  assert.equal(colorFor("string"), "#a5d6ff");
  assert.equal(colorFor("number"), "#79c0ff");
  assert.equal(colorFor("comment"), "#8b949e");
  assert.equal(colorFor("type"), "#7ee787");
  assert.equal(colorFor("function"), "#d2a8ff");
  assert.equal(colorFor("plain"), "#c9d1d9");
  // 없는 종류를 물으면 **본문색**. `undefined` 를 주면 CSS 에 그대로 흘러 "무색" 이 된다.
  assert.equal(colorFor("없는종류" as never), "#c9d1d9");
});

// ── 4. 상수 — 다른 곳이 참조하는 값 ─────────────────────────────────────────

test("읽기용 상수: 줄 번호 폭은 **최소 3자리**, 색칠 상한과 거터 상한이 정해져 있다", () => {
  assert.equal(MIN_GUTTER, 3);
  assert.equal(gutterWidthFor(9), 3);
  assert.equal(gutterWidthFor(999), 3);
  assert.equal(gutterWidthFor(1000), 4);
  assert.equal(gutterWidthFor(123456), 6);
  assert.ok(MAX_HIGHLIGHT_LINES > 0);
  assert.ok(MAX_TOKEN_PASSES > 0);
});

// ── 5. 이 검사가 거짓말할 수 있는 경우 (자기 감사) ──────────────────────────

test("퍼즈: 임의 문자열 3,000건에서도 **원문이 보존**된다 (표본 의존성 제거)", () => {
  const chars = "abz09_$#/`*.:;{}[]()+-=!?<>\"' \t가\\%&|~,^@";
  let seed = 987654321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 3000; i++) {
    const len = 1 + Math.floor(rnd() * 18);
    let s = "";
    for (let j = 0; j < len; j++) s += chars[Math.floor(rnd() * chars.length)];
    const lang = LANGS[Math.floor(rnd() * LANGS.length)];
    assert.equal(joined(tokenizeLine(s, lang)), s, `${lang} · ${JSON.stringify(s)}`);
  }
});
