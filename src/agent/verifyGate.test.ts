import { test } from "node:test";
import assert from "node:assert/strict";
import { VerifyGate } from "./verifyGate.js";

test("코드 편집 후 검증 없이 끝나면 한 번만 안내", () => {
  const g = new VerifyGate();
  g.noteEdit("src/a.ts");
  assert.match(g.nudge()!, /verify gate/);
  assert.equal(g.nudge(), null);
});
test("검증하면 안내 없음", () => {
  const g = new VerifyGate();
  g.noteEdit("src/a.ts");
  g.noteVerify();
  assert.equal(g.nudge(), null);
});
test("문서·설정 편집은 대상 아님", () => {
  const g = new VerifyGate();
  g.noteEdit("README.md");
  g.noteEdit("a.yaml");
  assert.equal(g.nudge(), null);
});
test("검증 뒤 다시 고치면 다시 미검증", () => {
  const g = new VerifyGate(2);
  g.noteEdit("a.ts");
  g.noteVerify();
  g.noteEdit("b.ts");
  assert.match(g.nudge()!, /b\.ts/);
});

import { looksLikeVerification } from "./verifyGate.js";
test("탐색 명령은 검증이 아니고 테스트·빌드 명령은 검증이다", () => {
  for (const c of ["ls -la", "cat package.json", "grep -r foo .", "git status"]) assert.equal(looksLikeVerification(c), false, c);
  for (const c of ["npm test", "npm run check", "pytest -q", "tsc --noEmit", "node check.js", "cargo test", "node -e \"console.log(1)\""]) assert.equal(looksLikeVerification(c), true, c);
});
