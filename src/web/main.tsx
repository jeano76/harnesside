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
import { MonitorPanel } from "./panels/MonitorPanel.js";
import { DiffPanel } from "./editor/DiffPanel.js";
import { planOpen, formatBytes } from "./editor/model.js";
import { WsClient } from "./wsClient.js";
import { DEFAULT_LAYOUT, movePanel, toggleCollapse, keyboardMove, panelOf, zoneLabel, type PanelId, type Zone } from "./layout/engine.js";
import { loadDraft, saveDraft, clearDraft, searchCommands, type Command, type Toast } from "./panels/notify.js";
import { filterEntries, defaultFilter, visibleTail, bufferFullLabel, filterLabel, type Filter, type LogLevel } from "./panels/logFilter.js";
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
 *  패널이 옮겨갈 때 제목까지 바뀐다(사용자가 못 찾는다). */
const TITLES: Record<string, string> = {
  explorer: "탐색기",
  agent: "에이전트",
  editor: "에디터",
  diff: "변경 검토",
  monitor: "모니터",
  log: "서버 로그",
  settings: "설정",
};

/**
 * 파일 보기. **빈 패널을 두지 않는다**(§11.3) — 열려 있는 파일이 없으면
 * "무엇을 열 수 있나" 를 보여준다. 판정(`planOpen`)은 이미 검증된 모듈을 쓴다.
 */
function FileView({ info }: { info: { path: string; content: string; version: number; size: number } }) {
  const plan = useMemo(() => planOpen({ path: info.path, name: info.path.split("/").pop() ?? "", size: info.size }, info.content), [info]);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 8px", borderBottom: `1px solid ${BORDER}`, flex: "0 0 auto" }}>
        <strong style={{ fontSize: 11 }}>{info.path.split("/").pop()}</strong>
        <span style={{ color: DIM, fontSize: 10 }}>{plan.language}</span>
        {plan.readOnly && <span style={{ color: "#d29922", fontSize: 10 }}>읽기 전용</span>}
        <span style={{ flex: 1 }} />
        <span style={{ color: DIM, fontSize: 10 }}>{formatBytes(info.size)}</span>
      </div>
      {/* 못 열면 **이유** 를 말한다. 빈 화면이 되면 안 된다. */}
      {plan.reason && <div style={{ padding: "4px 8px", color: plan.readOnly ? "#d29922" : DIM, fontSize: 11 }}>{plan.reason}</div>}
      {plan.kind === "image" ? (
        <div style={{ padding: 8, color: DIM, fontSize: 11 }}>이미지 뷰는 아직 구현되지 않았습니다. 경로와 크기는 위와 같습니다.</div>
      ) : plan.kind === "binary" ? (
        <div style={{ padding: 8, color: DIM, fontSize: 11 }}>바이너리라 내용을 표시하지 않습니다.</div>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: "6px 8px",
            font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: FG,
            overflow: "auto",
            flex: "1 1 auto",
            minHeight: 0,
          }}
        >
          {plan.content}
        </pre>
      )}
    </div>
  );
}

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

  const pushToast = useCallback((t: Toast) => {
    setToasts((prev) => [t, ...prev.filter((x) => x.id !== t.id)].slice(0, 5));
  }, []);

  // 부팅 상태 폴링
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
    explorer: <Empty title="열린 파일이 없습니다" hint="탐색기에서 파일을 여세요. 경로는 워크스페이스 루트 아래로만 제한됩니다." />,
    agent: (
      <Empty
        title="아직 메시지가 없습니다"
        hint="입력창에 무엇을 지시할지 쓰세요. 파괴적인 도구는 승인 게이트를 거칩니다."
        actions={EXAMPLES.map((t) => ({ label: t.length > 28 ? `${t.slice(0, 27)}…` : t, onClick: () => setDraft(t) }))}
      />
    ),
    diff: diff ? (
      <DiffPanel path={diff.path} oldText={diff.oldText} newText={diff.newText} source="file" onClose={() => setDiff(null)} />
    ) : (
      <Empty title="변경 사항이 없습니다" hint="에이전트가 파일을 쓰면 여기서 항목별로 승인하거나 되돌릴 수 있습니다." />
    ),
    editor: openFile ? (
      <FileView info={openFile} />
    ) : (
      <Empty
        title="열린 파일이 없습니다"
        hint="탐색기에서 파일을 여세요. 저장하지 않은 탭은 창을 닫아도 세션에 남습니다."
        actions={[{ label: "새로고침", onClick: () => void refreshTree() }, ...EXAMPLES.slice(0, 1).map((t) => ({ label: "예시 프롬프트", onClick: () => setDraft(t) }))]}
      />
    ),
    settings: <Empty title="설정" hint="모델 · 브라우저 · 에이전트 · 로그 · 업데이트 · 고급. 모든 항목에 값의 출처와 근거가 함께 표시됩니다." />,
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
        <span style={{ color: DIM }}>{modelName ?? "모델 미연결"}</span>
        {steps && <span style={{ color: DIM }}>부팅 {bootDone}/{steps.length}</span>}
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
                title={TITLES[id] ?? id}
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
                <Panel key={id} title={TITLES[id] ?? id} zone={z} collapsed={p?.collapsed} onToggle={toggle} onMove={move}>
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
                  <button type="button" disabled={!draft.trim()} style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "3px 10px", cursor: draft.trim() ? "pointer" : "default", font: "inherit" }}>
                    보내기
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
