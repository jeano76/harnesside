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

test("**열 곳이 하나뿐**이다 — 설정은 상단 우측 ⚙ 아이콘으로 연다", () => {
  // 사용자 지정: 설정만 남기고 측면 아이콘은 두지 않는다. 열 곳이 둘이면
  // "어느 쪽이 진짜인가" 를 알 수 없고 하나가 어긋난다(옛 `openWhat`이 그랬다).
  // 그래서 `AgentPanel` 은 빈 activity 를 넘기고, `Ide` 는 빈 띠를 그리지 않는다.
  assert.match(panel, /activity=\{\[\]\}/, "측면 아이콘이 남아 있다");
  assert.doesNotMatch(panel, /const openWhat = useMemo/, "별도 선택 상태가 남아 있다 — 열 곳이 하나뿐이면 필요 없다");
  assert.doesNotMatch(panel, /active: openWhat/, "열림 밝히기가 남아 있다");
  assert.match(ide, /activity\.length > 0/, "빈 띠를 그린다 — 48px 자리만 차지한다");
});

test("**별도 선택 상태를 들지 않는다** — 열 곳이 하나뿐이면 어긋날 곳이 없다", () => {
  // 옛 설계는 `openWhat` 으로 "지금 어디에 있나" 를 따로 계산했다. 진입로가
  // 상단 ⚙ 하나뿐이므로 그 상태는 죽은 코드다 — 남기면 "어느 쪽이 진짜인가" 가 된다.
  assert.doesNotMatch(panel, /const openWhat = useMemo/, "열린 뷰 계산이 남아 있다");
  // 설정 블록 자체는 대화 안에 열린다 — 여는 동작이 `openView settings` 인지 본다.
  assert.match(panel, /viewExtra=\{viewExtra\}/, "설정 블록 주입이 없다");
});

test("**탭 스트립이 없다** — 2026-10-04 에 삭제됨. 되살리면 이 검사가 깨진다", () => {
  // 탭 스트립은 "열려 있는 것" 을 보여주는 띠였는데, 열 곳이 설정 하나뿐인
  // 지금은 항상 비거나 항상 '대화' 하나라 띠의 의미를 없앤다. 되살리지 않는다.
  assert.doesNotMatch(ide, /TabStrip/, "탭 스트립이 되살아났다");
  assert.doesNotMatch(panel, /tabs=\{/, "탭 스트립에 여는 경로가 되살아났다");
  assert.doesNotMatch(panel, /VIEW_LABEL/, "탭 라벨 맵이 되살아났다");
});

test("**라벨 맵이 필요 없다** — 탭 스트립이 없으므로 내부 이름이 화면에 날 곳이 없다", () => {
  // `AgentBlock["view"]["what"]` 종류(settings/file/dirs/diff)는 저장된 옛 대화와의
  // 호환용으로 `blocks.ts` 에 남는다. 화면에 라벨로 보일 곳이 없으므로 맵은 두지 않는다.
  assert.doesNotMatch(panel, /const VIEW_LABEL: Record</, "라벨 맵이 되살아났다");
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
  // 2026-10-08 M9: 예시 문구는 카탈로그(empty.agent.example1~3)로 옮겼다.
  // 클릭이 카탈로그 값을 입력창에 채우는지 본다 — 리터럴 매칭이 아니다.
  assert.match(panel, /onClick=\{\(\) => onPick\(t\(k\)\)\}/, "예시가 눌러지지 않는다");
  assert.match(panel, /EXAMPLE_KEYS/, "예시 키 목록이 없다");
});

// ── 4. S-2 · S-5 · S-12 — 방향키 · 찾기 · 잘림 ───────────────────────────────

test("**액티비티바가 방향키로 이동한다** — `role` 만 있고 키가 없으면 장식이다", () => {
  // S-2: "액티비티바는 `role="tablist"` / `role="tab"` 를 선언해 **방향키로 이동**할
  // 있어야 한다." 요구는 둘 다를 함께 요구한다. 예전에는 `role` 만 있었다 — 스크린
  // 판독기는 "탭 5개" 라고 읽는데 **키보드는 어디로도 못 갔다**.
  assert.match(ide, /nextActivityIndex/, "방향키 이동 판정이 없다");
  assert.match(ide, /onKeyDown=\{\(e\) =>/, "액티비티바에 키 처리가 없다");
  // **세로 띠이므로** 세로 방향이 먼저다. `aria-orientation` 이 없으면 판독기가
  // 좌우로 안내한다(세로 띠에서 틀린 안내).
  assert.match(ide, /aria-orientation="vertical"/, "세로 띠인데 방향을 말하지 않는다");
  // **포커스만 옮기면 열지 않는다** — 이 항목은 "무엇을 열 것인가" 를 고르는 명령이라
  // 열어야 한다. 그러지 않으면 "옮겼는데 아무 일도 없다" 는 한 번의 탭이 생긴다.
  assert.match(ide, /items\[to\]\?\.onClick\(\)/, "옮기기만 하고 열지 않는다");
});

test("**경계에서 멈춘다** — 넘으면 몇 개나 있는지 모르게 된다", () => {
  assert.match(ide, /Math\.min\(count - 1, at \+ 1\)/, "아래에서 넘지 않는다");
  assert.match(ide, /Math\.max\(0, at - 1\)/, "위에서 넘지 않는다");
});

test("**rove tabindex** — Tab 은 선택된 한 곳으로만 들어간다", () => {
  // 전부 `0` 이면 사용자는 세 아이콘을 하나씩 Tab 으로 방문해야 하고, 지금 어디가
  // 선택됐는지 모른 채 세 번을 누른다(WAI-ARIA 탭 패턴).
  assert.match(ide, /tabIndex=\{i === focus \? 0 : -1\}/, "rove tabindex 가 없다");
  assert.match(ide, /refs\.current\[to\]\?\.focus\(\)/, "DOM 포커스를 옮기지 않는다 — tabIndex 만 바꾸면 안 된다");
});

test("**긴 글자를 말줄임하고 원문을 남긴다** — 잘린 걸 숨기지 않는다 (S-12)", () => {
  // 예전 상태바는 `flexShrink: 0` + `overflow: hidden` 이라 **오른쪽에서 잘리고
  // 말줄임표도 없었다.** 사용자는 "화면이 깨졌다" 고 읽는다.
  assert.match(ide, /textOverflow: "ellipsis"/, "말줄임표가 없다");
  assert.match(ide, /minWidth: 0/, "줄어들 항목에 minWidth 가 없다 — ellipsis 가 동작 안 한다");
  // **원문이 있어야 한다** — 말줄임만 있고 `title` 이 없으면 무엇이 잘렸는지 모른다.
  assert.match(ide, /title=\{s\.title \?\? \(s\.ellipsis \? s\.text : undefined\)\}/, "말줄임된 항목의 원문을 남기지 않는다");
  // **항상 붙잡을 수 없는 항목은 줄이지 않는다** — "연결" 이 "연" 으로 줄어드는 것은
  // 말줄임이 아니라 손실이다.
  assert.match(ide, /flexShrink: 0/, "짧은 값까지 같이 줄어든다");
});

test("**탭 스트립이 없으므로 잘릴 탭도 없다** (S-12)", () => {
  // 탭 스트립(`overflowX: "auto"` 로 가로 스크롤하던 띠)은 2026-10-04 에 삭제됐다.
  // 잘림 검사는 상태바 말줄임 쪽에 남아 있다(위 "긴 글자를 말줄임하고" 검사).
  assert.doesNotMatch(ide, /overflowX: "auto"/, "탭 스트립이 되살아났다");
});

test("빠른 이동·검색이 없다 — 사용자 명시 제거 (2026-10-04)", () => {
  // 되살리면 이 검사가 깨진다. 탐색은 셸+디렉터리 블록이 맡는다.
  assert.doesNotMatch(panel, /onOpenView\("search"\)/, "검색 열기가 남아 있다");
  assert.doesNotMatch(panel, /onOpenView\("files"\)/, "빠른 이동 열기가 남아 있다");
  assert.doesNotMatch(panel, /id: "search"/, "검색 아이콘이 남아 있다");
  assert.doesNotMatch(panel, /id: "files"/, "빠른 이동 아이콘이 남아 있다");
});

// ── 5. 이 검사가 **자기 자신을 속이지 않는지** ────────────────────────────────

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

test("알림 센터가 대화창에 있다 — 우하단 토스트의 미러 (별도 UI 요소)", () => {
  assert.match(panel, /function NoticeBell/, "NoticeBell 컴포넌트가 없다");
  assert.match(panel, /notices=\{notices\}/, "호출부에 notices 전달이 없다");
  assert.match(panel, /onDismissNotice/, "닫기 경로가 없다 — 본 것만 사라져야 한다");
});

test("빈 띠를 그리지 않는다 — 항목 없는 액티비티바는 자리만 차지한다", () => {
  // 2026-10-04 사용자 지적: 대화 탭명은 불필요하다. 같은 이유로 항목 없는
  // 액티비티바도 그리지 않는다 — 빈 48px 띠는 "무엇이 있다" 는 거짓말이다.
  assert.match(ide, /if \(activity\.length > 0|activity\.length > 0 &&/, "빈 띠를 그린다");
});
