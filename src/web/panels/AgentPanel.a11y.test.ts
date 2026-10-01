/**
 * 머리 조작의 **이름이 보인다** — 화면에서 확인하는 것 (2026-10-01).
 *
 * 왜 화면을 봐야 하나: 이 패널의 UX 개선은 **모두 시각적**이다. 아이콘 옆에 라벨이
 * 붙었는지는 유닛 테스트로는 알 수 없다 — `aria-label` 이 있으면 DOM 에는 있어도
 * **눈에는 안 보인다.** 그래서 `verify-window` 가 CDP로 읽는 실제 텍스트를 본다.
 *
 * 이 파일은 **규칙**을 정한다. 지금 붙잡고 있는 것은 `verify-window.mjs` 다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const panel = read("src/web/panels/AgentPanel.tsx");

test("머리 아이콘에 **보이는 이름**이 붙는다 — `title` 은 마우스를 올려야 보인다", () => {
  // 예전엔 아이콘만 있었다. `title`/`aria-label` 은 **안 보인다.**
  assert.match(
    panel,
    /label="설정"\s+glyph="⚙"/,
    "설정 아이콘에 라벨이 없다 — 키보드 사용자는 이름을 알 수 없다",
  );
  assert.match(panel, /label="변경 검토"/, "변경 검토에 라벨이 없다");
  assert.match(panel, /label="디렉터리"/, "디렉터리에 라벨이 없다");
});

test("이름이 **`aria-hidden` 안쪽에** 있지 않다 — 화면 판독기에만 보이게 두면 안 된다", () => {
  // 라벨은 `aria-hidden` 이 아닌 자리에 있어야 **눈에도** 보인다.
  // `label="…"` 뒤에 `glyph` 이 오지만, 그 사이에 `active={…}` 가 들어갈 수 있다.
  // 순서를 고정하지 않고 **두 prop 이 같은 버튼에 있는지** 만 본다.
  const m = /<IconButton[\s\S]{0,220}?label="[^"]+"[\s\S]{0,120}?glyph="[^"]+"/.exec(panel);
  assert.ok(m, "아이콘 뒤에 `{label}` 이 렌더되지 않는다 — 라벨이 도형이나 툴팁으로만 남는다");
  // 아이콘 **도형**만 숨긴다. 라벨 텍스트는 읽혀야 하고.
  // JSX 는 여러 줄에 걸치므로 `[\s\S]` 로 잇는다 — 한 줄 정규식은 조용히 실패한다.
  // 그리고 `{label}` 앞에는 `>` 가 **없다** — JSX 에서 텍스트는 그대로 온다.
  // **`aria-hidden` 의 `>` 까지 중간의 속성을 통과시키고**, 그 다음에 `{glyph}` 가 오는
  // 형태를 본다. `[\s\S]{0,120}?>` 는 그 사이의 `>` 를 먼저 삼켜버려 뒤를 못 맞춘다.
  assert.match(
    panel,
    /aria-hidden="true"[\s\S]{0,60}?>[\s\S]{0,20}\{glyph\}[\s\S]{0,20}?<\/span>[\s\S]{0,10}\{label\}/,
    "도형을 숨기고 라벨을 보이는 자리에 두지 않았다",
  );
  // 라벨이 **도형 안에** 들어가 있으면 눈에도 안 보인다 — 그게 이 검사의 존재 이유다.
  // 정규식 하나로 재귀적으로 판별하려 하면 창이 새도 모르게 뒤쪽의 `{label}` 을 붙잡는다.
  // 그래서 **위치**로 본다: `aria-hidden` span 이 **닫힌 뒤**에 라벨이 있어야 한다.
  const hiddenAt = panel.indexOf('aria-hidden="true"');
  assert.ok(hiddenAt >= 0, "숨긴 도형이 없다 — 검사가 볼 것이 없다");
  const spanEnd = panel.indexOf("</span>", hiddenAt);
  const labelAt = panel.indexOf("{label}", hiddenAt);
  assert.ok(labelAt >= 0, "{label} 이 렌더되지 않는다");
  assert.ok(
    labelAt > spanEnd,
    "라벨이 `aria-hidden` 안쪽에 있다 — 화면에도 판독기에도 이름이 없다",
  );
});

test("**열린 뷰**가 밝아진다 — 사용자는 지금 어디에 있는지 모른다", () => {
  assert.match(panel, /active=\{openWhat === "settings"\}/, "설정이 열림을 말하지 않는다");
  assert.match(panel, /active=\{openWhat === "diff"\}/, "변경 검토가 열림을 말하지 않는다");
  assert.match(panel, /active=\{openWhat === "dirs"\}/, "디렉터리가 열림을 말하지 않는다");
  // 밝힘은 **색만이 아니다.** 색을 못 보는 사람도 있다.
  assert.match(panel, /aria-pressed=\{active\}/, "열림 상태가 보조기술에 전달되지 않는다");
});

test("**열린 뷰는 블록에서** 읽는다 — 화면이 따로 들면 어긋난다", () => {
  assert.match(panel, /const openWhat = useMemo/, "열린 뷰를 계산하지 않는다");
  // `openView` 가 마지막 블록에 `view` 를 남기는 것이 진본 — 거기서 읽어야 한다.
  assert.match(panel, /for \(let i = blocks\.length - 1/, "뒤에서부터 찾지 않는다 — 닫힌 뷰를 열린 것으로 읽는다");
});

test("**`openView` 는 하나만 남긴다** — 밝힘이 이 전제 위에 선다", () => {
  const blocks = read("src/session/blocks.ts");
  assert.match(
    blocks,
    /last\.kind === "view"[\s\S]{0,200}return blocks;/,
    "같은 뷰를 두 번 열면 하나가 남지 않는다 — 화면이 쌓인다",
  );
});

test("빈 상태는 **누를 수 있는 예시**가 있다 — 글자로만 적으면 시작을 한 번의 클릭으로 못 줄인다", () => {
  assert.match(panel, /function FirstRun/, "빈 상태 컴포넌트가 없다");
  assert.match(panel, /onClick=\{\(\) => onPick\(e\)\}/, "예시가 눌러지지 않는다 — 읽고 직접 타이핑해야 한다");
  assert.match(panel, /const EXAMPLES = \[/, "예시가 없다");
});

test("예시는 **보낸다**가 아니라 **채운다** — 고칠 기회를 빼앗기지 않는다", () => {
  const main = read("src/web/main.tsx");
  const m = /onExample=\{\(text\) => \{[\s\S]{0,400}?\}\}/.exec(main);
  assert.ok(m, "onExample 이 없다");
  assert.match(m[0], /setDraft\(text\)/, "입력창에 **채우지** 않는다");
  assert.doesNotMatch(m[0], /sendMessage|submit|enter\(/, "누르는 즉시 보낸다 — 되돌리기 어렵다");
});

test("이 검사가 **자기 자신을 속이지 않는지** — `verify-window` 가 빈 상태 문구를 본다", () => {
  const vw = read("scripts/verify-window.mjs");
  assert.match(vw, /빈 상태가 채워짐/, "빈 상태 검사가 사라졌다");
  // **가짜 통과** 금지: 예시가 **클릭 가능한지**까지 봐야 한다.
  assert.match(vw, /예시|EXAMPLES|onPick|button/, "빈 상태가 '글자 하나' 만 있어도 통과한다 — 그게 결함이었다");
});
