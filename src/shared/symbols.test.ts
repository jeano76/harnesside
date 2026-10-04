/** symbols 추출 검사 — 뒤집으면 실패해야 한다. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols } from "./symbols.js";

describe("extractSymbols", () => {
  it("TS 함수·클래스·인터페이스를 줄 번호와 함께 찾는다", () => {
    const src = ["export async function foo() {", "}", "export class Bar {", "}", "export interface Baz {", "}"].join("\n");
    const r = extractSymbols("a.ts", src);
    assert.equal(r.truncated, false);
    assert.deepEqual(
      r.symbols.map((s) => `${s.kind}:${s.name}:${s.line}`),
      ["function:foo:1", "class:Bar:3", "interface:Baz:5"]
    );
  });
  it("일반 const 는 export 된 것만, 지역 변수는 잡지 않는다", () => {
    const src = ["export const K = 1;", "function f() {", "  const local = 2;", "}"].join("\n");
    const r = extractSymbols("a.ts", src);
    assert.ok(r.symbols.some((s) => s.name === "K"), "export const 를 못 찾았다");
    assert.ok(!r.symbols.some((s) => s.name === "local"), "지역 변수를 기호로 잡았다 — 노이즈다");
    assert.ok(r.symbols.some((s) => s.name === "f"), "모듈 함수는 잡아야 한다(텍스트 기준 아웃라인)");
  });
  it("python def/class, 쉘 함수, md 제목을 찾는다", () => {
    const py = extractSymbols("a.py", "def foo():\n  pass\nclass Bar:\n  pass\n");
    assert.deepEqual(
      py.symbols.map((s) => `${s.kind}:${s.name}:${s.line}`),
      ["def:foo:1", "class:Bar:3"]
    );
    const sh = extractSymbols("a.sh", "build() {\n  echo\n}\n");
    assert.deepEqual(
      sh.symbols.map((s) => `${s.kind}:${s.name}:${s.line}`),
      ["def:build:1"]
    );
    const md = extractSymbols("a.md", "# T\n\n## S\n");
    assert.deepEqual(
      md.symbols.map((s) => `${s.kind}:${s.name}:${s.line}`),
      ["heading:T:1", "heading:S:3"]
    );
  });
  it("모르는 확장자는 빈 목록이다 (지어내지 않는다)", () => {
    assert.deepEqual(extractSymbols("a.gguf", "foo bar"), { symbols: [], truncated: false });
  });
  it("넘치면 자르고 표시한다", () => {
    const src = Array.from({ length: 20 }, (_, i) => `export function f${i}() {}`).join("\n");
    const r = extractSymbols("a.ts", src, 5);
    assert.equal(r.symbols.length, 5);
    assert.equal(r.truncated, true);
  });
});
