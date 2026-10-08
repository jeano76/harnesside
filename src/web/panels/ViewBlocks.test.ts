/** 설정만 남긴 뷰 배선 검사 — 측면 아이콘·디렉터리·변경 검토 진입로는 제거됨.
 *
 * 사용자 지정: 설정 기능만 남기고, 여는 곳은 상단 우측 ⚙ 아이콘(과 팔레트)뿐이다.
 * 디렉터리·변경 검토 블록을 여는 경로는 없어야 한다 — 아이콘도, 노드도, 명령도.
 * 저장된 옛 dirs/diff 블록은 ToolBlock이 "제거되었습니다"로 정직하게 말한다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const tool = readFileSync(join(ROOT, "src/web/panels/ToolBlock.tsx"), "utf8");
const main = readFileSync(join(ROOT, "src/web/main.tsx"), "utf8");
const panel = readFileSync(join(ROOT, "src/web/panels/AgentPanel.tsx"), "utf8");

describe("설정만 남긴 뷰 배선", () => {
  it("ToolBlock이 설정·파일 블록을 그린다", () => {
    assert.match(tool, /block\.view\?\.what === "settings"/, "settings 분기가 없다");
    assert.match(tool, /block\.view\?\.what === "file"/, "file 분기가 없다");
    assert.match(tool, /extra\?\.settings/, "settings 노드를 읽지 않는다");
  });
  it("main이 설정 노드만 준다", () => {
    assert.match(main, /settings: settingsNode/, "viewExtra에 settings가 없다");
    assert.doesNotMatch(main, /dirsNode/, "dirs 노드가 남아 있다");
    assert.doesNotMatch(main, /reviewNode/, "review 노드가 남아 있다");
    assert.doesNotMatch(main, /from ".\/panels\/ViewBlocks.js"/, "제거된 ViewBlocks를 아직 가져온다");
  });
  it("디렉터리·변경 검토를 여는 경로가 없다", () => {
    assert.doesNotMatch(panel, /id: "dirs"/, "디렉터리 아이콘이 남아 있다");
    assert.doesNotMatch(panel, /onOpenView\("dirs"\)/, "디렉터리 열기가 남아 있다");
    assert.doesNotMatch(main, /view\.openDiff/, "변경 검토 팔레트 명령이 남아 있다");
    assert.doesNotMatch(main, /what: "diff"/, "diff 블록을 여는 경로가 남아 있다");
  });
  it("상단 우측 ⚙ 아이콘이 설정을 **토글**한다 — 같은 뷰를 누르면 닫힘", () => {
    assert.match(main, /aria-label="설정 열기"/, "헤더에 설정 아이콘이 없다");
    // 헤더·팔레트·블록 안 ▸ 가 **하나의 함수**(`toggleView`)를 탄다. 경로마다 따로
    // 만들면 "아이콘에서는 닫히는데 팔레트에서는 쌓인다" 가 된다.
    const toggles = (main.match(/toggleView\(prev, \{ what: "settings" \}/g) ?? []).length;
    assert.ok(toggles >= 2, `토글 경로가 ${toggles}개뿐이다 — 헤더·팔레트·블록이 같은 규칙을 타야 한다`);
    assert.match(main, /onToggleView=\{onToggleView\}/, "블록에 토글 경로가 전달되지 않는다");
    assert.match(main, /onCloseView=\{onCloseView\}/, "블록에 접기 경로가 전달되지 않는다");
    assert.match(panel, /onToggleView=\{onToggleView\}/, "AgentPanel 이 토글 경로를 블록에 넘기지 않는다");
  });
  it("설정 블록은 **접힌 상태**를 그리고 ✕ 로 접는다 — 삭제가 아니다", () => {
    assert.match(tool, /view\.viewCollapsed === true/, "접힘 표시가 없다");
    assert.match(tool, /aria-expanded=\{!collapsed\}/, "펼침 상태를 보조기술에 말하지 않는다");
    assert.match(tool, /!collapsed &&/, "접힌 상태에서도 설정 내용이 그려진다");
  });
  it("저장된 옛 dirs/diff 블록은 제거됐다고 말한다", () => {
    // 2026-10-08 M9: 문구는 카탈로그(`block.viewRemoved`)로 옮겼다. 렌더 텍스트는
    // 같아야 하므로 키 사용 + 카탈로그 값을 함께 본다 — 한쪽만 보면 빈 카드가 통과한다.
    assert.match(tool, /block\.viewRemoved/, "제거 안내 키를 쓰지 않는다");
    const ko = readFileSync(join(ROOT, "src/web/i18n/ko.ts"), "utf8");
    assert.match(ko, /"block\.viewRemoved": "이 화면은 제거되었습니다\."/, "카탈로그에 제거 안내가 없다 — 옛 블록이 거짓말을 한다");
    assert.doesNotMatch(tool, /extra\.dirs/, "제거된 dirs 노드를 아직 읽는다");
    assert.doesNotMatch(tool, /extra\.review/, "제거된 review 노드를 아직 읽는다");
  });
  it("뒤집으면 실패해야 한다 — 배선을 빼면 검사가 깨진다", () => {
    assert.ok(!tool.includes("NOT_A_REAL_VIEW"), "매처가 살아 있는지 확인");
  });
});
