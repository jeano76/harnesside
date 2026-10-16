import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractChecklist, loadSkillChecklist, checklistCachePath, clampTrigger, CHECKLIST_MAX_LINES, INDEX_TRIGGER_MAX_CHARS } from "./checklist.js";
import { configureSkills, executeTool } from "../tools/index.js";
import { injectSkillIndexIntoSystemPrompt } from "./loader.js";

function bigSkill(title: string, n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `- 규칙 ${i + 1}: 이 항목은 꽤 긴 설명을 가진다. 단, 예외 조건이 뒤에 붙는다 ${"x".repeat(200)}`);
  return `---\nname: ${title}\ndescription: ${title} 설명\n---\n\n# ${title}\n\n## 원칙\n${rows.slice(0, n / 2).join("\n")}\n\n## 절차\n${rows.slice(n / 2).join("\n")}\n`;
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-skill-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("긴 스킬은 ≤15줄 체크리스트로 줄고 · 줄당 길이가 제한되며 · 제목이 남는다", () => {
  const r = extractChecklist(bigSkill("테스트", 400));
  assert.equal(r.compressed, true);
  assert.ok(r.text.split("\n").length <= CHECKLIST_MAX_LINES, `줄 수 ${r.text.split("\n").length}`);
  assert.ok(r.text.split("\n").every((l) => l.length <= 170));
  assert.match(r.text, /## 테스트/);
  assert.match(r.text, /### 절차/, "뒤쪽 섹션이 통째로 사라졌다");
});

test("이미 짧은 스킬(≤15줄)은 압축하지 않는다 — 있는 내용을 깎지 않는다", () => {
  const body = "---\ntrigger: t\n---\n# 짧음\n- a\n- b\n";
  const r = extractChecklist(body);
  assert.equal(r.compressed, false);
  assert.equal(r.text, "# 짧음\n- a\n- b");
});

test("코드펜스 안의 '- ' 줄은 항목으로 세지 않는다", () => {
  const body = "# T\n" + "x\n".repeat(20) + "```\n- fake item\n```\n- real item\n";
  assert.ok(!extractChecklist(body).text.includes("fake item"));
  assert.ok(extractChecklist(body).text.includes("real item"));
});

test("캐시: 같은 원본이면 재사용, 원본이 바뀌면(해시 불일치) 다시 만든다", async () =>
  withDir(async (dir) => {
    const a = bigSkill("가", 100);
    const first = await loadSkillChecklist(dir, "가", a);
    const cached = await readFile(checklistCachePath(dir, "가"), "utf8");
    assert.match(cached, /method: extract/);
    // 캐시 파일을 변조하면 해시가 같으므로 그대로 쓴다(재생성하지 않았다는 증거).
    await writeFile(checklistCachePath(dir, "가"), cached.replace("\n", "\nCACHED-MARK\n"), "utf8");
    assert.match(await loadSkillChecklist(dir, "가", a), /CACHED-MARK/);
    const b = bigSkill("가", 120);
    const regenerated = await loadSkillChecklist(dir, "가", b);
    assert.ok(!regenerated.includes("CACHED-MARK"), "원본이 바뀌었는데 옛 캐시를 썼다");
    assert.notEqual(regenerated, first);
  }));

test("clampTrigger: 스킬당 설명 ≤120자, 줄바꿈은 한 줄로", () => {
  assert.equal(clampTrigger("a\n  b"), "a b");
  const c = clampTrigger("z".repeat(500));
  assert.equal(c.length, INDEX_TRIGGER_MAX_CHARS);
  assert.ok(c.endsWith("…"));
});

test("시스템 프롬프트 인덱스에는 설명이 120자로 잘려 들어간다", () => {
  const p = injectSkillIndexIntoSystemPrompt("base", [{ name: "n", trigger: "q".repeat(400), path: "/x" }]);
  assert.ok(!p.includes("q".repeat(121)));
});

test("load_skill: 기본은 체크리스트, mode:full 은 전체, 모르는 mode 는 거부", async () =>
  withDir(async (dir) => {
    const path = join(dir, "s.md");
    const body = bigSkill("스킬", 200);
    await writeFile(path, body, "utf8");
    configureSkills([{ name: "스킬", trigger: "t", path }]);
    const def = (await executeTool("load_skill", JSON.stringify({ name: "스킬" }), dir)).content;
    const full = (await executeTool("load_skill", JSON.stringify({ name: "스킬", mode: "full" }), dir)).content;
    assert.equal(full, body);
    assert.ok(def.length < full.length / 5, `체크리스트 ${def.length} vs 전체 ${full.length}`);
    assert.match(def, /mode:"full"/);
    await assert.rejects(executeTool("load_skill", JSON.stringify({ name: "스킬", mode: "delegate" }), dir), /unknown mode/);
  }));

test("측정: 큰 스킬 3개를 연속 로드해도 컨텍스트 증가분 ≤ 3 × 체크리스트 상한 (전체 로드 대비 절감 수치 출력)", async () =>
  withDir(async (dir) => {
    const names = ["가", "나", "다"];
    const entries = [];
    let fullTotal = 0;
    for (const n of names) {
      const path = join(dir, `${n}.md`);
      const body = bigSkill(n, 400);
      fullTotal += body.length;
      await writeFile(path, body, "utf8");
      entries.push({ name: n, trigger: "t", path });
    }
    configureSkills(entries);
    let total = 0;
    for (const n of names) total += (await executeTool("load_skill", JSON.stringify({ name: n }), dir)).content.length;
    const perChecklistMax = CHECKLIST_MAX_LINES * 175 + 200; // 줄당 ≤170자 + 제목·안내문
    assert.ok(total <= 3 * perChecklistMax, `증가분 ${total}자 > ${3 * perChecklistMax}`);
    console.log(`# 측정: 3개 로드 ${total}자 (전체 로드였다면 ${fullTotal}자, ${(fullTotal / total).toFixed(1)}배 절감) — 합성 스킬 기준, 실제 스킬은 미측정`);
  }));
