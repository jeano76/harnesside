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
import { animationFor, initialThink, ingest, finish, thinkNotice, type ThinkState, type ThinkStyle } from "../agent/think.js";
// 블록 규칙의 **정본**은 여기다. 이 파일은 그려 줄 뿐이다(두 곳에 판단을 두면 어긋난다).
import { appendToBlock, applyEvent, groupTurns, type AgentBlock } from "../../session/blocks.js";
import type { ApiClient } from "../api.js";
import { ToolBlock } from "./ToolBlock.js";
import { Markdown } from "./Markdown.js";
import { Ide } from "./Ide.js";
import { useI18n } from "../i18n/index.js";
import type { Toast } from "./notify.js";

export const THINK_STYLES: { id: ThinkStyle; label: string; hint: string }[] = [
  { id: "dots", label: "파동 점", hint: "기본. 생각 중임을 짧게 알립니다" },
  { id: "pulse", label: "고동", hint: "한 점이 밝아졌다 어두워집니다" },
  { id: "orbit", label: "공전", hint: "가장 눈에 띕니다" },
  { id: "shimmer", label: "번짐", hint: "글 흐름에 은은한 빛" },
  { id: "bar", label: "막대", hint: "움직임 없음. prefers-reduced-motion 에 적합" },
];

export type { AgentBlock };
export { applyEvent, appendToBlock };

/**
 * 첫 실행 빈 상태 (§11.3: 빈 화면은 결함이다).
 *
 * 실측(2026-10-01): 이 자리가 화면에서 **가장 넓은 면**인데, 한 줄 글자로만 채워져 있었다
 * (`아직 메시지가 없습니다. 입력창에 지시하십시오.`). `verify-window.mjs` 의 "빈 상태가
 * 채워짐" 검사가 **실패**했다 — 요구(§11.3)를 어기는 것이었는데, "빈 화면" 이라는
 * 표현이 "글자가 하나 있다" 면 충분하다고 착각해서 왔다.
 *
 * 첫 사용자가 **무엇을 할 수 있는지** 알 수 없으면 무엇이든 시도하지 않는다. 그래서:
 *  - 무엇을 하는지 한 문장
 *  - **누를 수 있는** 예시 3개 (복사하지 말고 버튼)
 *  - 키보드 힌트 (Enter 전송 / Shift+Enter 줄바꿈 / Ctrl+K 명령)
 *
 * 예시를 **텍스트로만** 적지 않는 이유는 "읽고 직접 타이핑" 을 요구하기 때문이다 —
 * 빈 화면의 목적은 "시작하기" 를 한 번의 클릭으로 줄이는 것이다.
 */
/**
 * 이만큼 묶이면 **요약줄을** 보여준다 (2026-10-01).
 *
 * 수를 **왜** 8으로 정했는지는 측정하지 않았다 — 대신 **기준**을 적어 둔다:
 * 화면 높이를 넘기기 시작하는 정도면 사용자는 스크롤바를 찾고, 각 묶음을 하나씩
 * 접으려면 화면을 먼저 훑어야 하는데 **무엇을 접어야 하는지 그 벽 안에서 모른다.**
 * 그래서 "한 화면에 다 보이지 않을 만큼" 을 넘어가는 지점을 넘어서 생기는 불편을
 * 없애는 최소치로 잡는다. 이 값이 맞는지 확인하지 않았으므로 **기준을 바꿔야 한다면
 * 바꿔도 된다** — 다만 바꾸는 근거는 "벽이 사라졌어야" 가 아니라 "이 숫자 이후에
 * 불편했다" 여야 한다.
 */
const COLLAPSE_AT = 8;

const EXAMPLES = [
  "이 저장소의 구조를 한 문단으로 설명해 주세요",
  "최근 변경 파일을 찾아 Likely 버그를 하나만 골라 주세요",
  "테스트를 실행하고 실패한 것만 정리해 주세요",
];

function FirstRun({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div style={{ display: "grid", gap: 10, padding: "12px 4px", maxWidth: 620 }}>
      <div style={{ fontSize: 12, color: "#c9d1d9" }}>
        여기서 지시를 입력하면 이 저장소에서 에이전트가 직접 일합니다.
      </div>
      <div style={{ fontSize: 11, color: "#6e7681" }}>
        아래 예시 중 하나를 누르면 입력창에 채워집니다 — 바로 보낼 수도, 고쳐서 보낼 수도 있습니다.
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {EXAMPLES.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => onPick(e)}
            style={{
              textAlign: "left",
              background: "#161b22",
              color: "#c9d1d9",
              border: "1px solid #30363d",
              borderRadius: 6,
              padding: "6px 10px",
              cursor: "pointer",
              font: "inherit",
              fontSize: 12,
            }}
          >
            {e}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "#6e7681", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span>Enter 전송</span>
        <span>Shift+Enter 줄바꿈</span>
        <span>Ctrl+K 명령</span>
        <span>설정·변경검토는 위 아이콘</span>
      </div>
    </div>
  );
}

/**
 * 알림 센터 — 우하단 토스트의 대화창 미러 (별도 UI 요소).
 * 토스트는 TTL 후 사라지지만 목록은 남는다. 오류는 빨강, 정보는 회색.
 * 닫아도 토스트 타이머와 무관 — 이미 본 것은 다시 세지 않는다.
 */
function NoticeBell({ notices, onDismiss }: { notices?: Toast[]; onDismiss?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const items = notices ?? [];
  if (items.length === 0) return null;
  const errors = items.filter((n) => n.kind === "error").length;
  return (
    <span style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`알림 ${items.length}개 보기`}
        title="알림 센터 (우하단 알림과 같은 내용)"
        style={{ background: "none", border: 0, color: errors > 0 ? "#f85149" : "#8b949e", cursor: "pointer", font: "inherit", fontSize: 11 }}
      >
        🔔 {items.length}
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 30, width: 300, maxHeight: 260, overflow: "auto", background: "#161b22", border: "1px solid #30363d", borderRadius: 6, padding: 6, display: "grid", gap: 6 }}>
          {items.map((n) => (
            <div key={n.id} style={{ borderLeft: `2px solid ${n.kind === "error" ? "#f85149" : n.kind === "warn" ? "#d29922" : "#58a6ff"}`, paddingLeft: 6 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <span style={{ fontSize: 11, color: "#c9d1d9", fontWeight: 700, flex: 1 }}>{n.title}</span>
                {onDismiss && (
                  <button type="button" aria-label={`${n.title} 닫기`} onClick={() => onDismiss(n.id)} style={{ background: "none", border: 0, color: "#6e7681", cursor: "pointer", font: "inherit", fontSize: 10 }}>
                    ✕
                  </button>
                )}
              </div>
              <div style={{ fontSize: 10, color: "#8b949e" }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * 압축 진행·결과 — 시작과 끝을 화면이 말한다 (사용자 요구).
 * 압축 중에는 "멈춘 것처럼" 보이면 안 되고, 끝나면 "무엇이 잊혀지고
 * 무엇이 남았는지" 를 보여준다. 요약 본문까지 접어서 둔다.
 */
export interface CompactionView {
  phase: "running" | "complete" | "failed";
  droppedCount?: number;
  droppedTokens?: number;
  keptCount?: number;
  keptTokens?: number;
  summary?: string;
  droppedPreview?: string[];
}

function CompactionBanner({ info, onClose }: { info: CompactionView; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  if (info.phase === "running") {
    return (
      <div role="status" style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 8px", fontSize: 11, color: "#d29922", borderBottom: "1px solid #30363d" }}>
        <span aria-hidden="true">◌</span>
        <span>압축 중… 대화 기록을 정리합니다 (체크포인트는 저장됨)</span>
      </div>
    );
  }
  if (info.phase === "failed") {
    return (
      <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 8px", fontSize: 11, color: "#f85149", borderBottom: "1px solid #30363d" }}>
        <span aria-hidden="true">✗</span>
        <span style={{ flex: 1 }}>압축 실패 — 체크포인트는 저장됐고 현재 대화로 계속합니다</span>
        <button type="button" onClick={onClose} aria-label="압축 알림 닫기" style={{ background: "none", border: 0, color: "#6e7681", cursor: "pointer", font: "inherit" }}>✕</button>
      </div>
    );
  }
  return (
    <div style={{ borderBottom: "1px solid #30363d", fontSize: 11 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 8px" }}>
        <span aria-hidden="true" style={{ color: "#3fb950" }}>✓</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ background: "none", border: 0, color: "#c9d1d9", cursor: "pointer", font: "inherit", textAlign: "left", flex: 1 }}
        >
          압축 완료 — {info.droppedCount ?? "?"}개 메시지({(info.droppedTokens ?? 0).toLocaleString("ko-KR")} 토큰)를 요약으로, {info.keptCount ?? "?"}개 유지
        </button>
        <button type="button" onClick={onClose} aria-label="압축 알림 닫기" style={{ background: "none", border: 0, color: "#6e7681", cursor: "pointer", font: "inherit" }}>✕</button>
      </div>
      {open && (
        <div style={{ padding: "0 8px 6px 22px", display: "grid", gap: 4 }}>
          {info.summary && (
            <div style={{ color: "#c9d1d9", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{info.summary}</div>
          )}
          {info.droppedPreview && info.droppedPreview.length > 0 && (
            <div style={{ color: "#6e7681", fontSize: 10 }}>
              <div>잊혀진 내용:</div>
              {info.droppedPreview.map((p, i) => (
                <div key={i}>· {p}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkIndicator({ state, style, notice }: { state: ThinkState; style: ThinkStyle; notice?: { short: string; title: string } | null }) {
  const anim = animationFor(style);
  // 꺼져 있으면 표시줄 자체가 없다 — 단, 예산 안내가 있으면 그 한 줄은 보인다.
  if (!state.enabled && !notice) return null;
  const used = state.usedTokens.toLocaleString("ko-KR");
  const cap = state.maxReasoningTokens.toLocaleString("ko-KR");
  // **한 줄로 합친다.** 예전엔 `Thinking · N 토큰` 줄과 `추론 예산 곧 초과 (N/M·추정)` 줄이
  // 따로 있어 같은 숫자가 두 번 보였다. 현재/최대 쌍은 이 한 곳에만 둔다.
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 6, color: "#6e7681", fontSize: 11 }}
      {...(notice ? { title: notice.title } : {})}
    >
      {state.enabled && anim.dots > 0 && (
        <span style={{ display: "inline-flex", gap: 3 }}>
          {Array.from({ length: anim.dots }).map((_, i) => (
            <span
              key={i}
              className="think-dot"
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: "#d29922",
                animationDuration: `${anim.durationMs}ms`,
                animationDelay: `${i * 160}ms`,
              }}
            />
          ))}
        </span>
      )}
      <span>
        Thinking · {used}/{cap} 토큰(추정){notice ? ` — ${notice.short}` : ""}
      </span>
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
/**
 * **이 자리에는 조작 버튼이 없다** (2026-10-01).
 *
 * 예전에 `IconButton` 이 여기 있었다. **IDE 액티비티바**(`Ide` 의 `activity`)가 같은
 * 일을 하므로 **죽은 코드가 됐다** — 고치지 않고 두면 "같은 일을 두 곳에 둔다" 가 되고,
 * 어느 쪽이 진짜인지 알 수 없다. **지운 것**이 낫다.
 */


export function AgentPanel({
  blocks,
  running,
  think,
  onCancel,
  client,
  onExample,
  // 상태바용 — 셸이 준다(§`Ide` 의 `status`). 여기서 WS 를 붙들지 않는다.
  wsState,
  context,
  /** `view` 블록이 그릴 내용. 설정 패널처럼 **무거운 것**은 셸이 주입한다 —
   *  이 컴포넌트가 그 화면을 아는 것이 아니라 **무엇을 그릴지 알기만 하면** 되므로. */
  viewExtra,
  // 뷰 열기/닫기 — 헤더 ⚙ 아이콘과 **같은 규칙**(`toggleView`)을 블록 안에서도 쓴다.
  onToggleView,
  onCloseView,
  onToggleBlock,
  /** 편집기로 파일을 연다(경로 하나). 없으면 파일 미리보기에 `편집` 버튼이 없다. */
  onEditFile,
  // 설정은 상단 우측 ⚙ 아이콘(셸 헤더)으로 연다 — 측면 아이콘은 두지 않는다.
  // 열 곳이 하나뿐이므로 "어느 쪽이 진짜인가" 가 생기지 않는다.
  // 승인 게이트처럼대화 위에 떠야 하는 것(§8.2) — 별도 패널이 아니라 대화 본문 위에서만 그린다.
  overlay,
  notices,
  onDismissNotice,
  compaction,
  onDismissCompaction,
}: {
  blocks: AgentBlock[];
  running: boolean;
  think: ThinkState;
  onCancel: () => void;
  /** 빈 상태의 예시를 **입력창에 채운다**(보내지는 않는다 — 사용자가 고쳐서 보낸다). */
  onExample: (text: string) => void;
  /**
   * 상태바용 — 연결 상태와 컨텍스트 (§`Ide` 의 `status`).
   *
   * **셸이 준다.** 이 컴포넌트가 WS 를 직접 붙들면 **소켓이 두 개** 생기고 재연결이
   * 두 배가 된다(실측: 이미 그렇게 사고가 났고, 로그가 "창 연결이 끊어졌습니다" 를
   * 두 번 찍었다). 그래서 **읽기만** 받는다.
   */
  wsState?: "connecting" | "open" | "closed";
  /** 컨텍스트 사용량 — 상태바에 사는 값(§11.3: 모르는 것을 아는 것처럼 보이지 않는다). */
  context?: { usedTokens: number; totalTokens: number } | null;
  /** 도구 블록이 에디터·셸을 **그 자리에서** 그리기 위해 필요. */
  client?: ApiClient;
  /** `view` 블록이 그릴 설정. **셸이 대상을 알고** 있다. 설정만 남긴다. */
  viewExtra?: { settings?: React.ReactNode };
  /**
   * 뷰를 **토글**한다 — 헤더 ⚙ 아이콘과 **같은 규칙**(`toggleView`)이다.
   * 경로마다 따로 만들면 "아이콘에서는 닫히는데 블록에서는 쌓인다" 가 된다.
   * 웹 창은 헤더 아이콘 하나뿐이라 블록 안에서도 그것을 쓴다.
   */
  onToggleView?: () => void;
  /** 특정 뷰 블록을 접는다(블록 안의 ✕). 메시지를 지우지 않는다 — 되돌릴 수 있어야 한다. */
  onCloseView?: (block: AgentBlock) => void;
  /** 슬래시 결과 블록 하나를 접고 편다. */
  onToggleBlock?: (block: AgentBlock) => void;
  /** 파일 미리보기의 `편집` → 편집기로 연다. 경로만 전달한다(열고 닫는 책임은 `main.tsx`). */
  onEditFile?: (path: string) => void;
  // 승인 게이트처럼대화 위에 떠야 하는 것 (§8.2). 별도 패널이 아니라 대화 본문 위에서만 그린다.
  // Ide 로 그대로 넘긴다 — 흐름을 가리되 스크롤로 이어지게.
  overlay?: React.ReactNode;
  /**
   * 우하단 토스트의 대화창 미러 — 별도 UI 요소(사용자 요구).
   * 토스트는 TTL 후 사라지지만, 오류는 여기서 다시 볼 수 있어야 한다.
   * 읽기만 받는다(WS·타이머는 셸이 들고 있다).
   */
  notices?: Toast[];
  onDismissNotice?: (id: string) => void;
  /** 압축 진행·결과 — 별도 UI 요소. 읽기만 받는다. */
  compaction?: CompactionView | null;
  onDismissCompaction?: () => void;
}) {
  const style: ThinkStyle = think.style;
  /**
   * 예산 초과 안내 — **판정과 문구를 `thinkNotice` 에 맡긴다.**
   *
   * 예전엔 이 자리에서 라벨 문자열을 직접 적었다. 그것이 틀린 말을 했다(사용자가 지적).
   * 문자열을 여기서 직접 관리하는 한, 다음turnstile에도 같은 착각이 반복된다.
   */
  const budgetNotice = thinkNotice(think, running);
  const bottom = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** **맨 아래에 붙어 있는가.** 이 값이 오토 스크롤의 조건이다. */
  const [pinned, setPinned] = useState(true);
  /** 접은 묶음의 인덱스. **마지막 묶음은 항상 펼친다** — 진행 중인데 접으면 안 된다. */
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const turns = useMemo(() => groupTurns(blocks), [blocks]);
  const toggle = (i: number) => setCollapsed((c) => ({ ...c, [i]: c[i] !== true }));
  /**
   * **전체 접기 / 펼치기**(2026-10-01).
   *
   * `collapsed[i] === false` 이 "펼친" 뜻이므로, 접으려면 **모두 true** 로 만든다.
   * 상태를 **한 값**으로 채우지 않고 전부 덮어써야 새 묶음도 같은 상태를 따른다 —
   * 개별 값을 계산해서 넣으면 새 대화가 붙을 때마다 규칙이 갈린다.
   *
   * **마지막 묶음은 `open` 계산에서 항상 펼친다**(아래). 그래서 여기서 접어도
   * 진행 중인 묶음이 보이지 않는 일은 없다 — 어기지 않는다.
   */
  const setAllCollapsed = (closed: boolean) => {
    setCollapsed(Object.fromEntries(turns.map((_, i) => [i, closed])));
  };

  /**
   * 측면 액티비티바는 두지 않는다 (사용자 지정: 설정은 상단 우측 ⚙ 아이콘으로 연다).
   * `openWhat` 같은 별도 선택 상태도 들지 않는다 — "지금 어디에 있나" 를 모르면
   * 같은 것을 또 누르게 된다는 문제는, 열 곳이 하나뿐이면 생기지 않는다.
   * 설정 블록 자체는 대화 안에 열린다(`viewExtra.settings`).
   */

  useEffect(() => {
    // **붙어 있을 때만** 따라간다. 안 그러면 읽던 곳을 빼앗긴다.
    if (pinned) scrollToBottom(scroller.current);
  }, [blocks.length, blocks[blocks.length - 1]?.text.length, pinned, turns.length]);

  // 새 턴이 시작되면 마지막 지점으로 먼저 간다 (사용자 요구).
  // 읽던 중이었어도 새 출력이 시작됐다는 사실이 더 중요하다 — 배지는 턴 중간
  // 스크롤업에만 쓴다.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running && !wasRunning.current) {
      setPinned(true);
      scrollToBottom(scroller.current);
    }
    wasRunning.current = running;
  }, [running]);

  // thinking 은 **기본 ON** 이다(사용자 지정, 2026-10-04) — "켜면 예산을 통째로 쓸 수 있습니다" /
  // "상한을 넘어 thinking 을 끄고 도구 호출을 강제합니다" 안내는 상시 소음이라 **표시하지 않는다**.
  // 상한 초과 시의 동작(강제 도구 호출)은 그대로이고 `think` 상태·테스트도 그대로다 — 화면만 조용하다.
  const warnings = useMemo<string[]>(() => [], []);
  /** 패널 제목은 카탈로그에서 — 하드코딩하면 M9 누락이 조용히 남는다. */
  const t = useI18n();

/**
 * 뷰 라벨은 한 곳에만 둔다. 탭에 직접 적으면 뷰가 늘 때마다 여러 곳을 고쳐야 하고
 * 하나가 반드시 어긋난다. 새 view.what을 추가하면 여기 키도 추가한다.
 */

  return (
    <Ide
      overlay={overlay}
      activity={[]}
      status={[
        { text: wsState === "open" ? "\u25CF 실시간" : wsState === "connecting" ? "\u25CB 연결 중" : "\u25B2 끊김", tone: wsState === "open" ? "good" : wsState === "connecting" ? "warn" : "error", title: "WebSocket 연결 상태" },
        // **모르면 모른다고 쓴다** — 0 으로 두지 않는다. 0 은 "안 쓴다" 로 읽힌다.
        ...(context
          ? [{ text: `컨텍스트 ${context.usedTokens.toLocaleString("ko-KR")} / ${context.totalTokens.toLocaleString("ko-KR")}`, tone: context.usedTokens / context.totalTokens > 0.8 ? ("warn" as const) : ("normal" as const) }]
          : [{ text: "컨텍스트 \u2014", title: "작업 중이 아니면 측정되지 않습니다" }]),
        ...(running ? [{ text: "실행 중", tone: "warn" as const }] : []),
        { text: `묶음 ${turns.length}` },
      ]}
    >
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* 스타일/토글 — §5.3 의 선택지. 숨기면 "생각이 왜 안 보이냐" 를 답할 수 없다. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderBottom: "1px solid #30363d", flexWrap: "wrap" }}>
        {/* ── 머리 아이콘 → **IDE 액티비티바** 로 옮겼다 (2026-10-01) ────────────────
            요구(원문, 옮기면서 글자가 깨졌던 것을 읽히게 고침):
            "설정, 변경파일이력 모두 에이젼트 패널 타이틀에 아이콘으로 docking을
            제공하고 각 메뉴 선택시 대화창 처럼 출력화면 안에 블럭화 하여 내용을 보여준다.
            기존 설정과 , 변경검토 패널은 삭제를 한다."

            **여기에도 두면 같은 일을 두 번 하게 된다** — VS Community 의 액티비티바가
            같은 역할(무엇을 여는지를 고르는 자리)을 한다. 한 곳에 모아야 "지금 어디에
            있는가" 를 **한 번만** 말할 수 있다. 두 곳에 있으면 하나가 어긋난다.

            **선택된 항목에만 이름을 보여준다** — 아이콘만 두면 첫 사용자가 무엇인지
            모르고, 키보드 사용자는 아예 못 본다. */}

        <span style={{ width: 1, height: 14, background: "#30363d" }} />
        <span style={{ fontSize: 10, color: "#8b949e" }}>Thinking</span>
        <span style={{ flex: 1 }} />
        {running && (
          <button type="button" onClick={onCancel} style={{ background: "#21262d", color: "#f85149", border: "1px solid #30363d", borderRadius: 4, font: "inherit", fontSize: 10, padding: "1px 6px", cursor: "pointer" }}>
            취소
          </button>
        )}
        <NoticeBell notices={notices} onDismiss={onDismissNotice} />
      </div>

      {warnings.length > 0 && (
        <div style={{ padding: "3px 6px", color: "#d29922", fontSize: 10, borderBottom: "1px solid #30363d" }}>
          {warnings.join(" ")}
        </div>
      )}

      {compaction && onDismissCompaction && (
        <CompactionBanner info={compaction} onClose={onDismissCompaction} />
      )}

      {/* ── 묶음 요약 · 전체 접기/펼치기 — **스크롤 밖**에 둔다 (사용자 요구) ──────
          요구: "1개 대화 묶음 · 1개 항목 / 전체 접기 / 전체 펼치기 이 영역은 화면
          이동안되게 고정해주고 스크롤은 이 영역 아래부터 진행".

          왜 스크롤 **안**에 두면 안 되나: 대화가 길어지면 이 줄이 화면 위로 사라지고
          "전체 접기" 로 한 번에 정리하는 유일한 자리가 사라진다 — 가장 필요할 때
          가장 먼저 안 보인다. 스크롤 밖(형제)이면 **항상** 보인다.

          요구 원문(벽 대응, 2026-10-01): 복원된 대화(211블록)가 끝없이 이어지는 벽으로
          보였다. 묶음별로 하나씩 접어야 하고 무엇을 접어야 하는지도 모른다. 그래서:
          - **몇 묶음 · 몇 항목**인지 — 벽의 크기를 알아야 방향이 잡힌다.
          - **전체 접기 / 펼치기** — 하나씩이 아니라 한 번에.
          - 접어도 **마지막 묶음은 항상 펼친다**(진행 중인데 접으면 안 된다).
          컨트롤은 **항상 보인다**(VS 처럼) — 있다가 없어지면 기능을 잃었다고 읽힌다. */}
      {turns.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: "0 0 auto",
            padding: turns.length > COLLAPSE_AT ? "3px 6px" : "2px 6px",
            background: "#0d1117",
            borderBottom: "1px solid #21262d",
            color: "#8b949e",
            fontSize: 11,
          }}
        >
          <span>
            {turns.length}개 대화 묶음 · {blocks.length}개 항목
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setAllCollapsed(true)}
            style={{
              background: "#21262d",
              color: "#c9d1d9",
              border: "1px solid #30363d",
              borderRadius: 4,
              font: "inherit",
              fontSize: 11,
              padding: "1px 7px",
              cursor: "pointer",
            }}
          >
            전체 접기
          </button>
          <button
            type="button"
            onClick={() => setAllCollapsed(false)}
            style={{
              background: "#21262d",
              color: "#c9d1d9",
              border: "1px solid #30363d",
              borderRadius: 4,
              font: "inherit",
              fontSize: 11,
              padding: "1px 7px",
              cursor: "pointer",
            }}
          >
            전체 펼치기
          </button>
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
        {blocks.length === 0 && !running && <FirstRun onPick={onExample} />}

        {turns.map((turn, ti) => {
          const last = ti === turns.length - 1;
          // **초기값이 `undefined` 인데 `=== false` 로 "펼침" 을 검사하고 있었다**
          // (2026-10-01 실측). 그래서 **처음부터 모든 이전 묶음이 닫힘**으로 그려지고,
          // 사용자가 "펼치기" 를 눌러도 계속 닫혀 있었다 — 닫힘에서 펼침으로 **전이가 안 된다**.
          // `!== true` 가 맞다: 명시적으로 접은 것(`true`)만 닫힌 것으로 본다.
          //
          // **기본은 펼침**이어야 한다 — 대화는 사용자가 쌓아온 것이고, 처음부터 접혀
          // 있으면 "내 대화가 어디 갔나" 를 해결하려면 **전부 펼치기** 를 눌러야 한다.
          const open = last && running ? true : collapsed[ti] !== true;
          return (
            <div
              key={turn.at + "-" + ti}
              className="elev-1"
              style={{
                marginBottom: 8,
                // 마지막(최신) 묶음은 하이라이트 — 어디가 최신인지 색+말로 말한다.
                border: last ? "1px solid #1f6feb" : "1px solid #21262d",
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
                {last && (
                  <span style={{ color: "#79c0ff", fontSize: 10, whiteSpace: "nowrap" }} title="가장 최근 출력">
                    {ti === turns.length - 1 && running ? "● 최신" : "최신"}
                  </span>
                )}
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
                      <BlockBody
                        block={b}
                        client={client}
                        viewExtra={viewExtra}
                        onToggleView={onToggleView}
                        onCloseView={onCloseView ? () => onCloseView(b) : undefined}
                        onToggleBlock={onToggleBlock ? () => onToggleBlock(b) : undefined}
                        onEditFile={onEditFile}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {running && (think.enabled || budgetNotice) && <ThinkIndicator state={think} style={style} notice={budgetNotice} />}

        {/* **읽고 있는데 새 내용이 온다** — 조용히 끌지 않는다. */}
        {!pinned && (
          <button
            type="button"
            onClick={() => scrollToBottom(scroller.current, true)}
            style={{
              position: "sticky", bottom: 4, left: 0, margin: "0 auto", display: "block",
              background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d",
              borderRadius: 999, padding: "2px 10px", cursor: "pointer", font: "inherit", fontSize: 10,
            }}
          >
            ↓ 아래에 새 내용
          </button>
        )}
        <div ref={bottom} />
      </div>
      </div>
    </Ide>
  );
}

/** 블록 하나를 그린다. 묶음 안에서 재사용되므로 **독립 컴포넌트** 다. */
function BlockBody({
  block: b,
  client,
  viewExtra,
  onToggleView,
  onCloseView,
  onToggleBlock,
  onEditFile,
}: {
  block: AgentBlock;
  client?: ApiClient;
  viewExtra?: { settings?: React.ReactNode };
  onToggleView?: () => void;
  onCloseView?: () => void;
  onToggleBlock?: () => void;
  onEditFile?: (path: string) => void;
}) {
  if (b.kind === "user") {
    return (
      <div style={{ borderLeft: "2px solid #79c0ff", paddingLeft: 6 }}>
        <div style={{ fontSize: 10, color: "#79c0ff", marginBottom: 1 }}>나</div>
        <div style={{ color: "#c9d1d9", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {b.text}
        </div>
      </div>
    );
  }
  if (b.kind === "reasoning") {
    return (
      <details open style={{ borderLeft: "2px solid #d29922", paddingLeft: 6 }}>
        <summary style={{ cursor: "pointer", fontSize: 10, color: "#d29922" }}>
          Thinking {b.text.length.toLocaleString("ko-KR")}자
        </summary>
        <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", font: "11px/1.5 ui-monospace, monospace", color: "#8b949e" }}>
          {b.text}
        </pre>
      </details>
    );
  }
  if (b.kind === "text") {
    // **마크다운을 IDE 테마로** (2026-10-01). 예전엔 `pre` 에 원문을 그대로 넣었다 —
    // 그래서 `**굵게**`, `` `코드` ``, `## 제목` 이 **기호 그대로** 보였다. 강조가
    // 없었다는 말이고 그건 **맞았다.** 파일 미리보기만 색이 있었고 대화 본문은
    // 플레인 텍스트였다.
    //
    // **사용자 발화(`kind === "user"`)는 그대로 둔다** — 사람이 쓴 원문이다.
    // 사용자가 마크다운 기호를 친 것이 아니라면 **그대로 보여야** 한다.
    return (
      <div style={{ margin: 0, wordBreak: "break-word" }}>
        <Markdown text={b.text} />
      </div>
    );
  }
  // 한 줄 상태는 그대로. 여러 줄 상태(재개 안내문·압축 보고 등)는 구조가 있는
  // 글이므로 Markdown 으로 그린다 — 평문으로 두면 수천 자 벽이 된다(실측).
  // 짧은 한 줄까지 Markdown 에 넣으면 앞의 `·` 약 속 표기가 문단으로 바뀌어
  // 로그 흐름이 끊기므로, 개행이 있을 때만 분기한다.
  if (b.kind === "status") {
    if (b.text.includes("\n")) {
      return (
        <div style={{ borderLeft: "2px solid #30363d", paddingLeft: 8, margin: "4px 0", wordBreak: "break-word" }}>
          <Markdown text={b.text} />
        </div>
      );
    }
    return <div style={{ color: "#6e7681", fontSize: 11 }}>· {b.text}</div>;
  }
  if (b.kind === "error") return <div style={{ color: "#f85149", fontSize: 11 }}>오류: {b.text}</div>;
  return (
    <ToolBlock
      block={b}
      client={client}
      extra={viewExtra}
      onToggleView={onToggleView}
      onCloseView={onCloseView}
      onToggleBlock={onToggleBlock}
      onEditFile={onEditFile}
    />
  );
}

/** 스크롤이 바닥에 얼마나 가까운가. 40px 안이면 "붙어 있다" 고 본다. */
function nearBottom(el: HTMLElement | null): boolean {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function scrollToBottom(el: HTMLElement | null, smooth = false): void {
  // 스트리밍 중에는 즉시 점프해야 한다. `smooth` 는 목표가 계속 움직이면
  // 애니메이션이 영원히 뒤처져 "완료된 뒤에야" 도착한다(실측).
  // 사용자가 배지를 눌렀을 때만 부드럽게 간다.
  el?.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

/** 델타 한 개로 think 상태를 갱신한다(예산 초과 시 강제 전환은 여기서 일어난다). */
export function thinkAfterDelta(s: ThinkState, d: { reasoning?: string; text?: string }): ThinkState {
  return ingest(s, d);
}

export { initialThink, finish };
