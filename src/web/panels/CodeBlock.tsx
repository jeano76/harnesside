/**
 * **코드 블록** — 파일 미리보기와 셸 출력이 **같은 것**으로 보인다 (2026-10-01).
 *
 * 왜 이것이 새 파일인가: 하이라이트 엔진(`editor/highlight.ts`)은 **이미 있었고**
 * 파일 미리보기가 쓰고 있었다. 셸 출력은 그것을 **쓰지 않았다** — 그래서 사용자는
 * 같은 프로그램 안에서 두 가지 다른 표면을 봤다:
 *
 *   파일 미리보기  줄번호 · 색 · 확장자 표시   ← IDE 처럼
 *   셸 출력        회색 글씨 한 덩어리         ← 평문
 *
 * 요구: "메시지 창이 IDE 처럼 색상과 인덴트 또는 양식등이 없어 — 강조나 diff 처럼
 * ide 기능이 제공이 되어야 하는데." 즉 **표면이 달라서는 안 된다.**
 *
 * 그래서 하이라이트를 **나 쓰지 않고** 기존 엔진에 붙인다. 규칙이 두 곳에 있으면
 * 곧 어긋난다 — 실제로 그랬다.
 *
 * ── 하지 않는 것 ────────────────────────────────────────────────────────────
 * **셸 출력을 "언어" 로 파싱하지 않는다.** `ls` 의 출력은 셸 문법이 **아니다.**
 * 명령줄(들어온 것)만 `shell` 로 하이라이트하고, **출력은 그대로 둔다** — 지어내면
 * 사용자가 화면을 믿지 못하게 된다.
 */

import React, { useMemo } from "react";
import { useFollowTail } from "./useFollowTail.js";
import { colorFor, tokenizeLine, type Language } from "../editor/highlight.js";
// 인덴트 가이드 — 규칙은 `editor/indentRules.ts`, 렌더는 `editor/IndentGuides.tsx`.
// FilePreview 와 **똑같은 방식**(코드 텍스트 안쪽, 상대 좌표)이라 두 화면의 선이 어긋나지 않는다.
import { IndentGuides } from "../editor/IndentGuides.js";
import { indentInfoFor } from "../editor/indentRules.js";
import { COLOR, FONT, LAYOUT, RADIUS, SPACE } from "../theme/tokens.js";

const DIM = COLOR.DIM_SUBTLE;
const BORDER = COLOR.BORDER;
const FG_BTN = COLOR.FG;
export interface CodeBlockProps {
  /**
   * 하이라이트할 언어. `null` 이면 **색을 칠하지 않는다.**
   *
   * **셸 출력에는 `null` 을 준다** — `ls` 의 출력은 셸 문법이 **아니다.** 색을 칠하면
   * 지어내는 것이 되고 사용자는 화면을 믿지 않게 된다. 하이라이트되는 것은
   * **들어온 명령줄** 뿐이고, 그것은 `command` 로 따로 준다.
   */
  lang: Language | null;
  /** **들어온 명령줄** — 이것만 하이라이트한다(셸 문법이므로). */
  command?: string;
  /** 코드/출력 본문. */
  text: string;
  /** 왼쪽 줄번호를 찍는다. */
  lineNumbers?: boolean;
  /** 접을 수 있게 한다 — 출력이 500줄이면 화면을 먹는다. */
  collapsible?: boolean;
  /** 접었을 때 보여줄 한 줄 요약(예: "셸 출력 128줄"). */
  summary?: string;
  /** 처음에 접혀 있을지. 기본 false — 결과를 보러 왔으므로 펴 둔다. */
  defaultCollapsed?: boolean;
  maxHeight?: number;
  /**
   * 스트리밍 따라가기 — 내용이 자랄 때 끝 근처에 있으면 끝으로 옮긴다.
   * 작성 중인 코드(LiveDraft)처럼 토큰이 계속 붙는 보기에만 켠다. 정적인
   * 출력에 켜도 해는 없지만, 의미 없는 prop 은 거짓말이므로 끄고 둔다.
   */
  autoScroll?: boolean;
}

export const FIRST_COLLAPSED_LINES = LAYOUT.FOLD_AT_LINES;

/**
 * 코드 블록이 **접을 수 있는지** 계산한다(순수 함수 — 렌더링과 분리).
 *
 * 접기 UI 는 클릭할 대상이 있어야 한다. 줄이 짧으면 펼칠 내용이 없으니
 * "펼치기" 를 보여주는 것은 거짓이다. 그래서:
 *   - `collapsible` 이 아니고,
 *   - 줄 수가 24 줄을 넘지 않으면
 *   접기 버튼을 만들지 않는다(`canToggle = false`).
 *
 * 컴포넌트 내부 계산이 아니라 함수로 뺀 이유: 이 규칙은 테스트가 요구한다.
 * 계산 로직이 달라지면 안 되며(간단한 규칙), 밖에서도 고정을 요구하므로 분리한다.
 */
export interface FoldState {
  /** 접기 버튼 UI 를 만들 수 있는가. */
  canToggle: boolean;
  /** 현재 줄 수. */
  lineCount: number;
}

export function computeFold(lines: string[], collapsible: boolean): FoldState {
  const tooLong = lines.length > FIRST_COLLAPSED_LINES;
  return { canToggle: collapsible && tooLong, lineCount: lines.length };
}

export function CodeBlock({
  lang,
  command,
  text,
  lineNumbers = true,
  collapsible = false,
  summary,
  defaultCollapsed = false,
  maxHeight = LAYOUT.CODE_MAX_HEIGHT,
  autoScroll = false,
}: CodeBlockProps) {
  const [open, setOpen] = React.useState(!defaultCollapsed);
  const [copied, setCopied] = React.useState(false);
  // **명령줄은 출력과 따로** 그린다 — 같이 넣으면 출력이 하이라이트되어 지어내게 된다.
  const outLines = useMemo(() => text.replace(/\s+$/, "").split("\n"), [text]);
  const lines = useMemo(() => (command ? [`$ ${command}`, ...outLines] : outLines), [command, outLines]);
  /** 줄번호는 **출력에만** — 명령줄은 1번이 아니라 "프롬프트" 다. */
  const isCommandLine = (i: number): boolean => Boolean(command) && i === 0;

  // **접을 수 없고 짧으면** 접기 UI 를 아예 만들지 않는다 — 클릭할 대상이 없는데
  // "펼치기" 가 보이는 것은 **거짓말**이다.
  // 접기 가능여부 — 순수 함수 computeFold 로 분리(위). 계산은 고정에 있다.
  const canToggle = useMemo(() => computeFold(lines, collapsible).canToggle, [lines, collapsible]);

  const shown = canToggle && !open ? lines.slice(0, FIRST_COLLAPSED_LINES) : lines;
  const hidden = lines.length - shown.length;
  // 스트리밍 중에는 끝을 따라간다 — 스크롤바가 생겨도 새 토큰이 보이게.
  // 사용자가 위로 올리면 그때부터는 손대지 않는다(판정은 followTail.ts).
  const follow = useFollowTail<HTMLPreElement>(autoScroll, text);

  return (
    <div style={{ margin: "4px 0 0", border: `1px solid ${COLOR.SURFACE_3}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1 }}>
      {(
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 6px", fontSize: FONT.META, color: DIM }}>
          <span>{summary ?? `${lines.length}줄`}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            aria-label="코드 복사"
            title={copied ? "복사됨" : "복사"}
            onClick={() => {
              try {
                void navigator.clipboard?.writeText(command ? `$ ${command}\n${text}` : text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                /* 클립보드 실패는 조용히 둔다 */
              }
            }}
            style={{
              background: "transparent",
              color: copied ? COLOR.GOOD : DIM,
              border: 0,
              font: "inherit",
              fontSize: FONT.META,
              padding: "0 4px",
              cursor: "pointer",
            }}
          >
            {copied ? "✓ 복사됨" : "⧉ 복사"}
          </button>
          {canToggle ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              background: COLOR.SURFACE_3,
              color: FG_BTN,
              border: `1px solid ${BORDER}`,
              borderRadius: RADIUS.S,
              font: "inherit",
              fontSize: FONT.META,
              padding: "0 6px",
              cursor: "pointer",
            }}
          >
            {open ? "접기" : `나머지 ${lines.length - FIRST_COLLAPSED_LINES}줄 펼치기`}
          </button>
          ) : (
            // VS 처럼 접기 자리는 항상 보인다. 접을 만큼 길지 않으면 비활성으로 —
            // 숨기면 접기 기능 자체를 잃었다고 읽힌다. 비활성 사유는 title 에.
            <span
              aria-disabled="true"
              title={`접을 만큼 길지 않습니다 (${lines.length}줄)`}
              style={{
                color: COLOR.LINE_NUM,
                fontSize: FONT.META,
                padding: "0 6px",
                cursor: "default",
                userSelect: "none",
              }}
            >
              접기
            </span>
          )}
        </div>
      )}
      <pre
        ref={follow.ref}
        onScroll={follow.onScroll}
        style={{
          margin: 0,
          padding: "4px 0",
          maxHeight: open ? maxHeight : undefined,
          overflow: "auto",
          font: `${FONT.AUX}px/${FONT.LINE_CODE} ${FONT.MONO}`,
          tabSize: FONT.TAB_SIZE,
        }}
      >
        {shown.map((line, i) => (
          <div key={i} style={{ display: "flex", paddingRight: 6 }}>
            {lineNumbers && !isCommandLine(i) && (
              <span
                // **줄번호는 줄 수가 아니라 텍스트**다 — 화면 판독기가 "줄 12" 로 읽어야 한다.
                aria-hidden="true"
                style={{
                  flex: "0 0 auto",
                  minWidth: 30,
                  paddingRight: SPACE.CODE_GUTTER,
                  textAlign: "right",
                  color: COLOR.LINE_NUM,
                  userSelect: "none",
                }}
              >
                {i + 1}
              </span>
            )}
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: COLOR.FG, flex: "1 1 auto", position: "relative" }}>
              {/* **명령줄에는 선을 그리지 않는다** — `$ npm run build` 의 들여쓰기는 블록 구조가 아니라 접두사다. */}
              {!isCommandLine(i) && (
                <IndentGuides
                  info={indentInfoFor(line, { tabSize: FONT.TAB_SIZE })}
                  offsetCh={0}
                  color={COLOR.LINE_NUM}
                />
              )}
              {isCommandLine(i) && command
                ? // **명령줄만 하이라이트** — 셸 문법이므로.
                  tokenizeLine(`$ ${command}`, "shell").map((t, ti) => (
                    <span key={ti} style={{ color: colorFor(t.kind) }}>
                      {t.text}
                    </span>
                  ))
                : lang === null
                  ? line
                  : tokenizeLine(line, lang).map((t, ti) => (
                      <span key={ti} style={{ color: colorFor(t.kind) }}>
                        {t.text}
                      </span>
                    ))}
              {line === "" ? " " : null}
            </span>
          </div>
        ))}
        {hidden > 0 && (
          <div style={{ paddingLeft: 38, color: DIM, fontSize: 10 }}>… {hidden}줄 접힘</div>
        )}
      </pre>
    </div>
  );
}
