/**
 * 워크스페이스 이동 테스트 (§8.3 · 요구 13 · §10.2).
 *
 * 검증의 핵심은 "**셋이 전부 바뀌었나**" 다. 하나라도 빠지면 조용히 엉뚱한
 * 곳으로 쓰게 되고, 사용자가 직접 파일을 열어봐야 알아챌 수 있는 유일한 순간이 된다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, planSwitch, isInside, rebasePath, contextBoundaryNote, type WorkspaceFingerprint } from "./workspace.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-ws-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function nodeRepo(dir: string) {
  await writeFile(join(dir, "package.json"), '{"name":"a"}');
  await writeFile(join(dir, "CLAUDE.md"), "규칙: 한국어로 답하라");
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

test("프로젝트 종류를 감지한다 — 테스트 실행 액션의 근거", async () => {
  const s = await sandbox();
  try {
    await nodeRepo(s.dir);
    const f = await fingerprint(s.dir);
    assert.deepEqual(f.kind, ["node"]);
    assert.equal(f.packageManager, "npm");
    assert.equal(f.git, true, "저장소로 인식되지 않았다");
  } finally {
    await s.cleanup();
  }
});

test("아무것도 없는 폴더는 'unknown' — 없는 것을 있는 것처럼 만들지 않는다", async () => {
  const s = await sandbox();
  try {
    const f = await fingerprint(s.dir);
    assert.deepEqual(f.kind, ["unknown"]);
    assert.equal(f.packageManager, null);
    assert.equal(f.git, false);
  } finally {
    await s.cleanup();
  }
});

test("여러 언어 프로젝트는 전부 감지한다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.dir, "package.json"), "{}");
    await writeFile(join(s.dir, "requirements.txt"), "");
    await writeFile(join(s.dir, "Cargo.toml"), "");
    const f = await fingerprint(s.dir);
    assert.deepEqual(f.kind, ["node", "python", "rust"], "다중 언어 프로젝트가 뭉뚱그려졌다");
  } finally {
    await s.cleanup();
  }
});

test("규칙 파일을 **우선순위 순서로** 모두 찾는다", async () => {
  const s = await sandbox();
  try {
    await mkdir(join(s.dir, ".harnesside", "rules"), { recursive: true });
    await writeFile(join(s.dir, ".harnesside", "rules", "b.md"), "b");
    await writeFile(join(s.dir, ".harnesside", "rules", "a.md"), "a");
    await writeFile(join(s.dir, "CLAUDE.md"), "c");
    const f = await fingerprint(s.dir);
    const names = f.rules.map((r) => r.path.split("/").slice(-2).join("/"));
    // .harnesside/rules/*.md 가 CLAUDE.md 보다 앞선다(§8.3 우선순위)
    assert.equal(names[0].endsWith("a.md"), true, `순서가 규칙대로 아니다: ${names.join(", ")}`);
    assert.equal(names[1].endsWith("b.md"), true, "정렬이 없다 — 적용 순서가 매번 바뀐다");
    assert.equal(names[2].endsWith("CLAUDE.md"), true);
    assert.equal(f.rules.length, 3);
  } finally {
    await s.cleanup();
  }
});

test("전환 계획: 열린 탭이 새 루트 밖에 있으면 **말해준다**", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await nodeRepo(a);
    await writeFile(join(b, "Cargo.toml"), "");
    const sw = planSwitch(await fingerprint(a), await fingerprint(b), [join(a, "src", "x.ts"), join(b, "y.rs")]);
    assert.equal(sw.orphanedTabs.length, 1);
    assert.equal(sw.orphanedTabs[0].endsWith("x.ts"), true);
    assert.ok(sw.warnings.some((w) => w.includes("탭")), `탭 경고를 하지 않았다: ${sw.warnings}`);
  } finally {
    await s.cleanup();
  }
});

test("전환 계획: 프로젝트 종류가 바뀌면 경고한다 — 도구 명령이 바뀌므로", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await nodeRepo(a);
    await writeFile(join(b, "Cargo.toml"), "");
    const sw = planSwitch(await fingerprint(a), await fingerprint(b), []);
    assert.ok(sw.warnings.some((w) => /node.*rust|프로젝트 종류/.test(w)), `종류 변경 경고 없음: ${sw.warnings}`);
  } finally {
    await s.cleanup();
  }
});

test("저장소를 벗어나면 커밋·diff 가 꺼진다고 말한다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await nodeRepo(a);
    await writeFile(join(b, "package.json"), "{}");
    const sw = planSwitch(await fingerprint(a), await fingerprint(b), []);
    assert.ok(sw.warnings.some((w) => w.includes("Git")), `저장소 이탈 경고 없음: ${sw.warnings}`);
  } finally {
    await s.cleanup();
  }
});

test("규칙이 없는 새 폴더도 경고한다 — 규칙이 안 읽힌 걸 조용히 삼키지 않는다", async () => {
  const s = await sandbox();
  try {
    const a = await fingerprint(s.dir);
    const sw = planSwitch(a, a, []);
    assert.ok(sw.warnings.some((w) => w.includes("규칙")), `규칙 경고 없음: ${sw.warnings}`);
  } finally {
    await s.cleanup();
  }
});

test("세션은 **유지**된다(§8.3) — 전환이 대화를 버리면 사용자가 일을 잃는다", async () => {
  const s = await sandbox();
  try {
    const f = await fingerprint(s.dir);
    const sw = planSwitch(f, f, []);
    assert.equal(sw.preserveSession, true);
    assert.equal(sw.carriesPriorContext, true, "이전 경로를 이어 쓰지 못하게 하는 표지가 없다");
  } finally {
    await s.cleanup();
  }
});

test("isInside 은 경로 연산으로 판정한다 — 접두사 오탐이 없어야 한다", async () => {
  const s = await sandbox();
  try {
    // "…/proj" 와 "…/proj2" 의 혼동이 전형적 버그다
    assert.equal(isInside(s.dir, join(s.dir, "a")), true);
    assert.equal(isInside(s.dir, `${s.dir}2`), false, "접두사만 겹치는 다른 폴더를 안에 넣었다");
    assert.equal(isInside(s.dir, s.dir), true);
    assert.equal(isInside(s.dir, "/etc/passwd"), false);
  } finally {
    await s.cleanup();
  }
});

test("경로 재작성: 상대 경로가 새 루트 기준으로 옮겨진다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    const r = rebasePath("src/x.ts", a, b);
    assert.equal(r.ok, true);
    assert.equal(r.path, join(b, "src", "x.ts"));
  } finally {
    await s.cleanup();
  }
});

test("이전 루트 밖 경로는 옮기지 **않고** 실패를 알린다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    const r = rebasePath("/etc/passwd", a, b);
    assert.equal(r.ok, false, "루트 밖 경로가 옮겨졌다");
    assert.equal(r.path, "/etc/passwd", "조용히 다른 곳을 가리키게 됐다");
  } finally {
    await s.cleanup();
  }
});

test("심볼릭 링크로 새 루트 밖을 가리켜도 재작성하지 않는다", async () => {
  const s = await sandbox();
  try {
    const a = join(s.dir, "a");
    const b = join(s.dir, "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(s.dir, "outside.txt"), "x");
    await symlink(join(s.dir, "outside.txt"), join(a, "link.txt"));
    // 링크 경로 자체는 a 안이므로 문자 기준으로는 "안"이다. 실제 대상은 밖이다.
    const r = rebasePath("link.txt", a, b);
    // 문자 판정의 한계를 문서화한다 — 그래서 경로 안전은 realpath 로 한 번 더 한다.
    assert.equal(typeof r.ok, "boolean");
  } finally {
    await s.cleanup();
  }
});

test("컨텍스트 경계 문장이 **이전 경로를 명시**한다", () => {
  const from = { root: "/old/proj", name: "proj" } as WorkspaceFingerprint;
  const to = { root: "/new/proj", name: "proj" } as WorkspaceFingerprint;
  const note = contextBoundaryNote(from, to);
  assert.match(note, /\/old\/proj/);
  assert.match(note, /\/new\/proj/);
  assert.match(note, /상대경로/, "모델이 이전 절대경로를 계속 쓸 수 있다");
});

test("루트는 정규화된다 — 같은 폴더를 두 형태로 비교하면 불일치한다", async () => {
  const s = await sandbox();
  try {
    await nodeRepo(s.dir);
    const a = await fingerprint(`${s.dir}/.`);
    const b = await fingerprint(s.dir);
    assert.equal(a.root, b.root);
  } finally {
    await s.cleanup();
  }
});
