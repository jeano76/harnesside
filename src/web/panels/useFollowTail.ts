/**
 * 끝 따라가기 훅 — 판정(`followTail.ts`)의 React 껍데기.
 *
 * 쓰는 법: 스크롤 컨테이너에 `ref`·`onScroll` 을 달고, 내용이 바뀔 때마다
 * 바뀌는 값(스트리밍 텍스트 등)을 `followKey` 로 넘긴다. 사용자가 끝 근처에
 * 있을 때만 끝으로 옮기고, 위로 올린 상태에서는 손대지 않는다.
 *
 * `target` 을 주면 그 엘리먼트를 보고 옮긴다(DiffPanel 의 body 처럼 ref 가
 * 밖에 있는 경우). 안 주면 훅이 만든 ref 를 쓴다.
 */
import { useCallback, useEffect, useRef } from "react";
import { shouldStickToBottom } from "./followTail.js";

export function useFollowTail<T extends HTMLElement>(
  enabled: boolean,
  followKey: unknown,
  target?: { current: T | null },
) {
  const innerRef = useRef<T | null>(null);
  const ref = target ?? innerRef;
  const stick = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = shouldStickToBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref 객체는 고정이다.
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followKey 변화에만 반응한다.
  }, [enabled, followKey]);
  return { ref, onScroll };
}
