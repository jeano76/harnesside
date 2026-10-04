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
import { COLOR, LAYOUT, toneColor } from "../theme/tokens.js";

const HAIRLINE = COLOR.BORDER;
const SURFACE_2 = COLOR.SURFACE_2;
const SURFACE_3 = COLOR.SURFACE_3;
const SURFACE_1 = COLOR.SURFACE_1;
const FG = COLOR.FG;
const DIM = COLOR.DIM;
const ACTIVE_BLUE = COLOR.ACTIVE_BLUE;
const INACTIVE = COLOR.INACTIVE;

export interface ActivityItem {
  id: string;
  /** 아이콘 글자 — VS 는 도형을 쓴다. 여기에 **이름**도 같이 준다. */
  glyph: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}


/**
 * 상태바 항목 — 오른쪽 정렬되는 것은 뒤에 둔다.
 *
 * `ellipsis` 는 **길어질 수 있는 항목에만** 켠다. 켠 항목만 줄여지고 말줄임표로
 * 접힌다. 켜지 않은 항목(연결 상태·컨텍스트 같은 **몇 자 안 되는 값**)은 크기를
 * 지킨다 — 좁은 창에서 "연결" 이 "연" 으로 줄어드는 것은 말줄임이 아니라 **손실**이다.
 */
export interface IdeStatusItem {
  text: string;
  tone?: "normal" | "warn" | "error" | "good";
  /** 마우스를 올렸을 때 원문. 말줄임이 있으면 **거기 전체가** 있어야 한다. */
  title?: string;
  /** 줄바꿈 대신 말줄임표로 접어도 되는가. 긴 경로·긴 파일명만. */
  ellipsis?: boolean;
}

export interface IdeProps {
  activity: ActivityItem[];
  /** 상태바 항목 — 오른쪽 정렬되는 것은 뒤에 둔다. */
  status?: IdeStatusItem[];
  /** 탭 스트립과 본문 사이의 얇은 줄. VS 는 탭마다 연한 선이 있다. */
  children: React.ReactNode;
  /** 본문 فوق **오버레이**로 띄울 것 — 승인 게이트처럼 대화 흐름을 가리지만
   *   별도 패널이어서는 안 되는 무거운 UI 에서만 그린다. */
  overlay?: React.ReactNode;
  /** 액티비티바 폭(고정). VS Community 는 좁다. 좁은 창에서도 밀리면 안 된다. */
  activityWidth?: number;
}

/**
 * 액티비티바에서 **방향키가 옮겨갈 다음 인덱스** (S-2: "`role="tablist"` 를 선언해
 * **방향키로 이동**할 수 있어야 한다").
 *
 * 규칙은 **WAI-ARIA 탭 패턴(세로)** 이다:
 *   - `ArrowDown`/`ArrowRight` → 다음, `ArrowUp`/`ArrowLeft` → 이전
 *   - `Home` → 처음, `End` → 끝
 *   - 경계에서 ** 멈춘다. 넘어가면 "몇 개나 있는지" 를 모르게 된다.
 *
 * **순환시키지 않는 이유**: 감기면 마지막 항목에서 처음 항목으로 **값의 개수만큼**
 * 눌러야 한다. 화면에 몇 개인지 보이지 않는 곳에서 사용자가 몇 번을 눌러야 하는지
 * 계산하게 하는 것은 **발견 불가능한 함정**이다(부록 B 8: 화면이 말해야 한다).
 *
 * **포커스를 옮기면서 열기도 한다**(자동 활성화). 이 항목들은 탭이 아니라
 * "무엇을 열 것인가" 를 고르는 명령이라, 포커스만 옮기고 열지 않으면
 * "옮겼는데 아무 일도 없다" 는 한 번의 탭이 더 생긴다.
 *
 * @param key 누른 키. 관계없으면 `null`(옮기지 않는다).
 * @param count 항목 수. 0 이면 `-1`(옮길 곳이 없다).
 * @param current 지금 고른 인덱스. 없으면 0.
 */
export function nextActivityIndex(key: string | null, count: number, current: number): number {
  if (!key || count <= 0) return -1;
  const at = current >= 0 && current < count ? current : 0;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return Math.min(count - 1, at + 1);
    case "ArrowUp":
    case "ArrowLeft":
      return Math.max(0, at - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return -1;
  }
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
  const current = Math.max(0, items.findIndex((i) => i.active === true));
  const [focus, setFocus] = React.useState(current);
  // **선택이 바뀌면 포커스도 따라간다** — 키보드 사용자가 화면 밖으로 버려지는
  // 일이 없어야 한다(별도 상태를 들면 둘이 어긋난다).
  React.useEffect(() => setFocus(current), [current]);
  /** 실제로 **DOM 포커스**를 옮기기 위한 참조. `tabIndex` 만 바꾸면 포커스는 안 간다 —
   *  스크린 판독기는 "여기로 가세요" 와 "여기가 있다" 를 다르게 읽는다. */
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="tablist"
      aria-label="주요 보기"
      aria-orientation="vertical"
      onKeyDown={(e) => {
        const to = nextActivityIndex(e.key, items.length, focus);
        if (to < 0) return;
        // **페이지 전체가 방향키로 스크롤되지 않게** 먼저 막는다. 막지 않으면
        // 대화가 아니라 **창** 이 이동한다 — 포커스는 액티비티바 안에서 끝나야 한다.
        e.preventDefault();
        e.stopPropagation();
        setFocus(to);
        items[to]?.onClick();
        refs.current[to]?.focus();
      }}
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
      {items.map((it, i) => {
        const on = it.active === true;
        return (
          <button
            key={it.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            // **rove tabindex** — Tab 은 선택된 한 곳으로만 들어간다. 전부 `0` 이면
            // 사용자는 세 아이콘을 하나씩 눌러야 하는데, 지금 어디가 선택됐는지
            // 모른 채로 세 번을 누르게 되는 셈이다(WAI-ARIA 탭 패턴).
            tabIndex={i === focus ? 0 : -1}
            aria-label={it.label}
            title={it.label}
            onClick={() => {
              setFocus(i);
              it.onClick();
            }}
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
 * 상태바 — **맨 아래 한 줄**.
 *
 * 길어질 수 있는 항목만 줄이고(`ellipsis`), **원문은 `title` 에 남긴다.**
 * 잘린 걸 숨기면 "화면이 깨졌다" 고 읽힌다. 짧은 상태값(연결·컨텍스트)은
 * 줄이지 않는다 — "연결" 이 "연" 으로 줄어드는 것은 말줄임이 아니라 손실이다.
 */
function StatusBar({ items }: { items: IdeStatusItem[] }) {
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
        <span
          key={i}
          title={s.title ?? (s.ellipsis ? s.text : undefined)}
          style={
            s.ellipsis
              ? {
                  color: toneColor(s.tone),
                  minWidth: 0,
                  flexShrink: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }
              : { color: toneColor(s.tone), flexShrink: 0 }
          }
        >
          {s.text}
        </span>
      ))}
    </div>
  );
}

/** IDE 프레임 — 액티비티바 · 본문 · 상태바 (탭 스트립 삭제 2026-10-04: 제목 불필요). */
export function Ide({ activity, status, children, overlay, activityWidth = LAYOUT.ACTIVITY_WIDTH }: IdeProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: SURFACE_1 }}>
      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        {/* 항목이 없으면 띠를 그리지 않는다 — 빈 띠는 48px 자리만 차지한다.
            (사용자 지정: 설정은 상단 우측 아이콘으로 열고, 측면 아이콘은 두지 않는다) */}
        {activity.length > 0 && <ActivityBar items={activity} width={activityWidth} />}
        <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* **대화 위에 떠야 한다**(승인 게이트) — 자식 버튼이 클릭되도록 이벤트도 연다. */}
        {overlay && <div style={{ position: "absolute", inset: 0, zIndex: 20 }}>{overlay}</div>}
          {children}
        </div>
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
