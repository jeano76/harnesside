/**
 * 앱 셸 (§5.0 레이아웃 골격 · §5.7 입력창 · §5.4 도킹).
 *
 * 이전에는 부팅 시퀀스만 보여주는 화면이었다. 이제 **실제 IDE** 다:
 * 좌(탐색기) · 중앙(편집기/diff) · 우(에이전트/모니터) · 하(로그, 닫을 수 없음).
 *
 * 두 가지가 이 파일의 존재 이유다:
 *  1. **빈 상태를 채운다**(§11.3). 빈 화면은 결함이다. 각 영역은 "무엇을 할 수 있나"
 *     와 예시 버튼을 보여준다.
 *  2. **멈춘 것처럼 보이지 않는다**(§11.3). WS 상태, 계측, 대기 시간을 항상 보인다.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError, type BootStep, type GpuInfo } from "./api.js";
import { resolveToken } from "./session.js";
import { LogPanel } from "./panels/LogPanel.js";
import { WorkspaceBar } from "./panels/WorkspaceBar.js";
import { AgentPanel, applyEvent, type AgentBlock } from "./panels/AgentPanel.js";
import { ModelPanel } from "./panels/ModelPanel.js";
import { initialThink, finish, ingest, type ThinkState, type ThinkStyle } from "./agent/think.js";
import type { WorkspaceFingerprint } from "../server/workspace.js";
import { MonitorPanel } from "./panels/MonitorPanel.js";
import { DiffPanel } from "./editor/DiffPanel.js";
import { EditorView } from "./editor/EditorView.js";
import { dispatchWs } from "./wsBus.js";
import { TerminalView } from "./panels/TerminalView.js";
import { CommitBox } from "./panels/CommitBox.js";
import { ResumeBanner } from "./panels/ResumeBanner.js";
import "@xterm/xterm/css/xterm.css";
import { WsClient } from "./wsClient.js";
import { DEFAULT_LAYOUT, movePanel, toggleCollapse, keyboardMove, panelOf, zoneLabel, type PanelId, type Zone } from "./layout/engine.js";
import { loadDraft, saveDraft, clearDraft, searchCommands, type Command, type Toast } from "./panels/notify.js";
import { filterEntries, defaultFilter, visibleTail, bufferFullLabel, filterLabel, type Filter, type LogLevel } from "./panels/logFilter.js";
import { useI18n } from "./i18n/index.js";
// 이 import 가 카탈로그를 **등록한다**. 훅만 쓰고 여기 안 쓰면 사전이 비어 있고,
// `t()` 는 키 문자열을 그대로 돌려준다(2026-09-30 까지 실제로 그랬다).
import "./i18n/install.js";
import type { LogEntry } from "../server/logRing.js";
import type { Metrics } from "../shared/metrics.js";

const { token, cleanHref } = resolveToken(
  typeof location !== "undefined" ? location.href : "/",
  typeof sessionStorage !== "undefined" ? sessionStorage : undefined,
);
if (typeof history !== "undefined" && typeof location !== "undefined") {
  history.replaceState(null, "", cleanHref);
}

const client = new ApiClient({ token });

const BG = "#0d1117";
const FG = "#c9d1d9";
const DIM = "#6e7681";
const BORDER = "#30363d";

/** §11.3 빈 상태: "무엇을 할 수 있나" 와 예시 프롬프트. */
const EXAMPLES = [
  "이 저장소의 구조를 한 문단으로 설명해 주세요",
  "최근 변경 파일을 찾아 Likely 버그를 하나만 골라 주세요",
  "테스트를 실행하고 실패한 것만 정리해 주세요",
];

/** 패널 제목. 존과 무관하게 **같은 이름** 이어야 한다 — 제목을 존에서 만들면
 *  패널이 옮겨갈 때 제목까지 바뀐다(사용자가 못 찾는다).
 *
 *  값이 아니라 **키** 다(M9): 문장은 카탈로그가 정본이다. 키가 사전에 없으면 화면에
 *  `panel.editor` 가 그대로 찍힌다 — 그게 "옮기지 않은 문자열" 을 눈에 보이게 하는
 *  방법이고, 조용히 옛 문자열로 되돌리면 배치가 거짓말을 하게 된다(§5.8). */
const TITLE_KEY: Record<string, string> = {
  explorer: "panel.explorer",
  agent: "panel.agent",
  editor: "panel.editor",
  terminal: "panel.terminal",
  diff: "panel.diff",
  monitor: "panel.monitor",
  log: "panel.log",
  settings: "panel.settings",
};

function Empty({ title, hint, actions }: { title: string; hint: string; actions?: { label: string; onClick: () => void }[] }) {
  return (
    <div style={{ padding: 16, color: DIM, display: "grid", gap: 8, justifyItems: "start" }}>
      <div style={{ color: FG, fontSize: 13 }}>{title}</div>
      <div style={{ fontSize: 12 }}>{hint}</div>
      {actions && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "3px 8px", cursor: "pointer", font: "inherit", fontSize: 11 }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 패널을 **존에 따라** 배치한다.
 *
 * 엔진이 판정한 존을 **그대로 렌더**해야 한다. 고정 3열 그리드로 그렸다가 존 라벨만
 * 붙이면, 라벨이 실제 위치와 어긋난다 — 사용자는 "오른쪽 도크" 라고 적혀 있는데
 * 화면에서는 중앙에 있다. **라벨이 거짓말을 하는 배치가 도킹 엔진보다 나쁘다.**
 * 그래서 열 배열을 존에서 **계산**한다.
 */
/**
 * 존별로 묶는다.
 *
 * `top` 과 `bottom` 도 **자기 자리를 갖는다.** 중앙 열에 끼워 넣으면서 머리에는
 * "상단 도크" 라고 적으면 라벨이 거짓말이 된다(실제로 났다). 그래서 행을 따로 잡는다.
 */
function groupByZone(panels: { id: PanelId; zone: Zone }[]) {
  const out: Record<Zone, PanelId[]> = { left: [], center: [], right: [], top: [], bottom: [] };
  for (const p of panels) out[p.zone].push(p.id);
  return out;
}

function Panel({
  title,
  zone,
  collapsed,
  onToggle,
  onMove,
  children,
  dockable = true,
}: {
  title: string;
  zone: Zone;
  collapsed?: boolean;
  onToggle?: () => void;
  onMove?: (z: Zone) => void;
  children: React.ReactNode;
  dockable?: boolean;
}) {
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", background: BG }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", background: "#161b22", borderBottom: `1px solid ${BORDER}`, flex: "0 0 auto" }}>
        <strong style={{ fontSize: 11, color: FG }}>{title}</strong>
        {/* 위치는 사람이 이해할 수 있는 말로 (§5.8) — 내부 식별자 노출 금지 */}
        <span style={{ fontSize: 10, color: DIM }}>{zoneLabel(zone)}</span>
        <span style={{ flex: 1 }} />
        {dockable && onMove && (
          <span style={{ display: "flex", gap: 2 }}>
            {(["left", "right", "top", "bottom"] as Zone[]).map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => onMove(z)}
                title={`${zoneLabel(z)}로 이동`}
                style={{ background: "none", border: 0, color: DIM, cursor: "pointer", fontSize: 10 }}
              >
                {z === "left" ? "◧" : z === "right" ? "◨" : z === "top" ? "▭" : "▁"}
              </button>
            ))}
          </span>
        )}
        {onToggle && (
          <button type="button" onClick={onToggle} title="접기/펼치기" style={{ background: "none", border: 0, color: DIM, cursor: "pointer", fontSize: 10 }}>
            {collapsed ? "▸" : "▾"}
          </button>
        )}
      </div>
      {!collapsed && <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto" }}>{children}</div>}
    </div>
  );
}

export default function App() {
  // M9: 문자열은 여기서 키로 바꾼다. 훅이 **함수** 를 돌려주는 이유는 로케일이
  // 바뀌면 다시 그려야 해서다 — 함수를 그대로 받아쓰면 stale 이 된다.
  const t = useI18n();
  const [steps, setSteps] = useState<BootStep[] | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logStatus, setLogStatus] = useState<import("./panels/logFilter.js").LogStatus | null>(null);
  const [filter, setFilter] = useState<Filter>(defaultFilter());
  const [wsState, setWsState] = useState<"connecting" | "open" | "closed">("connecting");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricSeries, setMetricSeries] = useState<(number | null)[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [draft, setDraft] = useState(() => loadDraft(typeof localStorage !== "undefined" ? localStorage : null)?.text ?? "");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [modelName, setModelName] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; oldText: string; newText: string } | null>(null);
  // 열려 있는 파일(§5.1). 없으면 빈 패널이 아니라 "무엇을 열 수 있나" 를 보여준다.
  const [openFile, setOpenFile] = useState<{ path: string; content: string; version: number; size: number } | null>(null);
  const refreshTree = useCallback(async () => {
    try {
      await client.get("/api/fs/tree?path=.");
    } catch {
      /* 탐색기는 별도 패널에서 처리한다 */
    }
  }, []);
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [monitorCollapsed, setMonitorCollapsed] = useState(false);
  // §8.3 워크스페이스. **헤더에 항상** 루트를 보여야 한다 — 도구가 어디에 쓰는지
  // 모르는 상태로 일하게 두지 않는다.
  const [workspace, setWorkspace] = useState<WorkspaceFingerprint | null>(null);
  const [tree, setTree] = useState<{ name: string; kind: "dir" | "file"; size: number }[] | null>(null);
  // §5.3 Think + §5.4 블록. 델타는 WS 로 온다(폴링이 아니다).
  const [blocks, setBlocks] = useState<AgentBlock[]>([]);
  const [think, setThink] = useState<ThinkState>(() => initialThink());
  const [turnRunning, setTurnRunning] = useState(false);
  /** §7.4 진행 중인 다운로드 목록(WS 로 온다). */
  const [downloads, setDownloads] = useState<{ id: string; file: string; state: string; progress: number; totalBytes: number; receivedBytes: number; error: string | null }[]>([]);
  /** 복원했음을 사용자에게 **한 번** 말한다 — 조용히 복원되면 "왜 대화가 있지?" 가 된다. */
  const [restored, setRestored] = useState(0);
  const blocksRef = useRef<AgentBlock[]>([]);
  blocksRef.current = blocks;

  /** 열린 탭 목록 — 전환 계획을 서버에 보낼 때 필요하다(탭이 새 루트 밖에 있으면 닫혀야 한다). */
  const openTabs = useMemo(() => (openFile ? [openFile.path] : []), [openFile]);


  const pushToast = useCallback((t: Toast) => {
    setToasts((prev) => [t, ...prev.filter((x) => x.id !== t.id)].slice(0, 5));
  }, []);

  useEffect(() => {
    if (restored <= 0) return;
    pushToast({
      id: "session:restored",
      kind: "info",
      title: "이전 대화를 복원했습니다",
      body: `블록 ${restored}개 — 창을 닫아도 남습니다.`,
      at: Date.now(),
      ttlMs: 10_000,
      requiresAck: false,
      source: "session",
    });
  }, [restored, pushToast]);

  /**
   * 턴을 보낸다.
   *
   * **응답을 기다리지 않는다** — 델타는 WS 로 온다. 여기서 기다리면 "보냈는데 아무 반응이
   * 없다" 는 12초짜리 침묵이 생기고, 그 침묵을 사용자는 멈춘 것으로 읽는다. 요청이
   * 실패하면 **즉시** 말하고, 성공 여부도 서버가 WS 로 알려 준다.
   */
  const sendTurn = useCallback(async () => {
    const text = draft.trim();
    if (!text || turnRunning) return;
    setTurnRunning(true);
    // 사용자 입력을 대화 기록에 **먼저** 남긴다. WS 가 늦게 와도 순서가 뒤집히지 않는다.
    setBlocks((prev) => applyEvent(prev, { type: "agent.status", text: `전송: ${text.slice(0, 60)}`, at: Date.now() }));
    setDraft("");
    try {
      const r = await client.post<{ ok: boolean; detail: string }>("/api/agent/turn", { text });
      if (!r.ok) {
        setTurnRunning(false);
        pushToast({ id: "turn:fail", kind: "error", title: "턴을 시작하지 못했습니다", body: r.detail, at: Date.now(), ttlMs: 15_000, requiresAck: false, source: "agent" });
      }
    } catch (e) {
      setTurnRunning(false);
      pushToast({ id: "turn:fail", kind: "error", title: "턴 요청이 실패했습니다", body: e instanceof ApiError ? e.message : String(e), at: Date.now(), ttlMs: 15_000, requiresAck: false, source: "agent" });
    }
  }, [draft, turnRunning, pushToast]);

  const loadTree = useCallback(async () => {
    try {
      const t = await client.get<{ entries: { name: string; kind: "dir" | "file"; size: number }[] }>("/api/fs/tree?path=.");
      setTree(t.entries);
    } catch (e) {
      // **빈 배열이 아니라 실패를 보인다.** 탐색기가 조용히 비면 "폴더가 비었다" 로 읽힌다.
      setTree(null);
      pushToast({
        id: "tree:error",
        kind: "error",
        title: "탐색기를 읽지 못했습니다",
        body: e instanceof ApiError ? e.message : String(e),
        at: Date.now(),
        ttlMs: 10_000,
        requiresAck: false,
        source: "fs",
      });
    }
  }, [pushToast]);

  const openFileByPath = useCallback(async (path: string) => {
    try {
      const f = await client.get<{ path: string; content: string; version: number; size: number }>(
        `/api/fs/file?path=${encodeURIComponent(path)}`
      );
      setOpenFile(f);
    } catch (e) {
      pushToast({
        id: `open:${path}`,
        kind: "error",
        title: "파일을 열지 못했습니다",
        body: `${path} — ${e instanceof ApiError ? e.message : String(e)}`,
        at: Date.now(),
        ttlMs: 10_000,
        requiresAck: false,
        source: "fs",
      });
    }
  }, [pushToast]);

  // 부팅 상태 폴링 + 워크스페이스 지문
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const w = await client.get<{ current: WorkspaceFingerprint }>("/api/workspace");
        if (!alive) return;
        setWorkspace(w.current);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
      await loadTree();
    })();
    return () => {
      alive = false;
    };
  }, [loadTree]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [b, g] = await Promise.all([client.get<{ steps: BootStep[] }>("/api/bootstrap"), client.get<GpuInfo>("/api/gpu")]);
        if (!alive) return;
        setSteps(b.steps);
        setGpu(g);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // 로그 + 계측 스트리밍 (§2.3 · §5.5)
  useEffect(() => {
    const idePort = Number(new URL(location.href).port || 7317);
    const ws = new WsClient({
      port: idePort,
      token,
      onEvent: (ev) => {
        // **모든 패널이 이 소켓을 공유한다**(wsBus). 패널이 따로 열면 재연결이 N 배로
        // 되고 PTY 출력을 놓친다.
        dispatchWs(ev);
        const evType = String(ev.type);
        if (ev.type === "log.append") {
          const e2 = ev.entry as LogEntry | undefined;
          if (!e2) return;
          setLogs((prev) => {
            const last = prev[prev.length - 1];
            if (last && e2.seq <= last.seq) return prev;
            const next = [...prev, e2];
            return next.length > 2000 ? next.slice(next.length - 2000) : next;
          });
        } else if (ev.type === "log.status") {
          setLogStatus(ev.status as typeof logStatus);
        } else if (ev.type === "sys.metrics") {
          const m = (ev.metrics ?? null) as Metrics | null;
          setMetrics(m);
          if (m) setMetricSeries((prev) => [...prev, m.cpu.overall].slice(-120));
        } else if (ev.type === "model.download") {
          // §7.4 진행률. **모르면 모른다고 말하는 값** 을 그대로 옮긴다(0% 는 "0 바이트" 다).
          const item = ev.item as { id: string; file: string; state: string; progress: number; totalBytes: number; receivedBytes: number; error: string | null } | undefined;
          if (item) setDownloads((prev) => [...prev.filter((d) => d.id !== item.id), item]);
        } else if (evType.startsWith("agent.")) {
          // **모든 에이전트 이벤트를 한 곳에서** 블록으로 바꾼다. 분기마다 따로
          // 처리하면 순서가 뒤집히고(상태 문구가 답변 뒤에 붙는다) 되돌리기 어렵다.
          if (evType === "agent.reasoning") {
            setThink((s) => ({ ...ingest(s, { reasoning: String(ev.text ?? "") }), startedAt: s.startedAt ?? Date.now() }));
          }
          if (evType === "agent.done" || evType === "agent.error") setTurnRunning(false);
          if (evType === "agent.status" && /응답 중/.test(String(ev.text ?? ""))) setTurnRunning(true);
          if (evType === "agent.done" || evType === "agent.error") setThink((s) => finish(s));
          setBlocks((prev) =>
            applyEvent(prev, {
              type: evType,
              text: (ev.text ?? ev.path) as string | undefined,
              tool: ev.tool as AgentBlock["tool"],
              at: Number(ev.at ?? Date.now()),
            })
          );
        } else if (ev.type === "workspace.changed") {
          // 다른 곳(팔레트·다른 창)에서 루트가 바뀌었다. 화면을 **모으지 않으면** 사용자는
          // 옛 폴더에 계속 쓰게 된다.
          const change = ev.change as { to?: WorkspaceFingerprint; switchPlan?: { warnings?: string[] } } | undefined;
          if (change?.to) setWorkspace(change.to);
          setOpenFile(null); // 열린 파일은 새 루트 밖에 있을 수 있다 — 닫고 다시 고른다
          void loadTree();
          for (const w of change?.switchPlan?.warnings ?? []) {
            pushToast({
              id: `ws:${w.slice(0, 12)}`,
              kind: "warn",
              title: "워크스페이스가 바뀌었습니다",
              body: w,
              at: Date.now(),
              ttlMs: 15_000,
              requiresAck: false,
              source: "workspace",
            });
          }
        } else if (ev.type === "fs.changed") {
          // 자기 쓰기가 아니므로 외부 편집이다 — 사용자에게 **왜** 알리는지 말해야 한다.
          const p = String(ev.path ?? "");
          if (p) {
            pushToast({
              id: `fs:${p}`,
              kind: "info",
              title: "디스크에서 변경됨",
              body: `${p} — 버퍼가 최신이 아닐 수 있습니다. 새로고침 하십시오.`,
              at: Date.now(),
              ttlMs: 10_000,
              requiresAck: false,
              source: "fs",
            });
          }
        }
      },
      onStatus: (s) => setWsState(s),
    });
    ws.connect();

    void (async () => {
      try {
        const r = await client.get<{ entries: LogEntry[]; status: typeof logStatus }>("/api/logs?limit=500");
        setLogs((prev) => (prev.length > 0 ? prev : r.entries));
        setLogStatus(r.status);
      } catch {
        /* WS 로 이어진다 */
      }
      try {
        const m = await client.get<{ latest: Metrics | null; series: (number | null)[] }>("/api/metrics");
        setMetrics(m.latest);
        setMetricSeries(m.series ?? []);
      } catch {
        /* 계측은 나중에 온다 */
      }
      try {
        const v = await client.get<{ model: string | null }>("/api/system/version");
        setModelName(v.model);
      } catch {
        /* 없으면 모델 미연결 상태를 보여준다 */
      }
    })();

    return () => ws.close();
  }, [pushToast]);

  // M7: 입력창 드래프트 자동 저장 — **서버 상태와 무관하게** (창 스코프)
  useEffect(() => {
    saveDraft({ text: draft, savedAt: Date.now(), attachments: [] }, typeof localStorage !== "undefined" ? localStorage : null);
  }, [draft]);

  // §5.10 — **새로고침/서버 재시작** 에서만 세션을 복원한다.
  // WS 재연결에서 이걸 부르면 스트리밍 중 화면이 통째로 바뀐다(§5.10 금지).
  // 구분은 `planRestore` 가 하고, 여기서는 WS 상태가 **닫힘→열림** 을 거친 경우에만
  // 복원을 시도한다. 최초 로드에서도 복원을 시도하는 것이 "새로고침" 이다.
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (wsState !== "open" || restoredOnce.current) return;
    restoredOnce.current = true;
    void (async () => {
      try {
        const cur = await client.get<{ id: string | null; blocks: { id: string; kind: string; title: string; content: unknown; createdAt: number }[]; saved: boolean }>(
          "/api/session/current"
        );
        if (!cur.id || cur.blocks.length === 0) return;
        // **빈 화면으로 덮지 않는다.** 지금 화면에 블록이 있으면(스트리밍 중) 붙인다.
        if (blocksRef.current.length > 0) return;
        setBlocks(
          cur.blocks.map((b, i) => ({
            id: b.id || `restored-${i}`,
            kind: (b.kind as AgentBlock["kind"]) ?? "text",
            text: typeof b.content === "string" ? b.content : (b.title ?? ""),
            at: b.createdAt ?? Date.now(),
          }))
        );
        setRestored(cur.blocks.length);
      } catch {
        // 복원 실패는 조용히 넘어간다 — 창이 뜨는 것을 막을 이유는 없다.
      }
    })();
  }, [wsState]);

  // M5 팔레트
  const commands: Command[] = useMemo(
    () => [
      { id: "view.toggleLog", title: "로그 패널 접기/펼치기", category: "보기", keys: [], run: "view.toggleLog()" },
      { id: "view.toggleMonitor", title: "모니터 패널 접기/펼치기", category: "보기", keys: [], run: "view.toggleMonitor()" },
      { id: "palette.open", title: "명령 팔레트", category: "기타", keys: ["Ctrl+K"], run: "palette.open()" },
    ],
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      } else if (e.altKey && e.key.startsWith("Arrow")) {
        // §5.8: 드래그 없이도 패널을 이동할 수 있어야 한다
        const map: Record<string, Zone> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" };
        const target = map[e.key];
        if (!target) return;
        e.preventDefault();
        setLayout((l) => {
          const focused = l.panels.find((p) => !p.collapsed && p.zone !== "center") ?? l.panels[0];
          const next = keyboardMove(focused.zone, target === "left" ? -1 : target === "right" ? 1 : 0, target === "top" ? -1 : target === "bottom" ? 1 : 0);
          return movePanel(l, focused.id as PanelId, next);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * 패널 본문. **존과 무관하게** 같은 내용 — 패널이 옮겨가면 내용까지 바뀌면
   * 사용자는 "어디로 옮긴 거지?" 하고 헤더만 찾게 된다.
   */
  const BODY: Partial<Record<PanelId, React.ReactNode>> = {
    explorer: (
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* 루트를 바꾼 뒤에도 **무엇이 바뀌었는지**가 보인다 — 지문을 여기서 읽는다. */}
        <div style={{ padding: "4px 8px", borderBottom: `1px solid ${BORDER}`, color: DIM, fontSize: 10 }}>
          {workspace ? (
            <>
              {workspace.kind.map((k) => k).join("/")} · 규칙 {workspace.rules.length}개
              {workspace.packageManager ? ` · ${workspace.packageManager}` : ""}
              {workspace.buildHint ? ` · 빌드: ${workspace.buildHint}` : ""}
            </>
          ) : (
            "지문 계산 중"
          )}
        </div>
        {tree === null ? (
          <Empty title={t("empty.treeFailed.title")} hint={t("empty.treeFailed.hint")} actions={[{ label: t("action.retry"), onClick: () => void loadTree() }]} />
        ) : tree.length === 0 ? (
          <Empty title={t("empty.folderEmpty.title")} hint={t("empty.folderEmpty.hint", { root: workspace?.root ?? "" })} />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 4 }}>
            {tree.map((e) => (
              <li key={e.name}>
                <button
                  type="button"
                  onClick={() => (e.kind === "file" ? void openFileByPath(e.name) : void loadTree())}
                  disabled={e.kind === "dir"}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "none",
                    border: 0,
                    color: e.kind === "dir" ? FG : DIM,
                    padding: "2px 6px",
                    cursor: e.kind === "file" ? "pointer" : "default",
                    font: "inherit",
                    fontSize: 11,
                  }}
                >
                  {e.kind === "dir" ? "▸ " : "· "}
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
    agent: (
      <>
        {/* M3 재개 배너 — **있을 때만** 나타난다. 항상 보이면 경고가 무시된다. */}
        <ResumeBanner
          client={client}
          running={turnRunning}
          onResumed={() => setBlocks((prev) => prev)}
          onNotice={(kind, title, body) =>
            pushToast({ id: `agent:${title}`, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "agent" })
          }
        />
      <AgentPanel
        blocks={blocks}
        running={turnRunning}
        think={think}
        onStyle={(s: ThinkStyle) => setThink((prev) => ({ ...prev, style: s }))}
        onThinking={(on) => {
          setThink((prev) => initialThink({ enabled: on, style: prev.style }));
          void client.post("/api/agent/thinking", { enabled: on }).catch((e) =>
            pushToast({ id: "think:fail", kind: "error", title: "thinking 설정을 보내지 못했습니다", body: String(e), at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "agent" })
          );
        }}
        onCancel={() => void client.post("/api/agent/cancel")}
      />
      </>
    ),
    // §9.3 커밋. diff(한 파일 비교)와 **커밋(저장소 전체)** 은 다른 일이라 같은
    // 존에 둘 수 있지만 같은 패널은 아니다 — 요구 16 의 커밋 단계가 여기다.
    diff: diff ? (
      <>
        <DiffPanel path={diff.path} oldText={diff.oldText} newText={diff.newText} source="file" onClose={() => setDiff(null)} />
        <CommitBox
          client={client}
          onNotice={(kind, title, body) =>
            pushToast({ id: `git:${title}`, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "git" })
          }
        />
      </>
    ) : (
      <CommitBox
        client={client}
        onNotice={(kind, title, body) =>
            pushToast({ id: `git:${title}`, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "git" })
      }
      />
    ),
    editor: openFile ? (
      <EditorView
        client={client}
        info={openFile}
        onNotice={(kind, title, body) =>
          pushToast({ id: `fs:${title}`, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "fs" })
        }
      />
    ) : (
      <Empty
        title={t("empty.noFile.title")}
        hint={t("empty.noFile.hint")}
        actions={[{ label: t("action.refresh"), onClick: () => void refreshTree() }, ...EXAMPLES.slice(0, 1).map((ex) => ({ label: t("empty.noFile.example"), onClick: () => setDraft(ex) }))]}
      />
    ),
    terminal: (
      <TerminalView
        client={client}
        onNotice={(kind, title, body) =>
          pushToast({ id: `term:${title}`, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "terminal" })
        }
      />
    ),
    settings: (
      <ModelPanel
        client={client}
        onNotice={(kind, title, body) =>
          pushToast({ id: `models:${title}`, kind, title, body, at: Date.now(), ttlMs: 15_000, requiresAck: false, source: "models" })
        }
        onPhase={(p) => {
          // 진행 단계는 **한 줄로** 보인다(§11.3: 무언가 happening 하고 있어야 한다).
          setBlocks((prev) => applyEvent(prev, { type: "agent.status", text: `[업데이트] ${p.message}`, at: Date.now() }));
        }}
      />
    ),
  };

  const visible = useMemo(() => visibleTail(filterEntries(logs, filter), 2000), [logs, filter]);
  const hits = useMemo(() => searchCommands(commands, paletteQuery, 12), [commands, paletteQuery]);
  // 로그 패널은 항상 최하단에 붙으므로 배치 대상에서 제외한다(§5.12 닫을 수 없음).
  const zones = useMemo(
    () => groupByZone(layout.panels.filter((p) => p.id !== "log").map((p) => ({ id: p.id, zone: p.zone }))),
    [layout],
  );
  /** 입력창을 그릴 열. **정확히 하나** — 두 곳에 그리면 같은 입력창이 두 개 보인다. */
  const inputZone: Zone = zones.right.includes("agent")
    ? "right"
    : zones.left.includes("agent")
      ? "left"
      : zones.center.includes("agent")
        ? "center"
        : "center";
  // 열 폭도 존에 따라 정한다 — 없는 열은 만들지 않는다(빈 공간을 남기면 낭비다).
  const gridCols = `${zones.left.length ? "260px " : ""}1fr${zones.right.length ? " 380px" : ""}`;
  const gridRows = ["28px", ...(zones.top.length ? ["auto"] : []), "1fr", "auto"].join(" ");
  const full = bufferFullLabel(logStatus);
  const bootDone = steps?.filter((s) => s.ok).length ?? 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: gridCols,
        gridTemplateRows: "28px 1fr auto",
        height: "100vh",
        background: BG,
        color: FG,
        font: "12px/1.5 system-ui, -apple-system, 'Noto Sans KR', sans-serif",
      }}
    >
      {/* 상단 바 */}
      <header style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 12, padding: "0 10px", borderBottom: `1px solid ${BORDER}`, background: "#161b22" }}>
        <strong>harnesside</strong>
        {/* 지금 어디에 쓰고 있는지 — **항상** 보인다(§8.3). */}
        <WorkspaceBar
          client={client}
          current={workspace}
          openTabs={openTabs}
          onError={(m) => {
            setError(m);
            pushToast({ id: "ws:error", kind: "error", title: "워크스페이스 전환 실패", body: m, at: Date.now(), ttlMs: 15_000, requiresAck: false, source: "workspace" });
          }}
          onSwitched={({ to }) => {
            setWorkspace(to);
            setOpenFile(null);
            void loadTree();
            pushToast({
              id: "ws:switched",
              kind: "info",
              title: "워크스페이스를 바꿨습니다",
              body: `${to.name} — 도구 호출 기준도 여기로 바뀝니다.`,
              at: Date.now(),
              ttlMs: 10_000,
              requiresAck: false,
              source: "workspace",
            });
          }}
        />
        <span style={{ color: DIM }}>{modelName ?? "모델 미연결"}</span>
        {steps && <span style={{ color: DIM }}>{t("app.booting", { stage: bootDone, total: steps.length })}</span>}
        {full && <span style={{ color: full.color, fontSize: 11 }} title="로그 상한">{full.text}</span>}
        {error && <span style={{ color: "#f85149" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: wsState === "open" ? "#3fb950" : wsState === "connecting" ? "#d29922" : "#f85149" }} title="WebSocket 연결 상태">
          {wsState === "open" ? "● 실시간" : wsState === "connecting" ? "○ 연결 중" : "▲ 끊김"}
        </span>
      </header>

      {/* 상단 도크 — 전용 행. 중앙 열에 넣으면 라벨이 거짓말이 된다(§5.4·§5.8). */}
      {zones.top.length > 0 && (
        <div
          style={{
            gridRow: 2,
            gridColumn: "1 / -1",
            display: "flex",
            flexDirection: "row",
            gap: 6,
            padding: 6,
            minWidth: 0,
            borderBottom: `1px solid ${BORDER}`,
            maxHeight: 280,
          }}
        >
          {zones.top.map((id) => (
            <div key={id} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <Panel
                title={t(TITLE_KEY[id] ?? `panel.${id}`)}
                zone="top"
                collapsed={panelOf(layout, id)?.collapsed}
                onToggle={() => setLayout((l) => toggleCollapse(l, id))}
                onMove={(target) => setLayout((l) => movePanel(l, id, target))}
              >
                {BODY[id]}
              </Panel>
            </div>
          ))}
        </div>
      )}

      {/* 좌 / 중앙 / 우 — **존에서 계산한다**(고정 그리드 아님) */}
      {(["left", "center", "right"] as const).map((zone) => {
        const ids = zones[zone];
        if (ids.length === 0) return null;
        return (
          <div
            key={zone}
            style={{
              // 상단 도크가 있으면 본체는 그 다음 행이다.
              gridRow: zones.top.length > 0 ? 3 : 2,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 6,
              minHeight: 0,
              minWidth: 0,
              borderRight: zone === "right" ? "none" : `1px solid ${BORDER}`,
            }}
          >
            {ids.map((id) => {
              const p = panelOf(layout, id);
              const z = p?.zone ?? zone;
              const move = (target: Zone) => setLayout((l) => movePanel(l, id, target));
              const toggle = () => setLayout((l) => toggleCollapse(l, id));
              if (id === "monitor") {
                return <MonitorPanel key={id} latest={metrics} series={metricSeries} collapsed={p?.collapsed} onToggle={toggle} />;
              }
              return (
                <Panel key={id} title={t(TITLE_KEY[id] ?? `panel.${id}`)} zone={z} collapsed={p?.collapsed} onToggle={toggle} onMove={move}>
                  {BODY[id]}
                </Panel>
              );
            })}
            {/* 입력창은 **한 곳에만** 렌더한다. 에이전트 열이 있으면 그 열에,
                없으면 중앙에. 두 열에 다 그리면 같은 입력창이 두 개 보이고
                어느 쪽에 썼는지 모른다(실제로 그렇게 났다). */}
            {zone === inputZone && (
              <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, display: "flex", flexDirection: "column", flex: "0 0 auto" }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="무엇을 할까요? (실수로 창을 닫아도 입력 내용은 남습니다)"
                  style={{ background: "transparent", color: FG, border: 0, outline: "none", resize: "none", minHeight: 72, padding: 8, font: "inherit" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderTop: `1px solid ${BORDER}` }}>
                  <span style={{ fontSize: 10, color: DIM }}>{draft ? "드래프트 저장됨" : ""}</span>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    onClick={() => {
                      clearDraft(typeof localStorage !== "undefined" ? localStorage : null);
                      setDraft("");
                    }}
                    style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", fontSize: 11 }}
                  >
                    지우기
                  </button>
                  <button
                    type="button"
                    disabled={!draft.trim() || turnRunning}
                    onClick={() => void sendTurn()}
                    style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "3px 10px", cursor: draft.trim() && !turnRunning ? "pointer" : "default", font: "inherit" }}
                  >
                    {turnRunning ? "응답 중…" : "보내기"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* 하단: 로그 — 닫을 수 없는 기본 탭 (§5.12) */}
      <footer style={{ gridColumn: "1 / -1", borderTop: `1px solid ${BORDER}`, background: BG }}>
        <LogPanel entries={visible} status={logStatus ?? undefined} level={filter.level as LogLevel} onSetLevel={(l) => setFilter((f) => ({ ...f, level: l }))} height={layout.logHeight} filterLabel={filterLabel(filter)} />
      </footer>

      {/* 팔레트 */}
      {paletteOpen && (
        <div onClick={() => setPaletteOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,0.6)", display: "grid", placeItems: "start center", paddingTop: "12vh", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 520, background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 8, overflow: "hidden" }}>
            <input
              autoFocus
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              placeholder="명령 검색…"
              style={{ width: "100%", background: "transparent", border: 0, borderBottom: `1px solid ${BORDER}`, color: FG, padding: 10, outline: "none", font: "inherit" }}
            />
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              {hits.length === 0 && <div style={{ padding: 12, color: DIM }}>일치하는 명령이 없습니다</div>}
              {hits.map((h) => (
                <div key={h.cmd.id} style={{ padding: "6px 10px", display: "flex", gap: 8, borderBottom: `1px solid #21262d` }}>
                  <span>{h.cmd.title}</span>
                  <span style={{ color: DIM, fontSize: 10 }}>{h.cmd.category}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 알림 */}
      <div style={{ position: "fixed", right: 12, bottom: 12, display: "grid", gap: 6, zIndex: 40, width: 320 }}>
        {toasts.map((t) => (
          <div key={t.id} style={{ background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8, display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: t.kind === "error" ? "#f85149" : t.kind === "warn" ? "#d29922" : FG, fontSize: 12 }}>{t.title}</div>
              <div style={{ color: DIM, fontSize: 11 }}>{t.body}</div>
            </div>
            <button type="button" onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))} style={{ background: "none", border: 0, color: DIM, cursor: "pointer" }}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const el = document.getElementById("root");
if (el) {
  const { createRoot } = await import("react-dom/client");
  createRoot(el).render(<App />);
}
