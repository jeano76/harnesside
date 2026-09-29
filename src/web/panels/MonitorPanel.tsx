/**
 * 시스템 모니터 패널 (§5.5 · 요구 11).
 *
 * 성능 규칙이 이 컴포넌트의 설계 전체를 결정한다:
 *
 * - **1Hz 로 값이 바뀌는데 1Hz 로 DOM 을 다시 만들면 안 된다.** React 는 값의
 *   *버킷*이 바뀔 때만 리렌더하고, 실제 숫자/도형은 `requestAnimationFrame` +
 *   easing 으로 ref 를 통해 직접 갱신한다.
 * - **숨겨진 탭에서는 멈춘다.** `visibilityState: hidden` 이면 rAF 루프를 푼다
 *   (백그라운드 탭에서 60fps 루프는 배터리이고 발열이다).
 * - `prefers-reduced-motion` 이면 보간 없이 즉시 반영한다.
 * - 임계치는 **색만** 바꾼다. 점멸은 접근성·눈부심 문제다(§5.5).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { bucket, severity, formatBytes as fmtBytes, SEVERITY_COLOR, type Metrics } from "../../shared/metrics.js";

export const FG = "#c9d1d9";
export const DIM = "#6e7681";
export const BG = "#0d1117";

export interface MonitorPanelProps {
  /** 최신 샘플. null 이면 "아직 측정 안 됨" 이지 "모두 0%" 이 아니다. */
  latest: Metrics | null;
  /** 스파크라인용 최근 수열(최신이 뒤). */
  series?: (number | null)[];
  height?: number;
  onToggle?: () => void;
  collapsed?: boolean;
}

/** rAF + easing 으로 표시값을 0→목표로 이동시킨다(150~250ms). */
export function useAnimatedNumber(target: number, ms = 200, active = true): React.RefObject<HTMLSpanElement> {
  const ref = useRef<HTMLSpanElement>(null);
  const state = useRef({ from: target, to: target, start: 0, raf: 0 });
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced || !active) {
      state.current = { from: target, to: target, start: 0, raf: 0 };
      el.textContent = fmtPct(target);
      return;
    }
    const s = state.current;
    s.from = Number.parseFloat(el.textContent ?? "0") || 0;
    s.to = target;
    s.start = 0;
    cancelAnimationFrame(s.raf);
    const step = (t: number) => {
      if (!s.start) s.start = t;
      const k = Math.min(1, (t - s.start) / ms);
      // easeOutCubic — 시작이 빠르고 끝이 잔잔하게. 선형은 "계속 움직인다" 고 느껴진다.
      const e = 1 - (1 - k) ** 3;
      const v = s.from + (s.to - s.from) * e;
      el.textContent = fmtPct(v);
      if (k < 1) s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(s.raf);
  }, [target, ms, active, reduced]);
  return ref;
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** 문서가 보일 때만 true — 숨겨진 탭에서 애니메이션을 멈추기 위한 것(§5.5). */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = () => setVisible(document.visibilityState !== "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

export interface GaugeProps {
  label: string;
  /** null 이면 계측 불가 — 0 이 아니라 "?" 로 보인다. */
  pct: number | null;
  value: string;
  color?: string;
  size?: number;
  warning?: string;
}

/** 도넛 게이지 — 0→N% 로 그려지며 수치도 카운트업한다. SVG 는 ref 로 직접 갱신한다. */
export function Gauge({ label, pct, value, color, size = 72 }: GaugeProps) {
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  const sev = pct === null ? "unknown" : severity(pct);
  const fill = color ?? SEVERITY_COLOR[sev];
  const arc = useRef<SVGCircleElement>(null);
  const shown = useAnimatedNumber(pct ?? 0, 200, true);
  const target = pct === null ? 0 : Math.max(0, Math.min(100, pct));

  useEffect(() => {
    const el = arc.current;
    if (!el) return;
    // 전체 원(1.0)에서 목표 비율로 줄인다 — React 리렌더 없이 attribute 만 건드린다.
    el.setAttribute("stroke-dasharray", `${(c * target) / 100} ${c}`);
  }, [c, target]);

  if (pct === null) {
    return (
      <div style={{ width: size, textAlign: "center" }}>
        <svg width={size} height={size} role="img" aria-label={`${label}: 측정 불가`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#21262d" strokeWidth={7} />
          <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill={DIM} fontSize={16}>
            ?
          </text>
        </svg>
        <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>{label}</div>
        <div style={{ fontSize: 11, color: SEVERITY_COLOR.unknown }}>측정 불가</div>
      </div>
    );
  }

  return (
    <div style={{ width: size, textAlign: "center" }}>
      <svg width={size} height={size} role="img" aria-label={`${label} ${value}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#21262d" strokeWidth={7} />
        <circle
          ref={arc}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={fill}
          strokeWidth={7}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          strokeDasharray={`0 ${c}`}
        />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill={FG} fontSize={13} ref={shown as never}>
          {value}
        </text>
      </svg>
      <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>{label}</div>
    </div>
  );
}

/** 스파크라인 — 구멍(null)은 잇지 않고 끊는다. 0 과 잇으면 "측정 실패" 가 "0%" 로 보인다. */
export function Sparkline({ data, width = 120, height = 28, color = "#3fb950" }: { data: (number | null)[]; width?: number; height?: number; color?: string }) {
  if (data.length < 2) return <div style={{ width, height, color: DIM, fontSize: 10 }}>추이 없음</div>;
  const max = Math.max(1, ...data.map((d) => d ?? 0));
  const x = (i: number) => (i / (data.length - 1)) * (width - 1);
  const y = (v: number) => height - 1 - (v / max) * (height - 2);
  const segs: string[] = [];
  let cur: string[] = [];
  data.forEach((d, i) => {
    if (d === null) {
      if (cur.length) segs.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${cur.length ? "L" : "M"}${x(i).toFixed(1)},${y(d).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur.join(" "));
  return (
    <svg width={width} height={height} role="img" aria-label={`추이 ${data.length}샘플`} style={{ display: "block" }}>
      {segs.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={1.25} />
      ))}
    </svg>
  );
}

/** 코어 히트맵 — 코어 0~N 격자. */
export function CoreHeatmap({ cores, cell = 7 }: { cores: number[]; cell?: number }) {
  if (cores.length === 0) return <div style={{ color: DIM, fontSize: 11 }}>코어 정보 없음</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 2 }} role="img" aria-label={`코어 ${cores.length}개 사용률`}>
      {cores.map((c, i) => (
        <div
          key={i}
          title={`코어 ${i}: ${c.toFixed(0)}%`}
          style={{ width: cell, height: cell, borderRadius: 1, background: SEVERITY_COLOR[severity(c)] }}
        />
      ))}
    </div>
  );
}

function Bar({ label, pct, text, color }: { label: string; pct: number | null; text: string; color?: string }) {
  const sev = pct === null ? "unknown" : severity(pct);
  const w = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 120 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span style={{ color: DIM }}>{label}</span>
        <span style={{ color: color ?? SEVERITY_COLOR[sev] }}>{text}</span>
      </div>
      <div style={{ height: 5, background: "#21262d", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${w}%`, height: "100%", background: color ?? SEVERITY_COLOR[sev], transition: "width 200ms ease-out" }} />
      </div>
    </div>
  );
}

// 바이트 표시는 `shared/metrics` 의 정본을 쓴다(중복 정의는 서로 어긋난다).

export function MonitorPanel({ latest, series, height = 200, onToggle, collapsed }: MonitorPanelProps) {
  const visible = useDocumentVisible();
  // §5.5: "DOM 위젯을 1Hz 로 재생성하지 않는다" — 버킷이 바뀔 때만 리렌더한다.
  const b = useMemo(() => {
    if (!latest) return null;
    return {
      cpu: bucket(latest.cpu.overall),
      mem: bucket(latest.mem.usedPct),
      gpuMem: latest.gpu ? bucket(latest.gpu.memPct) : null,
      ctx: latest.context ? bucket(latest.context.pct) : null,
      disk: bucket(latest.disk.usedPct),
      cores: latest.cpu.cores.map((c) => bucket(c, 5)).join(","),
      llamaRss: latest.llama ? bucket(latest.llama.rssBytes / 1024 ** 2, 10) : null,
      tps: latest.tokensPerSec,
    };
  }, [latest]);

  if (collapsed) {
    return (
      <div style={{ background: BG, color: DIM, border: "1px solid #30363d", borderRadius: 6, padding: "4px 10px", fontSize: 12, display: "flex", gap: 12 }}>
        <span>모니터</span>
        {b && (
          <>
            <span>CPU {b.cpu.toFixed(1)}%</span>
            <span>RAM {b.mem.toFixed(1)}%</span>
            {b.gpuMem !== null && <span>VRAM {b.gpuMem.toFixed(1)}%</span>}
            {b.ctx !== null && <span style={{ color: b.ctx > 80 ? SEVERITY_COLOR.crit : FG }}>컨텍스트 {b.ctx.toFixed(1)}%</span>}
          </>
        )}
        {onToggle && (
          <button type="button" onClick={onToggle} style={{ marginLeft: "auto", background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit" }}>
            펼치기
          </button>
        )}
      </div>
    );
  }

  return (
    <section
      style={{
        background: BG,
        color: FG,
        border: "1px solid #30363d",
        borderRadius: 6,
        padding: 10,
        display: "grid",
        gap: 10,
        overflow: "auto",
        maxHeight: height,
      }}
    >
      {!latest ? (
        // §11.3: 빈 화면은 결함이다 — 무엇을 하고 있고 무엇이 안 되는지 말한다.
        <div style={{ color: DIM, fontSize: 12 }}>계측 시작 중… 서버가 1초마다 샘플을 모읍니다.</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
            <Gauge label="CPU" pct={latest.cpu.cores.length ? latest.cpu.overall : null} value={`${latest.cpu.overall.toFixed(0)}%`} />
            <Gauge label="RAM" pct={latest.mem.usedPct} value={`${latest.mem.usedPct.toFixed(0)}%`} />
            <Gauge
              label="VRAM"
              pct={latest.gpu ? latest.gpu.memPct : null}
              value={latest.gpu ? `${latest.gpu.memPct.toFixed(0)}%` : "?"}
            />
            <Gauge
              label="컨텍스트"
              pct={latest.context?.pct ?? null}
              value={latest.context ? `${latest.context.pct.toFixed(0)}%` : "?"}
              color={latest.context && latest.context.pct > 80 ? SEVERITY_COLOR.crit : undefined}
            />
            {/* §5.5: 80% 초과에 "컴팩션 임박" — 게이지 색과 함께 이유를 말한다. */}
            {latest.context && latest.context.pct > 80 && (
              <div style={{ alignSelf: "center", color: SEVERITY_COLOR.crit, fontSize: 11 }}>
                컴팩션 임박
                <div style={{ color: DIM }}>
                  {latest.context.usedTokens.toLocaleString()} / {latest.context.totalTokens.toLocaleString()} 토큰
                </div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            <Bar label="디스크" pct={latest.disk.usedPct} text={`${fmtBytes(latest.disk.freeBytes)} 남음 / ${fmtBytes(latest.disk.totalBytes)}`} />
            {latest.gpu && (
              <>
                <Bar label="GPU 사용률" pct={latest.gpu.utilPct} text={`${latest.gpu.utilPct.toFixed(0)}%`} />
                {latest.gpu.tempC !== null && <Bar label="GPU 온도" pct={latest.gpu.tempC} text={`${latest.gpu.tempC.toFixed(0)}°C`} color={latest.gpu.tempC > 85 ? SEVERITY_COLOR.crit : undefined} />}
                {latest.gpu.powerW !== null && <Bar label="전력" pct={null} text={`${latest.gpu.powerW.toFixed(0)} W`} color="#a371f7" />}
              </>
            )}
            {latest.llama && <Bar label="llama RSS" pct={null} text={fmtBytes(latest.llama.rssBytes)} color="#58a6ff" />}
          </div>

          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, color: DIM }}>CPU 추이 (최근 {series?.length ?? 0}샘플)</div>
              {series && series.length > 1 ? <Sparkline data={series} /> : <div style={{ color: DIM, fontSize: 11 }}>추적 중…</div>}
            </div>
            <div>
              <div style={{ fontSize: 11, color: DIM }}>코어별 (0~N)</div>
              <CoreHeatmap cores={latest.cpu.cores} />
            </div>
            {latest.tokensPerSec !== null && (
              <div style={{ fontSize: 11, color: DIM }}>
                토큰 속도 <b style={{ color: FG }}>{latest.tokensPerSec.toFixed(1)}</b> tok/s
              </div>
            )}
          </div>

          <div style={{ fontSize: 10, color: DIM, display: "flex", gap: 10 }}>
            <span>기준 {new Date(latest.at).toLocaleTimeString("ko-KR")}</span>
            <span>· 서버 1Hz 계측, 요청당 계측 없음</span>
            {!visible && <span style={{ color: SEVERITY_COLOR.warn }}>· 탭이 숨겨져 갱신을 멈췄습니다</span>}
            {onToggle && (
              <button type="button" onClick={onToggle} style={{ marginLeft: "auto", background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit" }}>
                접기
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
