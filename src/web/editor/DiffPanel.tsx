/**
 * 가로 diff 패널 (§5.2 · 요구 3).
 *
 * 왜 Monaco DiffEditor 가 아니라 직접 그리는가: Monaco 는 선택적 의존성이고,
 * 번들에 5MB 를 더한다. 그리고 이 프로그램에서 diff 는 **세 reviewing 경로**를 쓴다
 * (디스크↔버퍼 / HEAD↔워킹트리 / 도구 전후) — 라벨·통계·확장 모드가 다르다.
 * 렌더링이 검증을 통과한 `diff.ts` + `inline.ts` 위에 얹히면 되돌릴 수 있다.
 *
 * 라벨을 무엇이라 부르든 **"무엇끼리 비교하는가"** 를 모호하게 두지 않는다. 사용자가
 * "이게 뭔지 모르겠는데 초록이 뭐야" 라고 묻는 순간 diff 검토는 끝난다.
 */

import React, { useMemo, useRef, useEffect } from "react";
import { diffText, type DiffResult, type DiffLine } from "./diff.js";
import { inlineSpans, statLabel, type DiffSource, type Span } from "./inline.js";

const BG = "#0d1117";
const FG = "#c9d1d9";
const DIM = "#6e7681";

const KIND_COLOR: Record<DiffLine["kind"], { bg: string; fg: string; mark: string }> = {
  context: { bg: "transparent", fg: FG, mark: "transparent" },
  add: { bg: "#12261a", fg: "#7ee787", mark: "#2ea043" },
  del: { bg: "#2a1215", fg: "#ffa198", mark: "#da3633" },
  modify: { bg: "#1b2030", fg: "#d2a8ff", mark: "#8957e5" },
};

export interface DiffPanelProps {
  path: string;
  oldText: string;
  newText: string;
  source: DiffSource;
  leftLabel?: string;
  rightLabel?: string;
  layout?: "side" | "inline";
  onLayoutChange?: (l: "side" | "inline") => void;
  onClose?: () => void;
  width?: number;
  height?: number;
}

const DEFAULT_LEFT: Record<DiffSource, string> = { file: "디스크", git: "HEAD", tool: "실행 전" };
const DEFAULT_RIGHT: Record<DiffSource, string> = { file: "버퍼", git: "워킹트리", tool: "실행 후" };

export function DiffPanel(props: DiffPanelProps) {
  const {
    path,
    oldText,
    newText,
    source,
    leftLabel = DEFAULT_LEFT[source],
    rightLabel = DEFAULT_RIGHT[source],
    layout,
    onLayoutChange,
    onClose,
    width = 1200,
    height = 520,
  } = props;

  const mode = layout ?? (width < 900 ? "inline" : "side");
  const diff: DiffResult = useMemo(() => diffText(oldText, newText), [oldText, newText]);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Ctrl+Alt+D 로 전체 화면 (§5.2). 브라우저 기본 기능과 겹치지 않는 조합이고,
  // 포커스가 패널 밖이어도 창 단위로 동작해야 discovery 가 가능하다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        const el = bodyRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el.requestFullscreen?.().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lines = diff.hunks.flatMap((h) => h.lines);

  return (
    <section
      style={{
        background: BG,
        color: FG,
        border: "1px solid #30363d",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 10px",
          borderBottom: "1px solid #30363d",
          background: "#161b22",
          flex: "0 0 auto",
        }}
      >
        <strong style={{ fontSize: 12 }}>{path}</strong>
        <span style={{ color: DIM }}>
          {leftLabel} → {rightLabel}
        </span>
        <span style={{ color: "#7ee787" }}>+{diff.stat.added}</span>
        <span style={{ color: "#ffa198" }}>−{diff.stat.removed}</span>
        {diff.stat.modified > 0 && <span style={{ color: "#d2a8ff" }}>{statLabel(diff.stat)}</span>}
        <span style={{ flex: 1 }} />
        {/* 레이아웃 토글. 자동으로만 바뀌면 사용자가 선택했다는 기억이 사라진다. */}
        <button
          type="button"
          onClick={() => onLayoutChange?.(mode === "side" ? "inline" : "side")}
          disabled={!onLayoutChange}
          title="가로/인라인 전환 (기본은 가로)"
          style={btn}
        >
          {mode === "side" ? "가로" : "인라인"}
        </button>
        <button
          type="button"
          onClick={() => {
            const el = bodyRef.current;
            if (!el) return;
            if (document.fullscreenElement) void document.exitFullscreen();
            else void el.requestFullscreen?.().catch(() => undefined);
          }}
          title="전체 화면 (Ctrl+Alt+D)"
          style={btn}
        >
          ⛶
        </button>
        {onClose && (
          <button type="button" onClick={onClose} title="닫기" style={btn}>
            ✕
          </button>
        )}
      </header>

      {diff.hunks.length === 0 ? (
        // §11.3: 빈 화면은 결함이다. "변경 없음" 을 이유와 함께 말한다.
        <div style={{ padding: 16, color: DIM }}>
          두 내용이 같습니다. 차분이 없습니다.
        </div>
      ) : mode === "side" ? (
        <SideBySide lines={lines} bodyRef={bodyRef} height={height} />
      ) : (
        <InlineView lines={lines} bodyRef={bodyRef} height={height} />
      )}
    </section>
  );
}

const btn: React.CSSProperties = {
  background: "#21262d",
  color: FG,
  border: "1px solid #30363d",
  borderRadius: 5,
  padding: "2px 8px",
  cursor: "pointer",
  font: "inherit",
};

/** modify 짝을 인덱스로. 짝이 깨진 줄(짝 없음)은 짝 없는 modify 로 본다. */
function pairIndex(lines: DiffLine[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].kind === "modify" && lines[i + 1].kind === "modify") {
      map.set(i, i + 1);
      map.set(i + 1, i);
      i++;
    }
  }
  return map;
}

function renderLineText(line: DiffLine, mate: DiffLine | undefined, side: "old" | "new"): React.ReactNode {
  if (line.kind === "context") return line.text || " ";
  if (line.kind === "modify" && mate) {
    const spans: Span[] = side === "old" ? inlineSpans(mate.text, line.text).left : inlineSpans(mate.text, line.text).right;
    return spans.map((s, i) =>
      s.changed ? (
        <mark key={i} style={{ background: KIND_COLOR.modify.mark, color: "#fff", borderRadius: 2 }}>
          {s.text}
        </mark>
      ) : (
        <span key={i}>{s.text}</span>
      ),
    );
  }
  if (line.kind === "add" || line.kind === "del") {
    return (
      <span style={{ background: KIND_COLOR[line.kind].mark, color: "#fff", borderRadius: 2 }}>{line.text || " "}</span>
    );
  }
  return line.text || " ";
}

function SideBySide({
  lines,
  bodyRef,
  height,
}: {
  lines: DiffLine[];
  bodyRef: React.RefObject<HTMLDivElement>;
  height: number;
}) {
  const pairs = pairIndex(lines);
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  lines.forEach((l, i) => {
    if (l.kind === "add") {
      left.push({ ...l, text: "", line: -1, kind: "context" });
      right.push(l);
    } else if (l.kind === "del") {
      left.push(l);
      right.push({ ...l, text: "", line: -1, kind: "context" });
    } else {
      left.push(l);
      right.push(l);
    }
    void pairs;
    void i;
  });

  return (
    <div ref={bodyRef} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", overflow: "auto", height, flex: "1 1 auto", minHeight: 0 }}>
      <div>
        <div style={{ position: "sticky", top: 0, background: "#161b22", padding: "3px 8px", color: DIM, borderBottom: "1px solid #21262d" }}>
          이전
        </div>
        {left.map((l, i) => (
          <Row key={i} line={l} mate={right[i]} side="old" />
        ))}
      </div>
      <div style={{ borderLeft: "1px solid #30363d" }}>
        <div style={{ position: "sticky", top: 0, background: "#161b22", padding: "3px 8px", color: DIM, borderBottom: "1px solid #21262d" }}>
          현재
        </div>
        {right.map((l, i) => (
          <Row key={i} line={l} mate={left[i]} side="new" />
        ))}
      </div>
    </div>
  );
}

function Row({ line, mate, side }: { line: DiffLine; mate: DiffLine; side: "old" | "new" }) {
  const c = KIND_COLOR[line.kind];
  const no = line.line < 0 ? "" : String(line.line);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", background: c.bg, minHeight: 18 }}>
      <span style={{ color: DIM, textAlign: "right", paddingRight: 8, userSelect: "none" }}>{no}</span>
      <span style={{ color: c.fg, whiteSpace: "pre-wrap", wordBreak: "break-word", paddingRight: 8 }}>
        {renderLineText(line, mate.kind === "modify" ? mate : undefined, side)}
      </span>
    </div>
  );
}

function InlineView({
  lines,
  bodyRef,
  height,
}: {
  lines: DiffLine[];
  bodyRef: React.RefObject<HTMLDivElement>;
  height: number;
}) {
  return (
    <div ref={bodyRef} style={{ overflow: "auto", height, flex: "1 1 auto", minHeight: 0 }}>
      {lines.map((l, i) => {
        const c = KIND_COLOR[l.kind];
        return (
          <div
            key={i}
            style={{ display: "grid", gridTemplateColumns: "44px 1fr", background: c.bg, minHeight: 18 }}
          >
            <span style={{ color: DIM, textAlign: "right", paddingRight: 8, userSelect: "none" }}>
              {l.line < 0 ? "" : l.line}
            </span>
            <span style={{ color: c.fg, whiteSpace: "pre-wrap", wordBreak: "break-word", paddingRight: 8 }}>
              {l.text || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}
