/**
 * U-6/U-7 AgentService 레시피 배선 — 판단은 recipes 모듈에 있고,
 * 여기서 확인하는 것은 **부름과 말함**이다 (파일 없음 → found:false,
 * 모르는 이름 → 404, 저장 검증, lint 진단 수집).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService, type AgentEvent } from "./agentService.js";

function service(dir: string, events: AgentEvent[] = []) {
  return new AgentService({
    baseDir: () => dir,
    baseUrl: () => "http://127.0.0.1:1",
    model: "fake",
    systemPrompt: "test",
    thresholds: { autoTriggerRatio: 1, contextWindowTokens: 100_000 },
    emit: (e) => events.push(e),
  });
}

test("레시피 파일 없음 → found:false (오류 아님)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-recipes-"));
  try {
    const svc = service(dir);
    const r = await svc.listRecipes();
    assert.equal(r.found, false);
    assert.deepEqual(r.recipes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("모르는 레시피 실행 → 404 (지어내지 않음)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-recipes-"));
  try {
    const svc = service(dir);
    await assert.rejects(() => svc.runRecipe("nope"), /레시피 파일이 없습니다/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("저장 검증 실패는 쓰지 않음 · 정상은 쓰고 읽힘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-recipes-"));
  try {
    const svc = service(dir);
    const bad = await svc.saveRecipes("recipes:\n  - name: x\n");
    assert.ok(bad.errors.length > 0);
    assert.equal((await svc.listRecipes()).found, false);
    const good = await svc.saveRecipes("recipes:\n  - name: hi\n    cmd: echo hi\n    kind: run\n    parse: plain\n");
    assert.deepEqual(good.errors, []);
    const listed = await svc.listRecipes();
    assert.equal(listed.found, true);
    assert.equal(listed.recipes[0].name, "hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("실행 결과 기록 · 감지 제안", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-recipes-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo t" } }), "utf8");
    const svc = service(dir);
    const d = await svc.detectRecipeProposal();
    assert.ok(d.proposal.some((p) => p.name === "test"), JSON.stringify(d.proposal));
    assert.match(d.yaml, /test/);
    await svc.saveRecipes("recipes:\n  - name: hi\n    cmd: echo hi\n    kind: run\n    parse: plain\n");
    const r = await svc.runRecipe("hi");
    assert.equal(r.ok, true);
    assert.match(r.raw, /hi/);
    const listed = await svc.listRecipes();
    assert.ok(listed.runs.hi && listed.runs.hi.ok === true);
    await assert.rejects(() => svc.runRecipe("nope"), /없는 레시피/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
