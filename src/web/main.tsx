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
import { openView } from "../session/blocks.js";
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
    <div
      className="elev-1 elev-lift"
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        background: BG,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", background: "#161b22", borderBottom: `1px solid ${BORDER}`, flex: "0 0 auto" }}>
        {/* 패널 머리 — 본체보다 **한 단계 높은 면**(§elevation). 어두운 테마에서
            어두운 머리는 아래 본체에 **파묻혀** 계단처럼 보인다. 한 단계 밝아야
            "이건 바깥 덮개" 라 읽힌다. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 8px",
            background: "#161b22",
            borderBottom: `1px solid ${BORDER}`,
            borderTopLeftRadius: 5,
            borderTopRightRadius: 5,
            flex: "0 0 auto",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.045)",
          }}
        >
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
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const focusDraft = useCallback(() => draftRef.current?.focus(), []);
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
    // **사람이 보낸 말을 블록으로 남긴다** — 이것이 대화 묶음의 경계다(2026-10-01).
    // 예전에는 `전송: …` 라는 **상태 줄** 로만 남겼다. 그래서 묶음의 시작을 알 수
    // 없었고, "어떤 물음에 대한 답인지" 가 화면에 남지 않았다.
    setBlocks((prev) => applyEvent(prev, { type: "agent.user", text, at: Date.now() }));
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

  /** 헤더·셸·설정이 **같은 알림 경로**를 쓴다 — 한 종류의 알림이 화면 한 곳에 모인다. */
  const notice = useCallback(
    (kind: "info" | "warn" | "error", title: string, body: string, source = "app") =>
      pushToast({ id: `${source}:${title}`, kind, title, body, at: Date.now(), ttlMs: 12_000, requiresAck: false, source }),
    [],
  );

  const onModelPhase = useCallback((p: { state: string; progress: number; message: string }) => {
    setBlocks((prev) => applyEvent(prev, { type: "agent.status", text: `[업데이트] ${p.message}`, at: Date.now() }));
  }, []);

  /**
   * 명령 팔레트 (M5) — 2026-10-01.
   *
   * 여기의 `run` 은 예전부터 **문자열**이었고 **아무도 실행하지 않았다**(실측:
   * `grep '\.run' src/web/` 의 결과는 검색 대상 비교뿐). 팔레트에서 Enter 를 눌러도
   * 아무 일도 없었고, 화면은 **정상처럼** 명령 목록을 보여줬다. 조용히 안 되는 메뉴는
   * 죽었다고 알아채기 가장 어렵다.
   *
   * 그래서 **함수**로 바꿨다. 그리고 목록에 있던 세 항목이 **실제로 무엇을 하는지** 를
   * 지금 있는 기능에 맞췄다 — 없는 기능을 팔레트에 적어두면 그것도 조용한 거짓말이다.
   */
  const commands: Command[] = useMemo(
    () => [
      { id: "view.toggleLog", title: "서버 로그 접기/펼치기", category: "보기", keys: [], run: () => setLogOpen((v) => !v) },
      { id: "view.biggerShell", title: "셸 영역 키우기", category: "보기", keys: [], run: () => setBottomH((h) => Math.max(160, h - 80)) },
      { id: "view.smallerShell", title: "셸 영역 줄이기", category: "보기", keys: [], run: () => setBottomH((h) => Math.min(window.innerHeight * 0.7, h + 80)) },
      { id: "view.resetShell", title: "셸 영역 크기 초기화", category: "보기", keys: [], run: () => setBottomH(260) },
      {
        id: "view.openSettings",
        title: "설정 열기",
        category: "설정",
        keys: [],
        // **별도 패널이 아니라 대화 안의 블록**으로 연다(2026-10-01 요구).
        run: () => setBlocks((prev) => openView(prev, { what: "settings" }, Date.now())),
      },
      {
        id: "view.openDiff",
        title: "변경 검토 열기",
        category: "보기",
        keys: [],
        run: () => setBlocks((prev) => openView(prev, { what: "diff" }, Date.now())),
      },
      {
        id: "terminal.newShell",
        title: "새 셸 열기",
        category: "기타",
        keys: [],
        run: () => client.post("/api/terminal", {}).catch((e) => notice("warn", "셸을 열지 못했습니다", String(e))),
      },
      { id: "palette.open", title: "명령 팔레트", category: "기타", keys: ["Ctrl+K"], run: () => setPaletteOpen((v) => !v) },
    ],
    [client, notice],
  );

  /**
   * 설정 화면 — **`BODY` 보다 먼저** 만든다.
   *
   * 순서가 중요한 이유: 설정은 대화 **안의 블록**으로 그려지는데, 그 블록을 그리는
   * `AgentPanel` 은 `BODY` **안**에 있다. 즉 `BODY` 가 설정 노드를 필요로 하고,
   * `BODY` 안의 `AgentPanel` 이 같은 노드를 다시 받아야 한다 — 순서가 뒤집히면
   * "선언 전 사용" 이 된다. 그래서 먼저 만들고 **두 곳이 공유**한다.
   *
   * deps 가 안정적이어야 한다 — `ModelPanel` 은 이 값으로 `useEffect` 를 돌고,
   * 값이 매 렌더 바뀌면 무한 요청이 된다(2026-10-01 실측: `/api/models` 5초 3303회).
   */
  const settingsNode = useMemo(
    () => <ModelPanel client={client} onNotice={notice} onPhase={onModelPhase} />,
    [client, notice, onModelPhase],
  );
  const viewExtra = useMemo(() => ({ settings: settingsNode }), [settingsNode]);

  /**
   * 패널 본문. **존과 무관하게** 같은 내용 — 패널이 옮겨가면 내용까지 바뀌면
   * 사용자는 "어디로 옮긴 거지?" 하고 헤더만 찾게 된다.
   */
  const BODY: Partial<Record<PanelId, React.ReactNode>> & Record<string, React.ReactNode> = {
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
        client={client}
        onOpenView={(what, path) => setBlocks((prev) => openView(prev, path ? { what, path } : { what }, Date.now()))}
        viewExtra={viewExtra}
        running={turnRunning}
        // 상태바 — 이미 **앱 전체가 하나씩** 붙들고 있는 값을 **읽기만** 넘긴다.
        // 여기서 WS 를 새로 붙들면 소켓이 두 개 생기고 재연결이 두 배가 된다.
        wsState={wsState}
        context={metrics?.context ?? null}
        think={think}
        onStyle={(s: ThinkStyle) => setThink((prev) => ({ ...prev, style: s }))}
        onThinking={(on) => {
          setThink((prev) => initialThink({ enabled: on, style: prev.style }));
          void client.post("/api/agent/thinking", { enabled: on }).catch((e) =>
            pushToast({ id: "think:fail", kind: "error", title: "thinking 설정을 보내지 못했습니다", body: String(e), at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "agent" })
          );
        }}
        onCancel={() => void client.post("/api/agent/cancel")}
        // 예시는 **채우기만** 한다. 바로 보내면 사용자가 고칠 기회를 잃는다 —
        // "누르는 즉시 실행" 은 되돌리기 어렵다(§5.10: 무엇을 했는지 말해야 한다).
        onExample={(text) => {
          setDraft(text);
          focusDraft();
        }}
      />
      </>
    ),
    // §9.3 커밋. diff(한 파일 비교)와 **커밋(저장소 전체)** 은 다른 일이라 같은
    // 존에 둘 수 있지만 같은 패널은 아니다 — 요구 16 의 커밋 단계가 여기다.
    terminal: (
      <TerminalView
        client={client}
        onNotice={notice}
      />
    ),
    // ── 설정은 **패널이 아니라 대화 안의 블록**이다 (2026-10-01) ────────────────
    // `BODY` 의 키는 이제 "존에 놓는 패널" 이 아니라 **열 수 있는 것** 의 목록이다.
    // 설정은 머리 아이콘으로 열고 대화 사이에 블록으로 쌓인다 — 그래야 "무엇을
    // 설정하려다가 무엇을 봤나" 가 한 스크롤로 이어진다.
    settings: settingsNode,

  };

  const visible = useMemo(() => visibleTail(filterEntries(logs, filter), 2000), [logs, filter]);
  const hits = useMemo(() => searchCommands(commands, paletteQuery, 12), [commands, paletteQuery]);
  const full = bufferFullLabel(logStatus);
  const bootDone = steps?.filter((s) => s.ok).length ?? 0;

  // ── 셸 구조 (2026-10-01 사용자 사양) ─────────────────────────────────────────
  //
  //   ┌──────────────────────────────────────────────┐
  //   │  에이전트 출력  (가장 넓게, 화면 중앙 위)      │  ← 1fr
  //   ├──────────────────────────────────────────────┤
  //   │  프롬프트 입력창                              │  ← 고정
  //   ├───────────────────────────────┬──────────────┤
  //   │  셸(터미널)                   │  계측 상태  │  ← 하단, 가변 배분
  //   │                               │  (전부 노출) │     + 리사이즈
  //   ├───────────────────────────────┴──────────────┤
  //   │  서버 로그 (접힘 기본)                        │
  //   └──────────────────────────────────────────────┘
  //
  // **왜 좌우 존을 없앴나**: 좌우에 260px 과 380px 을 두면 1600px 창에서 **46%** 가
  // 대화가 아니다. 이 프로그램의 첫 화면은 대화다. 계측은 읽는 게 아니라 **확인하는**
  // 것이므로 좁은 폭으로 충분하고, 그 폭을 대화에 주는 게 낫다.
  //
  // **계측 패널 폭의 근거**: 게이지 4개가 나란히 들어갈 최소 폭. 이보다 좁으면 줄이
  // 접히고, 그것은 "전부 노출" 이라는 요구를 어긴다. 300px 은 4개 게이지(각 72px +
  // 라벨)가 딱 들어가는 폭이다.
  const MONITOR_MIN_W = 300;
  const [monitorW, setMonitorW] = useState(MONITOR_MIN_W);
  const [bottomH, setBottomH] = useState(() => {
    try {
      return Number(localStorage.getItem("harnesside.bottomH")) || 260;
    } catch {
      return 260;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("harnesside.bottomH", String(Math.round(bottomH)));
    } catch {
      /* 저장 불가 — 이번 실행에만 적용 */
    }
  }, [bottomH]);

  /** 로그 접힘 — **기본 접힘**(2026-10-01). 데몬 상태 창이지 매번 보는 창이 아니다. */
  const [logOpen, setLogOpen] = useState(() => {
    try {
      return localStorage.getItem("harnesside.logOpen") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("harnesside.logOpen", logOpen ? "1" : "0");
    } catch {
      /* 저장 불가 — 접힘 상태만 이번 실행에 적용된다 */
    }
  }, [logOpen]);

  return (
    <div
      style={{
        display: "grid",
        // 열은 **하나**다. 좌우 존을 없앴으므로 좌우로 줄 것이 없다(2026-10-01).
        gridTemplateColumns: "1fr",
        // 행: 상단 바 · **에이전트(1fr)** · 프롬프트 · 하단(셸+계측) · 로그
        gridTemplateRows: `28px 1fr auto ${bottomH}px ${logOpen ? `${layout.logHeight}px` : "28px"}`,
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


      {/* ── ① 에이전트 출력 (메인) ────────────────────────────────────────────
          화면 중앙 위를 **가장 넓게** 차지한다(2026-10-01 사양). 이 앱의 첫 화면은
          대화이고, 좌우 존을 없애면서 대화에 폭을 전부 줬다. */}
      <div style={{ gridRow: 2, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", padding: "6px 6px 0" }}>
        <div className="elev-1" style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {BODY.agent}
        </div>
      </div>

      {/* ── ② 프롬프트 입력창 (에이전트 바로 아래) ────────────────────────────
          요구: "하단에는 프롬프트 입력 창이됨". 대화의 **바로 아래**에 있어야
          문맥이 이어진다 — 아래쪽 셸 영역에 두면 "무엇을 하려는지" 와 "무엇을 보고
          있는가" 가 화면 양 끝으로 벌어진다. */}
      <div style={{ gridRow: 3, padding: "6px", display: "flex" }}>
        <div
          className="elev-1"
          style={{ flex: 1, border: `1px solid ${BORDER}`, borderRadius: 6, display: "flex", flexDirection: "column", background: BG, overflow: "hidden" }}
        >
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // **Enter 로 보내고 Shift+Enter 로 줄바꿈** — 대화창의 최대 규칙(§5.7).
              // 키보드 중심 개발자에게 이것 없으면 다 줄을 Shift+Enter 로 눌러야 한다.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (draft.trim() && !turnRunning) void sendTurn();
              }
            }}
            placeholder="무엇을 할까요? (Enter 로 전송 · Shift+Enter 로 줄바꿈 · 창을 닫아도 입력 내용은 남습니다)"
            style={{ background: "transparent", color: FG, border: 0, outline: "none", resize: "none", minHeight: 64, maxHeight: 220, padding: 8, font: "inherit" }}
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
      </div>

      {/* ── ③ 하단: 셸(가변) + 계측(최소 폭, 전부 노출) ──────────────────────
          요구: "패널간에는 사이즈가 플랙스하게 조정이 가능함" · "cpu 등 상태표시
          내용은 제일 하단의 쉘 영역 우측에 최소 사이즈로 모두 다 노출될 수 있는
          높이를 유지하면서 폭을 설정해서 반영해줘"

          즉 (a) 둘 사이에 **드래그 경계선**이 있고, (b) 계측은 **줄이 보이지
          않게** — 즉 자체 스크롤이 없어야 한다(2026-10-01 앞선 요구: "항상 전체를
          보여줘야"). */}
      <div style={{ gridRow: 4, display: "flex", minHeight: 0, minWidth: 0, padding: "0 6px 6px", gap: 0 }}>
        <div className="elev-1" style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {BODY.terminal}
        </div>

        {/* 리사이저 — **키보드로도** 잡을 수 있게 했다. 마우스만으로는 "고정돼 있나?"
           를 알 수 없다(M8: 키보드만으로 조작 가능해야 한다). */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="패널 크기 조절"
          tabIndex={0}
          onPointerDown={(e) => {
            const startX = e.clientX;
            const startW = monitorW;
            const move = (ev: PointerEvent) => {
              // **왼쪽으로 끌면 계측이 넓어진다** — 시작점 대비의 변화량을 그대로 쓴다.
              setMonitorW(Math.max(MONITOR_MIN_W, Math.min(window.innerWidth * 0.6, startW - (ev.clientX - startX))));
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setMonitorW((w) => Math.max(MONITOR_MIN_W, w + 24));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              setMonitorW((w) => Math.max(MONITOR_MIN_W, w - 24));
            }
          }}
          style={{ width: 6, flex: "0 0 auto", cursor: "col-resize", background: "transparent" }}
          onDoubleClick={() => setMonitorW(MONITOR_MIN_W)}
        />
        <div
          className="elev-1"
          style={{
            flex: `0 0 ${monitorW}px`,
            width: monitorW,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* **접지 않는다** — 계측은 언제나 보인다. 접으면 "이제 CPU 가 갑자기
              100% 가 됐는데 왜 아무 말도 없지" 가 된다(요구: "전부 다 노출"). */}
          <MonitorPanel latest={metrics} series={metricSeries} />
        </div>
      </div>

      {/* 로그 — **닫을 수 없는 기본 탭**(§5.12)이지만 **접을 수 있다**(2026-10-01).
          "닫을 수 없음" 은 사라져서는 안 된다는 뜻이지, 항상 펼쳐 두어야 한다는 뜻이 아니다.
          접었을 때 **마지막 줄** 이 보인다 — 로그가 무언가를 하고 있다는 사실 자체가
          제일 중요한 신호이고, 그걸 숨기면 "멈췄다" 고 읽힌다. */}
      <footer
        style={{
          gridColumn: "1 / -1",
          borderTop: `1px solid ${BORDER}`,
          background: BG,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {!logOpen && (
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            aria-expanded={false}
            title="서버 로그 펼치기"
            style={{
              display: "flex", gap: 8, alignItems: "center",
              background: "none", border: 0, color: DIM, cursor: "pointer",
              font: "inherit", fontSize: 11, padding: "4px 10px", textAlign: "left", width: "100%",
            }}
          >
            <span>▴ 서버 로그</span>
            {/* **내용이 있으면 접어도 보여준다.** 몇 줄인지 말하지 않으면
                "접었으니 0 건" 으로 읽힌다 — 실제로는 계속 쌓이고 있다. */}
            {visible.length > 0 && (
              <span style={{ color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {visible[visible.length - 1].message}
              </span>
            )}
            <span style={{ marginLeft: "auto" }}>
              {visible.length.toLocaleString("ko-KR")}줄
            </span>
          </button>
        )}
        {logOpen && (
          <>
            <button
              type="button"
              onClick={() => setLogOpen(false)}
              aria-expanded={true}
              style={{
                display: "flex", gap: 8, alignItems: "center",
                background: "none", border: 0, color: DIM, cursor: "pointer",
                font: "inherit", fontSize: 11, padding: "2px 10px", textAlign: "left",
              }}
            >
              <span>▾ 서버 로그</span>
              <span style={{ marginLeft: "auto" }}>접기</span>
            </button>
            <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
              <LogPanel entries={visible} status={logStatus ?? undefined} level={filter.level as LogLevel} onSetLevel={(l) => setFilter((f) => ({ ...f, level: l }))} height={layout.logHeight} filterLabel={filterLabel(filter)} />
            </div>
          </>
        )}
      </footer>

      {/* 팔레트 */}
      {paletteOpen && (
        <div onClick={() => setPaletteOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,0.6)", display: "grid", placeItems: "start center", paddingTop: "12vh", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} className="elev-3" style={{ width: 520, background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 8, overflow: "hidden" }}>
            <input
              autoFocus
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              placeholder="명령 검색…"
              style={{ width: "100%", background: "transparent", border: 0, borderBottom: `1px solid ${BORDER}`, color: FG, padding: 10, outline: "none", font: "inherit" }}
            />
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              {hits.length === 0 && <div style={{ padding: 12, color: DIM }}>일치하는 명령이 없습니다</div>}
              {/* **이 항목들은 선택 가능하다.** 예전에는 `div` 였고 `onClick` 도
                  `Enter` 처리도 **없었다** — 화면은 "메뉴" 처럼 보이는데 눌러도 아무
                  일도 없었다(2026-10-01 실측). 조용히 안 되는 메뉴는 죽었다고
                  알아채기 가장 어렵다: 목록이 보이므로 "기능이 없다" 가 아니라
                  "이 몇 개가 말썽이다" 고 읽힌다.

                  그래서 `button` 이고, 고른 항목은 **반드시 `run` 을 실행**한다.
                  실패하면 **사유를 말한다** — 조용히 닫으면 "뭘 눌렀는지" 가 사라져
                  아무 일도 없었다고 읽힌다. */}
              {hits.map((h) => (
                <button
                  key={h.cmd.id}
                  type="button"
                  onClick={() => {
                    setPaletteOpen(false);
                    try {
                      void h.cmd.run();
                    } catch (e) {
                      notice("error", "명령을 실행하지 못했습니다", e instanceof Error ? e.message : String(e));
                    }
                  }}
                  style={{
                    display: "flex", gap: 8, width: "100%", textAlign: "left",
                    padding: "6px 10px", background: "none", border: 0,
                    borderBottom: "1px solid #21262d", color: FG,
                    cursor: "pointer", font: "inherit",
                  }}
                >
                  <span style={{ flex: 1 }}>{h.cmd.title}</span>
                  <span style={{ color: DIM, fontSize: 10 }}>{h.cmd.category}</span>
                  {h.cmd.keys.length > 0 && <span style={{ color: DIM, fontSize: 10 }}>{h.cmd.keys.join(" ")}</span>}
                </button>
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
