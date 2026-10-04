/**
 * 대화 마크다운 — **강조가 보인다** / **위험한 것은 통과시키지 않는다** (2026-10-01).
 *
 * 실측 출발점: 대화 본문이 `pre` 에 원문 그대로 들어갔다. 그래서 모델이 보낸
 * `**굵게**`, `` `코드` ``, `## 제목` 이 **기호 그대로** 보였다. 강조가 없었다는
 * 말이고 그건 **맞았다** — 파일 미리보기만 색이 있었고 대화는 플레인 텍스트였다.
 *
 * 여기서는 두 가지를 함께 고정한다:
 *   1. **강조가 실제로 나간다** — 머리·굵게·인라인 코드·펜스가 각각 다른 모양.
 *   2. **원본 HTML 은 통과시키지 않는다** — 모델 출력을 그대로 신뢰하면 안 된다.
 *
 * 2번이 더 중요하다. **"안전해 보이지만 위험한 것"** 이 가장 위험하다 — 이전 버그에서
 * 404 가 올바른 문장("읽지 못했습니다")으로 떠서 사용자는 "파일이 없다" 고 믿고
 * 개발자는 아무것도 못 찾았다. 여기서도 **모르는 태그를 조용히 내보내면** 같은 일이
 * 화면에서 일어난다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

const ROOT = process.cwd();
const src = readFileSync(join(ROOT, "src/web/panels/Markdown.tsx"), "utf8");
const panel = readFileSync(join(ROOT, "src/web/panels/AgentPanel.tsx"), "utf8");

/** 이 컴포넌트와 **같은 설정**으로 파싱한다 — 설정이 달라지면 검사가 빈CHK가 된다. */
function parse(text: string): string {
  marked.setOptions({ gfm: true, breaks: false, async: false });
  marked.use({ renderer: { html: () => "" } });
  return String(marked.parse(text, { async: false }));
}

// ── 1. 강조가 실제로 나가는가 ───────────────────────────────────────────────

test("`**굵게**` 는 `strong` 으로 — 기호가 그대로 보이면 강조가 없는 것이다", () => {
  assert.match(parse("**굵게**"), /<strong>굵게<\/strong>/);
});

test("`` `코드` `` 는 `code` 로", () => {
  assert.match(parse("`const a = 1`"), /<code>const a = 1<\/code>/);
});

test("`## 제목` 은 `h2` 로 — 단계가 보존된다", () => {
  const out = parse("## 제목");
  assert.match(out, /<h2>/);
  assert.ok(!/<p>## /.test(out), "제목이 문단이 되었다 — 단계가 사라졌다");
});

test("`**` 안의 `*` 는 **강조가 아니라** 글자로 — 과하게 칠하면 읽을 수 없다", () => {
  // `2 * 3 * 4` 를 세 강조로 보면 수식이 깨져 보인다.
  const out = parse("2 * 3 * 4");
  assert.ok(!/<em>/.test(out), `수식이 강조로 바뀌었다: ${out}`);
});

test("**목록**은 항목으로 — 하나가 아니라 여러 개", () => {
  assert.match(parse("- 하나\n- 둘"), /<li>하나<\/li>/);
});

test("**링크**는 주소가 남는다 — 무엇으로 가는지는 말해야 한다", () => {
  assert.match(parse("[클릭](https://x.com)"), /href="https:\/\/x\.com"/);
});

// ── 2. 원본 HTML 은 통과시키지 않는다 ───────────────────────────────────────

test("`<script>` 는 **버려진다** — 모델 출력을 그대로 믿으면 안 된다", () => {
  const out = parse("<script>alert(1)</script>");
  assert.ok(!/<script/i.test(out), `스크립트가 통과했다: ${out}`);
  assert.ok(!/alert\(1\)/.test(out), `스크립트 내용이 살아남았다: ${out}`);
});

test("`<img onerror>` 는 **버려진다** — 속성 주입 경로", () => {
  const out = parse("<img src=x onerror=alert(1)>");
  assert.ok(!/onerror/i.test(out), `이벤트 속성이 통과했다: ${out}`);
  assert.ok(!/alert\(1\)/.test(out), `스크립트가 살아남았다: ${out}`);
});

test("**인라인 이벤트**는 남지 않는다 — `javascript:` 링크도", () => {
  // `marked` 는 **`javascript:` 를 그대로 통과시킨다**(실측). 파서가 아니라
  // **렌더러가** 막아야 한다 — 그래야 실제 화면이 안전하다.
  assert.match(parse("[클릭](javascript:alert(1))"), /javascript:/, "파서가 이미 막는다고 가정하면 안 된다");
  const out = parse("[클릭](javascript:alert(1))");
  // 컴포넌트의 방어선은 `safeHref` 다 — 여기서 확인한다.
  assert.match(src, /export function safeHref/, "safeHref 가 없다 — 렌더러가 방어하지 않는다");
  assert.match(src, /\["http", "https", "mailto"\]\.includes\(scheme\)/, "화이트리스트가 아니다 — 블랙리스트는 새 스킴에 뚫린다");
  assert.match(src, /if \(!href\)/, "위험한 링크를 그대로 둔다");
  assert.ok(!/rel="noreferrer noopener" \}>/.test(src) || /safeHref\(el\.props\.href\)/.test(src), "noopener 만 믿는다 — javascript: 는 못 막는다");
});

test("**원본 속성은 신뢰하지 않는다** — `style` 로 무엇이든 주입될 수 있다", () => {
  // 파서는 통과시킬 수 있다. **렌더러가 속성을 모두 벗긴다** — 그게 방어선이다.
  assert.match(src, /removeAttribute/, "속성을 벗기지 않는다 — 주입 경로가 열려 있다");
});

test("**모르는 태그**는 **텍스트로만** 내린다 — 미끼를 넣지 않는다", () => {
  assert.match(src, /모르는 태그/, "모르는 태그 처리 규칙이 없다");
  assert.match(src, /<span key=\{key\}>\{kids\}<\/span>/, "모르는 태그를 그대로 감싸지 않는다");
});

// ── 3. 실측 — 강조가 없었던 것을 되돌린다 ────────────────────────────────────

test("대화 본문이 **더 이상 `pre` 원문이 아니다** — 그게 원인이었다", () => {
  // `kind === "text"` 가 `pre` 로 그려지던 것이 원인이다.
  // 창을 **넓히되**, 첫 `}` 에서 자르지 않는다 — 주석 안에 `}` 가 있다.
  // **분기 전체**를 `if (` 와 다음 분기(`if (b.kind === "status")`) 사이로 잡는다.
  const textBranch = /if \(b\.kind === "text"\) \{[\s\S]*?\n  \}\n/.exec(panel);
  assert.ok(textBranch, "text 블록 렌더 분기를 찾지 못했다");
  assert.ok(
    !/<pre style=\{\{ margin: 0, whiteSpace: "pre-wrap"/.test(textBranch[0]),
    "text 블록이 여전히 pre 에 원문 그대로 들어간다 — 강조가 없다",
  );
  assert.match(textBranch[0], /<Markdown text=\{b\.text\}/, "text 블록이 Markdown 을 쓰지 않는다");
});

test("**사용자 발화**는 원문 그대로 — 사람이 쓴 글에 마크다운을 씌우면 원본이 사라진다", () => {
  const userBranch = /if \(b\.kind === "user"\) \{[\s\S]{0,600}?\n  \}/.exec(panel);
  assert.ok(userBranch, "user 분기를 찾지 못했다");
  assert.match(userBranch[0], /\{b\.text\}/, "사용자 발화가 변환된다 — 원문이 아니게 된다");
  assert.doesNotMatch(userBranch[0], /<Markdown/, "사용자 발화에 마크다운 렌더를 적용했다");
});

test("**셸 출력**은 마크다운이 아니다 — 코드 블록으로 그린다", () => {
  // 셸 출력에 마크다운을 씌우면 `**` 같은 문자가 강조로 바뀌어 **출력이 틀려 보인다.**
  const tool = readFileSync(join(ROOT, "src/web/panels/ToolBlock.tsx"), "utf8");
  assert.doesNotMatch(tool, /<Markdown/, "셸 출력에 마크다운 렌더를 적용했다 — 출력이 변형된다");
  assert.match(tool, /<CodeBlock/, "셸 출력이 코드 블록이 아니다");
});

test("**펜스 언어**는 펜스 정보로 정한다 — 없으면 추측하지 않는다", () => {
  // 언어를 잘못 칠하면 지어내게 되고, 그건 색 없는 것보다 나쁘다.
  assert.match(src, /langHint/, "펜스 언어를 읽지 않는다");
  assert.match(src, /\? "text"|: "text"/, "언어가 없을 때의 기본값이 없다");
});

// ── 4. 이 검사가 **자기 자신을 속이지 않는지** ────────────────────────────────

test("[살아있는지] 이 검사의 파서가 **강조를 실제로 잡는다** — 아니면 아래가 빈 소리다", () => {
  // `html: () => ""` 설정이 다른 곳에서 덮어써졌다면, **보안 검사 4건이 전부**
  // 통과하면서 아무것도 검사하지 않게 된다.
  assert.match(parse("**굵게**"), /<strong>/, "자기 파서가 강조를 못 잡는다 — 아래 검사가 무효");
  assert.match(parse("```ts\nx\n```"), /class="language-ts"/, "자기 파서가 펜스를 못 잡는다");
});

test("파서와 컴포넌트가 **같은 설정**을 쓴다 — 어긋나면 검사가 빈 소리가 된다", () => {
  // 컴포넌트에는 `html` 차단이 **있어야** 한다. 없으면 위 4건이 통과하는데
  // 실제 앱은 위험한 HTML 을 렌더한다 — **검사와 제품이 다른 것**이 가장 나쁘다.
  assert.match(src, /html\(\)\s*\{\s*return "";/, "컴포넌트가 원본 HTML 을 차단하지 않는다");
  assert.match(src, /async: false/, "marked 의 비동기 설정이 없다 — html 차단이 씹힐 수 있다");
});

test("**렌더에 실패하면 원문을 둔다** — 빈 화면이 결함이다", () => {
  assert.match(src, /catch[\s\S]{0,200}return ""/, "파싱 실패 처리가 없다");
  assert.match(src, /html \? toReact\(html\) : text/, "실패하면 빈 화면만 남는다");
});

test("표 머리글은 `th` 로 — `td` 로 내리면 머리인지 모른다", () => {
  assert.match(src, /if \(el\.type === "th"\)/, "th 분기가 없다 — 머리가 일반 셀로 그려진다");
  assert.match(src, /<th key=\{key\}/, "th 엘리먼트가 없다");
  assert.match(src, /fontWeight: 700/, "머리 강조가 없다");
});

test("표 구조(thead/tbody/tr)를 살린다 — 줄만 있고 선이 없으면 깨져 보인다", () => {
  for (const tag of ['"thead"', '"tbody"', '"tr"']) {
    assert.ok(src.includes(`el.type === ${tag}`), `${tag} 분기가 없다`);
  }
});
