import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runRecipeDef,
  readProjectRecipes,
  createLastRunStore,
  writeProjectRecipes,
} from "./recipes.js";
import type { RecipeDef } from "../recipes/recipes.js";

const DEF: RecipeDef = { name: "typecheck", cmd: "npm run typecheck", kind: "lint", parse: "tsc" };

describe("U-6 runRecipeDef", () => {
  it("통과: 원문 + 파싱 구조 함께 반환", async () => {
    const r = await runRecipeDef(DEF, "/proj", (async () => ({
      code: 0,
      timedOut: false,
      stdout: "done",
      stderr: "",
    })) as never);
    assert.equal(r.ok, true);
    assert.equal(r.raw, "done");
    assert.equal(r.parsed.failed, 0);
  });
  it("시간 초과 → 통과 아님 (exit 0이어도)", async () => {
    const r = await runRecipeDef(DEF, "/proj", (async () => ({
      code: 0,
      timedOut: true,
      stdout: "partial",
      stderr: "",
    })) as never);
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
  });
  it("실패 출력은 파싱된 실패 위치 포함", async () => {
    const r = await runRecipeDef(DEF, "/proj", (async () => ({
      code: 2,
      timedOut: false,
      stdout: "src/a.ts(1,1): error TS1005: ';' expected.",
      stderr: "",
    })) as never);
    assert.equal(r.ok, false);
    assert.equal(r.parsed.failures.length, 1);
    assert.equal(r.parsed.failures[0].file, "src/a.ts");
  });
  it("cwd 탈출 거부", async () => {
    const evil: RecipeDef = { ...DEF, cwd: "../../etc" };
    await assert.rejects(() => runRecipeDef(evil, "/proj", (async () => ({})) as never), /프로젝트 밖/);
  });
});

describe("U-6 project file", () => {
  it("파일 없음 → found:false (오류 아님)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recipes-"));
    assert.deepEqual(await readProjectRecipes(dir), { found: false, recipes: [], errors: [] });
  });
  it("검증 실패 내용은 쓰지 않음", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recipes-"));
    mkdirSync(join(dir, ".harnesside"), { recursive: true });
    const { errors } = await writeProjectRecipes(dir, "recipes:\n  - name: x\n");
    assert.ok(errors.length > 0);
    const back = await readProjectRecipes(dir);
    assert.equal(back.found, false);
  });
  it("정상 내용은 쓰고 읽힘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recipes-"));
    const text = "recipes:\n  - name: t\n    cmd: npm test\n    kind: test\n    parse: plain\n";
    assert.deepEqual((await writeProjectRecipes(dir, text)).errors, []);
    const back = await readProjectRecipes(dir);
    assert.equal(back.found, true);
    assert.equal(back.recipes[0].name, "t");
    writeFileSync(join(dir, ".harnesside", "recipes.yaml"), "marker");
  });
});

describe("U-6 last runs", () => {
  it("기록 없음 → null (미실행)", () => {
    const s = createLastRunStore();
    assert.equal(s.get("nope"), null);
    s.record("t", { ok: true, timedOut: false }, 123);
    assert.deepEqual(s.get("t"), { at: 123, ok: true, timedOut: false });
  });
});
