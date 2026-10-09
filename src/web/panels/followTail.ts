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
