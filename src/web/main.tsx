/**
 * 부팅 화면 (§3.2 "부팅 로그 화면" · §5.12 로그 패널의 시작점).
 *
 * P2 단계에서는 IDE 전체가 아니라 **부팅 시퀀스**를 먼저 보여준다. 이유: 요구 8
 * (라운드 모서리)과 단계 9(웹 자산)의 성공을 확인하려면 "창이 뜨고 내용이 있는" 상태가
 * 필요한데, IDE 를 다 만들어야 확인할 수 있으면 P2 의 완료를 증명할 수 없다.
 */

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiClient, ApiError, type BootStep, type GpuInfo } from "./api.js";
import { resolveToken } from "./session.js";
import { LogPanel } from "./panels/LogPanel.js";
import { WsClient } from "./wsClient.js";
import type { LogEntry, LogLevel } from "../server/logRing.js";

const { token, cleanHref } = resolveToken(
  typeof location !== "undefined" ? location.href : "/",
  typeof sessionStorage !== "undefined" ? sessionStorage : undefined
);
// 토큰을 URL 에서 제거한다. cleanHref 는 항상 경로 형태이므로 그대로 넣으면 된다.
if (typeof history !== "undefined" && typeof location !== "undefined") {
  history.replaceState(null, "", cleanHref);
}

const client = new ApiClient({ token });

function App() {
  const [steps, setSteps] = useState<BootStep[] | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §5.12: 로그 패널은 **닫을 수 없는 기본 탭**이다. 데몬이라 서버 상태를 보는
  // 유일한 창이고, 닫으면 "멈췄다"로 오해된다.
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logStatus, setLogStatus] = useState<{
    keptChars: number;
    droppedLines: number;
    maxChars: number;
    bufferFull: boolean;
  } | null>(null);
  const [logLevel, setLogLevel] = useState<LogLevel>("info");
  const [wsState, setWsState] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    let alive = true;
    // 부팅이 진행 중일 수 있으므로 몇 초 간격으로 다시 물어본다(폴링은 1Hz 로 충분).
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

  // 로그 스트리밍(§2.3). WS 가 끊겨도 **화면이 통째로 바뀌면 안 된다**(§5.10):
  //이미 있는 항목은 유지하고 새 것만 붙인다. WS 가 못 붙을 때만 폴링으로 대체한다.
  useEffect(() => {
    const idePort = Number(new URL(location.href).port || 7317);
    const ws = new WsClient({
      port: idePort,
      token,
      onEvent: (ev) => {
        if (ev.type === "log.append") {
          const e = ev.entry as LogEntry | undefined;
          if (!e) return;
          setLogs((prev) => {
            const last = prev[prev.length - 1];
            if (last && e.seq <= last.seq) return prev; // 재전송된 것은 무시
            // 상한을 클라이언트에서도 지킨다 — WS 가 늦어도 브라우저 메모리가 새지는 않는다
            const next = [...prev, e];
            return next.length > 2000 ? next.slice(next.length - 2000) : next;
          });
        } else if (ev.type === "log.status") {
          setLogStatus(ev.status as typeof logStatus);
        }
      },
      onStatus: (s) => setWsState(s),
    });
    ws.connect();

    // WS 가 붙어도 **초기 스냅샷**은 받아야 한다(연결 전 기록분).
    void (async () => {
      try {
        const r = await client.get<{ entries: LogEntry[]; status: typeof logStatus }>("/api/logs?limit=500");
        setLogs((prev) => (prev.length > 0 ? prev : r.entries));
        setLogStatus(r.status);
      } catch {
        // 스냅샷 실패는 조용히 넘어간다 — WS 로 이어진다
      }
    })();

    return () => ws.close();
  }, []);

  const done = steps?.filter((s) => s.ok).length ?? 0;
  return (
    <div style={{ padding: 16, display: "grid", gridTemplateRows: "auto 1fr auto", height: "100%", gap: 12 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <strong style={{ fontSize: 15 }}>harnesside</strong>
        <span style={{ color: "#8b949e" }}>부팅 시퀀스</span>
        {steps && (
          <span style={{ color: "#8b949e" }}>
            {done}/{steps.length} 완료
          </span>
        )}
        {logStatus && (
          <span style={{ color: "#6e7681", fontSize: 12 }}>
            로그 {logStatus.keptChars.toLocaleString()}자 / 상한 {logStatus.maxChars.toLocaleString()}자
          </span>
        )}
        {/* 연결 상태를 숨기지 않는다. WS 가 끊기면 로그도 흐르지 않는다는 뜻이므로
            사용자가 "왜 멈췄지"를 추측하지 않아야 한다(§11.3). */}
        <span
          style={{
            fontSize: 12,
            color: wsState === "open" ? "#3fb950" : wsState === "connecting" ? "#d29922" : "#f85149",
          }}
          title="WebSocket 연결 상태"
        >
          {wsState === "open" ? "● 실시간" : wsState === "connecting" ? "○ 연결 중" : "▲ 끊김"}
        </span>
      </header>

      <div style={{ overflow: "auto", minHeight: 0 }}>
        {!steps && !error && <div style={{ color: "#8b949e" }}>서버에 연결하는 중…</div>}
        {error && (
          <div style={{ color: "#f85149", border: "1px solid #f85149", padding: 8, borderRadius: 6 }}>{error}</div>
        )}
        {steps?.map((s) => (
          <div key={s.n} style={{ display: "flex", gap: 10, padding: "2px 0" }}>
            <span style={{ width: 28, color: "#8b949e" }}>{String(s.n).padStart(2, "0")}</span>
            <span style={{ width: 18 }}>{s.ok ? "●" : s.pending ? "○" : "▲"}</span>
            <span style={{ width: 240, color: s.ok ? "#3fb950" : s.pending ? "#6e7681" : "#d29922" }}>{s.name}</span>
            <span style={{ color: "#8b949e", whiteSpace: "nowrap" }}>{s.detail}</span>
          </div>
        ))}
      </div>

      <footer style={{ color: "#8b949e", borderTop: "1px solid #30363d", paddingTop: 8, display: "grid", gap: 2 }}>
        {gpu ? (
          <>
            <div>
              브라우저 GPU: <b style={{ color: gpu.mode === "off" ? "#d29922" : "#3fb950" }}>{gpu.mode}</b> · 예약 {gpu.reserveMiB} MiB · 실측 free {gpu.measured.vramFreeMiB} / 모델 {gpu.measured.modelMiB} MiB
            </div>
            {gpu.rationale.map((r, i) => (
              <div key={i} style={{ fontSize: 12 }}>· {r}</div>
            ))}
          </>
        ) : (
          <div>GPU 정책 조회 중…</div>
        )}
        {/* §5.12: 서버 로그가 상시 보인다. 서버가 데몬이라 이 패널이 유일한 창이다. */}
        <div style={{ marginTop: 6, border: "1px solid #30363d", borderRadius: 6, overflow: "hidden" }}>
          <LogPanel
            entries={logs}
            status={logStatus ?? undefined}
            level={logLevel}
            onSetLevel={setLogLevel}
            height={180}
          />
        </div>
      </footer>
    </div>
  );
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
