import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KEYMAP_ACTIONS,
  keysFor,
  findKeymapConflicts,
  findActionByKey,
  checkBrowserConflicts,
  parseKeymapPreset,
} from "./keymap.js";

describe("U-11 keymap", () => {
  it("프리셋 내부 충돌 0 (vscode/intellij)", () => {
    assert.deepEqual(findKeymapConflicts("vscode"), []);
    assert.deepEqual(findKeymapConflicts("intellij"), []);
  });
  it("같은 동작이 두 프리셋에 각각 최소 1개 키", () => {
    for (const a of KEYMAP_ACTIONS) {
      assert.ok(a.vscode.length >= 1, a.id);
      assert.ok(a.intellij.length >= 1, a.id);
    }
  });
  it("단축키로 찾기: 키 → 동작", () => {
    assert.equal(findActionByKey("vscode", "F12"), "goto.definition");
    assert.equal(findActionByKey("intellij", "Ctrl+B"), "goto.definition");
    assert.equal(findActionByKey("vscode", "Alt+Enter"), "intention.action");
    assert.equal(findActionByKey("vscode", "no-such-key"), null);
    assert.equal(findActionByKey("vscode", ""), null);
  });
  it("브라우저 예약키 충돌은 숨기지 않고 목록으로", () => {
    const c = checkBrowserConflicts("vscode");
    assert.ok(c.length >= 1, "예상되는 충돌이 최소 1건은 보여야 한다");
    for (const e of c) assert.ok(e.reason, e.key);
  });
  it("palette.all 은 4종 단축키를 모두 같은 팔레트로 (U-1 검증)", () => {
    const v = keysFor("vscode", "palette.all");
    assert.ok(v.includes("Ctrl+K") && v.includes("Ctrl+Shift+P") && v.includes("Ctrl+P"));
    assert.ok(keysFor("intellij", "palette.all").includes("Shift Shift"));
  });
  it("preset 파싱: 모르면 null (지어내지 않음)", () => {
    assert.equal(parseKeymapPreset("vscode"), "vscode");
    assert.equal(parseKeymapPreset("emacs"), null);
    assert.equal(parseKeymapPreset(null), null);
  });
});
