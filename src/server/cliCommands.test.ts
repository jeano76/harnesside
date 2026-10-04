import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PROVIDER_BY_ID } from "../shared/cliProviders.js";
import { frontmatterValue, listCliCommands, tomlDescription, versionMatches } from "./cliCommands.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hs-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "hs-proj-"));
  await mkdir(join(cwd, ".claude/commands/team"), { recursive: true });
  await writeFile(join(cwd, ".claude/commands/deploy.md"), "---\ndescription: 배포하기\n---\n본문");
  await writeFile(join(cwd, ".claude/commands/team/review.md"), "# 제목\n\n리뷰 요청서를 만든다\n");
  await mkdir(join(home, ".claude/skills/my-skill"), { recursive: true });
  await writeFile(join(home, ".claude/skills/my-skill/SKILL.md"), "---\nname: my-skill\ndescription: \"내 스킬\"\n---\n");
  await writeFile(join(home, ".claude/commands-ignored.txt"), "x");
  await mkdir(join(cwd, ".gemini/commands/git"), { recursive: true });
  await writeFile(join(cwd, ".gemini/commands/git/commit.toml"), 'description = "커밋 메시지 만들기"\nprompt = "..."\n');
  return { home, cwd };
}

test("claude: 내장 표 + 프로젝트 명령(하위 폴더는 :) + 사용자 스킬을 합친다", async () => {
  const { home, cwd } = await fixture();
  const r = (await listCliCommands(CLI_PROVIDER_BY_ID.claude, { cwd, home, installedVersion: "2.1.289 (Claude Code)" }))!;
  const by = Object.fromEntries(r.commands.map((c) => [c.name, c]));
  assert.equal(by["help"]!.source, "builtin");
  assert.equal(by["deploy"]!.description, "배포하기");
  assert.equal(by["team:review"]!.description, "리뷰 요청서를 만든다");
  assert.equal(by["my-skill"]!.description, "내 스킬");
  assert.equal(r.stale, false);
});

test("버전이 다르면 stale, 확인 못 한 표(gemini)는 항상 stale + 그 사실을 말한다", async () => {
  const { home, cwd } = await fixture();
  const c = (await listCliCommands(CLI_PROVIDER_BY_ID.claude, { cwd, home, installedVersion: "3.0.0 (Claude Code)" }))!;
  assert.equal(c.stale, true);
  assert.ok(c.notes.some((n) => n.includes("2.1.289")));
  const g = (await listCliCommands(CLI_PROVIDER_BY_ID.gemini, { cwd, home, installedVersion: "0.60.0" }))!;
  assert.equal(g.stale, true);
  assert.ok(g.notes.some((n) => n.includes("확인하지 못했습니다") || n.includes("문서 기준")));
  assert.equal(g.commands.find((x) => x.name === "git:commit")!.description, "커밋 메시지 만들기");
});

test("codex: 아무것도 지어내지 않는다", async () => {
  const { home, cwd } = await fixture();
  const r = (await listCliCommands(CLI_PROVIDER_BY_ID.codex, { cwd, home, installedVersion: null }))!;
  assert.equal(r.commands.length, 0);
  assert.ok(r.notes.some((n) => n.includes("미확인")));
});

test("사용자 정의가 같은 이름의 내장을 가린다", async () => {
  const { home, cwd } = await fixture();
  await writeFile(join(cwd, ".claude/commands/help.md"), "---\ndescription: 우리 도움말\n---\n");
  const r = (await listCliCommands(CLI_PROVIDER_BY_ID.claude, { cwd, home, installedVersion: "2.1.289" }))!;
  const helps = r.commands.filter((c) => c.name === "help");
  assert.equal(helps.length, 1);
  assert.equal(helps[0]!.description, "우리 도움말");
});

test("파서·버전 비교", () => {
  assert.equal(frontmatterValue("---\nname: a\ndescription: 'x y'\n---\n", "description"), "x y");
  assert.equal(frontmatterValue("본문만", "description"), null);
  assert.equal(tomlDescription('description = "a \\"b\\""\n'), 'a "b"');
  assert.equal(versionMatches("2.1.289", "2.1.289 (Claude Code)"), true);
  assert.equal(versionMatches("2.1.289", "2.1.2890"), false);
  assert.equal(versionMatches(null, "1"), false);
});

test("agy: 확인된 내장 표(1.2.9)와 재개·YOLO 인자, 스캔 못 하는 사용자 정의는 그 사실을 말한다", async () => {
  const { home, cwd } = await fixture();
  const p = CLI_PROVIDER_BY_ID.agy!;
  assert.deepEqual(p.yoloArgs, ["--dangerously-skip-permissions"]);
  assert.deepEqual(p.resumeArgs, ["--continue"]);
  const r = (await listCliCommands(p, { cwd, home, installedVersion: "1.2.9" }))!;
  assert.equal(r.stale, false);
  assert.ok(r.commands.some((c) => c.name === "codesearch"));
  assert.ok(r.notes.some((n) => n.includes("미확인")));
});
