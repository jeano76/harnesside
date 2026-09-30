/**
 * 스폰 플래그 — `--jinja` 는 **대화의 존재 조건**이다 (2026-10-01).
 *
 * 실측: 이 플래그가 없던 서버가 한국어 질문에 대해 `separ separ separ…` 반복과
 * 러시아어·중국어·히브리어 쓰레기를 냈다. 600토큰을 받아도 `content` 가 빈 채
 * `reasoning_content` 만 찢어졌다.
 *
 * 원인은 **채팅 템플릿 미적용**이었다. `--jinja` 없으면 llama-server 는 GGUF 안의
 * Jinja 템플릿을 쓰지 않는다. 모델이 "사람이 무슨 말을 했나" 를 모르면 받은 문장을
 * **이어 쓰기** 시작한다 — 그게 쓰레기의 정체다.
 *
 * **증빙은 토큰 수다**: `"ABC"` 3글자 → `prompt_tokens: 11`. 템플릿이 붙었다면
 * 역할 표시 + 생성 프롬프트로 30~50이 나온다.
 *
 * 이 테스트가 없으면 `--jinja` 는 "있으면 좋다" 는 최적화로 취급되다가 조용히
 * 사라진다. 그리고 **없어져도 서버는 200 을 준다** — 그래서 Nobody notices.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildLlamaArgs, type LlamaLaunchOptions } from "./llamaLauncher.js";

const TUNING = {
  gpuLayers: 999,
  contextSize: 16384,
  threads: 6,
  threadsBatch: 11,
  batchSize: 2048,
  ubatchSize: 512,
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
  flashAttn: true,
  parallel: 1,
  cpuMoeLayers: 32,
};

const OPTS: LlamaLaunchOptions = {
  binPath: "/bin/true",
  modelPath: "/models/x.gguf",
  host: "127.0.0.1",
  port: 8080,
  tuning: TUNING as never,
};

test("**`--jinja` 를 준다** — 없으면 대화가 되지 않는다", () => {
  const { args } = buildLlamaArgs(OPTS);
  assert.ok(args.includes("--jinja"), `--jinja 없음: ${args.join(" ")}`);
});

test("**근거를 함께 말한다** — 왜 이 플래그가 있는지 rationale 에 남는다", () => {
  const { rationale } = buildLlamaArgs(OPTS);
  const line = rationale.find((r) => r.includes("jinja"));
  assert.ok(line, "근거가 없다 — 다음에 누가 지워도 모른다");
  assert.match(line!, /템플릿/, "무엇을 하는 플래그인지 말하지 않는다");
});

test("**KV 캐시 플래그가 살아 있다** — jinja 를 넣으면서 지우지 않았다", () => {
  // 실측: jinja 를 넣는 수정 과정에서 이 두 줄이 **사라졌다**. 성능 플래그를
  // 고치면서 이웃을 지우는 것은 가장 조용한 손실이다(§④ 표 10: 정본은 한 곳).
  const { args } = buildLlamaArgs(OPTS);
  const k = args.indexOf("--cache-type-k");
  assert.ok(k >= 0, "--cache-type-k 가 사라졌다");
  assert.equal(args[k + 1], "q8_0", "KV k 값이 틀렸다");
  assert.ok(args.includes("--cache-type-v"), "--cache-type-v 가 사라졌다");
});

test("**병렬 슬롯 1** 유지 — 늘리면 컨텍스트가 나뉘어 조용히 잘린다", () => {
  const { args } = buildLlamaArgs(OPTS);
  const np = args.indexOf("-np");
  assert.ok(np >= 0, "-np 없음");
  assert.equal(args[np + 1], "1", "슬롯이 늘었다 — 컨텍스트가 슬롯 수로 나뉜다");
});

test("**모델·주소·포트** 는 그대로 — 플래그 추가는 이것을 바꾸지 않는다", () => {
  const { args } = buildLlamaArgs(OPTS);
  const i = args.indexOf("-m");
  assert.equal(args[i + 1], "/models/x.gguf");
  const p = args.indexOf("--port");
  assert.equal(args[p + 1], "8080");
});
