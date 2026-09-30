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
// 블록 규칙의 **정본**은 여기다. 이 파일은 그려 줄 뿐이다(두 곳에 판단을 두면 어긋난다).
import { appendToBlock, applyEvent, groupTurns, type AgentBlock } from "../../session/blocks.js";
import type { ApiClient } from "../api.js";
import { ToolBlock } from "./ToolBlock.js";

export const THINK_STYLES: { id: ThinkStyle; label: string; hint: string }[] = [
  { id: "dots", label: "파동 점", hint: "기본. 생각 중임을 짧게 알립니다" },
  { id: "pulse", label: "고동", hint: "한 점이 밝아졌다 어두워집니다" },
  { id: "orbit", label: "공전", hint: "가장 눈에 띕니다" },
  { id: "shimmer", label: "번짐", hint: "글 흐름에 은은한 빛" },
  { id: "bar", label: "막대", hint: "움직임 없음. prefers-reduced-motion 에 적합" },
];

export type { AgentBlock };
export { applyEvent, appendToBlock };

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

/**
 * 머리 아이콘 한 개.
 *
 * **왜 컴포넌트로 떼어냈나**: 아이콘 세 개를 인라인으로 쓰면 `aria-label` 을
 * 빠뜨리기 쉽고, 빠뜨리면 "화면 판독기가 무엇인지 말하지 못하는 버튼" 이 된다(M8).
 * 여기선 그걸 구조적으로 막는다 — 라벨을 **쓰지 않으면 컴파일되지 않게**.
 */
function IconButton({ label, glyph, onClick }: { label: string; glyph: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        background: "none",
        border: 0,
        color: "#8b949e",
        cursor: "pointer",
        font: "inherit",
        fontSize: 13,
        lineHeight: 1,
        padding: "1px 4px",
        borderRadius: 4,
      }}
    >
      {glyph}
    </button>
  );
}

export function AgentPanel({
  blocks,
  running,
  think,
  onStyle,
  onThinking,
  onCancel,
  client,
  /** `view` 블록이 그릴 내용. 설정 패널처럼 **무거운 것**은 셸이 주입한다 —
   *  이 컴포넌트가 그 화면을 아는 것이 아니라 **무엇을 그릴지 알기만 하면** 되므로. */
  viewExtra,
  onOpenView,
}: {
  blocks: AgentBlock[];
  running: boolean;
  think: ThinkState;
  onStyle: (s: ThinkStyle) => void;
  onThinking: (on: boolean) => void;
  onCancel: () => void;
  /** 도구 블록이 에디터·셸을 **그 자리에서** 그리기 위해 필요. */
  client?: ApiClient;
  /** `view` 블록이 그릴 설정 패널 등. **셸이 대상을 알고** 있다. */
  viewExtra?: { settings?: React.ReactNode };
  /** 머리 아이콘 — 선택한 것을 **대화 안에 블록으로** 연다 (2026-10-01). */
  onOpenView: (what: "settings" | "diff" | "file" | "dirs", path?: string) => void;
}) {
  const [style, setStyle] = useState<ThinkStyle>(think.style);
  const bottom = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** **맨 아래에 붙어 있는가.** 이 값이 오토 스크롤의 조건이다. */
  const [pinned, setPinned] = useState(true);
  /** 접은 묶음의 인덱스. **마지막 묶음은 항상 펼친다** — 진행 중인데 접으면 안 된다. */
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const turns = useMemo(() => groupTurns(blocks), [blocks]);
  const toggle = (i: number) => setCollapsed((c) => ({ ...c, [i]: c[i] !== false }));

  useEffect(() => {
    // **붙어 있을 때만** 따라간다. 안 그러면 읽던 곳을 빼앗긴다.
    if (pinned) scrollToBottom(scroller.current);
  }, [blocks.length, blocks[blocks.length - 1]?.text.length, pinned, turns.length]);

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
        {/* ── 머리 아이콘 (2026-10-01) ────────────────────────────────────────────
            요구: "설정, 변경파일이력 모두 에이젼트 패널 타이틀에 아이콘으로ogi로 ding을
            제공하고 각 메뉴 선택시 대화창 처럼 출력화면 안에 블럭화 하여 내용을 보여준다.
            기존 설정과 , 변경검토 패널은 삭제를 한다."

            왜 **제목에** 두나: 이 앱의 첫 화면은 대화다. 설정을 찾으러 **다른 패널로
            가면** 문맥이 끊긴다. 제목을 클릭해 대화 안에 블록으로 열면 "무엇을
            설정하려다가 무엇을 봤나" 가 한 스크롤로 이어진다.

            **글자 대신 아이콘을 쓴 이유**: 머리는 24px 두께다. "설정 · 변경 검토" 라고
            적으면 agent · terminal · log 머리가 전부 말하는 화면이 된다 — 옆 패널
            머리와 **같은 문법**을 써야 읽힌다. 그래서 아이콘 + `aria-label` + `title`
            (M8: 이름을 가진 조작 요소는 **이름**이 있어야 한다).

            아이콘 글자는 **도형**이 아니라 라벨을 축약한 것이라 화면 판독기에는
            의미가 없다. 그래서 `aria-label` 을 준다. */}
        <span style={{ display: "flex", gap: 2 }} role="group" aria-label="보기">
          <IconButton label="설정" glyph="⚙" onClick={() => onOpenView("settings")} />
          <IconButton label="변경 검토" glyph="⎇" onClick={() => onOpenView("diff")} />
          <IconButton label="디렉터리" glyph="▤" onClick={() => onOpenView("dirs")} />
        </span>
        <span style={{ width: 1, height: 14, background: "#30363d" }} />
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

      {/* ── 대화 묶음 (2026-10-01) ─────────────────────────────────────────────
          요구: "프롬프트 입력의 출력창은 마치 메신저 대화창 처럼 동작이 되는거야
          답변은 하나의 묶음인거고 파일을 여는것, DIFF 해주는거, 쉘을 구동하거나
          도구를 구동하는 것 모두 하나의 대화 덩어리처럼 보여주고 필요시 오토 스크롤과
          펼침과 닫힘을 제공해야"

          즉 **묶음의 경계는 사람이 보낸 말**이고, 그 뒤의 사고·답변·도구·파일 열람이
          전부 그 안에 든다. `groupTurns` 가 정본이라 화면과 세션 저장이 같은 경계를 쓴다.

          **오토 스크롤은 "맨 아래에 있을 때만"** 한다. 사용자가 위로 스크롤 중인데
          새 델타가 오면 계속 끌려 내려가면 읽던 곳을 빼앗긴다(§11.3: "멈춘 것처럼
          보이지 않는다" 의 반대 — 사용자가 못 읽는다). 지금 위치가 바닥에 가까우면
          따라가고, 아니면 **"아래에 새 내용"** 배지를 띄운다. */}
      <div
        ref={scroller}
        onScroll={() => setPinned(nearBottom(scroller.current))}
        style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "4px 6px" }}
      >
        {blocks.length === 0 && !running && (
          <div style={{ color: "#6e7681", fontSize: 11 }}>아직 메시지가 없습니다. 입력창에 지시하십시오.</div>
        )}

        {turns.map((turn, ti) => {
          const last = ti === turns.length - 1;
          const open = last ? true : collapsed[ti] === false;
          return (
            <div
              key={turn.at + "-" + ti}
              className="elev-1"
              style={{
                marginBottom: 8,
                border: "1px solid #21262d",
                borderRadius: 6,
                overflow: "hidden",
                background: "#0d1117",
              }}
            >
              {/* 묶음 머리 — **사람이 한 말**과 그 묶음이 한 일. 이것이 접기 기준. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  background: "#161b22",
                  borderBottom: open ? "1px solid #21262d" : 0,
                  fontSize: 11,
                }}
              >
                {turn.prompt ? (
                  <button
                    type="button"
                    onClick={() => toggle(ti)}
                    aria-expanded={open}
                    style={{
                      flex: 1, minWidth: 0, textAlign: "left",
                      background: "none", border: 0, color: "#c9d1d9",
                      cursor: "pointer", font: "inherit", fontSize: 11,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ color: "#6e7681" }}>{open ? "▾" : "▸"}</span> {turn.prompt}
                  </button>
                ) : (
                  <span style={{ flex: 1, color: "#6e7681", fontSize: 10 }}>이전 대화</span>
                )}
                <span style={{ color: "#6e7681", fontSize: 10, whiteSpace: "nowrap" }}>{turn.summary}</span>
                <span style={{ color: "#484f58", fontSize: 10, whiteSpace: "nowrap" }}>
                  {new Date(turn.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                </span>
                {turn.prompt && (
                  <button
                    type="button"
                    onClick={() => toggle(ti)}
                    aria-label={open ? "묶음 접기" : "묶음 펼치기"}
                    style={{ background: "none", border: 0, color: "#6e7681", cursor: "pointer", font: "inherit", fontSize: 10 }}
                  >
                    {open ? "접기" : "펼치기"}
                  </button>
                )}
              </div>

              {open && (
                <div style={{ padding: "6px 8px" }}>
                  {turn.blocks.map((b) => (
                    <div key={b.id} style={{ marginBottom: 6 }}>
                      <BlockBody block={b} client={client} viewExtra={viewExtra} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {running && <ThinkIndicator state={think} style={style} />}

        {/* **읽고 있는데 새 내용이 온다** — 조용히 끌지 않는다. */}
        {!pinned && (
          <button
            type="button"
            onClick={() => scrollToBottom(scroller.current)}
            style={{
              position: "sticky", bottom: 4, left: 0, margin: "0 auto", display: "block",
              background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d",
              borderRadius: 12, padding: "2px 10px", cursor: "pointer", font: "inherit", fontSize: 10,
            }}
          >
            ↓ 아래에 새 내용
          </button>
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}

/** 블록 하나를 그린다. 묶음 안에서 재사용되므로 **독립 컴포넌트** 다. */
function BlockBody({
  block: b,
  client,
  viewExtra,
}: {
  block: AgentBlock;
  client?: ApiClient;
  viewExtra?: { settings?: React.ReactNode };
}) {
  if (b.kind === "user") {
    return (
      <div style={{ color: "#c9d1d9", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {b.text}
      </div>
    );
  }
  if (b.kind === "reasoning") {
    return (
      <details open style={{ borderLeft: "2px solid #d29922", paddingLeft: 6 }}>
        <summary style={{ cursor: "pointer", fontSize: 10, color: "#d29922" }}>
          사고 {b.text.length.toLocaleString("ko-KR")}자
        </summary>
        <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", font: "11px/1.5 ui-monospace, monospace", color: "#8b949e" }}>
          {b.text}
        </pre>
      </details>
    );
  }
  if (b.kind === "text") {
    return (
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.6 system-ui, sans-serif", color: "#c9d1d9" }}>
        {b.text}
      </pre>
    );
  }
  if (b.kind === "status") return <div style={{ color: "#6e7681", fontSize: 11 }}>· {b.text}</div>;
  if (b.kind === "error") return <div style={{ color: "#f85149", fontSize: 11 }}>오류: {b.text}</div>;
  return <ToolBlock block={b} client={client} extra={viewExtra} />;
}

/** 스크롤이 바닥에 얼마나 가까운가. 40px 안이면 "붙어 있다" 고 본다. */
function nearBottom(el: HTMLElement | null): boolean {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function scrollToBottom(el: HTMLElement | null): void {
  el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
}

/** 델타 한 개로 think 상태를 갱신한다(예산 초과 시 강제 전환은 여기서 일어난다). */
export function thinkAfterDelta(s: ThinkState, d: { reasoning?: string; text?: string }): ThinkState {
  return ingest(s, d);
}

export { initialThink, finish };
