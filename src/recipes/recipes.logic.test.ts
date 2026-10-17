import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadRecipesFile,
  serializeRecipes,
  detectRecipes,
  parseOutput,
  recipeStatusText,
} from "./recipes.js";

describe("U-6 recipes file", () => {
  it("정상 파일 로드", () => {
    const { recipes, errors } = loadRecipesFile(`
recipes:
  - name: typecheck
    cmd: npm run typecheck
    kind: lint
    parse: tsc
    timeoutMs: 120000
`);
    assert.deepEqual(errors, []);
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].name, "typecheck");
  });
  it("검증 오류는 목록으로 (조용히 버리지 않음)", () => {
    const { recipes, errors } = loadRecipesFile(`
recipes:
  - name: a
    cmd: ""
    kind: party
    parse: magic
  - name: a
    cmd: echo x
    kind: run
    parse: plain
  - name: slow
    cmd: sleep 1
    kind: run
    parse: plain
    timeoutMs: -5
`);
    assert.equal(recipes.length, 0);
    assert.ok(errors.length >= 3, errors.join(" | "));
  });
  it("YAML 깨짐·recipes 없음도 오류로", () => {
    assert.ok(loadRecipesFile("{bad").errors.length >= 1);
    assert.ok(loadRecipesFile("foo: 1").errors.length >= 1);
  });
  it("직렬화 왕복", () => {
    const defs = [{ name: "t", cmd: "npm test", kind: "test" as const, parse: "jest" as const }];
    const { recipes, errors } = loadRecipesFile(serializeRecipes(defs));
    assert.deepEqual(errors, []);
    assert.deepEqual(recipes, defs);
  });
});

describe("U-6 detect", () => {
  it("package.json 검증 스크립트만 제안 (dev/start 제외)", () => {
    const got = detectRecipes({
      packageJson: JSON.stringify({ scripts: { test: "jest", typecheck: "tsc --noEmit", dev: "vite", start: "node dist/x.js" } }),
    });
    const names = got.map((r) => r.name);
    assert.ok(names.includes("test") && names.includes("typecheck"), names.join(","));
    assert.ok(!names.includes("dev") && !names.includes("start"), names.join(","));
    assert.equal(got.find((r) => r.name === "typecheck")?.parse, "tsc");
  });
  it("깨진 package.json 은 제안 근거가 아님", () => {
    assert.deepEqual(detectRecipes({ packageJson: "{oops" }), []);
  });
  it("pyproject·go.mod·Cargo.toml", () => {
    const got = detectRecipes({ pyproject: "[tool.pytest]", goMod: "module x", cargoToml: "[package]" });
    assert.deepEqual(got.map((r) => r.parse), ["pytest", "go", "cargo"]);
  });
  it("아무 파일도 없으면 빈 제안", () => {
    assert.deepEqual(detectRecipes({}), []);
  });
});

const TSC_FIXTURE = `src/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts:5:1 - error TS1005: ';' expected.
`;
const ESLINT_FIXTURE = `/repo/src/a.ts
  12:3  error  Unexpected any  @typescript-eslint/no-explicit-any
  5:1  warning  Unused var  @typescript-eslint/no-unused-vars
`;
const JEST_FIXTURE = `● Suite › fails hard
    Expected: 1
    Received: 2
      at Object.<anonymous> (src/a.test.ts:12:3)
Tests:       1 failed, 9 passed, 10 total
`;
const PYTEST_FIXTURE = `FAILED tests/test_x.py::Test::test_y - assert 1 == 2
tests/test_x.py:12: in test_y
E   assert 1 == 2
1 failed, 9 passed in 0.5s
`;
const GO_FIXTURE = `--- FAIL: TestParse (0.00s)
    src/x_test.go:12: expected 1, got 2
FAIL
`;
const CARGO_FIXTURE = `failures:
    mycrate::tests::it_works
test result: FAILED. 9 passed; 1 failed; 0 ignored
`;

describe("U-6 parsers", () => {
  it("tsc 구·신형", () => {
    const p = parseOutput("tsc", TSC_FIXTURE, 2);
    assert.equal(p.failed, 2);
    assert.equal(p.failures[0].rule, "TS2322");
    assert.equal(p.failures[0].line, 12);
    assert.equal(p.failures[1].file, "src/b.ts");
  });
  it("eslint", () => {
    const p = parseOutput("eslint", ESLINT_FIXTURE, 1);
    assert.equal(p.failed, 2);
    assert.equal(p.failures[0].severity, "error");
    assert.equal(p.failures[1].severity, "warning");
  });
  it("jest 요약 수 + 위치", () => {
    const p = parseOutput("jest", JEST_FIXTURE, 1);
    assert.equal(p.failed, 1);
    assert.equal(p.passed, 9);
    assert.equal(p.failures[0].file, "src/a.test.ts");
  });
  it("pytest", () => {
    const p = parseOutput("pytest", PYTEST_FIXTURE, 1);
    assert.ok(p.failed >= 1 && p.passed === 9);
  });
  it("go", () => {
    const p = parseOutput("go", GO_FIXTURE, 1);
    assert.ok(p.failed >= 1);
    assert.equal(p.failures[0].file, "src/x_test.go");
  });
  it("cargo", () => {
    const p = parseOutput("cargo", CARGO_FIXTURE, 101);
    assert.equal(p.failed, 1);
    assert.equal(p.passed, 9);
  });
  it("plain: exit 0 → 실패 0, 아니면 실패", () => {
    assert.equal(parseOutput("plain", "whatever", 0).failed, 0);
    const p = parseOutput("plain", "boom\nkaboom", 1);
    assert.equal(p.failed, 1);
    assert.match(p.failures[0].message, /kaboom/);
  });
  it("모르는 형식은 빈 failures (실패로 속이지 않음)", () => {
    const p = parseOutput("tsc", "all good, no errors", 0);
    assert.deepEqual(p.failures, []);
    assert.equal(p.failed, 0);
  });
});

describe("U-6 status", () => {
  it("미실행 ≠ 통과", () => {
    assert.equal(recipeStatusText(null), "미실행");
  });
  it("통과·실패·시간 초과 구분 (시간 초과 ≠ 통과)", () => {
    assert.match(recipeStatusText({ at: 0, ok: true, timedOut: false }), /통과/);
    assert.match(recipeStatusText({ at: 0, ok: false, timedOut: false }), /실패/);
    const t = recipeStatusText({ at: 0, ok: false, timedOut: true });
    assert.match(t, /시간 초과/);
    assert.doesNotMatch(t, /통과/);
  });
});
