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
      </footer>
    </div>
  );
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
