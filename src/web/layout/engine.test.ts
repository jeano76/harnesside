/**
 * 도킹 레이아웃 엔진 테스트 (§5.4 · §5.8 · §10.2).
 *
 * 판정이 틀리면 패널이 사용자가 놓지 않은 곳에 놓이고 **조용히** 잘못된다.
 * 그래서 모든 경계값을 명시적으로 넣는다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  zoneAt,
  zonesFor,
  recordPlacement,
  zonePriority,
  movePanel,
  toggleCollapse,
  clampSize,
  clampLayout,
  keyboardMove,
  zoneLabel,
  DEFAULT_LAYOUT,
  DEFAULT_MAGNET,
  panelOf,
  type MagnetCounts,
  type Rect,
} from "./engine.js";

const R: Rect = { x: 0, y: 0, w: 1000, h: 800 };

test("드롭 존: 각 변 20% (§5.4 표)", () => {
  assert.equal(zoneAt(R, 50, 400), "left", "왼쪽 5%");
  assert.equal(zoneAt(R, 199, 400), "left", "19.9% — 아직 왼쪽");
  assert.equal(zoneAt(R, 950, 400), "right");
  // 경계는 **중앙에 속한다**(아래 모서리 테스트와 같은 규칙). 801 부터 오른쪽이다.
  assert.equal(zoneAt(R, 801, 400), "right");
  assert.equal(zoneAt(R, 800, 400), "center", "경계 지점이 오른쪽이다");
  assert.equal(zoneAt(R, 500, 50), "top");
  assert.equal(zoneAt(R, 500, 750), "bottom");
});

test("그 외는 중앙 — 왼쪽이 아니다", () => {
  assert.equal(zoneAt(R, 500, 400), "center");
  assert.equal(zoneAt(R, 250, 400), "center", "25% 지점은 왼쪽이 아니다");
  assert.equal(zoneAt(R, 300, 200), "center");
});

test("모서리는 한쪽으로 판정된다 — **모호하면 안 된다**", () => {
  // 좌상단: 좌우 조건이 먼저 걸리므로 left 다.
  assert.equal(zoneAt(R, 10, 10), "left");
  // 우하단
  assert.equal(zoneAt(R, 990, 790), "right");
  // 20% 경계 정확히
  assert.equal(zoneAt(R, 200, 400), "center", "정확히 20% 지점은 왼쪽이 아니다(경계 포함하지 않음)");
});

test("창이 이동한 상태에서도 판정이 따라간다 — 창 좌표는 무시해야 한다", () => {
  const moved: Rect = { x: 500, y: 300, w: 1000, h: 800 };
  // 창 안 상대 좌표로 판정해야 한다. 창 좌표를 섞으면 드롭 존이 어긋난다.
  assert.equal(zoneAt(moved, 550, 700), "left", "창 왼쪽 5% 여야 left");
  assert.equal(zoneAt(moved, 1000, 700), "center");
});

test("로그 패널은 위로 갈 수 없다 — 닫을 수 없는 기본 탭(§5.12)", () => {
  const z = zonesFor("log");
  assert.equal(z.includes("top"), false, "로그를 상단으로 끌 수 있다");
  assert.equal(z.includes("bottom"), true);
  const moved = movePanel(DEFAULT_LAYOUT, "log", "top");
  assert.equal(panelOf(moved, "log")?.zone, "bottom", "로그가 위로 올라갔다");
});

test("나머지 패널은 다섯 존 모두 가능하다", () => {
  for (const p of ["agent", "agent", "agent", "agent", "monitor", "agent"] as const) {
    assert.deepEqual(zonesFor(p), ["left", "right", "top", "bottom", "center"], `${p} 의 존이 제한됐다`);
  }
});

test("자기 진화: 같은 곳에 N번 놓으면 그 존이 우선한다(§5.4)", () => {
  let counts: MagnetCounts = {};
  for (let i = 0; i < 3; i++) counts = recordPlacement(counts, "agent", "left");
  const order = zonePriority(counts, "agent", DEFAULT_MAGNET);
  assert.equal(order[0], "left", "3번 놓은 존이 우선이 아니다");
  // 나머지는 여전히 도달 가능해야 한다
  assert.equal(order.length, 5);
  assert.ok(order.includes("center"));
});

test("임계 미만이면 배치가 기억되지 않는다 — 한 번은 우연이다", () => {
  let counts: MagnetCounts = {};
  counts = recordPlacement(counts, "agent", "left");
  counts = recordPlacement(counts, "agent", "left");
  const order = zonePriority(counts, "agent", { ...DEFAULT_MAGNET, threshold: 3 });
  assert.equal(order[0], "left", "left 가 첫 자리는 우연히 그렇다");
  const order2 = zonePriority({ agent: { top: 2 } }, "agent", { ...DEFAULT_MAGNET, threshold: 3 });
  assert.notEqual(order2[0], "top", "2번은 임계 미만인데 우선됐다");
});

test("개별 오버라이드가 자기 진화를 이긴다 — **사용자 설정이 최종 권한**", () => {
  const counts: MagnetCounts = { agent: { left: 10 } };
  const order = zonePriority(counts, "agent", { ...DEFAULT_MAGNET, overrides: { agent: "right" } });
  assert.equal(order[0], "right", "배치 10번이 사용자의 명시적 설정을 덮어썼다");
});

test("off 스위치면 자기 진화가 전부 멈춘다", () => {
  const counts: MagnetCounts = { agent: { left: 10 } };
  const order = zonePriority(counts, "agent", { ...DEFAULT_MAGNET, disabled: true });
  assert.deepEqual(order, zonesFor("agent"), "기억이 순서를 바꿨다");
});

test("패널별 기억은 서로 독립이다", () => {
  // 서로 다른 **존**의 기록이 섞이지 않는지 본다. 같은 존을 두 패널이 기록하면
  // 하나를 옮겼을 때 다른 하나까지 끌어간다(실측: 자기 진화가 배치를 바꾸는 문제).
  const counts: MagnetCounts = { agent: { left: 5 }, terminal: { right: 5 } };
  assert.equal(zonePriority(counts, "agent", DEFAULT_MAGNET)[0], "left");
  assert.equal(zonePriority(counts, "terminal", DEFAULT_MAGNET)[0], "right");
});

test("배치 기록은 원본을 바꾸지 않는다 — 되돌리려면 원본이 남아야 한다", () => {
  const before: MagnetCounts = { agent: { left: 1 } };
  const after = recordPlacement(before, "agent", "top");
  assert.equal(before.agent?.left, 1, "원본이 바뀌었다");
  assert.equal(after.agent?.left, 1, "다른 존의 기록이 사라졌다");
  assert.equal(after.agent?.top, 1);
});

test("이동하면 플로팅 좌표는 사라진다 — 자석에 놓였는데 좌표가 남으면 겹친다", () => {
  let l = movePanel({ ...DEFAULT_LAYOUT, panels: DEFAULT_LAYOUT.panels.map((p) => (p.id === "agent" ? { ...p, rect: { x: 1, y: 2, w: 3, h: 4 } } : p)) }, "agent", "left");
  const p = panelOf(l, "agent");
  assert.equal(p?.zone, "left");
  assert.equal(p?.rect, undefined, "플로팅 좌표가 남았다");
  assert.equal(p?.detached, false, "분리 상태가 남았다");
});

test("접기/펼치기는 독립적이다", () => {
  const l = toggleCollapse(toggleCollapse(DEFAULT_LAYOUT, "agent"), "agent");
  assert.equal(panelOf(l, "agent")?.collapsed, false, "두 번 눌렀는데 접힌 상태");
  assert.equal(panelOf(l, "agent")?.collapsed, false, "다른 패널이 따라 접혔다");
});

test("좁은 창에서 크기를 비율로 클램프한다(§5.4)", () => {
  assert.equal(clampSize(400, 300), 240, "80% 초과를 클램프하지 않았다");
  assert.equal(clampSize(50, 1000), 120, "최소보다 작아졌다");
  assert.equal(clampSize(300, 1000), 300, "정상 크기를 바꿨다");
  const l = clampLayout({ ...DEFAULT_LAYOUT, logHeight: 500 }, { w: 800, h: 400 });
  assert.ok(l.logHeight <= 400 * 0.6, `로그 높이가 클램프되지 않았다: ${l.logHeight}`);
});

test("키보드 이동(§5.8) — 드래그 없이도 배치할 수 있다", () => {
  assert.equal(keyboardMove("center", 1, 0), "right");
  assert.equal(keyboardMove("center", -1, 0), "left");
  assert.equal(keyboardMove("left", -1, 0), "left", "맨 왼쪽에서 더 가면 그대로");
  assert.equal(keyboardMove("right", 1, 0), "right", "맨 오른쪽");
  assert.equal(keyboardMove("left", 0, -1), "top");
  assert.equal(keyboardMove("left", 0, 1), "bottom");
  assert.equal(keyboardMove("top", 1, 0), "right");
  assert.equal(keyboardMove("center", 0, 0), "center");
});

test("라벨은 사람이 이해할 수 있는 말이다 — 내부 식별자가 그대로 노출되면 안 된다", () => {
  for (const z of ["left", "right", "top", "bottom", "center"] as const) {
    const l = zoneLabel(z);
    assert.notEqual(l, z, `내부 식별자(${z})가 그대로 노출됐다`);
    assert.ok(l.length > 1);
  }
  assert.equal(zoneLabel("left", true), "분리 창");
});
