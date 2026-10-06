/**
 * 대화 출력 안에 나타나는 **파일 미리보기** (2026-10-01).
 *
 * 요구: "파일의 미리보기 기능은 해당 파일 선택이 되는 시점에 ai 대화 출력창에 블럭으로
 * 내용을 IDE 처럼 데이터 포맷 또는 형식에 맞추어 나타내는 거야. 지금 처럼 별도의 파일
 * 에디터 패널은 없고 대화 출력 패널안에서 동작시키는 거야"
 *
 * ── 왜 별도 패널이 아니라 **블록**인가 ───────────────────────────────────────
 * 화면이 두 곳으로 갈라지면 **맥락이 갈라진다.** "에이전트가 이 파일을 왜 열었나" 를
 * 보려면 스크롤을 되돌아가야 하고, 그 사이에 다른 일이 지나가 있다. 대화 흐름 안에
 * 블록으로 두면 ** causative 인과가 한 화면에** 남는다.
 *
 * 그래서 `main.tsx` 의 `openFile` 상태(별도 에디터 패널)가 아니라 **에이전트 블록
 * 목록**에 붙는다. 파일 하나를 열면 대화에 블록 하나가 쌓이고, 순서도 그대로다.
 *
 * ── IDE 처럼 보이게 하는 것 ──────────────────────────────────────────────────
 *  - **줄 번호** — 어디를 보고 있는지 말해 준다. 하이라이터가 아니라 IDE 의 책임.
 *  - **확장자별 하이라이트** — `editor/highlight.ts`.
 *  - **탭 정렬** — 고정폭 숫자폭(`tabular-nums`)이 없으면 줄 번호가 흔들린다.
 *  - **모르는 형식은 **말한다** — "미지원: .foo" 를 조용히 칠하지 않고 쓴다.
 *
 * **자르지 않는다.** 긴 파일을 잘라 보여주면 사용자는 자기 코드를 모른다고 믿는다.
 * 상한을 넘으면 "N줄 중 M줄만 표시" 라고 **말하고** 잘라야 한다.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../api.js";
import {
  colorFor,
  gutterWidthFor,
  languageFor,
  LANGUAGE_LABEL,
  MAX_HIGHLIGHT_LINES,
  tokenizeLine,
} from "../editor/highlight.js";
import { extractSymbols } from "../../shared/symbols.js";
// 인덴트 가이드 — 규칙은 `editor/indentRules.ts`, 렌더는 `editor/IndentGuides.tsx`.
import { IndentGuides } from "../editor/IndentGuides.js";
import { indentInfoFor } from "../editor/indentRules.js";
import { COLOR, FONT, RADIUS } from "../theme/tokens.js";

const DIM = COLOR.DIM_SUBTLE;
const BORDER = COLOR.BORDER;

export interface FilePreviewProps {
  client: ApiClient;
  path: string;
  /** 사용자가 명시적으로 여는 경우만 하이라이트를 미리 돌린다(자동 열림은 하지 않는다). */
  autoOpen?: boolean;
  /**
   * **편집기로 연다.** 있으면 헤더에 `편집` 버튼이 붙는다.
   *
   * 왜 기본값이 `없음`인가: 이 화면은 대화 안의 블록이고, 블록을 **둘러보는** 것과
   * **편집**하는 것은 다른 행위다. 편집 버튼은 **편집기로 갈 수 있을 때만** 보여야
   * 한다 — 항상 붙이면 "누르면 뭐가 된다" 를 모르는 버튼이 하나 늘어난다.
   */
  onEdit?: (path: string) => void;
}

export function FilePreview({ client, path, autoOpen = false, onEdit }: FilePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const lang = useMemo(() => languageFor(path), [path]);

  useEffect(() => {
    // **중복 요청 방지** — 블록이 리렌더될 때마다 읽으면 파일을 계속 읽는다.
    if (content !== null || error !== null || !autoOpen) return;
    let alive = true;
    setLoading(true);
    void client
      .get<{ content: string }>(`/api/fs/file?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (alive) setContent(r.content);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `content`/`error` 를 deps 에 넣으면 **성공 직후에 또 읽는다**(값이 바뀌면
    // effect 가 다시 돈다). 그래서 여기서는 **경로만** 본다.
  }, [client, path, autoOpen, content, error]);

  const lines = useMemo(() => (content ?? "").split("\n"), [content]);
  const gutter = gutterWidthFor(lines.length);
  const truncated = lines.length > MAX_HIGHLIGHT_LINES;
  const shown = truncated ? lines.slice(0, MAX_HIGHLIGHT_LINES) : lines;
  /** 기호 아웃라인 — 텍스트 기준(타입 해석 없음). 클릭하면 그 줄로 스크롤한다. */
  const outline = useMemo(
    () => (content === null ? { symbols: [], truncated: false } : extractSymbols(path, content)),
    [content, path]
  );
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (jumpLine === null) return;
    lineRefs.current.get(jumpLine)?.scrollIntoView({ block: "nearest" });
    const t = setTimeout(() => setJumpLine(null), 1500);
    return () => clearTimeout(t);
  }, [jumpLine, content]);

  return (
    <div className="elev-1" style={{ border: `1px solid ${BORDER}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "3px 8px",
          background: COLOR.SURFACE_2,
          borderBottom: `1px solid ${BORDER}`,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.045)",
          fontSize: FONT.META,
        }}
      >
        <span style={{ color: COLOR.FG }}>{path.split("/").pop()}</span>
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(path)}
            title={`${path} 를 편집기로 엽니다 (자동 저장)`}
            style={{
              background: "transparent",
              color: COLOR.BLUE,
              border: `1px solid ${BORDER}`,
              borderRadius: RADIUS.XS,
              padding: "0 6px",
              font: "inherit",
              fontSize: FONT.META,
              cursor: "pointer",
            }}
          >
            편집
          </button>
        )}
        <span style={{ color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path}</span>
        <span style={{ marginLeft: "auto", color: DIM, whiteSpace: "nowrap" }}>
          {LANGUAGE_LABEL[lang]}
          {content !== null && ` · ${lines.length.toLocaleString("ko-KR")}줄`}
        </span>
      </div>

      {/* **미지원 형식을 말한다.** 조용히 칠하지 않으면 사용자는 화면만 보고
          "왜 색이 안치지" 를 프로그램 버그로 여긴다. */}
      {lang === "text" && (
        <div style={{ padding: "3px 8px", fontSize: FONT.META, color: COLOR.YELLOW, borderBottom: `1px solid ${BORDER}` }}>
          이 형식은 색칠하지 않습니다 (미지원 확장자) — 내용은 그대로 보입니다.
        </div>
      )}

      {loading && <div style={{ padding: "6px 8px", fontSize: FONT.AUX, color: DIM }}>읽는 중…</div>}
      {error && (
        <div style={{ padding: "6px 8px", fontSize: FONT.AUX, color: COLOR.ERROR }}>
          읽지 못했습니다: {error}
        </div>
      )}

      {content !== null && (
        <>
          {truncated && (
            <div style={{ padding: "3px 8px", fontSize: FONT.META, color: COLOR.YELLOW, borderBottom: `1px solid ${BORDER}` }}>
              {lines.length.toLocaleString("ko-KR")}줄 중 {MAX_HIGHLIGHT_LINES.toLocaleString("ko-KR")}줄만 표시합니다 — 나머지는 **자르지 않았습니다**.
            </div>
          )}
          {/* 기호 아웃라인 (§7.1 1단계 — 텍스트 기준, 타입 해석 없음). */}
          {outline.symbols.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "3px 8px", borderBottom: `1px solid ${BORDER}`, fontSize: FONT.META }}>
              <span style={{ color: DIM }}>기호</span>
              {outline.symbols.slice(0, 24).map((s) => (
                <button
                  key={`${s.line}:${s.name}`}
                  type="button"
                  title={`${s.kind} · ${s.line}줄 (텍스트 기준)`}
                  onClick={() => setJumpLine(s.line)}
                  style={{
                    background: jumpLine === s.line ? COLOR.SURFACE_3 : "transparent",
                    color: jumpLine === s.line ? COLOR.FG : COLOR.BLUE,
                    border: 0, cursor: "pointer", font: "inherit", padding: "0 2px", textDecoration: "underline",
                  }}
                >
                  {s.name}
                </button>
              ))}
              {outline.symbols.length > 24 && <span style={{ color: DIM }}>+{outline.symbols.length - 24}개</span>}
              {outline.truncated && <span style={{ color: COLOR.YELLOW }}>잘림</span>}
            </div>
          )}
          <div style={{ maxHeight: 420, overflow: "auto", padding: "4px 0" }}>
            <pre
              style={{
                margin: 0,
                // `tabular-nums` 없으면 줄 번호가 **흔들린다** — 한 줄씩 다른 폭으로
                // 정렬되면 코드가 옆으로 물려 보인다.
                fontVariantNumeric: "tabular-nums",
                font: "11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {shown.map((line, i) => (
                <div
                  key={i}
                  ref={(el) => {
                    if (el) lineRefs.current.set(i + 1, el);
                    else lineRefs.current.delete(i + 1);
                  }}
                  style={{
                    display: "flex",
                    paddingRight: 8,
                    position: "relative",
                    background: jumpLine === i + 1 ? COLOR.SURFACE_3 : "transparent",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: `${gutter + 1}em`,
                      flex: "0 0 auto",
                      textAlign: "right",
                      paddingRight: 8,
                      color: COLOR.LINE_NUM,
                      userSelect: "none",
                    }}
                  >
                    {i + 1}
                  </span>
                  {/* 가이드를 **코드 텍스트 안쪽**에 그린다 — 줄 번호 거터는 `em` 단위라서
                      `ch` 로 변환하려면 글자 폭을 재야 한다(측정 없이 정확히 할 수 없다).
                      코드 시작점을 상대 좌표로 잡으면 그 재 측정이 필요 없다. */}
                  <span style={{ whiteSpace: "pre", color: COLOR.FG, position: "relative" }}>
                    <IndentGuides
                      info={indentInfoFor(line, { tabSize: FONT.TAB_SIZE })}
                      offsetCh={0}
                      color={COLOR.LINE_NUM}
                    />
                    {tokenizeLine(line, lang).map((tok, k) => (
                      <span key={k} style={{ color: colorFor(tok.kind) }}>
                        {tok.text}
                      </span>
                    ))}
                    {/* 빈 줄도 줄 하나다.** `\n` 을 명시하지 않으면 빈 줄이
                        사라지고 **그 뒤 모든 줄 번호가 한 칸씩 밀린다** — 가장
                        찾기 어려운 종류의 화면 버그다. */}
                    {"\n"}
                  </span>
                </div>
              ))}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
