/**
 * 슬래시 메뉴 **스크롤** 계산 — 선택 항목이 화면 밖으로 나가도 따라가는 순수 로직.
 *
 * ── 무엇이 고장인가 (재촉으로 확인) ────────────────────────────────────────
 *
 * 리스트박스는 `maxHeight: 240, overflowY: "auto"` 이라 **스크롤이 가능하다.**
 * 그런데 `main.tsx` 어디에도 그 컨테이너를 움직이는 코드가 없다:
 * `ArrowDown`/`ArrowUp` 은 `setSlashIdx` 만 부르고 끝난다.
 *
 * 결과: 항목을 계속 누르면 **선택 표시만 화면 아래로 사라진다.** 사용자는
 * 아래로 내리고 있다고 believes 화면이 따라오길 기대하는데 아무 일도 안 일어난다.
 * 목록이 스크롤되는 것도 아니고 선택이 보이지 않는 것도 아니고 **그냥 멈춘다.**
 *
 * ── 왜 `scrollIntoView` 를 안 쓰는가 ────────────────────────────────────────
 *
 * `scrollIntoView` 는 **조상 전부**를 스크롤한다. 이 메뉴는 대화 위 플로팅이라,
 * 쓰면 **대화 스크롤까지 같이 움직여** 읽던 자리를 빼앗긴다(§11.3).
 * 그래서 **컨테이너의 `scrollTop` 만 직접** 바꾼다 — 옆에 있는 것만 움직인다.
 *
 * ── 순수 함수인 이유 ────────────────────────────────────────────────────────
 *
 * DOM 을 만들지 않고 숫자만으로 판정한다. 그래야 "항목이 마지막에 있는데
 * 목록이 끝까지 내려갔는가" 를 **단위 테스트로** 증명할 수 있다.
 */

/** 선택 항목을 보이게 하는 **최소** 스크롤 위치. */
export interface ShowItemInput {
  /** 컨테이너의 현재 `scrollTop`. */
  scrollTop: number;
  /** 컨테이너의 보이는 높이(`clientHeight`). */
  clientHeight: number;
  /** 항목 윗변의 위치 — **스크롤 내용 좌표** 기준(즉 `scrollTop` 을 더한 값). */
  itemTop: number;
  /** 항목 높이. */
  itemHeight: number;
}

/**
 * 항목이 **보이게 하는 최소한만** 스크롤한다.
 *
 * 최소한만 움직이는 이유: 필요 이상으로 스크롤하면 사용자가 보던 항목이 위로 사라져
 * 또 다른 항목이 보이지 않게 된다. 한 칸씩 움직여야 **연속으로** 내려가는 느낌이 난다.
 *
 * 위쪽을 벗어났으면 `itemTop` 으로 붙인다(여백 0 — 항목 높이가 곧 줄 높이).
 * 아래쪽을 벗어났으면 항목 아랫변을 컨테이너 아랫변에 맞춘다.
 * 이미 보이면 **아무것도 바꾸지 않는다** — 무관한 스크롤은 부작용이다.
 */
export function scrollTopToShow({ scrollTop, clientHeight, itemTop, itemHeight }: ShowItemInput): number {
  // 입력 방어 — 숫자가 아니면 0 으로 간주한다. NaN 이 들어오면 아래 비교가 전부 false 여서
  // 조용히 아무것도 안 하는데, 그게 "이미 보인다" 와 구분이 안 되는 상태가 된다.
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  const height = Number.isFinite(clientHeight) ? Math.max(0, clientHeight) : 0;
  const item = Number.isFinite(itemTop) ? itemTop : 0;
  const ih = Number.isFinite(itemHeight) ? Math.max(0, itemHeight) : 0;

  if (item < top) return item; // 위로 벗어남 → 항목 윗변에 붙인다
  const itemBottom = item + ih;
  if (itemBottom > top + height) return itemBottom - height; // 아래로 벗어남 → 아랫변에 맞춘다
  return top; // 이미 보인다 → 움직이지 않는다
}

/**
 * 항목의 위치를 **스크롤 내용 좌표**로 잰다.
 *
 * `offsetTop` 은 **가장 가까운 positioned 조상** 기준이라, 이 메뉴처럼
 * `position:absolute` 를 쓰면 **컨테이너가 아니라 바깥 div 가 기준**이 된다.
 * 그래서 `getBoundingClientRect` 두 개를 빼서 **스크롤과 무관한 값**을 얻는다.
 *
 * 왜 이 함수가 따로 있나: 순수 계산(`scrollTopToShow`)과 **재촉**(여기)을
 * 분리해야 테스트가 DOM 없이 증명할 수 있다.
 */
export function itemTopInContent(list: HTMLElement, item: HTMLElement): number {
  const lb = list.getBoundingClientRect();
  const ib = item.getBoundingClientRect();
  return ib.top - lb.top + list.scrollTop;
}