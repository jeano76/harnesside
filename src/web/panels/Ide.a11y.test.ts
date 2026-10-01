/**
 * IDE 프레임 — **이름이 보인다** / **지금 어디에 있는지 말한다** (2026-10-01).
 *
 * 이 파일은 `AgentPanel.a11y.test.ts` 를 **대체한다**. 그 테스트는 대화 패널 **머리**의
 * 아이콘을 검사했다. 그 아이콘은 이제 **없다** — VS Community 의 **액티비티바**가 같은
 * 일을 하므로 같은 일을 두 곳에 두게 되고, 어느 쪽이 진짜인지 알 수 없게 된다.
 *
 * 그래서 **검사도 옮겨간다.** 규칙은 그대로다:
 *   1. **보이는 이름**이 있다 — `title` 은 마우스를 올려야 보이고, 키보드 사용자는
 *      아예 못 본다.
 *   2. **`aria-hidden` 안쪽에** 이름이 있지 않다 — 도형과 이름을 구분한다.
 *   3. **열린 뷰가 밝아진다** — 사용자는 지금 어디에 있는지 모르면 같은 것을 또 누른다.
 *
 * **옮길 때 지켜야 할 것**: 같은 이름이 **한 곳에만** 있어야 한다. 두 곳을 검사하면
 * 하나가 어긋났을 때 놓친다 — 그래서 액티비티바와 `AgentPanel` 의 전달을 **같이** 본다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const ide = read("src/web/panels/Ide.tsx");
const panel = read("src/web/panels/AgentPanel.tsx");

// ── 1. 보이는 이름 ──────────────────────────────────────────────────────────

test("액티비티바 항목에 **보이는 이름**이 있다 — `title` 은 마우스를 올려야 보인다", () => {
  assert.match(ide, /aria-label=\{it\.label\}/, "aria-label 이 없다");
  assert.match(ide, /title=\{it\.label\}/, "title 이 없다");
  // **선택된 항목은 글자로도 보여준다** — 그것이 "보인다" 의 뜻이다.
  assert.match(
    ide,
    /\{on && \(\s*<span[^>]*>\{it\.label\}<\/span>/,
    "선택된 항목의 이름이 글자로 보이지 않는다 — 아이콘에만 남는다",
  );
});

test("**이름이 `aria-hidden` 안쪽에** 있지 않다 — 화면 판독기에만 보이면 안 된다", () => {
  // 아이콘(도형)만 숨긴다. 이름은 **읽혀야** 하고 — 눈에도.
  assert.match(ide, /<span aria-hidden="true">\{it\.glyph\}<\/span>/, "도형을 숨기지 않았다");
  // 이름이 숨긴 span **안**에 있는 형태는 없어야 한다.
  assert.doesNotMatch(
    ide,
    /aria-hidden="true"[^<]{0,40}\{it\.label\}/,
    "이름이 aria-hidden 안에 있다 — 화면에도 판독기에도 없다",
  );
});

test("액티비티바가 **tablist/tab** 역할을 말한다 — 방향키로 옮겨갈 수 있어야 한다", () => {
  assert.match(ide, /role="tablist"/, "tablist 가 없다");
  assert.match(ide, /role="tab"/, "tab 이 없다");
  assert.match(ide, /aria-selected=\{on\}/, "선택 상태가 보조기술에 전달되지 않는다");
});

// ── 2. 지금 어디에 있는지 ───────────────────────────────────────────────────

test("**열린 뷰**가 밝아진다 — 사용자는 지금 어디에 있는지 모른다", () => {
  // `AgentPanel` 이 `active` 를 **정본 블록**에서 읽어 액티비티바에 준다.
  assert.match(panel, /active: openWhat === "settings"/, "설정이 열림을 말하지 않는다");
  assert.match(panel, /active: openWhat === "diff"/, "변경 검토가 열림을 말하지 않는다");
  assert.match(panel, /active: openWhat === "dirs"/, "디렉터리가 열림을 말하지 않는다");
  // **밝힘은 색만이 아니다** — 색을 못 보는 사람이 있다.
  assert.match(ide, /borderLeft: on \? `2px solid \$\{ACTIVE_BLUE\}`/, "왼쪽 강조선이 없다");
  assert.match(ide, /background: on \? SURFACE_2 : "transparent"/, "배경도 달라야 한다");
});

test("**열린 뷰는 블록에서** 읽는다 — 화면이 따로 들면 어긋난다", () => {
  assert.match(panel, /const openWhat = useMemo/, "열린 뷰를 계산하지 않는다");
  // `openView` 가 마지막 블록에 `view` 를 남기는 것이 진본 — 거기서 읽어야 한다.
  assert.match(panel, /for \(let i = blocks\.length - 1/, "뒤에서부터 찾지 않는다 — 닫힌 뷰를 열린 것으로 읽는다");
});

test("**탭 스트립**에도 열린 뷰가 보인다 — 두 곳이 같은 것을 말한다", () => {
  // 액티비티바와 탭 스트립은 **같은 `openWhat`** 를 본다. 서로 다른 값을 쓰면 어긋난다.
  assert.match(panel, /tabs=\{/, "탭 스트립에 열린 뷰가 없다");
  assert.match(panel, /openWhat === "settings" \? "설정"/, "탭 라벨이 뷰를 식별하지 못한다");
});

// ── 3. 죽은 코드를 남기지 않는다 ───────────────────────────────────────────

test("**조작 버튼이 하나뿐**이다 — 같은 일을 두 곳에 두면 하나가 어긋난다", () => {
  // 대화 머리의 아이콘은 **옮겨졌다**. 남으면 "어느 쪽이 진짜인가" 를 알 수 없다.
  const defs = (panel.match(/function IconButton/g) ?? []).length;
  assert.equal(defs, 0, "AgentPanel 에 조작 버튼이 남아 있다 — 액티비티바와 같은 일을 두 곳에 둔다");
  assert.match(panel, /죽은 코드/, "제거 이유가 기록되어 있지 않다 — 다음 사람이 되돌린다");
});

test("**빈 상태**는 여전히 눌 수 있다 — IDE 로 바꿨다고 시작이 사라지지 않는다", () => {
  assert.match(panel, /function FirstRun/, "빈 상태 컴포넌트가 없다");
  assert.match(panel, /onClick=\{\(\) => onPick\(e\)\}/, "예시가 눌러지지 않는다");
});

// ── 4. 이 검사가 **자기 자신을 속이지 않는지** ────────────────────────────────

test("[살아있는지] 이름이 **실제로 렌더**된다 — 규칙만 있고 그리지 않으면 통과한다", () => {
  // 도형만 렌더하고 이름을 빼먹어도 `aria-label` 이 있으면 앞의 검사는 통과한다.
  // 그래서 **글자로 그리는 JSX** 가 있는지 본다.
  assert.match(
    ide,
    /\{on && \(\s*<span style=\{\{ fontSize: 8, color: DIM, letterSpacing: 0\.2 \}\}>\{it\.label\}<\/span>\s*\)\}/,
    "이름을 그리는 JSX 가 없다 — 도형만 그리고 aria-label 로만 통과한다",
  );
});

test("**요구 원문**이 코드에 남아 있다 — 무엇을 구현한 것인지 알 수 있어야 한다", () => {
  // 원문이 사라지면 다음 사람이 "왜 액티비티바가 있나" 를 되묻고 지운다.
  assert.match(panel, /요청\(원문|요구\(원문/, "요구 원문이 없다");
  assert.match(ide, /솔루션 탐색기를 되살리지 않았다/, "되살리지 않은 것과 그 이유가 없다");
});
