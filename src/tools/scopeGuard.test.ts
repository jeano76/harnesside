import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeWarnings } from "./scopeGuard.js";

test("새 파일은 경고", () => {
  assert.equal(scopeWarnings({ path: "a.ts", existed: false, before: "", after: "x" }).length, 1);
});
test("공백만 바뀌면 경고", () => {
  const w = scopeWarnings({ path: "a.ts", existed: true, before: "a=1;\nb=2;", after: "a = 1;\n\nb = 2;" });
  assert.match(w[0], /공백/);
});
test("import 재정렬만이면 경고", () => {
  const w = scopeWarnings({ path: "a.ts", existed: true, before: 'import b from "b";\nimport a from "a";\nx()', after: 'import a from "a";\nimport b from "b";\nx()' });
  assert.match(w[0], /import/);
});
test("실제 변경은 경고 없음", () => {
  assert.deepEqual(scopeWarnings({ path: "a.ts", existed: true, before: "a=1", after: "a=2" }), []);
});
