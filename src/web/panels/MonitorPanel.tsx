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
import { useI18n } from "../i18n/index.js";

export const FG = "#c9d1d9";
export const DIM = "#6e7681";
export const BG = "#0d1117";
const BORDER = "#30363d";

export interface MonitorPanelProps {
  /** 최신 샘플. null 이면 "아직 측정 안 됨" 이지 "모두 0%" 이 아니다. */
  latest: Metrics | null;
  /** 스파크라인용 최근 수열(최신이 뒤). */
  series?: (number | null)[];
  /**
   * **최소** 높이. 최대 높이가 아니다.
   *
   * 2026-10-01 실측: 이 값이 **최대** 높이로 쓰이고 있어서 패널이 항상 잘렸다 —
   * 게이지 4개, 바 4개, 스파크라인, 코어 히트맵, 기준 시각이 있는데 200px 안에
   * 들어가지 않아 **항상 스크롤바**가 났다. 물리 상태를 보려고 여는 창에서
   * 스크롤바가 있다는 것은 "아래에 뭐가 더 있다" 를 의미하는데, 그 아래는
   * **같은 화면의 나머지** 다. 스크롤을 요구하지 않는 유일한 정보가 이것이다.
   *
   * 그래서 잘라내지 않는다 — **내용이 전부 보이도록** 키운다. 좁은 도크에서는
   * 바깥 스크롤이 생겨도 **패널 안은 항상 전부** 보인다.
   */
  height?: number;
  onToggle?: () => void;
  collapsed?: boolean;
  /**
   * 하단 셸 우측용 밀집 표시 (2026-10-04).
   *
   * 10-01 요구 "셸 영역 우측 · 최소 사이즈 · 전부 노출" 로 돌아간다.
   * 큰 도넛·스파크라인·코어 히트맵 대신 수치 행으로 전부 보인다.
   * 스파크라인·코어별 분포는 펼친 화면(기본 패널)의 몫으로 남긴다.
   */
  compact?: boolean;
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
  /**
   * true 면 커질수록 위험(기본). false 면 **적을수록** 위험 — 디스크 여유가 그렇다.
   * 모양은 그대로 두고 **색 판정만** 뒤집는다(§5.5: 임계치는 색만 바꾼다).
   */
  higherIsWorse?: boolean;
  /**
   * **값이 없을 때 왜 없는지** (2026-10-01).
   *
   * 왜 필요한가: 값이 없으면 화면에는 `?` 와 "측정 불가" 만 남았다. 그런데 그건
   * **세 가지 다른 상태를 한 문장으로 뭉갠다** —
   *   1. 측정 도구가 **없다** (이 머신에 `nvidia-smi` 가 없다)
   *   2. 아직 **첫 표본이 없다** (샘플러가 1초 뒤 채운다)
   *   3. 읽기는 했는데 **값이 비었다** (권한 없음)
   *
   * 사용자는 셋 중 무엇을 해야 하는지 달라서 다르게 대응한다. "측정 불가" 만 보면
   * **아무것도 할 수 없다** 고 읽고 — 실제로는 GPU 드라이버를 설치하면 된다.
   *
   * 그래서 **사유를 자리에서 넘긴다.** 이 컴포넌트가 계기를 아는 게 아니라
   * **각 계기가 왜 없는지 말하는 것** 이다 — 앞의 `viewExtra` 와 같은 경계다.
   * 주지 않으면 사유 없는 "측정 불가" 로 돌아간다(호출처를 고칠 수 없으므로
   * **검사**가 이걸 막는다).
   */
  why?: string;
}

/**
 * 도넛 게이지 — 0→N% 로 그려지며 수치도 카운트업한다. SVG 는 ref 로 직접 갱신한다.
 *
 * `higherIsWorse: false` 를 주면 **적을수록 위험한** 값(디스크 여유)도 같은 모양으로
 * 그린다. 같은 종류의 계측이 **모양까지 다르면** 읽는 사람이 "이건 다른 종류의 수치구나"
 * 를 배워야 하고, 그 차이를 배우는 대가가 작지 않다 — 그래서 형태는 같게 두고
 * **색 판정만** 뒤집는다.
 */
export function Gauge({ label, pct, value, color, size = 72, higherIsWorse = true, why }: GaugeProps) {
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  // **위험 판정은 값이 아니라 여유로 한다.** 디스크가 91% 차 있으면 초록(정상)이
  // 되어야 한다 — `usedPct` 로 색을 정하면 9% 남았는데 정상처럼 보인다.
  const sev = pct === null ? "unknown" : severity(higherIsWorse ? pct : 100 - pct);
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
        <svg width={size} height={size} role="img" aria-label={`${label}: 측정 불가${why ? ` — ${why}` : ""}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#21262d" strokeWidth={7} />
          <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill={DIM} fontSize={16}>
            ?
          </text>
        </svg>
        <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>{label}</div>
        {/* **사유를 말한다.** "측정 불가" 는 무엇을 해야 하는지 말하지 않으므로
            사용자는 손을 놓는다. 사위가 없으면 그 사실을 그대로 쓴다. */}
        <div
          style={{ fontSize: 10, color: SEVERITY_COLOR.unknown, marginTop: 1, lineHeight: 1.3 }}
          // 사유가 길어도 게이지가 **넘치지 않게** — 이 패널은 높이가 고정이다.
          title={why}
        >
          {why ?? "측정 불가"}
        </div>
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
          style={{ width: cell, height: cell, borderRadius: 2, background: SEVERITY_COLOR[severity(c)] }}
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
      <div style={{ height: 5, background: "#21262d", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${w}%`, height: "100%", background: color ?? SEVERITY_COLOR[sev], transition: "width 200ms ease-out" }} />
      </div>
    </div>
  );
}

// 바이트 표시는 `shared/metrics` 의 정본을 쓴다(중복 정의는 서로 어긋난다).

/**
 * 한 줄 모니터 스트립 — 셸 하단 (2026-10-04 사용자 명시).
 * CPU·RAM·VRAM·컨텍스트를 100% 기준 막대로 한 줄에. 너비는 flex 라 창에 맞게
 * 늘고 줄며, track 이 곧 100% 스케일이다. 수치는 전부 보인다(추측 금지).
 */
export function MonitorStrip({ latest }: { latest: Metrics | null }) {
  if (!latest) return <div style={{ fontSize: 10, color: DIM, padding: "1px 8px" }}>계측 시작 중…</div>;
  const cell = (label: string, pct: number | null, text: string, warn?: boolean) => (
    <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "1 1 90px", minWidth: 80 }} title={`${label} ${text}`}>
      <span style={{ color: DIM, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: "1 1 auto", height: 4, background: "#21262d", borderRadius: 2, overflow: "hidden", minWidth: 24 }}>
        <span style={{ display: "block", width: `${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%`, height: "100%", background: warn ? SEVERITY_COLOR.crit : pct === null ? "#484f58" : SEVERITY_COLOR[severity(pct)] }} />
      </span>
      <span style={{ color: warn ? SEVERITY_COLOR.crit : FG, flexShrink: 0 }}>{text}</span>
    </span>
  );
  const ctx = latest.context;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "1px 8px", fontSize: 10, borderTop: `1px solid ${BORDER}`, background: BG, flexWrap: "nowrap", overflow: "hidden", whiteSpace: "nowrap" }}>
      {cell("CPU", latest.cpu.cores.length ? latest.cpu.overall : null, `${latest.cpu.overall.toFixed(0)}%`)}
      {cell("RAM", latest.mem.usedPct, `${latest.mem.usedPct.toFixed(0)}%`)}
      {cell("VRAM", latest.gpu ? latest.gpu.memPct : null, latest.gpu ? `${latest.gpu.memPct.toFixed(0)}%` : "?")}
      {/* GPU 사용률 — `null` 은 "모른다"(nvidia-smi 가 값을 안 줬거나 GPU 없음)이지 0 이 아니다. */}
      {cell("GPU", latest.gpu?.utilPct ?? null, latest.gpu?.utilPct === null || !latest.gpu ? "?" : `${latest.gpu.utilPct.toFixed(0)}%`)}
      {cell("CTX", ctx?.pct ?? null, ctx ? `${ctx.pct.toFixed(0)}%` : "—", !!ctx && ctx.pct > 80)}
      {cell("DISK", 100 - latest.disk.usedPct, fmtBytes(latest.disk.freeBytes))}
    </div>
  );
}

export function MonitorPanel({ latest, series, height = 200, onToggle, collapsed, compact = false }: MonitorPanelProps) {
  const visible = useDocumentVisible();
  /** 패널 제목은 카탈로그에서 — 하드코딩하면 M9 누락이 조용히 남는다. */
  const t = useI18n();
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

  if (compact) {
    return (
      <section
        aria-label={t("panel.monitor")}
        style={{ background: BG, color: FG, borderLeft: `1px solid ${BORDER}`, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 5, overflowY: "auto", minHeight: 0 }}
      >
        <div style={{ fontSize: 10, color: DIM }}>{t("panel.monitor")}</div>
        {!latest ? (
          <div style={{ color: DIM, fontSize: 11 }}>계측 시작 중…</div>
        ) : (
          <>
            <Bar label="CPU" pct={latest.cpu.cores.length ? latest.cpu.overall : null} text={`${latest.cpu.overall.toFixed(0)}%`} />
            <Bar label="RAM" pct={latest.mem.usedPct} text={`${latest.mem.usedPct.toFixed(0)}%`} />
            <Bar
              label="VRAM"
              pct={latest.gpu ? latest.gpu.memPct : null}
              text={latest.gpu ? `${latest.gpu.memPct.toFixed(0)}%` : "? (GPU 없음)"}
            />
            <Bar
              label="컨텍스트"
              pct={latest.context?.pct ?? null}
              text={latest.context ? `${latest.context.pct.toFixed(0)}%` : "? (작업 중에만 측정)"}
              color={latest.context && latest.context.pct > 80 ? SEVERITY_COLOR.crit : undefined}
            />
            <Bar label="디스크 여유" pct={100 - latest.disk.usedPct} text={fmtBytes(latest.disk.freeBytes)} />
            {latest.gpu && (
              <Bar
                label="GPU 사용률"
                pct={latest.gpu.utilPct}
                text={latest.gpu.utilPct === null ? "? (값 없음)" : `${latest.gpu.utilPct.toFixed(0)}%`}
              />
            )}
            <div style={{ fontSize: 10, color: DIM, lineHeight: 1.5 }}>
              {latest.gpu?.tempC !== null && latest.gpu?.tempC !== undefined ? `온도 ${latest.gpu.tempC.toFixed(0)}°C · ` : ""}
              {latest.gpu?.powerW !== null && latest.gpu?.powerW !== undefined ? `전력 ${latest.gpu.powerW.toFixed(0)}W · ` : ""}
              {latest.llama ? `llama ${fmtBytes(latest.llama.rssBytes)} · ` : ""}
              {latest.context ? `${latest.context.usedTokens.toLocaleString()}tok` : "토큰 —"}
            </div>
          </>
        )}
      </section>
    );
  }

  if (collapsed) {
    return (
      <div style={{ background: BG, color: DIM, border: "1px solid #30363d", borderRadius: 6, padding: "4px 10px", fontSize: 12, display: "flex", gap: 12 }}>
        <span>{t("panel.monitor")}</span>
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
        // **잘라내지 않는다.** `maxHeight` + `overflow: auto` 였을 때 이 패널은
        // 항상 스크롤바가 났다(실측) — 물리 상태를 보려고 여는 창이 스크롤을 요구하면
        // 그건 "아직 더 있다" 를 의미하는데, 그 아래는 같은 화면의 나머지다.
        // 높이는 **최소**로만 준다. 좁은 도크에서는 바깥이 스크롤되지만
        // **패널 안은 언제나 전부** 보인다.
        minHeight: height,
        overflow: "visible",
      }}
    >
      {!latest ? (
        // §11.3: 빈 화면은 결함이다 — 무엇을 하고 있고 무엇이 안 되는지 말한다.
        <div style={{ color: DIM, fontSize: 12 }}>계측 시작 중… 서버가 1초마다 샘플을 모읍니다.</div>
      ) : (
        <>
          {/* ── 게이지 2×2 강제 (2026-10-03 요구) ───────────────────────
              CPU·RAM·VRAM·컨텍스트 4개를 **항상 2열×2행 그리드**로 배치한다.
              flex-wrap 이면 좁은 도크에서 4개가 한 줄로 늘어났다 줄바뀌어 4×1이
              되는데, 요구는 "게이지 2×2"이다. grid repeat(2,1fr)로 세로를 두
              개씩 고정하고 스페이스는 게이지 사이의 gap 으로만 둔다. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "14px 28px", alignItems: "center" }}>
            <Gauge label="CPU" pct={latest.cpu.cores.length ? latest.cpu.overall : null} value={`${latest.cpu.overall.toFixed(0)}%`} />
            <Gauge label="RAM" pct={latest.mem.usedPct} value={`${latest.mem.usedPct.toFixed(0)}%`} />
            <Gauge
              label="VRAM"
              pct={latest.gpu ? latest.gpu.memPct : null}
              value={latest.gpu ? `${latest.gpu.memPct.toFixed(0)}%` : "?"}
              // **GPU 자체가 없을 때** — 드라이버가 없거나 `nvidia-smi` 를 못 찾았다.
              // "측정 불가" 라면 무엇을 설치해야 하는지 알 수 없다.
              why={latest.gpu ? undefined : "GPU 없음 — 드라이버 미설치"}
            />
            <Gauge
              label="컨텍스트"
              pct={latest.context?.pct ?? null}
              value={latest.context ? `${latest.context.pct.toFixed(0)}%` : "?"}
              color={latest.context && latest.context.pct > 80 ? SEVERITY_COLOR.crit : undefined}
              // **작업 중이 아니면 컨텍스트를 잴 수 없다.** 계측은 턴 안에서만 되고,
              // 대화가 멈춘 사이에 값은 오래된 것이거나 없다. 그래서 이유를 말한다 —
              // 실측: 이 값이 계속 "?" 로만 보여 "측정 불가" 를 결함으로 오해했다.
              // (0으로 두지 않는다 — 없는 것과 0 은 다르다.)
              why={latest.context ? undefined : "작업 중이 아니면 측정되지 않습니다"}
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

          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* ── 원형으로 통일 (2026-10-01) ─────────────────────────────────────
                디스크·GPU 사용률을 **막대**에서 **도넛**으로 바꿨다. 옆에 있는 CPU·RAM 과
                **모양이 다른 수치**는 읽는 사람이 "다른 종류구나" 를 배워야 하고, 그
                대가가 작지 않다. 같은 종류의 계측은 같은 형태로 읽힌다(§5.5).

                디스크는 **여유가 적을수록 위험**하므로 `higherIsWorse: false` 다.
                `usedPct` 로 색을 정하면 9% 남았는데도 초록이 된다 — 실제로
                "10.0 GiB 남음 / 115.8 GiB" 인데 정상처럼 보일 수 있다.

                **온도·전력·RSS 는 막대로 둔다.** 이건 **비율이 아니라 절대값**이라
                원형으로 그릴 수 없다(80W 의 72% 가 무슨 뜻이 없는지 모른다. 도넛에 억지로
                넣으면 수치가 있다는 사실이 사라진다. */}
            <Gauge
              label="디스크 여유"
              pct={100 - latest.disk.usedPct}
              value={`${fmtBytes(latest.disk.freeBytes)}`}
              higherIsWorse={false}
            />
            {latest.gpu && (
              <Gauge
                label="GPU 사용률"
                pct={latest.gpu.utilPct}
                // **null 을 0 으로 그리지 않는다** — 모르는 값을 아는 것처럼 보이면
                // 조용히 실패다. `?` 와 사유를 그대로 보여준다.
                value={latest.gpu.utilPct === null ? "?" : `${latest.gpu.utilPct.toFixed(0)}%`}
                why={latest.gpu.utilPct === null ? "nvidia-smi 가 값을 안 줬습니다" : undefined}
              />
            )}
          </div>

          {/* 온도·전력·메모리는 **비율이 아니라 수치**다. 막대가 맞다 — 도넛에 넣으면
              "전력 72%" 라는 말도 없는 값이 된다. */}
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            {latest.gpu && (
              <>
                {latest.gpu.tempC !== null && (
                  <Bar label="GPU 온도" pct={latest.gpu.tempC} text={`${latest.gpu.tempC.toFixed(0)}°C`} color={latest.gpu.tempC > 85 ? SEVERITY_COLOR.crit : undefined} />
                )}
                {latest.gpu.powerW !== null && <Bar label="전력" pct={null} text={`${latest.gpu.powerW.toFixed(0)} W`} color="#a371f7" />}
              </>
            )}
            {latest.llama && <Bar label="llama RSS" pct={null} text={fmtBytes(latest.llama.rssBytes)} color="#58a6ff" />}
            <span style={{ fontSize: 10, color: DIM }}>디스크 총 {fmtBytes(latest.disk.totalBytes)}</span>
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
