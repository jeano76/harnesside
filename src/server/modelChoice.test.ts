import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseModel } from "./modelChoice.js";

/** 프로젝트 폴더·홈 폴더·모델 파일을 진짜 파일시스템에 만든다. */
async function world(setup: (w: { project: string; home: string; models: string }) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "harnesside-modelchoice-"));
  const w = { project: join(base, "project"), home: join(base, "home"), models: join(base, "disk", "models") };
  await mkdir(w.project, { recursive: true });
  await mkdir(w.home, { recursive: true });
  await mkdir(w.models, { recursive: true });
  await setup(w);
  return { ...w, done: () => rm(base, { recursive: true, force: true }) };
}
const writeConfig = async (root: string, body: string) => {
  await mkdir(join(root, ".harnesside"), { recursive: true });
  await writeFile(join(root, ".harnesside", "config.yaml"), body, "utf8");
};

test("프로젝트 설정이 없어도 전역 설정의 모델을 쓴다 — 폴더를 바꿔 띄웠을 때 '모델이 없습니다' 가 되던 경우", async () => {
  const w = await world(async ({ home, models }) => {
    await writeFile(join(models, "Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "x");
    await writeConfig(home, `backend: local-llama\nmodel: ${join(models, "Ornith-1.5-35B-A3B-Q4_K_M.gguf")}\n`);
  });
  try {
    const c = await chooseModel({ projectRoot: w.project, modelsDir: join(w.home, ".harnesside", "models"), homeDir: w.home });
    assert.equal(c.via, "config");
    assert.equal(c.path, join(w.models, "Ornith-1.5-35B-A3B-Q4_K_M.gguf"));
    assert.match(c.reason, /전역 설정/, "어디서 찾았는지 말한다");
  } finally {
    await w.done();
  }
});

test("프로젝트 설정이 있으면 전역 설정보다 우선한다", async () => {
  const w = await world(async ({ project, home, models }) => {
    await writeFile(join(models, "a.gguf"), "x");
    await writeFile(join(models, "b.gguf"), "x");
    await writeConfig(project, `model: ${join(models, "a.gguf")}\n`);
    await writeConfig(home, `model: ${join(models, "b.gguf")}\n`);
  });
  try {
    const c = await chooseModel({ projectRoot: w.project, modelsDir: "/nonexistent", homeDir: w.home });
    assert.equal(c.path, join(w.models, "a.gguf"));
    assert.doesNotMatch(c.reason, /전역/);
  } finally {
    await w.done();
  }
});

test("프로젝트 설정의 경로가 낡아 파일이 없으면 전역 설정으로 넘어간다 (local-model 같은 자리표시자 포함)", async () => {
  const w = await world(async ({ project, home, models }) => {
    await writeFile(join(models, "good.gguf"), "x");
    await writeConfig(project, "model: local-model\n");
    await writeConfig(home, `model: ${join(models, "good.gguf")}\n`);
  });
  try {
    const c = await chooseModel({ projectRoot: w.project, modelsDir: "/nonexistent", homeDir: w.home });
    assert.equal(c.path, join(w.models, "good.gguf"));
  } finally {
    await w.done();
  }
});

test("어디에도 없으면 없다고 말하고, 설정에 적힌 낡은 경로는 제안에 남긴다", async () => {
  const w = await world(async ({ home, models }) => {
    await writeConfig(home, `model: ${join(models, "gone.gguf")}\n`);
  });
  try {
    const c = await chooseModel({ projectRoot: w.project, modelsDir: join(w.home, "nomodels"), homeDir: w.home });
    assert.equal(c.path, null);
    assert.equal(c.via, "none");
    assert.ok(c.suggestions.some((s) => s.name === "gone.gguf" && /파일이 없습니다/.test(s.why)), JSON.stringify(c.suggestions));
  } finally {
    await w.done();
  }
});

test("설정이 어디에도 없으면 모델 폴더 스캔으로 간다 (기존 동작 유지)", async () => {
  const w = await world(async ({ home }) => {
    await mkdir(join(home, ".harnesside", "models"), { recursive: true });
    await writeFile(join(home, ".harnesside", "models", "Ornith-1.5-35B-A3B-Q4_K_M.gguf"), "x");
  });
  try {
    const c = await chooseModel({ projectRoot: w.project, modelsDir: join(w.home, ".harnesside", "models"), homeDir: w.home });
    assert.equal(c.via, "priority-series");
  } finally {
    await w.done();
  }
});
