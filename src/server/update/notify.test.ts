/**
 * 추천 알림 테스트 (§5.13.2 · §10.2).
 *
 * 이 기능의 실패 형태는 두 가지이고 둘 다 조용하다:
 *  1. **노이즈** — 매번 울리는 알림. 사용자가 끄면 진짜 중요한 알림도 못 본다.
 *  2. **침묵** — 무시한 뒤에도 계속 울림. 끄는 것 자체가 효과가 없다.
 *
 * 그래서 "무시 후 재발 없음" 을 **직접** 검증한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  newWatchState,
  detectNewModels,
  detectLlama,
  silence,
  silenceAllOfKind,
  parseModelName,
  isNoise,
  quantRank,
  fitScore,
  scanModels,
  shouldCheck,
  newCheckState,
  onRateLimited,
  onOffline,
  onOnline,
  sortNotices,
  needsBanner,
  type ModelCandidate,
} from "./notify.js";

const cand = (file: string, over: Partial<ModelCandidate> = {}): ModelCandidate => ({
  file,
  bytes: 8 * 1024 ** 3,
  mtimeMs: 1_700_000_000_000,
  fingerprint: `${over.bytes ?? 8 * 1024 ** 3}:${over.mtimeMs ?? 1_700_000_000_000}`,
  ...over,
});

test("파일명에서 **계열과 양자화** 를 뽑는다", () => {
  const a = parseModelName("/models/Ornith-30B-Q5_K_M.gguf");
  assert.equal(a.family, "Ornith-30B");
  assert.equal(a.quant, "Q5_K_M");
  assert.equal(a.mmproj, false);

  const b = parseModelName("mmproj-7B-Q4_K_M.gguf");
  assert.equal(b.mmproj, true, "비전 투영 파일을 본체로 봤다");

  assert.equal(parseModelName("x-f16.gguf").quant, "F16");
  assert.equal(parseModelName("plain.gguf").quant, null);
});

test("노이즈는 제거한다 — mmproj·vocab·부분 파일·비 GGUF", () => {
  assert.equal(isNoise("mmproj-7B-Q4_K_M.gguf"), true);
  assert.equal(isNoise("tokenizer-vocab.gguf"), true);
  assert.equal(isNoise("big.gguf.part"), true);
  assert.equal(isNoise("big.gguf.incomplete"), true);
  assert.equal(isNoise("notes.txt"), true);
  assert.equal(isNoise("model-Q5_K_M.gguf"), false);
});

test("양자화 순서는 **문자열이 아니라 순위** — Q5 가 Q4 보다 높다", () => {
  assert.ok(quantRank("Q5_K_M") > quantRank("Q4_K_M"));
  assert.ok(quantRank("Q6_K") > quantRank("Q5_K_M"));
  assert.ok(quantRank("IQ3_M") > quantRank("Q4_K_M"), "IQ 계열이 Q4 아래다");
  assert.equal(quantRank(null), 0);
});

test("동일 계열은 1순위 — 점수와 무관하게 고정(요구 5 / P11)", () => {
  const cur = { family: "Ornith-30B", quant: "Q5_K_M" };
  assert.equal(fitScore(cur, { family: "Ornith-30B", quant: "Q5_K_M" }), 80);
  assert.equal(fitScore(cur, { family: "Ornith-30B", quant: "Q6_K" }), 95, "더 높은 양자화가 낮게 나온다");
  assert.ok(fitScore(cur, { family: "Other-7B", quant: "Q4_K_M" }) < 60, "다른 계열이 추천 1순위로 나온다");
});

test("새 모델은 **한 번만** 알린다 — 같은 지문이면 조용", () => {
  const st = newWatchState();
  const cur = { family: "Ornith-30B", quant: "Q5_K_M" };
  const list = [cand("Ornith-30B-Q6_K.gguf")];

  const first = detectNewModels(st, list, cur);
  assert.equal(first.length, 1, "첫 감지에서 알리지 않았다");

  const second = detectNewModels(st, list, cur);
  assert.equal(second.length, 0, "같은 파일을 또 알렸다 — 알림이 노이즈다");
});

test("파일이 **바뀌면** 다시 본다 (이전 모델이 업데이트된 것)", () => {
  const st = newWatchState();
  const cur = { family: "Ornith-30B", quant: "Q5_K_M" };
  detectNewModels(st, [cand("Ornith-30B-Q6_K.gguf", { bytes: 9_000_000_000 })], cur);
  const again = detectNewModels(st, [cand("Ornith-30B-Q6_K.gguf", { bytes: 9_500_000_000 })], cur);
  assert.equal(again.length, 1, "내용이 바뀌었는데 조용하다");
});

test("근거 없는 추천은 **알리지 않는다** — 노이즈 규칙", () => {
  const st = newWatchState();
  const cur = { family: "Ornith-30B", quant: "Q5_K_M" };
  const n = detectNewModels(st, [cand("SomeOther-7B-Q4_K_M.gguf")], cur);
  assert.equal(n.length, 0, "다른 계열을 추천했다");
});

test("**무시하면 재발하지 않는다** — 끄는 것이 실제로 효과가 있다", () => {
  const st = newWatchState();
  const cur = { family: "Ornith-30B", quant: "Q5_K_M" };
  const list = [cand("Ornith-30B-Q6_K.gguf")];

  const first = detectNewModels(st, list, cur);
  assert.equal(first.length, 1);
  silence(st, first[0]);

  // 무시한 지문을 **새 상태로** 다시 감지해도 조용해야 한다
  const st2 = { seen: new Map(), silenced: st.silenced };
  const again = detectNewModels(st2, list, cur);
  assert.equal(again.length, 0, "무시한 항목이 다시 울렸다 — '무시'가 무의미하다");
});

test("mmproj 는 본체 알림을 만들지 않는다", () => {
  const st = newWatchState();
  const cur = { family: "Ornith-30B", quant: "Q5_K_M" };
  const n = detectNewModels(st, [cand("Ornith-30B-mmproj-Q5_K_M.gguf")], cur);
  assert.equal(n.length, 0);
});

test("llama 바이너리 변경은 **배너** 다 — 조용한 정보가 아니다", () => {
  const st = newWatchState();
  // 첫 스캔은 "새 것" 이 아니라 기준 확립이다
  const first = detectLlama(st, { binaryMtimeMs: 1000, binarySize: 500, flags: ["-ngl", "99"], expectedFlags: ["-ngl", "99"] });
  assert.equal(first.length, 0, "첫 스캔에서 변경을 알렸다");

  const changed = detectLlama(st, { binaryMtimeMs: 2000, binarySize: 600, flags: ["-ngl", "99"], expectedFlags: ["-ngl", "99"] });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].severity, "action", "조용한 토스트로 하면 놓친다");
  assert.match(changed[0].body, /재시작/);
});

test("소스 리빌드로 **플래그가 사라지면** 경고한다 — GPU/튜닝 무효화", () => {
  const st = newWatchState();
  detectLlama(st, { binaryMtimeMs: 1000, binarySize: 500, flags: ["-ngl", "99", "--flash-attn"], expectedFlags: ["-ngl", "99", "--flash-attn"] });
  const n = detectLlama(st, {
    binaryMtimeMs: 1000,
    binarySize: 500,
    flags: ["-ngl", "99"],
    expectedFlags: ["-ngl", "99", "--flash-attn"],
  });
  assert.equal(n.length, 1);
  assert.equal(n[0].severity, "warn");
  assert.match(n[0].body, /--flash-attn/);
  assert.match(n[0].body, /GPU 모드/);
});

test("모델 디렉터리 스캔은 **내용을 읽지 않는다** — stat 만", async () => {
  // 진짜 파일시스템으로 한다: scan 은 stat 만 쓴다(수십 GB 를 읽지 않는다).
  // 목록과 디스크가 어긋난 경우(목록에만 있는 파일)도 조용히 넘어가야 한다.
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "harnesside-models-"));
  try {
    await writeFile(join(dir, "a-Q5_K_M.gguf"), Buffer.alloc(1024));
    await writeFile(join(dir, "b.txt"), "노이즈");
    await writeFile(join(dir, "mmproj-x.gguf"), Buffer.alloc(512));
    const got = await scanModels(dir, async (d) => (await import("node:fs/promises")).readdir(d));
    assert.equal(got.length, 1, `노이즈가 통과했다: ${got.map((g) => g.file).join(", ")}`);
    assert.equal(got[0].file, "a-Q5_K_M.gguf");
    assert.equal(got[0].bytes, 1024);
    assert.ok(got[0].fingerprint.includes(":"), "지문이 없다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("목록에만 있는(디스크에 없는) 파일은 조용히 넘어간다", async () => {
  const got = await scanModels("/models", async () => ["nonexistent.gguf"]);
  assert.deepEqual(got, []);
});

test("백그라운드 체크: **유휴 시에만** · 오프라인은 **조용히** 통과", () => {
  let s = newCheckState();
  s = { ...s, lastCheckAt: 0, idle: false };
  const busy = shouldCheck(s);
  assert.equal(busy.run, false, "사용자가 일하는 중에 백그라운드 체크가 돈다");
  assert.equal(busy.quiet, "busy");

  const offline = shouldCheck(onOffline({ ...s, idle: true }));
  assert.equal(offline.run, false);
  assert.equal(offline.quiet, "offline", "오프라인을 배너로 띄우면 사용자가 버그로 오인한다");

  // 1시간 안에 다시 물으면 안 된다
  const tooSoon = shouldCheck({ lastCheckAt: 1000, offline: false, idle: true, rateLimitUntil: 0 }, undefined, 2_000);
  assert.equal(tooSoon.run, false);
  assert.equal(tooSoon.quiet, "too-soon");
  assert.equal(shouldCheck({ lastCheckAt: 1000, offline: false, idle: true, rateLimitUntil: 0 }, undefined, 10_000_000).run, true);
});

test("429 는 **재시도 루프가 아니라 대기** 다", () => {
  const s = onRateLimited(newCheckState());
  assert.ok(s.rateLimitUntil > Date.now(), "한 시간이 아니다");
  const d = shouldCheck({ ...s, idle: true }, undefined, s.rateLimitUntil - 1000);
  assert.equal(d.run, false, "429 이후에도 계속 시도한다");
});

test("알림 정렬: **배너(조치·경고)** 가 조용한 정보보다 먼저", () => {
  const mk = (severity: "info" | "warn" | "action", fit: number) => ({
    id: `${severity}`,
    kind: "model" as const,
    title: "t",
    body: "b",
    fit,
    at: 0,
    silenceKey: `${severity}`,
    severity,
  });
  const s = sortNotices([mk("info", 100), mk("action", 60), mk("warn", 90)]);
  assert.deepEqual(s.map((x) => x.severity), ["action", "warn", "info"]);
  assert.equal(needsBanner(mk("info", 100)), false);
  assert.equal(needsBanner(mk("warn", 90)), true);
  assert.equal(needsBanner(mk("action", 60)), true);
});

test("silenceAllOfKind 는 조용한 통계를 돌려준다 — 몇 개를 끄는지 말해야 한다", () => {
  const st = newWatchState();
  const cur = { family: "Ornith-30B", quant: "Q5_K_M" };
  const ns = detectNewModels(st, [cand("a-Q6_K.gguf"), cand("b-Q6_K.gguf")], cur);
  for (const n of ns) silence(st, n);
  assert.equal(silenceAllOfKind(st, "model"), 0, "이미 무시된 것을 또 세었다");
  assert.equal(silenceAllOfKind(st, "llama"), 0);
});
