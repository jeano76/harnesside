/**
 * 끝 따라가기(stick-to-bottom) 판정 — 순수 함수.
 *
 * 스트리밍(작성 중인 코드·diff)이 `maxHeight` 를 넘기면 스크롤바가 생기는데,
 * 그때 화면이 맨 위에 멈춰 있으면 새 토큰이 보이지 않는 곳에 쌓인다. 그래서
 * 내용이 바뀔 때마다 "사용자가 끝 근처에 있는가" 를 보고, 그렇다면 끝으로
 * 옮긴다. **사용자가 위로 올린 상태에서는 건드리지 않는다** — 읽는 중인 줄을
 * 낚아채는 것이 이 기능의 유일한 실패 방식이므로, 판정은 관대하게(임계값 안은
 * "끝" 으로 본다), 동작은 조용히(스크롤 위치만 옮긴다) 한다.
 */

/** 끝으로 보는 여유(px). 줄 하나 높이보다 작고, 터치 관성보다 크다. */
export const STICK_THRESHOLD_PX = 24;

/**
 * 스크롤 컨테이너가 끝 근처에 있는가. `true` 면 다음 내용이 올 때 끝으로
 * 옮겨도 된다. 측정값이 비정상이면 `true` (따라가기) 로 둔다 — 멈추는 쪽이
 * "토큰이 안 보인다" 는 신고가 된다.
 */
export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return true;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * 방금 **우리가** 옮긴 위치에서 온 스크롤 이벤트인가.
 *
 * 스크롤 이벤트는 프로그램이 `scrollTop` 을 바꾼 **다음 프레임**에 도착한다. 그 사이 새 내용이 붙어
 * 있으면 이벤트 시점의 "바닥까지 거리" 가 임계값을 넘고, 그것을 사용자가 위로 올린 것으로 읽으면
 * 따라가기가 스스로 꺼진다 — 출력이 빠를수록(큰 덩어리가 연달아 올수록) 자주 일어난다(실측).
 * 사용자가 움직였다면 `scrollTop` 이 우리가 놓은 값과 달라진다. 같으면 우리 이벤트다.
 */
export function isOwnScroll(scrollTop: number, lastSetTop: number | null): boolean {
  return lastSetTop !== null && Number.isFinite(scrollTop) && Math.abs(scrollTop - lastSetTop) < 1;
}

/**
 * 스크롤 이벤트로 "따라가는 중인가" 를 갱신한다 — 순수 함수.
 * 우리 이벤트(`isOwnScroll`)는 **끄지 않는다**(바닥에 있으면 켤 수만 있다). 사용자가 움직인 이벤트만
 * 거리를 보고 정한다.
 */
export function nextStick(
  prev: boolean,
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  lastSetTop: number | null,
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  const near = shouldStickToBottom(m.scrollTop, m.scrollHeight, m.clientHeight, threshold);
  if (isOwnScroll(m.scrollTop, lastSetTop)) return prev || near;
  return near;
}
