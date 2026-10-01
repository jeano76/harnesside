/**
 * **IDE 프레임** — Visual Studio Community 형태 (2026-10-01).
 *
 * ── 왜 안쪽인가 ─────────────────────────────────────────────────────────────
 *
 * 요구는 "대화 패널을 IDE 형태로" 다. **패널 배치(layout)를 VS 로 바꾸지 않았다.**
 * 그랬다면 배선·고정 경계·소멸 규칙·지금 검증된 화면 검사가 전부 어긋난다. 대신
 * **패널 안쪽을 IDE 문법**으로 채웠다 — 사용자가 원하는 것은 작업 화면의 모양이지,
 * 도킹 규칙의 개조가 아니었다.
 *
 * ── 무엇을 가져왔나 ─────────────────────────────────────────────────────────
 *
 * VS Community 의 **알려진 구조**를 그대로 쓴다:
 *
 *   액티비티바   ← 맨 왼쪽 세로 아이콘 띠. 여기서 무엇을 여는지가 정해진다.
 *   탭 스트립   ← 지금 열려 있는 것. **하나라도 보이면** 어디에 있는지 안다.
 *   편집기 영역  ← 실제 내용.
 *   도크        ← 아래쪽(셸)·오른쪽(모니터). VS 의 아웃풋/프로퍼티 창 자리.
 *   상태바      ← 맨 아래 한 줄. 커서 위치·언어·연결 상태가 사는 곳.
 *
 * ── 무엇을 가져오지 않았나 ───────────────────────────────────────────────────
 *
 * **파일 탐색기·솔루션 탐색기를 되살리지 않았다.** 이전에 사용자 요구로 **삭제**했고,
 * 대화 안에 블록으로 열기로 했다(요구: "설정·변경기록을 대화 안에 블록화, 기존 패널 삭제").
 * 여기서 되살리면 **되돌아가는 것**이고, 되돌아간 이유는 지금도 유효하다.
 *
 * **리본도 넣지 않았다.** 리본은 명령을 숨기고 그림에 의존한다 — 키보드 사용자에게
 * 최악이다. VS Community 조차 리본에서 명령 팔레트로 옮기는 추세다.
 *
 * **색을 베끼지 않았다.** VS 의 파란 테마는 이 앱의 어두운 테마와 한 번도 안 맞았다.
 * **문법만** 가져온다.
 */

import React from "react";

const HAIRLINE = "#30363d";
const SURFACE_2 = "#161b22";
const SURFACE_3 = "#21262d";
const SURFACE_1 = "#0d1117";
const FG = "#c9d1d9";
const DIM = "#8b949e";
const ACTIVE_BLUE = "#0078d4";
const INACTIVE = "#4d4d4c";

export interface ActivityItem {
  id: string;
  /** 아이콘 글자 — VS 는 도형을 쓴다. 여기에 **이름**도 같이 준다. */
  glyph: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}

export interface IdeTab {
  id: string;
  label: string;
  active?: boolean;
  onClick: () => void;
  /** 닫기 버튼 — 없으면 안 그린다. 있는 것처럼만. */
  onClose?: () => void;
}

export interface IdeProps {
  title: string;
  activity: ActivityItem[];
  tabs: IdeTab[];
  /** 상태바 항목 — 오른쪽 정렬되는 것은 뒤에 둔다. */
  status?: { text: string; tone?: "normal" | "warn" | "error" | "good"; title?: string }[];
  /** 탭 스트립과 본문 사이의 얇은 줄. VS 는 탭마다 연한 선이 있다. */
  children: React.ReactNode;
  /** 액티비티바 폭(고정). VS Community 는 좁다. */
  activityWidth?: number;
}

/**
 * 액티비티바 — **세로 아이콘 띠**.
 *
 * **아이콘에만 의존하지 않는다.** VS Community 는 도형만 쓴다(그것의 언어다), 하지만
 * 이 앱의 첫 사용자는 VS 를 안 써봤을 수 있고 **키보드 사용자는 아이콘을 못 봅니다.**
 * 그래서 **선택된 항목에만 이름을 보여준다** — 지금 어디에 있는지가 가장 자주 필요한
 * 정보라 세로 폭 안에 들어가고, 나머지는 `aria-label` 로 이름이 남는다.
 */
function ActivityBar({ items, width }: { items: ActivityItem[]; width: number }) {
  return (
    <div
      role="tablist"
      aria-label="주요 보기"
      style={{
        flex: `0 0 ${width}px`,
        width,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        background: "#010409",
        borderRight: `1px solid ${HAIRLINE}`,
      }}
    >
      {items.map((it) => {
        const on = it.active === true;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={on}
            aria-label={it.label}
            title={it.label}
            onClick={it.onClick}
            style={{
              // **세로 띠** — 아이콘 위에 이름이 붙으면 여기서 2줄이 된다.
              height: on ? 44 : 40,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
              background: on ? SURFACE_2 : "transparent",
              // **왼쪽 강조선** — 색만이 아니다. 활성 항목은 배경도 다르다.
              borderLeft: on ? `2px solid ${ACTIVE_BLUE}` : "2px solid transparent",
              border: 0,
              borderRight: 0,
              borderBottom: 0,
              borderTop: 0,
              color: on ? FG : INACTIVE,
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
              lineHeight: 1,
              padding: 0,
            }}
          >
            <span aria-hidden="true">{it.glyph}</span>
            {on && (
              <span style={{ fontSize: 8, color: DIM, letterSpacing: 0.2 }}>{it.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 탭 스트립 — **지금 열려 있는 것**.
 *
 * VS Community 는 열려 있는 탭만 보여준다. 닫힌 것을 **회색으로 나열하지 않는다** —
 * 그러면 무엇이 열려 있는지 모른다. 여기서도 같게 한다: **열린 것만** 띠를 만든다.
 *
 * **탭 스트립에 항상 하나 이상** 있어야 한다. 비면 "여기가 어디지" 가 된다 —
 * 그래서 `tabs` 가 비었을 때 **제목 하나**로 채운다(무언가 없는 것처럼 보이지 않게).
 */
function TabStrip({ title, tabs }: { title: string; tabs: IdeTab[] }) {
  const shown = tabs.length > 0 ? tabs : [{ id: "_", label: title, active: true, onClick: () => {} }];
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "stretch",
        background: "#010409",
        borderBottom: `1px solid ${HAIRLINE}`,
        minHeight: 30,
        overflow: "hidden",
      }}
    >
      {shown.map((t) => {
        const on = t.active === true;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={t.onClick}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              background: on ? SURFACE_1 : "transparent",
              // **활성 탭 위쪽에 선** — VS Community 의 그 선. 아래는 열려 있으므로
              // 테두리가 이어져야 탭이 "몸체"처럼 보인다.
              borderTop: on ? `1px solid ${ACTIVE_BLUE}` : "1px solid transparent",
              borderLeft: `1px solid ${on ? HAIRLINE : "transparent"}`,
              borderRight: `1px solid ${on ? HAIRLINE : "transparent"}`,
              color: on ? FG : DIM,
              font: "inherit",
              fontSize: 11,
              cursor: "pointer",
              whiteSpace: "nowrap",
              maxWidth: 240,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</span>
            {t.onClose && (
              <span
                role="button"
                aria-label={`${t.label} 닫기`}
                onClick={(e) => {
                  // **탭 자체와 닫기를 구분한다** — 안 하면 탭이 열려 있다가 닫힌다.
                  e.stopPropagation();
                  t.onClose?.();
                }}
                style={{ color: DIM, fontSize: 12, lineHeight: 1, padding: "0 2px" }}
              >
                ✕
              </span>
            )}
          </button>
        );
      })}
      <span style={{ flex: 1 }} />
    </div>
  );
}

/**
 * 상태바 — **맨 아래 한 줄**.
 *
 * VS Community 의 상태바는 **높이가 얇고** 항상 보인다. 여기서도 얇게 두되
 * **항상 보이게** 한다 — 서버 상태와 컨텍스트를 한눈에 보는 자리다.
 *
 * **오른쪽 항목**은 뒤에 온다(`tone` 에 따라 색을 주되 **색만이 아니다** —
 * 값을 함께 쓴다).
 */
function StatusBar({ items }: { items: { text: string; tone?: string; title?: string }[] }) {
  const tone = (t: string | undefined): string =>
    t === "error" ? "#f85149" : t === "warn" ? "#d29922" : t === "good" ? "#3fb950" : DIM;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 20,
        padding: "0 8px",
        background: "#010409",
        borderTop: `1px solid ${HAIRLINE}`,
        fontSize: 10,
        color: DIM,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {items.map((s, i) => (
        <span key={i} title={s.title} style={{ color: tone(s.tone), flexShrink: 0 }}>
          {s.text}
        </span>
      ))}
    </div>
  );
}

/** IDE 프레임 — 액티비티바 · 탭 스트립 · 본문 · 상태바. */
export function Ide({ title, activity, tabs, status, children, activityWidth = 40 }: IdeProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: SURFACE_1 }}>
      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        <ActivityBar items={activity} width={activityWidth} />
        <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          <TabStrip title={title} tabs={tabs} />
          <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
        </div>
      </div>
      {status && status.length > 0 && <StatusBar items={status} />}
    </div>
  );
}

/** 본문 스크롤 영역 — IDE 의 편집기 면. */
export const EDITOR_BG = SURFACE_1;
export const DOCK_BG = SURFACE_2;
export const HAIRLINE_COLOR = HAIRLINE;
export const ACCENT = ACTIVE_BLUE;
export const SURFACE3 = SURFACE_3;
