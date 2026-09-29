/**
 * 에이전트 패널 (§5.3 Think · §5.4 블록 · M3 취소).
 *
 * 판정 로직은 **여기 없다** — `agent/think.ts` 가 이미 계산해 준다(예산 초과 전환,
 * 2회 재시도). 여기서 다시 계산하면 같은 규칙이 두 곳에 생기고, 둘이 어긋나는 날이 온다
 * (그래서 `think.ts` 는 처음부터 순수 함수로만 만들었다).
 *
 * `reasoning_content` 를 **숨기지 않는다**가 기본이다. 사고가 보이지 않으면 "뭘 얼마나
 * 생각했나" 를 알 수 없고, 사용자가 할 수 있는 행동(예산 줄이기)도 없다. 그래서 스타일
 * 선택(§5.3 의 5종)과 경고 문구를 함께 둔다.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { animationFor, initialThink, ingest, finish, type ThinkState, type ThinkStyle } from "../agent/think.js";

export const THINK_STYLES: { id: ThinkStyle; label: string; hint: string }[] = [
  { id: "dots", label: "파동 점", hint: "기본. 생각 중임을 짧게 알립니다" },
  { id: "pulse", label: "고동", hint: "한 점이 밝아졌다 어두워집니다" },
  { id: "orbit", label: "공전", hint: "가장 눈에 띕니다" },
  { id: "shimmer", label: "번짐", hint: "글 흐름에 은은한 빛" },
  { id: "bar", label: "막대", hint: "움직임 없음. prefers-reduced-motion 에 적합" },
];

export interface AgentBlock {
  id: string;
  kind: "reasoning" | "text" | "status" | "tool" | "error";
  text: string;
  tool?: { name: string; done?: boolean };
  at: number;
}

/** `reasoning` 델타를 누적하되, 블록 하나가 지나치게 길어지지 않게 자른다(§5.12 와 같은 이유). */
const MAX_BLOCK_CHARS = 4000;

export function appendToBlock(blocks: AgentBlock[], kind: AgentBlock["kind"], text: string, at: number, tool?: AgentBlock["tool"]): AgentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind && (kind !== "tool" || last.tool?.name === tool?.name) && at - last.at < 2500) {
    const merged = [...blocks.slice(0, -1), { ...last, text: (last.text + text).slice(-MAX_BLOCK_CHARS), tool: tool ?? last.tool }];
    return merged;
  }
  return [...blocks, { id: `${kind}-${at}-${blocks.length}`, kind, text: text.slice(0, MAX_BLOCK_CHARS), tool, at }];
}

/** WS 이벤트를 블록으로 바꾼다. **한 곳에서만** — 두 곳에서 바꾸면 순서가 뒤집힌다. */
export function applyEvent(blocks: AgentBlock[], e: { type: string; text?: string; tool?: AgentBlock["tool"]; at?: number }): AgentBlock[] {
  const at = e.at ?? Date.now();
  switch (e.type) {
    case "agent.reasoning":
      return appendToBlock(blocks, "reasoning", e.text ?? "", at);
    case "agent.delta":
      return appendToBlock(blocks, "text", e.text ?? "", at);
    case "agent.status":
      return appendToBlock(blocks, "status", e.text ?? "", at);
    case "agent.tool":
      return appendToBlock(blocks, "tool", e.tool?.name ?? "", at, e.tool);
    case "agent.error":
      return appendToBlock(blocks, "error", e.text ?? "", at);
    case "agent.diff":
      return appendToBlock(blocks, "text", `[${e.text ?? "diff"}] 변경됨`, at);
    default:
      return blocks;
  }
}

function ThinkIndicator({ state, style }: { state: ThinkState; style: ThinkStyle }) {
  const anim = animationFor(style);
  if (!state.enabled) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#6e7681", fontSize: 11 }}>
      {anim.dots > 0 && (
        <span style={{ display: "inline-flex", gap: 3 }}>
          {Array.from({ length: anim.dots }).map((_, i) => (
            <span
              key={i}
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: "#d29922",
                animation: `pulse ${anim.durationMs}ms ease-in-out ${i * 160}ms infinite`,
              }}
            />
          ))}
        </span>
      )}
      <span>사고 중 · {state.usedTokens.toLocaleString("ko-KR")} 토큰</span>
    </div>
  );
}

export function AgentPanel({
  blocks,
  running,
  think,
  onStyle,
  onThinking,
  onCancel,
}: {
  blocks: AgentBlock[];
  running: boolean;
  think: ThinkState;
  onStyle: (s: ThinkStyle) => void;
  onThinking: (on: boolean) => void;
  onCancel: () => void;
}) {
  const [style, setStyle] = useState<ThinkStyle>(think.style);
  const bottom = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // 스크롤은 **항상 맨 아래로**. 사용자가 위로 스크롤 중이어도 새 델타는 최신이어야 한다.
    bottom.current?.scrollIntoView({ block: "end" });
  }, [blocks.length, blocks[blocks.length - 1]?.text.length]);

  const warnings = useMemo(() => {
    const out: string[] = [];
    if (think.needsWarning) out.push("thinking 을 켜면 예산을 통째로 쓸 수 있습니다 — 도구 호출이 없을 수 있습니다.");
    if (think.reason) out.push(think.reason);
    return out;
  }, [think.needsWarning, think.reason]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* 스타일/토글 — §5.3 의 선택지. 숨기면 "생각이 왜 안 보이냐" 를 답할 수 없다. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderBottom: "1px solid #30363d", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "#6e7681" }}>
          <input type="checkbox" checked={think.enabled} onChange={(e) => onThinking(e.target.checked)} />
          사고 표시
        </label>
        <select
          value={style}
          onChange={(e) => {
            const s = e.target.value as ThinkStyle;
            setStyle(s);
            onStyle(s);
          }}
          style={{ background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, font: "inherit", fontSize: 10 }}
        >
          {THINK_STYLES.map((s) => (
            <option key={s.id} value={s.id} title={s.hint}>
              {s.label}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {running && (
          <button type="button" onClick={onCancel} style={{ background: "#21262d", color: "#f85149", border: "1px solid #30363d", borderRadius: 4, font: "inherit", fontSize: 10, padding: "1px 6px", cursor: "pointer" }}>
            취소
          </button>
        )}
      </div>

      {warnings.length > 0 && (
        <div style={{ padding: "3px 6px", color: "#d29922", fontSize: 10, borderBottom: "1px solid #30363d" }}>
          {warnings.join(" ")}
        </div>
      )}

      <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "4px 6px" }}>
        {blocks.length === 0 && !running && (
          <div style={{ color: "#6e7681", fontSize: 11 }}>아직 메시지가 없습니다. 입력창에 지시하십시오.</div>
        )}
        {blocks.map((b) => (
          <div key={b.id} style={{ marginBottom: 6 }}>
            {b.kind === "reasoning" && (
              <details open style={{ borderLeft: "2px solid #d29922", paddingLeft: 6 }}>
                <summary style={{ cursor: "pointer", fontSize: 10, color: "#d29922" }}>
                  사고 {b.text.length.toLocaleString("ko-KR")}자
                </summary>
                <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", font: "11px/1.5 ui-monospace, monospace", color: "#8b949e" }}>{b.text}</pre>
              </details>
            )}
            {b.kind === "text" && (
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.6 system-ui, sans-serif", color: "#c9d1d9" }}>{b.text}</pre>
            )}
            {b.kind === "status" && <div style={{ color: "#6e7681", fontSize: 11 }}>· {b.text}</div>}
            {b.kind === "tool" && (
              <div style={{ color: b.tool?.done ? "#3fb950" : "#6e7681", fontSize: 11 }}>
                {b.tool?.done ? "✓" : "▸"} 도구: {b.tool?.name}
              </div>
            )}
            {b.kind === "error" && <div style={{ color: "#f85149", fontSize: 11 }}>오류: {b.text}</div>}
          </div>
        ))}
        <ThinkIndicator state={think} style={style} />
        <div ref={bottom} />
      </div>
    </div>
  );
}

/** 델타 한 개로 think 상태를 갱신한다(예산 초과 시 강제 전환은 여기서 일어난다). */
export function thinkAfterDelta(s: ThinkState, d: { reasoning?: string; text?: string }): ThinkState {
  return ingest(s, d);
}

export { initialThink, finish };
