/** symbolsTs 검사 — 뒤집으면 실패해야 한다. 임시 워크스페이스 fixture. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDefinition,
  getReferences,
  lineColToOffset,
  offsetToLineCol,
  isSupportedSymbolFile,
} from "./symbolsTs.js";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "symts-"));
  await writeFile(join(root, "a.ts"), "export function foo(): number {\n  return 1;\n}\n");
  await writeFile(join(root, "b.ts"), 'import { foo } from "./a";\nconst v = foo();\n');
  await writeFile(join(root, "note.md"), "# t\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("symbolsTs offsets", () => {
  it("줄·열↔오프셋이 왕복한다", () => {
    const src = "ab\ncde\n";
    assert.equal(lineColToOffset(src, 2, 2), 4);
    assert.deepEqual(offsetToLineCol(src, 4), { line: 2, col: 2 });
  });
  it("범위 밖은 null이다 (0으로 꺾지 않는다)", () => {
    assert.equal(lineColToOffset("a\n", 5, 1), null);
    assert.equal(lineColToOffset("a\n", 1, 99), null);
    assert.equal(lineColToOffset("a\n", 0, 1), null);
  });
  it("지원 형식을 구분한다", () => {
    assert.ok(isSupportedSymbolFile("x.ts"));
    assert.ok(isSupportedSymbolFile("x.mjs"));
    assert.ok(!isSupportedSymbolFile("x.md"));
  });
});

describe("symbolsTs definition", () => {
  it("임포트 사용처에서 정의 파일로 간다 (b.ts → a.ts:1)", async () => {
    // b.ts 2줄: `const v = foo();` — foo 시작 열을 계산한다.
    const r = await getDefinition(root, "b.ts", 2, 11);
    assert.equal(r.available, true);
    if (!r.available) return;
    assert.ok(r.locations.length >= 1, "정의가 없다 — 컴파일러가 못 찾았다");
    const first = r.locations[0]!;
    assert.equal(first.path, "a.ts");
    assert.equal(first.line, 1);
  });
  it("모르는 기호는 빈 목록이다 (지어내지 않는다)", async () => {
    const r = await getDefinition(root, "b.ts", 2, 1);
    assert.equal(r.available, true);
    if (!r.available) return;
    // `const` 키워드 자리 — 정의가 없어야 한다.
    assert.deepEqual(r.locations, []);
  });
  it("미지원 형식은 available:false + 사유", async () => {
    const r = await getDefinition(root, "note.md", 1, 1);
    assert.equal(r.available, false);
  });
  it("줄 범위 밖은 400으로 던진다", async () => {
    await assert.rejects(() => getDefinition(root, "b.ts", 99, 1), (e: unknown) => {
      const s = (e as { status?: number }).status;
      assert.equal(s, 400);
      return true;
    });
  });
  it("루트 밖은 403으로 던진다", async () => {
    await assert.rejects(() => getDefinition(root, "../outside.ts", 1, 1), (e: unknown) => {
      const s = (e as { status?: number }).status;
      assert.equal(s, 403);
      return true;
    });
  });
});

describe("symbolsTs references", () => {
  it("정의에서 참조를 찾는다 (a.ts foo → b.ts 사용처 포함)", async () => {
    const r = await getReferences(root, "a.ts", 1, 17);
    assert.equal(r.available, true);
    if (!r.available) return;
    const paths = r.locations.map((l) => `${l.path}:${l.line}`);
    assert.ok(paths.some((p) => p.startsWith("b.ts:")), `b.ts 참조가 없다: ${paths.join(",")}`);
  });
});
