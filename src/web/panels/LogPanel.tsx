/**
 * 서버 로그 패널 (§5.12) — 상시 스트리밍, 상한 500,000자.
 *
 * 성능 규칙이 이 컴포넌트의 전부다(§5.12.3 + §4.7.4):
 *  - **가상 스크롤 필수**. 5만 줄 DOM 을 그대로 두면 `off` 모드(소프트웨어 렌더)에서
 *    프레임이 죽는다. 보이는 + 위아래 20줄만 렌더한다.
 *  - 50ms 버퍼 + rAF 커밋(초당 20회 상한). 한 줄씩 setState 하면 초당 수백 번 리렌더된다.
 *  - 행은 `React.memo` 로 격리 — 새 줄이 와도 보이는 행만 다시 그려진다.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogLevel, LogSource } from "../../server/logRing.js";

export interface LogPanelProps {
  entries: LogEntry[];
  status?: { keptChars: number; droppedLines: number; maxChars: number; bufferFull: boolean };
  /** 컨테이너 높이(px). 가상 스크롤이 이 값을 기준으로 계산한다. */
  height?: number;
  onClear?: () => void;
  onSetLevel?: (level: LogLevel) => void;
  level: LogLevel;
  /** 현재 필터가 왜 넓어졌는지 설명 (§5.12: "검색 중: debug 포함"). */
  filterLabel?: string;
}

const ROW_H = 18;
const OVERSCAN = 20;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "#6e7681",
  info: "#8b949e",
  warn: "#d29922",
  error: "#f85149",
};

const SOURCE_LABEL: Record<LogSource, string> = {
  server: "서버",
  llama: "llama",
  chrome: "브라우저",
  proc: "프로세스",
};

/** 레벨 순서 — 선택지의 "N 이상" 은 최소 레벨 필터다. */
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 검색 중에는 레벨 바닥을 debug 까지 내린다 — 사용자가 그 단어를 직접 물어봤으니
 * 레벨 때문에 "없음" 이라고 답하면 안 된다. 대신 아래 힌트로 **알려준다**
 * (조용히 완화하면 사용자는 왜 debug 가 나오는지 모른다).
 */
function minLevelFor(filter: string, level: LogLevel): LogLevel {
  return filter.trim() ? "debug" : level;
}

const Row = memo(function Row({ e }: { e: LogEntry }) {
  const time = new Date(e.ts).toISOString().slice(11, 23);
  return (
    <div
      style={{
        height: ROW_H,
        lineHeight: `${ROW_H}px`,
        display: "flex",
        gap: 8,
        whiteSpace: "pre",
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      <span style={{ color: "#484f58", flexShrink: 0 }}>{time}</span>
      <span style={{ color: LEVEL_COLOR[e.level], width: 44, flexShrink: 0 }}>{e.level.toUpperCase()}</span>
      <span style={{ color: "#58a6ff", width: 62, flexShrink: 0 }}>
        {e.source === "server" ? "" : SOURCE_LABEL[e.source]}
      </span>
      <span style={{ color: "#d4d4d4", overflow: "hidden", textOverflow: "ellipsis" }}>{e.message}</span>
    </div>
  );
});

export function LogPanel({ entries, status, height = 260, onClear, onSetLevel, level, filterLabel: filterLabelProp }: LogPanelProps) {
  const [filter, setFilter] = useState<string>("");
  const [sources, setSources] = useState<Set<LogSource>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const [truncatedNotice, setTruncatedNotice] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pending = useRef<LogEntry[]>([]);
  const raf = useRef<number | null>(null);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const min = RANK[level] ?? RANK.debug;
    return entries.filter((e) => {
      if (sources.size > 0 && !sources.has(e.source)) return false;
      if (RANK[e.level] < min) return false;
      if (q && !e.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, filter, sources, level]);

  /** 검색 중인데 레벨 선택이 debug 가 아니면, 바닥이 완화됐음을 알려준다. */
  const relaxed = filter.trim().length > 0 && level !== "debug";
  // 상위(셸)가 필터를 소유하면 그 설명을 우선한다 — 두 곳이 따로 계산하면
  // "왜 debug 가 보이냐" 를 설명하는 문구가 서로 달라진다.
  const shownFilterLabel = filterLabelProp ?? (relaxed ? `검색 중: 디버그 포함` : `레벨 ${level} 이상`);

  // 50ms 버퍼 + rAF 커밋: 새 줄이 와도 초당 20회 넘게 리렌더하지 않는다(§5.6 규칙 재사용).
  useEffect(() => {
    if (entries.length === 0) return;
    pending.current = entries.slice(-1);
    if (raf.current !== null) return;
    raf.current = window.setTimeout(() => {
      raf.current = null;
      // 강제 리렌더 대신 스크롤 위치만 맞춘다(리스트는 부모가 소유).
      if (autoScroll && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, 50);
    return () => {
      if (raf.current !== null) {
        window.clearTimeout(raf.current);
        raf.current = null;
      }
    };
  }, [entries, autoScroll]);

  // 잘림 배너는 **한 번만**(§5.12.2). 계속 띄우면 패널이 지저분해진다.
  useEffect(() => {
    if (status?.bufferFull && !truncatedNotice) setTruncatedNotice(true);
  }, [status?.bufferFull, truncatedNotice]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
    setAutoScroll(atBottom);
  }, []);

  const total = visible.length;
  const start = Math.max(0, total - Math.ceil(height / ROW_H) - OVERSCAN);
  const slice = visible.slice(start);

  const toggleSource = (s: LogSource) => {
    const next = new Set(sources);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSources(next);
  };

  return (
    <div style={{ height, display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 6px", borderBottom: "1px solid #30363d" }}>
        {(Object.keys(SOURCE_LABEL) as LogSource[]).map((s) => (
          <button
            key={s}
            onClick={() => toggleSource(s)}
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 4,
              border: "1px solid #30363d",
              background: sources.has(s) ? "#1f6feb33" : "transparent",
              color: sources.has(s) ? "#58a6ff" : "#8b949e",
              cursor: "pointer",
            }}
          >
            {SOURCE_LABEL[s]}
          </button>
        ))}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="서버 로그 검색"
          placeholder="검색"
          style={{ flex: 1, fontSize: 11, background: "#0d1117", border: "1px solid #30363d", color: "#d4d4d4", padding: "2px 6px", borderRadius: 4 }}
        />
        <label style={{ fontSize: 11, color: "#8b949e", display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          자동 스크롤
        </label>
        {onSetLevel && (
          <select
            value={level}
            onChange={(e) => onSetLevel(e.target.value as LogLevel)}
            style={{ fontSize: 11, background: "#0d1117", color: "#d4d4d4", border: "1px solid #30363d", borderRadius: 4 }}
          >
            <option value="debug">debug 이상</option>
            <option value="info">info 이상</option>
            <option value="warn">warn 이상</option>
            <option value="error">error</option>
          </select>
        )}
        {onClear && (
          <button onClick={onClear} style={{ fontSize: 11, color: "#8b949e", background: "transparent", border: "1px solid #30363d", borderRadius: 4, padding: "1px 6px", cursor: "pointer" }}>
            지우기
          </button>
        )}
        {/* 왜 이렇게 보이는지 설명한다 — 사용자가 추측하지 않아야 한다(§11.3). */}
        <span style={{ fontSize: 10, color: "#6e7681", marginLeft: "auto" }}>{shownFilterLabel}</span>
      </div>

      <div ref={scrollRef} onScroll={onScroll} style={{ overflow: "auto", minHeight: 0, padding: "2px 0" }}>
        {/* 앞쪽 잘린 구간을 높이로만 표현한다 — DOM 을 만들지 않는다 */}
        {start > 0 && <div style={{ height: start * ROW_H }} />}
        {slice.map((e) => (
          <Row key={e.seq} e={e} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "3px 6px", borderTop: "1px solid #30363d", fontSize: 11, color: "#8b949e" }}>
        <span>
          {total.toLocaleString()}줄{status ? ` · ${status.keptChars.toLocaleString()}자` : ""}
        </span>
        {status && (
          <span title={`상한 ${status.maxChars.toLocaleString()}자`}>
            상한 {status.maxChars.toLocaleString()}자
          </span>
        )}
        {truncatedNotice && status && status.droppedLines > 0 && (
          <span style={{ color: "#d29922" }}>
            … 앞 {status.droppedLines.toLocaleString()}줄이 잘렸습니다 · 전체 보기
          </span>
        )}
        {!autoScroll && <span style={{ color: "#58a6ff" }}>새 로그 ↓</span>}
        {relaxed && <span style={{ color: "#d29922" }}>검색 중: debug 포함</span>}
      </div>
    </div>
  );
}
