/**
 * 저장 블록 → 화면 블록 복원 (§5.10).
 *
 * 왜 별도 모듈인가: 매핑이 `main.tsx` 안에 인라인돼 있으면 브라우저 없이
 * 검사할 수 없다. 2026-10-12 실측(복원 블록이 인자·출력을 잃고
 * `content:"run_shell"` 모양이 됨)이 바로 "유닛 없이 화면에만 있던" 종류다 —
 * 규칙을 순수 함수로 빼고 여기서 고정한다.
 */

import { normalizeTool, type AgentBlock } from "./blocks.js";
import type { PersistedBlock } from "./store.js";

/** 화면이 읽는 저장 블록 모양 — `/api/session/current` 응답과 같다. */
export interface StoredBlock {
  id?: string;
  kind?: string;
  title?: string;
  content?: unknown;
  createdAt?: number;
  tool?: { name: string; done?: boolean; args?: unknown };
}

/**
 * 저장 블록을 화면 블록으로. `view` 블록은 복원하지 않는다 — 저장 형식에
 * 모양이 없어 "이 화면을 열 수 없습니다" 만 남는다(기존 동작 유지).
 * 도구 호출은 `normalizeTool` 로 정제해 인자·완료 표시를 살린다.
 */
export function toAgentBlocks(blocks: (StoredBlock | PersistedBlock)[]): AgentBlock[] {
  return blocks
    .filter((b) => b.kind !== "view")
    .map((b, i) => ({
      id: b.id || `restored-${i}`,
      kind: ((b.kind as AgentBlock["kind"]) ?? "text") as AgentBlock["kind"],
      text: typeof b.content === "string" ? b.content : (b.title ?? ""),
      at: b.createdAt ?? Date.now(),
      tool: b.tool ? normalizeTool({ name: b.tool.name, done: b.tool.done, args: b.tool.args }) : undefined,
    }));
}
