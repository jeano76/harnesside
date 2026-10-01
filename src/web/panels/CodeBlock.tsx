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
import { colorFor, tokenizeLine, type Language } from "../editor/highlight.js";

const DIM = "#6e7681";
const BORDER = "#30363d";
const FG_BTN = "#c9d1d9";
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
}

const FIRST_COLLAPSED_LINES = 24;

export function CodeBlock({
  lang,
  command,
  text,
  lineNumbers = true,
  collapsible = false,
  summary,
  defaultCollapsed = false,
  maxHeight = 260,
}: CodeBlockProps) {
  const [open, setOpen] = React.useState(!defaultCollapsed);
  // **명령줄은 출력과 따로** 그린다 — 같이 넣으면 출력이 하이라이트되어 지어내게 된다.
  const outLines = useMemo(() => text.replace(/\s+$/, "").split("\n"), [text]);
  const lines = useMemo(() => (command ? [`$ ${command}`, ...outLines] : outLines), [command, outLines]);
  /** 줄번호는 **출력에만** — 명령줄은 1번이 아니라 "프롬프트" 다. */
  const isCommandLine = (i: number): boolean => Boolean(command) && i === 0;

  // **접을 수 없고 짧으면** 접기 UI 를 아예 만들지 않는다 — 클릭할 대상이 없는데
  // "펼치기" 가 보이는 것은 **거짓말**이다.
  const tooLong = lines.length > FIRST_COLLAPSED_LINES;
  const canToggle = collapsible && tooLong;

  const shown = canToggle && !open ? lines.slice(0, FIRST_COLLAPSED_LINES) : lines;
  const hidden = lines.length - shown.length;

  return (
    <div style={{ margin: "4px 0 0", border: "1px solid #21262d", borderRadius: 6, background: "#0d1117" }}>
      {canToggle && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 6px", fontSize: 10, color: DIM }}>
          <span>{summary ?? `${lines.length}줄`}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              background: "#21262d",
              color: FG_BTN,
              border: `1px solid ${BORDER}`,
              borderRadius: 4,
              font: "inherit",
              fontSize: 10,
              padding: "0 6px",
              cursor: "pointer",
            }}
          >
            {open ? "접기" : `나머지 ${lines.length - FIRST_COLLAPSED_LINES}줄 펼치기`}
          </button>
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: "4px 0",
          maxHeight: open ? maxHeight : undefined,
          overflow: "auto",
          font: "10px/1.5 ui-monospace, monospace",
          tabSize: 2,
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
                  paddingRight: 8,
                  textAlign: "right",
                  color: "#484f58",
                  userSelect: "none",
                }}
              >
                {i + 1}
              </span>
            )}
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#c9d1d9", flex: "1 1 auto" }}>
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
