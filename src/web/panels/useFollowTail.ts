/**
 * 끝 따라가기 훅 — 판정(`followTail.ts`)의 React 껍데기.
 *
 * 쓰는 법: 스크롤 컨테이너에 `ref`·`onScroll` 을 달고, 내용이 바뀔 때마다
 * 바뀌는 값(스트리밍 텍스트 등)을 `followKey` 로 넘긴다. 사용자가 끝 근처에
 * 있을 때만 끝으로 옮기고, 위로 올린 상태에서는 손대지 않는다.
 *
 * `target` 을 주면 그 엘리먼트를 보고 옮긴다(DiffPanel 의 body 처럼 ref 가
 * 밖에 있는 경우). 안 주면 훅이 만든 ref 를 쓴다.
 *
 * `useStickToBottom` 은 내용 변화를 **DOM 에서 직접 관찰**한다 — 키를 넘길 수 없는 큰 영역(대화 전체)용.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { nextStick, shouldStickToBottom } from "./followTail.js";

export function useFollowTail<T extends HTMLElement>(
  enabled: boolean,
  followKey: unknown,
  target?: { current: T | null },
) {
  const innerRef = useRef<T | null>(null);
  const ref = target ?? innerRef;
  const stick = useRef(true);
  /** 우리가 마지막으로 놓은 scrollTop. 이 값과 같은 위치의 스크롤 이벤트는 우리 것이다. */
  const lastSet = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = nextStick(stick.current, el, lastSet.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref 객체는 고정이다.
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
      lastSet.current = el.scrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followKey 변화에만 반응한다.
  }, [enabled, followKey]);
  return { ref, onScroll };
}

/**
 * 스크롤 컨테이너 전체를 바닥에 붙여 둔다 — 안에서 **무엇이** 자라든(스트리밍 답변, 코드 초안, 도구
 * 출력) 따라간다. 키를 넘기는 방식은 자라는 것이 키에 안 들어 있으면 놓친다(대화 영역이 그랬다).
 *
 * - 자식이 바뀌면(MutationObserver) 다음 프레임에 바닥으로 옮긴다. 프레임당 한 번만(rAF 병합).
 * - 크기가 바뀌면(ResizeObserver) 같다 — 이미지·폰트·접기/펼치기.
 * - 사용자가 위로 올리면 멈추고 `pinned=false` 가 되어 "새 내용" 배지를 띄울 수 있다.
 */
export function useStickToBottom(ref: { current: HTMLElement | null }) {
  const stick = useRef(true);
  const lastSet = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const [pinned, setPinnedState] = useState(true);

  const setPinned = useCallback((v: boolean) => {
    stick.current = v;
    setPinnedState((p) => (p === v ? p : v));
  }, []);

  const jump = useCallback(
    (smooth = false) => {
      const el = ref.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      // 부드러운 이동은 도착 위치를 모른다 — 우리 이벤트로 취급하지 않고 이벤트가 정하게 둔다.
      lastSet.current = smooth ? null : el.scrollTop;
    },
    [ref],
  );

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (stick.current) jump();
    });
  }, [jump]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    for (const c of Array.from(el.children)) ro?.observe(c);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [ref, schedule]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = nextStick(stick.current, el, lastSet.current);
    if (next !== stick.current) setPinned(next);
    else if (next && !pinned) setPinned(true);
  }, [ref, setPinned, pinned]);

  return { pinned, onScroll, pin: (smooth = false) => { setPinned(true); jump(smooth); } };
}

export { shouldStickToBottom };
