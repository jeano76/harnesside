/**
 * GGUF 헤더에서 **측정값**만 읽는 얇은 껍데기.
 *
 * 왜 별도 파일인가: `/server calibrate` 와 `tuning.ts` 가 같은 헤더를 읽는데,
 * 둘이 각자 `open()` 하고 `Buffer.alloc()` 하면 어느 쪽이 "모델이 40층" 이라고
 * 말하는지 두 군데가 따로 놀게 된다. 이 프로젝트가 그 상태를 가장 많이 겪은
 * 결함이다 — 규칙이 둘로 갈라지면 어느 쪽도 다른 쪽의 수정을 받지 못한다.
 *
 * 그래서 읽기는 여기 **한 군데** 있고, 각 모듈은 여기에 물어본다. 반환값이
 * `undefined` 는 "못 읽었다" 이며 0 이 아니다 — 0 을 넣으면 계층 0 개의 모델이
 * 되어 계산이 조용히 무너진다(ggufMeta.ts 의 같은 경고 참조).
 */

import { readGgufKvShape, type KvShape } from "./ggufMeta.js";
import { stat } from "node:fs/promises";

export interface ModelMeta {
  /** File size in bytes. 0 when the file cannot be stat'd. */
  bytes: number;
  /** Transformer block count, from the header. Undefined when unreadable. */
  layers?: number;
  /** K+V elements per token of context. Undefined when unreadable. */
  kvElementsPerToken?: number;
  /** The model's trained context length, from the header. */
  trainedContext?: number;
  /** The header's KV shape in full, for callers that want attention layers too. */
  shape?: KvShape;
  /** Why a field is missing, so a caller can say WHICH measurement it lacks
   *  rather than reporting "no change" as if everything had been read. */
  missing: string[];
}

/**
 * Reads the model's measured shape. Never throws: a missing or unreadable file
 * yields `bytes: 0` and a `missing` entry, and the caller's job is to report that
 * honestly, not to fail a command over it.
 */
export async function readModelMeta(modelPath: string): Promise<ModelMeta> {
  const missing: string[] = [];
  const bytes = (await stat(modelPath).catch(() => undefined))?.size ?? 0;
  if (!bytes) missing.push("모델 파일 (없거나 읽을 수 없음)");
  const shape = await readGgufKvShape(modelPath).catch(() => undefined);
  if (!shape) missing.push("GGUF 헤더 (KV 비용·레이어 수를 헤더에서 읽지 못했습니다)");
  return {
    bytes,
    layers: shape?.layers,
    kvElementsPerToken: shape?.elementsPerToken,
    trainedContext: shape?.contextLength,
    shape,
    missing,
  };
}

/** MoE-ness of a model file, or undefined when the header cannot say. */
export async function readMoe(modelPath: string): Promise<boolean | undefined> {
  const { isMoeModel } = await import("./ggufMeta.js");
  return isMoeModel({ path: modelPath }).catch(() => undefined);
}