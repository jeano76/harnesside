/**
 * 인덴트 가이드 (2026-10-05 · ③).
 *
 * 이 테스트가 지키는 것, 순서대로:
 *  1. **위치 계산이 맞는다** — 2칸 들여쓰기에선 0열·2열, 4칸 탭에선 0열·4열.
 *  2. **탭은 "다음 탭 정지 위치" 만큼 간다** — 1 열에서 탭은 1칸. 이걸 1로 세면
 *     실제 탭 들여쓰기 파일에서 선이 어긋난다.
 *  3. **닫는 줄에는 자기 단계의 선이 없다** — 괄호를 관통하는 선이 가장 시끄럽다.
 *  4. **`ch` 로 배치한다** — 글자 폭을 재지 않는다. px 로 바꾸면 폰트 로드 전에
 *     측정해 **선이 코드 사이에 삐져나온다**(모듈 머리말에 실측 근거).
 *  5. **세 화면이 같은 규칙을 쓴다** — 한 화면만 다른 계산이면 사용자는
 *     "이 화면만 왜 다른가" 를 보며 원인을 찾을 수 없다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GUIDE_TAB_SIZE, GUIDE_VISUAL, guideLeftCss, indentColumnsFor, indentInfoFor } from "./indentRules.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");
const editorSrc = read("EditorView.tsx");
const previewSrc = read("../panels/FilePreview.tsx");
const codeBlockSrc = read("../panels/CodeBlock.tsx");
const renderSrc = read("IndentGuides.tsx");
const overlaySrc = read("colorOverlay.ts");

// ── 1. 들여쓰기 열 계산 ─────────────────────────────────────────────────────

test("들여쓰기 **열**을 센다 — 2칸 들여쓰기 4칸은 열 2개", () => {
  assert.equal(indentColumnsFor(""), 0);
  assert.equal(indentColumnsFor("x"), 0);
  assert.equal(indentColumnsFor("  x"), 2);
  assert.equal(indentColumnsFor("    x"), 4);
  assert.equal(indentColumnsFor("      x"), 6);
});

test("탭은 **다음 탭 정지 위치** 만큼 간다 — 1열에 탭은 1칸, 0열에 탭은 2칸", () => {
  // tabSize=2: 0열 → 2, 1열 → 2, 2열 → 4, 3열 → 4
  assert.equal(indentColumnsFor("\tx", { tabSize: 2 }), 2);
  assert.equal(indentColumnsFor(" \tx", { tabSize: 2 }), 2, "1열 + 탭 = 2열이어야 한다");
  assert.equal(indentColumnsFor("  \tx", { tabSize: 2 }), 4);
  assert.equal(indentColumnsFor("   \tx", { tabSize: 2 }), 4);
  // 4칸 탭 파일에서 탭 하나는 4열.
  assert.equal(indentColumnsFor("\tx", { tabSize: 4 }), 4);
  assert.equal(indentColumnsFor("\t\tx", { tabSize: 4 }), 8);
});

test("가이드 열은 **자기보다 바깥인 블록 시작 열**이다", () => {
  // 옵션을 **통과**시킨다 — 흘려보내면 tabSize=4 를 주는 케이스가 2 로 계산되어
  // 통과를 해 버린다(검사가 계산을 검사하지 않는 함수가 된다).
  const g = (line: string, opts: { tabSize?: number; step?: number } = { tabSize: 2 }) => indentInfoFor(line, opts).guides;
  assert.deepEqual(g("a"), []);
  assert.deepEqual(g("  a"), [0]);
  assert.deepEqual(g("    a"), [0, 2]);
  assert.deepEqual(g("      a"), [0, 2, 4]);
  // 들여쓰기 8열(tabSize=4) → 0열·4열
  assert.deepEqual(g("\t\ta", { tabSize: 4 }), [0, 4]);
});

test("**스텝은 탭 폭과 따로** — 4칸 들여쓰기 흔(tabSize=4)에서 4칸마다 선", () => {
  // 탭 폭 4(글자가 4칸 차지) + 2칸 들여쓰기 → 선은 2칸마다.
  const info = indentInfoFor("    x", { tabSize: 4, step: 2 });
  assert.deepEqual(info.guides, [0, 2]);
  assert.equal(info.indentColumns, 4);
});

test("**빈 줄에는 선이 없다** — 빈 줄에 선이 있으면 다음 줄이 어긋나 보인다", () => {
  for (const blank of ["", "   ", "\t"]) {
    const info = indentInfoFor(blank);
    assert.equal(info.blank, true, JSON.stringify(blank));
    assert.deepEqual(info.guides, [], "빈 줄에 선이 생겼다");
  }
});

// ── 2. 닫는 줄 ──────────────────────────────────────────────────────────────

test("**닫는 괄호 줄**에는 자기 단계의 선이 없다 — 괄호를 관통하지 않는다", () => {
  const info = indentInfoFor("    }", { tabSize: 2 });
  assert.equal(info.closing, true);
  assert.equal(info.closingKind, "brace");
  // 들여쓰기 4지만 한 단계(2) 안으로 빼므로 **0열까지만** — 2열 선이 `}` 를 관통했다.
  assert.deepEqual(info.guides, [0]);
});

test("닫는 줄 판정이 **알려진 토큰만** — 추측으로 넓히지 않는다", () => {
  const cases: Array<[string, boolean]> = [
    ["}", true], ["  }", true], ["]", true], [")", true],
    ["end", true], ["  else:", true], ["x = 1", false], ["", false],
    // `:` 로 끝나는 줄은 **열지 않는다** — 실측 오탐의 근거(아래 테스트).
    ["try:", false], ["if x:", false], ["case 1:", false], ["key:", false],
  ];
  for (const [line, want] of cases) {
    assert.equal(indentInfoFor(line).closing, want, `${JSON.stringify(line)} 의 판정이 ${want} 이어야 한다`);
  }
});

test("`:` 로 끝나는 줄은 **닫는 줄로 보지 않는다** — Python·JS 의 블록 여는 줄을 망가뜨리지 않기 위해", () => {
  // YAML 키(`key:`)는 블록을 닫는 것처럼 보이지만, 같은 모양이 Python/JS 에선
  // **블록을 여는** 줄이다. 언어 정보 없이 구분할 수 없으므로 **열지 않는다.**
  // 손해: YAML 키 줄의 선이 한 단계 깊게 보인다. 반대 선택의 손해가 더 크다.
  const opened = indentInfoFor("  try:", { tabSize: 2 });
  assert.equal(opened.closing, false);
  assert.deepEqual(opened.guides, [0], "블록 여는 줄에서 자기 단계의 선이 사라졌다");
  const yamlKey = indentInfoFor("  key:", { tabSize: 2 });
  assert.deepEqual([...yamlKey.guides], [0], "YAML 은 한 단계 깊게 보일 수 있다 — 감추지 않는다");
});

test("닫는 괄호가 **문자열 안에 있으면** 닫는 줄이 아니다", () => {
  const info = indentInfoFor('    const s = "}";', { tabSize: 2 });
  assert.equal(info.closing, false, "문자열 안의 } 를 닫는 괄호로 봤다");
});

// ── 3. 배치: `ch` 단위 ──────────────────────────────────────────────────────

test("배치는 **`ch`** 다 — px 로 변환하지 않는다 (측정 없이 정확해야 한다)", () => {
  assert.equal(guideLeftCss({ column: 0, offsetCh: 0 }), "calc(0.000ch)");
  assert.equal(guideLeftCss({ column: 2, offsetCh: 0 }), "calc(2.000ch)");
  // 거터가 있어도 덧셈 한 번이다 — 픽셀 변환이 개입할 자리가 없다.
  assert.equal(guideLeftCss({ column: 2, offsetCh: 4 }), "calc(6.000ch)");
  assert.ok(guideLeftCss({ column: 1, offsetCh: 0 }).includes("ch"), "ch 가 아니다");
  assert.ok(!guideLeftCss({ column: 1, offsetCh: 0 }).includes("px"), "px 가 섞였다 — 글자 폭을 잰 셈이 된다");
});

test("소수 열도 **3자리까지만** — 0.5px 씩 다른 선이 계단처럼 보인다", () => {
  const css = guideLeftCss({ column: 0.5, offsetCh: 0 });
  assert.equal(css, "calc(0.500ch)");
  assert.equal(guideLeftCss({ column: 0.12345, offsetCh: 0 }), "calc(0.123ch)");
});

test("선은 본문보다 약해야 한다 — 강하면 화면이 선으로 가득 찬다", () => {
  assert.ok(GUIDE_VISUAL.opacity < 0.5, `선 불투명도 ${GUIDE_VISUAL.opacity} — 코드가 죽는다`);
  assert.equal(GUIDE_VISUAL.width, "1px");
});

// ── 4. 배선: 세 화면이 **같은 규칙** ────────────────────────────────────────

test("세 화면(편집창 · 파일 미리보기 · 코드 블록)이 **같은 규칙**을 쓴다", () => {
  for (const [name, src] of [
    ["파일 미리보기", previewSrc],
    ["코드 블록", codeBlockSrc],
  ] as const) {
    assert.match(src, /indentInfoFor\(/, `${name} 이 인덴트 규칙을 계산하지 않는다`);
    assert.match(src, /<IndentGuides\b/, `${name} 이 가이드를 그리지 않는다`);
    assert.match(src, /FONT\.TAB_SIZE/, `${name} 이 탭 폭 정본(FONT.TAB_SIZE)을 쓰지 않는다`);
  }
  // 편집창은 **계산을 오버레이 계획이** 합니다(매 keystroke 다시 그리므로). 렌더만 편집창이 한다.
  assert.match(overlaySrc, /indentInfoFor\(/, "오버레이가 인덴트를 계산하지 않는다");
  assert.match(editorSrc, /<IndentGuides\b/, "편집창이 가이드를 그리지 않는다");
  assert.match(editorSrc, /l\.indent/, "편집창이 계산된 결과를 쓰지 않는다");
});

test("가이드는 **코드 텍스트 기준 상대 좌표**다 — 거터(em)와 ch 를 섞지 않는다", () => {
  // 거터는 `em` 단위라서 `ch` 로 바꾸려면 글자 폭을 재야 한다. 그래서 두 화면 모두
  // **코드 span 안쪽**에 두고 offsetCh=0 을 쓴다. 이게 깨지면 선이 줄 번호 위에 놓인다.
  for (const src of [previewSrc, codeBlockSrc]) {
    assert.match(src, /position: "relative"/, "코드 span 이 relative 가 아니다 — 상대 좌표의 기준이 없다");
    assert.match(src, /offsetCh=\{0\}/, "offsetCh 가 0 이 아니다 — 거터와 ch 를 섞고 있다");
  }
});

test("**명령줄에는 선이 없다** — `$ npm run build` 의 들여쓰기는 블록이 아니다", () => {
  assert.match(codeBlockSrc, /!isCommandLine\(i\) && \(\s*<IndentGuides/, "명령줄에도 가이드를 그린다");
});

test("가이드가 **없으면 아무것도 렌더하지 않는다** — 빈 div 를 남기지 않는다", () => {
  assert.match(renderSrc, /if \(info\.guides\.length === 0\) return null;/, "선이 0개여도 DOM 을 그린다");
  // 선은 클릭을 가로채면 안 된다 — 커서가 clicking 이 아닌 곳을 만든다.
  assert.match(renderSrc, /pointerEvents: "none"/, "선이 클릭을 가로챈다");
  // 스크린리더에 중복 노출되면 같은 내용을 두 번 읽는다.
  assert.match(renderSrc, /aria-hidden="true"/, "선이 스크린리더에 읽힌다");
});

test("오버레이는 **색칠 여부와 무관하게** 가이드를 계산한다", () => {
  // 미지원 형식(러스트 등)이어도 들여쓰기는 보인다 — 색은 없어도 구조는 읽힌다.
  assert.match(overlaySrc, /indent: indentInfoFor\(line/, "오버레이가 가이드를 계산하지 않는다");
  assert.ok(
    overlaySrc.indexOf("colorable ? tokenizeLine") < overlaySrc.indexOf("indent: indentInfoFor"),
    "가이드 계산이 색칠 분기 안에 있다 — 미지원 형식에서 사라진다",
  );
});
