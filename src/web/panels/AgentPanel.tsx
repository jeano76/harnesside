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
/**
 * 머리 조작: **이름을 **글자로** 보여준다**(2026-10-01).
 *
 * 예전엔 아이콘만 있었다(`aria-label` + `title`). 그런데:
 *  - `title` 은 **마우스를 올려야** 보인다. 키보드 사용자는 **아예 못 본다.**
 *  - `⎇`(변경 검토)와 `▤`(디렉터리)는 **도형이 아니라 임의 기호**다. 첫 사용자는
 *    무엇인지 알 수 없다 — `⚙` 만도 마찬가지.
 *
 * 그래서 **항상 보이는 짧은 라벨**을 함께 둔다. 아이콘은 위치를 잇는 보조로 남는다.
 * 폭이 문제면 **지금 열려 있는 것 하나만** 라벨을 보여준다 — 지금 어디에 있는지가
 * 가장 자주 필요한 정보라 남은 폭에 들어가고, 나머지는 아이콘 + `aria-label` 이 받는다.
 *
 * `labelHidden`(지금 열린 항목)를 생략하면 **항상 라벨** — 그래야 검사가
 * "이름이 보인다" 를 확인할 수 있다. 숨긴 항목은 `aria-label` 로 이름이 남는다.
 */
function IconButton({
  label,
  glyph,
  onClick,
  active,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
  /** 지금 열려 있는가. */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      style={{
        // **열려 있으면 배경이 있다** — "어디에 있나" 를 색이 말하게 한다.
        // 색만 바꾸지 않는다: 색을 못 보는 사람이 있으므로 **배경과 밑줄**도 함께 준다.
        background: active ? "#30363d" : "none",
        border: 0,
        borderBottom: active ? "1px solid #58a6ff" : "1px solid transparent",
        color: active ? "#c9d1d9" : "#8b949e",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        font: "inherit",
        fontSize: 11,
        lineHeight: 1.4,
        padding: "1px 5px",
        borderRadius: 4,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 12 }}>
        {glyph}
      </span>
      {label}
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
  onExample,
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
  /** 빈 상태의 예시를 **입력창에 채운다**(보내지는 않는다 — 사용자가 고쳐서 보낸다). */
  onExample: (text: string) => void;
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
   * **지금 열려 있는 뷰** — 머리 아이콘이 자기를 밝히는 근거(2026-10-01).
   *
   * 왜 블록에서 읽나: `openView` 가 **마지막 블록에 `view` 를 남기는 것**이 진본이다.
   * 화면이 별도 상태를 들면 **어긋난다** — 열었는데 아무것도 안 밝거나, 안 열었는데
   * 밝거나. "지금 어디에 있나" 를 모르면 사용자는 세 아이콘 중 무엇이 눌린 상태인지
   * 몰라 같은 것을 또 눌러 화면을 쌓는다(실측: 같은 설정이 두 번 쌓임은 `openView` 가
   * 막기 전 실제 있었다).
   *
   * **뒤에서부터** 찾는다 — 열림은 항상 **맨 뒤**에 있으므로 앞에서 찾으면 닫힌 뷰를
   * "열려 있다" 고 착각한다.
   */
  const openWhat = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const v = blocks[i]!.view;
      if (v) return v.what;
    }
    return undefined;
  }, [blocks]);

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
            요구(원문, 옮기면서 글자가 깨졌던 것을 읽히게 고침):
            "설정, 변경파일이력 모두 에이젼트 패널 타이틀에 아이콘으로 docking을
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
          <IconButton label="설정" glyph="⚙" active={openWhat === "settings"} onClick={() => onOpenView("settings")} />
          <IconButton label="변경 검토" glyph="⎇" active={openWhat === "diff"} onClick={() => onOpenView("diff")} />
          <IconButton label="디렉터리" glyph="▤" active={openWhat === "dirs"} onClick={() => onOpenView("dirs")} />
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
        {blocks.length === 0 && !running && <FirstRun onPick={onExample} />}

        {/* ── 많은 묶음 요약 (2026-10-01) ───────────────────────────────────────────
            실측: 복원된 대화(211블록)가 **끝없이 이어지는 벽**으로 보였다. 묶음별로
            접을 수는 있지만 그것을 하나씩 해야 하고, 사용자는 **무엇을 하나씩 접어야
            하는지조차 모른다.** 211블록이면 몇 묶음인지도 화면에 말돼 있지 않다.

            그래서 묶음이 **많을 때만** 요약을 맨 위에 둔다:
            - **몇 묶음 · 몇 블록**인지 — 벽의 크기를 알 수 있어야 방향이 잡힌다.
            - **전체 접기 / 펼치기** — 하나씩이 아니라 한 번에.
            - 접어도 **마지막 묶음은 항상 펼친다** — 진행 중인데 접으면 안 된다는
              기존 규칙과 같다. 여기서도 어기지 않는다.

            묶음이 적으면 **숨긴다** — 요약줄이 벽보다 더 거슬리면 그게 더 나쁘다. */}
        {turns.length > COLLAPSE_AT && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 6px",
              marginBottom: 6,
              border: "1px solid #21262d",
              borderRadius: 6,
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
        {turns.map((turn, ti) => {
          const last = ti === turns.length - 1;
          // **초기값이 `undefined` 인데 `=== false` 로 "펼침" 을 검사하고 있었다**
          // (2026-10-01 실측). 그래서 **처음부터 모든 이전 묶음이 닫힘**으로 그려지고,
          // 사용자가 "펼치기" 를 눌러도 계속 닫혀 있었다 — 닫힘에서 펼침으로 **전이가 안 된다**.
          // `!== true` 가 맞다: 명시적으로 접은 것(`true`)만 닫힌 것으로 본다.
          //
          // **기본은 펼침**이어야 한다 — 대화는 사용자가 쌓아온 것이고, 처음부터 접혀
          // 있으면 "내 대화가 어디 갔나" 를 해결하려면 **전부 펼치기** 를 눌러야 한다.
          const open = last ? true : collapsed[ti] !== true;
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
