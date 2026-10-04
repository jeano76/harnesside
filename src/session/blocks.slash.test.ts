import { test } from "node:test";
import assert from "node:assert/strict";
import { addSlash, finishSlash, findSlash, groupTurns, restartSlash, toggleSlashFold } from "./blocks.js";

test("슬래시 명령은 사람이 보낸 말 + 결과 블록으로 한 묶음이 된다", () => {
  const b = finishSlash(addSlash([], "s1", "help", 1), "s1", "내용", true);
  const turns = groupTurns(b);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, "/help");
  assert.equal(b[1].text, "내용");
  assert.equal(b[1].view?.slashState, "ok");
});

test("같은 명령의 최근 블록을 찾아 접고 펼친다(지우지 않는다)", () => {
  let b = finishSlash(addSlash([], "s1", "queue", 1), "s1", "x", true);
  assert.equal(findSlash(b, "queue")?.id, "s1");
  assert.equal(findSlash(b, "keys"), undefined);
  b = toggleSlashFold(b, "s1");
  assert.equal(findSlash(b, "queue")?.view?.viewCollapsed, true);
  assert.equal(b.length, 2);
  b = restartSlash(b, "s1");
  const v = findSlash(b, "queue")!.view!;
  assert.equal(v.viewCollapsed, false);
  assert.equal(v.slashState, "running");
});
