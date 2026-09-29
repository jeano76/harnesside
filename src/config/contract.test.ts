/**
 * 설정 계약 테스트 (§6.4, §10.2).
 *
 * 특히 두 가지가 이 파일의 존재 이유다:
 * 1) **재귀 병합** — 원본에서 "부분 병합이 누락 필드를 통째로 날린" 버그가 났다.
 * 2) **출처 표시** — 값이 안 바뀌는 이유를 사용자가 알 수 있어야 한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  deepMerge,
  loadConfig,
  saveConfig,
  migrate,
  findSecrets,
  createCredentialStore,
  describeSource,
  SCHEMA_VERSION,
  type SourceTree,
} from "./contract.js";

async function sandbox(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-config-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("중첩 객체 병합 — 원본에서 필드를 통째로 날린 버그의 재발 방지", () => {
  const base = { llama: { baseUrl: "http://127.0.0.1:8080", port: 8080, modelPath: "/a.gguf" }, gpu: { mode: "off" } };
  const over = { llama: { port: 9090 } };
  const merged = deepMerge(base, over);
  assert.equal(merged.llama.port, 9090, "덮어쓴 값");
  assert.equal(merged.llama.baseUrl, "http://127.0.0.1:8080", "덮어쓰지 않은 필드가 사라졌다");
  assert.equal(merged.llama.modelPath, "/a.gguf", "다른 필드도 사라졌다");
  assert.equal(merged.gpu.mode, "off");
  // 원본이 변하면 안 된다
  assert.equal(base.llama.port, 8080);
});

test("배열은 병합하지 않고 덮어쓴다 — 병합하면 뜻이 사라진다", () => {
  const merged = deepMerge({ tools: ["a", "b", "c"] }, { tools: ["x"] });
  assert.deepEqual(merged.tools, ["x"]);
});

test("undefined 는 '기본값 유지' 다 — 키 삭제가 아니다", () => {
  const merged = deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 });
  assert.equal(merged.a, 1);
  assert.equal(merged.b, 3);
});

test("병합 우선순위: default < global < project < env", async () => {
  const s = await sandbox();
  try {
    const g = join(s.dir, "global.yaml");
    const p = join(s.dir, "project.yaml");
    await writeFile(g, "gpu:\n  mode: budgeted\n  reserveMiB: 700\n");
    await writeFile(p, "gpu:\n  mode: budgeted\nllama:\n  port: 9090\n");
    const c = await loadConfig({
      globalConfigPath: g,
      projectConfigPath: p,
      env: { HARNESSIDE_GPU_MODE: "off" },
      defaults: { gpu: { mode: "off", reserveMiB: 0, reservedFor: "테스트" } },
    });
    const gpu = c.values.gpu as Record<string, unknown>;
    assert.equal(gpu.mode, "off", "env 가 이겨야 한다");
    assert.equal(gpu.reserveMiB, 700, "global 값이 project 에 지워지지 않아야 한다");
    assert.equal(gpu.reservedFor, "테스트", "default 값이 살아 있어야 한다");
    assert.equal((c.values.llama as Record<string, unknown>).port, 9090, "project");
    // 출처는 값 구조를 따라간다 — 최상위가 아니라 리프를 봐야 한다.
    assert.equal((c.sources.gpu as SourceTree).mode as string, "env");
    assert.equal((c.sources.gpu as SourceTree).reserveMiB as string, "global");
    assert.equal((c.sources.llama as SourceTree).port as string, "project");
  } finally {
    await s.cleanup();
  }
});

test("출처가 사람에게 읽히는 문장으로 나온다 — '값이 안 바뀌는 이유'를 알 수 있어야 한다", async () => {
  const s = await sandbox();
  try {
    const p = join(s.dir, "project.yaml");
    await writeFile(p, "llama:\n  port: 9090\n");
    const c = await loadConfig({ projectConfigPath: p, env: {}, defaults: { gpu: { mode: "off" } } });
    const lines = c.originLines.join(" | ");
    assert.ok(lines.includes("llama.port: 이 프로젝트에서 재정의"), lines);
    assert.ok(lines.includes("gpu.mode: 기본값"), `중첩 키의 출처가 빠져 있다: ${lines}`);
    assert.equal(describeSource("env", "gpu.mode").includes("환경변수"), true);
  } finally {
    await s.cleanup();
  }
});

test("깨진 설정 파일이어도 부팅은 계속된다 — 경고로 남고 기본값으로 진행", async () => {
  const s = await sandbox();
  try {
    const p = join(s.dir, "broken.yaml");
    await writeFile(p, "llama:\n  - 이건\n   잘못된 yaml: [[[\n");
    const c = await loadConfig({ projectConfigPath: p, env: {}, defaults: { gpu: { mode: "off" } } });
    assert.equal((c.values.gpu as Record<string, unknown>).mode, "off");
    assert.ok(c.warnings.length > 0, "경고가 남아야 한다");
  } finally {
    await s.cleanup();
  }
});

test("환경변수 타입 추론 — '8080' 이 문자열로 남으면 포트 비교가 틀린다", async () => {
  const s = await sandbox();
  try {
    const c = await loadConfig({
      env: { HARNESSIDE_LLAMA_PORT: "8080", HARNESSIDE_GPU_FORCED: "true", HARNESSIDE_X_MODE: "off" },
      defaults: {},
    });
    const llama = c.values.llama as Record<string, unknown>;
    assert.equal(llama.port, 8080);
    assert.equal(typeof llama.port, "number");
    assert.equal((c.values.gpu as Record<string, unknown>).forced, true);
    assert.equal((c.values.x as Record<string, unknown>).mode, "off");
  } finally {
    await s.cleanup();
  }
});

test("마이그레이션: 구 형식 키를 옮기되 **알 수 없는 키는 보존**한다", () => {
  const { values, notes } = migrate({ model: "/m.gguf", baseUrl: "http://x", laya: { port: 1 }, futureKey: { a: 1 } }, 0);
  const llama = values.llama as Record<string, unknown>;
  assert.equal(llama.modelPath, "/m.gguf");
  assert.equal(llama.baseUrl, "http://x");
  assert.equal((values.server as Record<string, Record<string, unknown>>).laya.port, 1);
  assert.deepEqual(values.futureKey, { a: 1 }, "미래 키를 버리면 안 된다");
  assert.equal(values.schemaVersion, SCHEMA_VERSION);
  assert.ok(notes.length > 0);
});

test("현재 스키마면 아무것도 바꾸지 않는다 (멱등)", () => {
  const input = { schemaVersion: SCHEMA_VERSION, llama: { port: 1 } };
  const { values } = migrate(input, SCHEMA_VERSION);
  assert.deepEqual(values, input);
});

test("원자적 쓰기: tmp → rename, 그리고 0600", async () => {
  const s = await sandbox();
  try {
    const p = join(s.dir, "config.yaml");
    await saveConfig(p, { llama: { port: 8080 } }, { mode: 0o600 });
    const raw = await readFile(p, "utf8");
    assert.equal((parseYaml(raw) as Record<string, Record<string, number>>).llama.port, 8080);
    const st = await stat(p);
    assert.equal(st.mode & 0o777, 0o600);
    // tmp 파일이 남지 않아야 한다
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(s.dir);
    assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0, "tmp 파일이 남았다");
  } finally {
    await s.cleanup();
  }
});

test("쓰기 후 다시 읽어도 값이 같고, 중첩 구조가 보존된다", async () => {
  const s = await sandbox();
  try {
    const p = join(s.dir, "c.yaml");
    const original = { llama: { port: 8080, baseUrl: "http://127.0.0.1:8080" }, gpu: { mode: "off" } };
    await saveConfig(p, original);
    const c = await loadConfig({ projectConfigPath: p, env: {}, defaults: {} });
    // 라운드트립 후에도 값이 보존된다 (schemaVersion 은 마이그레이션이 붙이는 값).
    assert.equal((c.values.llama as Record<string, unknown>).port, 8080);
    assert.equal((c.values.llama as Record<string, unknown>).baseUrl, "http://127.0.0.1:8080");
    assert.equal((c.values.gpu as Record<string, unknown>).mode, "off");
    assert.equal(c.schemaVersion, 0, "저장된 파일에는 스키마 버전이 없었음(마이그레이션 전)");
  } finally {
    await s.cleanup();
  }
});

test("시크릿 스캔 — 설정에 토큰이 들어가면 잡아낸다 (§10.6 CI 와 같은 규칙)", () => {
  const hits = findSecrets(["token: ghp_abcdefghijklmnopqrstuvwxyz012345", "api: sk-0123456789abcdefghij"].join("\n"));
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.name === "GitHub PAT"));
  assert.ok(hits.some((h) => h.name === "OpenAI"));
  assert.equal(findSecrets("harmless: value").length, 0);
});

test("credential store 는 0600 이고, 설정 파일과 분리된다", async () => {
  const s = await sandbox();
  try {
    const credPath = join(s.dir, "credentials.json");
    const store = createCredentialStore(credPath);
    await store.write("github", "ghp_secretvalue0123456789");
    assert.equal(await store.read("github"), "ghp_secretvalue0123456789");
    const st = await stat(credPath);
    assert.equal(st.mode & 0o777, 0o600, "시크릿 파일이 다른 사용자에게 읽히면 안 된다");
    assert.equal(await store.read("nonexistent"), null);
  } finally {
    await s.cleanup();
  }
});
