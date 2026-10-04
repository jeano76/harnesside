/**
 * 편집창 겹침 하이라이트 (2026-10-05 · ① 편집창 컬러 하이라이트).
 *
 * 이 기법의 실패는 두 가지라 **둘 다** 여기서 잡는다:
 *
 *  1. **어긋남** — 두 층의 문자 모양이 다르면 색이 한 칸씩 밀린다. 그래서 두 층이
 *     `EDITOR_TEXT_METRICS` 를 공유하고, 그것을 쓰는 곳이 둘인지를 본다.
 *  2. **글자가 사라짐(더 무서움)** — textarea 의 글자를 투명하게 만들면 **아래 층이
 *     보이지 않으면 편집창이 빈 화면이 된다.** 사용자는 자기 편집이 없어졌다고 믿는다.
 *     그래서 "투명 글자" 와 "색칠 층이 함께 렌더" 되는 것을 **한 검사로 묶어** 본다.
 *     하나만 있으면 실패다.
 *
 * 그리고 이 테스트는 **브라우저를 띄우지 않는다.** 실제 창에서 어긋나는지(폰트 치환·
 * 선택 색·RTL)는 미측정이며, 그 확인법은 `docs/VERIFICATION.md` 에 적었다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EDITOR_CARET_LAYER,
  EDITOR_OVERLAY_MAX_LINES,
  EDITOR_TEXT_METRICS,
  colorFor,
  editorOverlayPlan,
  normalizeForOverlay,
  unsupportedNote,
} from "./colorOverlay.js";

const here = dirname(fileURLToPath(import.meta.url));
const viewSrc = readFileSync(join(here, "EditorView.tsx"), "utf8");

const TS_SAMPLE = `import { readFile } from "node:fs/promises";
// 주석
export async function main(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  return raw.length;
}`;

// ── 글자가 보존되는가 (하이라이터가 코드를 망가뜨리면 하이라이트보다 나쁘다) ────

test("**토큰을 이어 붙이면 원본 줄과 같다** — 색칠이 글자를 잃지 않는다", () => {
  for (const text of [TS_SAMPLE, "a: 1 # 주석\nb: [1, 2]\n", "", "   ", "```\ncode\n```"]) {
    const plan = editorOverlayPlan({ text, lang: "typescript" });
    const rebuilt = plan.lines.map((l) => l.tokens.map((t) => t.text).join("")).join("\n");
    assert.equal(rebuilt, normalizeForOverlay(text), "색칠 후 글자가 원본과 다르다");
  }
});

test("**줄 수가 정확하다** — 마지막 줄이 사라지거나 늘어선다", () => {
  assert.equal(editorOverlayPlan({ text: "a\nb", lang: "typescript" }).totalLines, 2);
  // 끝의 빈 줄은 **진짜 빈 줄**이다. 1줄로 세면 마지막 줄이 한 칸 밀린다.
  assert.equal(editorOverlayPlan({ text: "a\n", lang: "typescript" }).totalLines, 2);
  assert.equal(editorOverlayPlan({ text: "a\n\n", lang: "typescript" }).totalLines, 3);
  assert.equal(editorOverlayPlan({ text: "", lang: "typescript" }).totalLines, 1);
  assert.equal(editorOverlayPlan({ text: "\n", lang: "typescript" }).totalLines, 2);
});

test("**줄 번호는 원래 파일의 줄 번호**다 (자른 뒤에도 1번부터 이어진다)", () => {
  const plan = editorOverlayPlan({ text: "a\nb\nc", lang: "typescript" });
  assert.deepEqual(plan.lines.map((l) => l.n), [1, 2, 3]);
});

// ── textarea 와 아래 층이 **같은 글자**여야 한다 ──────────────────────────────

test("줄바꿈을 정규화한다 — **Windows CRLF 를 그대로 칠하면 색이 밀린다**", () => {
  // 브라우저는 textarea 의 CRLF 를 LF 로 그린다. 색칠 층이 CRLF 를 유지하면
  // 첫 줄부터 어긋난다 — 실제 Windows 에서 나는 결함이다.
  const crlf = "a\r\nb\r\nc";
  assert.equal(normalizeForOverlay(crlf), "a\nb\nc");
  assert.equal(normalizeForOverlay("a\rb"), "a\nb", "옛 Mac 줄바꿈(\\r) 도 정규화해야 한다");
  assert.equal(normalizeForOverlay("a\nb"), "a\nb", "이미 LF 면 손대지 않는다");
  const plan = editorOverlayPlan({ text: crlf, lang: "typescript" });
  assert.equal(plan.totalLines, 3);
  assert.equal(plan.lines.map((l) => l.tokens.map((t) => t.text).join("")).join("\n"), "a\nb\nc");
});

test("두 층이 **같은 metrics 객체**를 쓴다 — 리터럴로 두 번 적지 않는다", () => {
  assert.ok(!/font:\s*"11px\/1\.5/.test(viewSrc), "EditorView 에 폰트 리터럴이 있다 — 두 벌이 됐다");
  const uses = viewSrc.match(/\.\.\.EDITOR_TEXT_METRICS/g) ?? [];
  // 세 층: ① 색칠 겹침 층 ② textarea ③ 읽기 전용 뷰. 하나라도 빠지면 그 층만 어긋난다
  // (사용자는 "이 화면만 왜 다른가" 로 읽는다 — 어느 층인지 말해 주는 사람이 없다).
  assert.equal(uses.length, 3, `EDITOR_TEXT_METRICS 를 쓰는 곳이 ${uses.length}개다 — 세 층이어야 한다`);
});

test("metrics 자체가 **어긋남을 만드는 항목들**을 모두 갖췄다", () => {
  // 빠진 항목이 "화면에서는 잘 보이는데 색만 밀리는" 실패로 이어진다.
  for (const key of ["font", "padding", "tabSize", "whiteSpace", "lineHeight", "letterSpacing", "wordBreak"]) {
    assert.ok(key in EDITOR_TEXT_METRICS, `metrics 에 ${key} 가 없다 — 한 층만 설정된다`);
  }
  assert.equal(EDITOR_TEXT_METRICS.tabSize, 2, "탭 폭이 tokens.ts 의 TAB_SIZE 와 어긋난다");
  // 폰트 문자열을 여기서 새로 적지 않는다 — 정본(theme/tokens.ts)에서 만든다.
  assert.match(EDITOR_TEXT_METRICS.font, /JetBrains Mono/, "tokens.ts 의 FONT.MONO 가 아니다");
});

test("투명한 글자에는 **커서를 되살린다** — 보이지 않는 편집창에 커서 없는 창은 죽은 창이다", () => {
  assert.equal(EDITOR_CARET_LAYER.color, "transparent");
  assert.ok(EDITOR_CARET_LAYER.caretColor, "caretColor 가 없다 — 커서가 사라진다");
  assert.equal(
    (EDITOR_CARET_LAYER as Record<string, unknown>).WebkitTextFillColor,
    "transparent",
    "WebkitTextFillColor 가 없으면 Safari 계열에서 글자가 **보여서** 두 번 출력된다",
  );
  assert.match(viewSrc, /\.\.\.EDITOR_CARET_LAYER/, "textarea 가 caret layer 를 쓰지 않는다");
});

// ── 글자가 보이게 하는 층이 **반드시** 렌더된다 ───────────────────────────────

test("**투명 글자와 색칠 층은 함께 존재해야 한다** — 하나만 있으면 편집창이 빈 화면이다", () => {
  const transparent = /\.\.\.EDITOR_CARET_LAYER/.test(viewSrc);
  const layer = /<pre[\s\S]{0,400}aria-hidden="true"/.test(viewSrc);
  assert.ok(transparent, "textarea 글자를 투명하게 만들지 않았다 (색칠 층이 있어도 의미 없음)");
  assert.ok(layer, "색칠 층(<pre>) 이 없다 — **글자가 보이지 않는다**");
  // 색칠 층은 스크린리더에 중복 노출되면 안 된다 — 같은 내용을 두 번 읽는다.
  assert.match(viewSrc, /aria-hidden="true"/, "색칠 층이 스크린리더에도 읽힌다 — 내용을 두 번 읽는다");
  // 입력을 가로채서는 안 된다 — 클릭하면 글자 위가 아니라 아래 층을 클릭하게 된다.
  assert.match(viewSrc, /pointerEvents: "none"/, "색칠 층이 클릭을 가로챈다 — 커서 위치가 어긋난다");
  // 스크롤 동기화 — 없으면 아래 층이 스크롤을 따라가지 않는다(색이 위로 흐른다).
  assert.match(viewSrc, /onScroll=/, "스크롤 동기화가 없다");
  assert.match(viewSrc, /translateY\(/, "스크롤 동기화가 translate 가 아니다");
});

// ── 색칠하지 못하는 경우를 **말한다** ────────────────────────────────────────

test("미지원 형식은 **칠하지 않고 그 사실을 말한다**", () => {
  const plan = editorOverlayPlan({ text: 'fn main() { println!("hi"); }', lang: "text", path: "src/main.rs" });
  assert.equal(plan.colorable, false, "미지원 형식을 칠했다");
  assert.match(plan.note!, /색칠하지 않습니다/);
  assert.match(plan.note!, /미지원: \.rs/, "어느 확장자인지 말하지 않는다");
  // 그래도 **내용은 그대로** 보여야 한다 — plain 토큰으로 전부 나온다.
  assert.equal(plan.lines.map((l) => l.tokens.map((t) => t.text).join("")).join("\n"), 'fn main() { println!("hi"); }');
  assert.match(unsupportedNote("Makefile"), /확장자 없음/);
});

test("**자르면 그 사실을 말한다** — 조용히 자르지 않는다", () => {
  const many = Array.from({ length: EDITOR_OVERLAY_MAX_LINES + 250 }, (_, i) => `const x${i} = ${i};`).join("\n");
  const plan = editorOverlayPlan({ text: many, lang: "typescript" });
  assert.equal(plan.truncated, true);
  assert.equal(plan.lines.length, EDITOR_OVERLAY_MAX_LINES);
  assert.match(plan.note!, /자르지 않았습니다/, "자른 사실을 말하지 않는다");
  assert.match(plan.note!, new RegExp(EDITOR_OVERLAY_MAX_LINES.toLocaleString("ko-KR")));
  // 작은 파일에는 ** unreasonably 큰 상한이 아니라 실제로 상한이 걸리지 않는다** — 노이즈를 만들지 않는다.
  const small = editorOverlayPlan({ text: "a\nb", lang: "typescript" });
  assert.equal(small.truncated, false);
  assert.equal(small.note, undefined, "잘리지 않았는데 말이 붙었다");
});

test("`text` 언어가 아니면 **메시지가 안 붙는다** — 정상 파일에 경고가 붙지 않는다", () => {
  const plan = editorOverlayPlan({ text: TS_SAMPLE, lang: "typescript", path: "a.ts" });
  assert.equal(plan.note, undefined);
  assert.equal(plan.colorable, true);
});

test("토큰 색은 **하이라이터 정본**에서 온다 — 색을 두 벌로 만들지 않는다", () => {
  // `colorFor` 는 `highlight.ts` 의 것을 재-export 한 것이어야 한다(한 벌).
  assert.equal(colorFor("keyword"), "#ff7b72");
  assert.match(viewSrc, /colorFor\(t\.kind\)/, "토큰 색을 쓰지 않는다");
});
