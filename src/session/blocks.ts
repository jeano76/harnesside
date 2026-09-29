/**
 * 대화 블록 모음 (§5.4) — **웹과 서버가 같은 규칙** 으로 만든다.
 *
 * 왜 `shared/` 가 아니라 `session/` 이냐: 이건 UI 상태가 아니라 **기록** 이다. 세션
 * 영속화가 서버에서 일어나므로 서버도 같은 블록을 만들어야 하고, 두 곳에서 각각 만들면
 * "화면에 보이는 것" 과 "저장되는 것" 이 어긋난다 — 복원했을 때 다른 내용이 나오면
 * 사용자는 데이터를 잃었다고 생각한다.
 *
 * 그래서 **React 를 여기 두지 않는다.** `web/panels/AgentPanel.tsx` 는 이 모듈을
 * 그려 줄 뿐이고, 판단은 전부 여기 있다(§④ 표 10: 정본은 한 곳).
 */

export interface AgentBlock {
  id: string;
  kind: "reasoning" | "text" | "status" | "tool" | "error";
  text: string;
  tool?: { name: string; done?: boolean };
  at: number;
}

/** 블록 하나의 인라인 상한. 넘으면 **뒤만** 남긴다(사용자가 본 마지막이 중요). */
export const MAX_BLOCK_CHARS = 4000;
/** 같은 종류를 합치는 시간 창. 이 안에 온 델타는 한 블록으로 본다. */
export const MERGE_WINDOW_MS = 2500;

/**
 * 델타를 누적하되, 지나치게 긴 블록을 만들지 않는다.
 *
 * **합치는 대상은 '스트림' 뿐이다.** `text` 와 `reasoning` 은 토큰이 쪼개져 와도
 * 하나의 말이므로 이어 붙여야 한다. `status` · `tool` · `error` 는 **각각 독립된
 * 사건** 이다 — 이들을 합치면 "컨텍스트 984/32768모델이 응답 중입니다모델이 사고
 * 델타를 보냈지만…" 처럼 한 줄로 뭉개져 읽을 수 없다(실측).
 * "같은 종류니까 합친다" 는 판단이 사건을 잃는 방법이다.
 */
export function appendToBlock(
  blocks: AgentBlock[],
  kind: AgentBlock["kind"],
  text: string,
  at: number,
  tool?: AgentBlock["tool"]
): AgentBlock[] {
  const last = blocks[blocks.length - 1];
  const streamable = kind === "text" || kind === "reasoning";
  const sameTool = kind !== "tool" || (!!last && last.tool?.name === tool?.name);
  if (streamable && last && last.kind === kind && sameTool && at - last.at < MERGE_WINDOW_MS) {
    return [
      ...blocks.slice(0, -1),
      { ...last, text: (last.text + text).slice(-MAX_BLOCK_CHARS), tool: tool ?? last.tool },
    ];
  }
  return [...blocks, { id: `${kind}-${at}-${blocks.length}`, kind, text: text.slice(0, MAX_BLOCK_CHARS), tool, at }];
}

/**
 * 서버 이벤트를 블록으로 바꾼다. **한 곳에서만** — 분기마다 따로 처리하면
 * 순서가 뒤집히고(상태 문구가 답변 뒤에 붙는다) 되돌리기 어렵다.
 */
export function applyEvent(
  blocks: AgentBlock[],
  e: { type: string; text?: string; tool?: AgentBlock["tool"]; at?: number }
): AgentBlock[] {
  const at = e.at ?? Date.now();
  switch (e.type) {
    case "agent.reasoning":
      return appendToBlock(blocks, "reasoning", e.text ?? "", at);
    case "agent.delta":
      return appendToBlock(blocks, "text", e.text ?? "", at);
    case "agent.status":
      return appendToBlock(blocks, "status", e.text ?? "", at);
    case "agent.tool":
      return appendToBlock(blocks, "tool", e.text ?? "", at, e.tool);
    case "agent.error":
      return appendToBlock(blocks, "error", e.text ?? "", at);
    case "agent.diff":
      return appendToBlock(blocks, "text", `[${e.text ?? "diff"}] 변경됨`, at);
    default:
      return blocks;
  }
}

/** 사람이 읽는 한 줄 — 목록·로그·세션 이름에 쓴다. */
export function blockLabel(b: AgentBlock): string {
  switch (b.kind) {
    case "reasoning":
      return `사고 ${b.text.length.toLocaleString("ko-KR")}자`;
    case "text":
      return b.text.slice(0, 60) || "(빈 답변)";
    case "status":
      return b.text;
    case "tool":
      return `도구 ${b.tool?.name ?? "?"}`;
    case "error":
      return `오류: ${b.text.slice(0, 60)}`;
  }
}
