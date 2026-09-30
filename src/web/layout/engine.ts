/**
 * 도킹 레이아웃 엔진 (§5.4 · 요구 4) — **드롭 존 판정**과 레이아웃 상태.
 *
 * 렌더링(드래그 표시, 스프링 애니메이션)은 CSS 다. 여기 있는 것은 **판정**이며,
 * 판정이 틀리면 사용자가 패널을 "왼쪽" 에 놓으려 했는데 "상단" 에 놓인다 — 조용히
 * 잘못되는, 가장 찾기 어려운 종류의 버그다. 그래서 순수 함수로 전부 검증한다.
 *
 * 자기 진화하는 자석(§5.4): 자주 쓰는 배치를 손에 익도록 어느 존이 우선순위를 갖는지
 * **배치 횟수로** 기억한다. 이 기억은 **사용자가 끄면 안 남는다**.
 */

import { t } from "../i18n/install.js";

export type Zone = "left" | "right" | "top" | "bottom" | "center";
export type PanelId = "explorer" | "agent" | "editor" | "terminal" | "diff" | "monitor" | "log" | "settings";

export const ALL_PANELS: PanelId[] = ["explorer", "agent", "editor", "terminal", "diff", "monitor", "log", "settings"];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** §5.4 표: 각 변 20% 가 드롭 존, 그 외가 중앙. */
export const EDGE_FRACTION = 0.2;

export function zoneAt(r: Rect, px: number, py: number, edge = EDGE_FRACTION): Zone {
  const left = r.x + r.w * edge;
  const right = r.x + r.w * (1 - edge);
  const top = r.y + r.h * edge;
  const bottom = r.y + r.h * (1 - edge);
  if (px < left) return "left";
  if (px > right) return "right";
  if (py < top) return "top";
  if (py > bottom) return "bottom";
  return "center";
}

/** 패널을 놓을 수 있는 존 전체(중앙 포함). 분리 창은 어느 쪽이든 가능하다. */
export function zonesFor(panel: PanelId): Zone[] {
  // 로그는 **항상 아래**다(§5.12 "닫을 수 없는 기본 탭"). 위로 끌어도 올라가지 않는다 —
  // 서버 상태를 보는 유일한 창을 잃어버리면 데몬이 침묵한다.
  if (panel === "log") return ["bottom", "center"];
  return ["left", "right", "top", "bottom", "center"];
}

/** 자기 진화: 배치 횟수. 개별 오버라이드로 해제할 수 있다. */
export type MagnetCounts = Partial<Record<PanelId, Partial<Record<Zone, number>>>>;

export interface MagnetPolicy {
  /** 이 횟수 이상 배치된 존이 우선순위를 갖는다. */
  threshold: number;
  /** 사용자가 개별 오버라이드로 껐다면 자기 진화를 멈춘다. */
  disabled: boolean;
  overrides: Partial<Record<PanelId, Zone>>;
}

export const DEFAULT_MAGNET: MagnetPolicy = { threshold: 3, disabled: false, overrides: {} };

/** 배치 한 번을 기록한다. 사용자가 명시한 오버라이드는 **덮어쓰지 않는다**. */
export function recordPlacement(counts: MagnetCounts, panel: PanelId, zone: Zone): MagnetCounts {
  const forPanel = { ...(counts[panel] ?? {}) };
  forPanel[zone] = (forPanel[zone] ?? 0) + 1;
  return { ...counts, [panel]: forPanel };
}

/** 드롭 존 우선순위 — 많이 놓은 존이 먼저(그대로 판정되지만, 하이라이트 순서가 달라진다). */
export function zonePriority(counts: MagnetCounts, panel: PanelId, policy: MagnetPolicy = DEFAULT_MAGNET): Zone[] {
  const zones = zonesFor(panel);
  const override = policy.overrides[panel];
  if (override) {
    // 사용자가 정한 곳이 최종 권한이다 — 자기 진화가 설정을 덮어쓰면 안 된다.
    return [override, ...zones.filter((z) => z !== override)];
  }
  if (policy.disabled) return zones;
  const c = counts[panel] ?? {};
  const learned = zones.filter((z) => (c[z] ?? 0) >= policy.threshold);
  return [...learned, ...zones.filter((z) => !learned.includes(z))];
}

export interface PanelState {
  id: PanelId;
  zone: Zone;
  /** 중앙(플로팅)이면 좌표가 있다. */
  rect?: Rect;
  /** 분리 창이면 이 창이 독립이다. */
  detached?: boolean;
  collapsed?: boolean;
  /** z 순서 — 떠 있는 패널 중 가장 위. */
  z?: number;
  size?: number;
}

export interface LayoutState {
  panels: PanelState[];
  /** 로그 패널은 항상 존재하고 닫을 수 없다(§5.12). */
  logHeight: number;
}

// `collapsed`/`detached` 는 **명시적으로** false 다. `undefined` 로 두면 UI 마다
// `p.collapsed` 를 그대로 조건문으로 써서 "접힘" 과 "값 없음" 이 갈라진다 —
// controlled 컴포넌트에 undefined 를 넘기면 아예 리렌더가 안 되는 부류의 버그다.
const base = (id: PanelId, zone: Zone, size?: number, z?: number): PanelState => ({
  id,
  zone,
  collapsed: false,
  detached: false,
  ...(size ? { size } : {}),
  ...(z ? { z } : {}),
});

export const DEFAULT_LAYOUT: LayoutState = {
  panels: [
    base("explorer", "left", 260),
    base("agent", "right", 380),
    base("editor", "center"),
    // M1 터미널. 기본으로는 **접혀 있다**(z=1) — 열면 모든 창에서 셸이 떠 있고
    // 사용자가 아무것도 하지 않은 채 프로세스가 쌓인다.
    base("terminal", "center", undefined, 1),
    base("diff", "center", undefined, 1),
    base("monitor", "right", 200),
    base("log", "bottom"),
    base("settings", "center", undefined, 2),
  ],
  logHeight: 180,
};

export function panelOf(layout: LayoutState, id: PanelId): PanelState | undefined {
  return layout.panels.find((p) => p.id === id);
}

/**
 * 패널을 존으로 옮긴다. **로그 패널은 예외가 아니다** — 닫을 수 없지만 옮길 수는
 * 있는데, 옮기더라도 "닫힌" 판정을 받아선 안 된다.
 */
export function movePanel(layout: LayoutState, id: PanelId, zone: Zone): LayoutState {
  if (!zonesFor(id).includes(zone)) return layout; // 로그를 위로 끌어도 놓지 않는다
  return {
    ...layout,
    panels: layout.panels.map((p) => (p.id === id ? { ...p, zone, detached: false, rect: undefined } : p)),
  };
}

export function toggleCollapse(layout: LayoutState, id: PanelId): LayoutState {
  return {
    ...layout,
    panels: layout.panels.map((p) => (p.id === id ? { ...p, collapsed: !p.collapsed } : p)),
  };
}

/** 창이 복원된 창보다 좁으면 비율로 클램프한다(§5.4). */
export function clampSize(size: number, viewport: number, min = 120, maxRatio = 0.8): number {
  const max = Math.max(min, viewport * maxRatio);
  return Math.max(min, Math.min(max, size));
}

export function clampLayout(layout: LayoutState, viewport: { w: number; h: number }): LayoutState {
  return {
    ...layout,
    logHeight: clampSize(layout.logHeight, viewport.h, 60, 0.6),
    panels: layout.panels.map((p) => (p.size ? { ...p, size: clampSize(p.size, p.zone === "left" || p.zone === "right" ? viewport.w : viewport.h) } : p)),
  };
}

/**
 * §5.8 접근성: 드래그만으로 못 하는 경우를 위한 키보드 경로.
 * `Alt+방향키` 가 유일한 경로여서는 안 된다 — Alt 는 브라우저/창 관리와 겹친다.
 */
export function keyboardMove(current: Zone, dx: number, dy: number): Zone {
  const order: Zone[] = ["left", "center", "right"];
  if (dx !== 0) {
    const h = order.indexOf(current === "top" || current === "bottom" ? "center" : current);
    return order[Math.max(0, Math.min(order.length - 1, h + Math.sign(dx)))];
  }
  if (dy !== 0) {
    if (current === "left" || current === "right") return dy < 0 ? "top" : "bottom";
    return current === "top" ? "left" : "right";
  }
  return current;
}

export const MOVE_LABEL: Record<Zone, string> = {
  left: "왼쪽 도크",
  right: "오른쪽 도크",
  top: "상단 도크",
  bottom: "하단 도크",
  center: "중앙 (플로팅)",
};

/** 존 → 사전 키. 라벨 문자는 **카탈로그가 정본**이다(§11.1 M9). */
const ZONE_KEY: Record<Zone, string> = {
  left: "zone.left",
  right: "zone.right",
  top: "zone.top",
  bottom: "zone.bottom",
  center: "zone.center",
};

export function zoneLabel(zone: Zone, detached = false): string {
  if (detached) return t("zone.detached");
  // 키가 없으면 **원래 라벨로 되돌린다.** `t()` 는 없는 키를 키 자체로 돌려주므로
  // 그대로 두면 화면에 "zone.left" 이 찍힌다 — 사전이 비어 있는 사고가 눈에 보인다.
  // 조용히 옛 문자열로 덮으면 **영역이 거짓말을 하게 된다**(§5.8).
  return t(ZONE_KEY[zone], undefined) || MOVE_LABEL[zone];
}
