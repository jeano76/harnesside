import { test } from "node:test";
import assert from "node:assert/strict";
import { findSameWeightsModel, familyRootOf } from "./existingModel.js";
import type { GgufFingerprint } from "./ggufMeta.js";

// 실제 사례: 같은 753 텐서 · 같은 하이퍼파라미터로 이름과 크기만 바뀐 재배포본.
const CANDIDATE = { filename: "Ornith-1.5-35B-A3B-Q4_K_M.gguf", sizeBytes: 21_864_081_056 };
const RENAMED = { path: "/m/Ornith-1.5-35B-Q4_K_M.gguf", sizeBytes: 21_713_463_040 };
const SAME_FP: GgufFingerprint = { arch: "qwen35moe", blockCount: 40, embeddingLength: 2048, tensorCount: 753, conclusive: true };

const fpReader = (fp: GgufFingerprint) => async () => fp;

test("이름·크기가 달라도 헤더가 같으면 같은 가중치로 본다", async () => {
  const hit = await findSameWeightsModel(CANDIDATE, [RENAMED], { readFingerprint: fpReader(SAME_FP) });
  assert.ok(hit, "재배포본을 놓쳤다 — 21.7 GB 를 다시 받게 된다");
  assert.equal(hit.path, RENAMED.path);
  assert.match(hit.reason, /헤더 qwen35moe·40층·텐서 753개 일치/);
});

test("헤더를 확실히 못 읽으면(inconclusive) 재사용하지 않는다", async () => {
  const unsure: GgufFingerprint = { arch: "", conclusive: false };
  assert.equal(await findSameWeightsModel(CANDIDATE, [RENAMED], { readFingerprint: fpReader(unsure) }), null);
});

test("크기 차이가 허용치를 넘으면 헤더를 읽지도 않는다", async () => {
  let reads = 0;
  const far = { path: "/m/Ornith-1.5-35B-Q4_K_M.gguf", sizeBytes: 15_000_000_000 };
  const hit = await findSameWeightsModel(CANDIDATE, [far], {
    readFingerprint: async () => (reads++, SAME_FP),
  });
  assert.equal(hit, null);
  assert.equal(reads, 0, "관계없는 모델에 헤더 I/O 를 쓰면 안 된다");
});

test("양자화 태그가 다르면 제외한다", async () => {
  const q8 = { path: "/m/Ornith-1.5-35B-Q8_0.gguf", sizeBytes: RENAMED.sizeBytes };
  assert.equal(await findSameWeightsModel(CANDIDATE, [q8], { readFingerprint: fpReader(SAME_FP) }), null);
});

test("정확히 같은 파일 이름은 이 단계의 몫이 아니다 (pickReusable 담당)", async () => {
  const exact = { path: "/m/" + CANDIDATE.filename, sizeBytes: CANDIDATE.sizeBytes };
  assert.equal(await findSameWeightsModel(CANDIDATE, [exact], { readFingerprint: fpReader(SAME_FP) }), null);
});

test("가족 루트는 MoE 크기 표시(-A3B)만 뺀다", () => {
  assert.equal(familyRootOf("Ornith-1.5-35B-A3B-Q4_K_M.gguf"), familyRootOf("Ornith-1.5-35B-Q4_K_M.gguf"));
  assert.notEqual(familyRootOf("Ornith-1.5-35B-Q4_K_M.gguf"), familyRootOf("Ornith-2-35B-Q4_K_M.gguf"));
});
