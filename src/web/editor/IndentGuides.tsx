/**
 * 인덴트 가이드 렌더 (2026-10-05 · ③).
 *
 * 규칙(위치 계산)은 `indentRules.ts` 의 순수 함수에 있고, 여기는 **그림만** 한다.
 * 이 저장소 관례(`.ts` 에 규칙 · `.tsx` 에 렌더)를 그대로 지킨 이유가 여기에 있다:
 * 가이드 위치는 **브라우저 없이** 검사할 수 있어야 한다. 이 컴포넌트는 "선이
 * 어디쯤 놓이는가" 를 아무것도 모른다 — `guides` 를 그대로 그릴 뿐이다.
 *
 * 왜 `position: absolute` 인가: 줄마다 `relative` 컨테이너 안에 **1px짜리 세로선**
 * 을 얹는다. `border-left` 로 그리면 줄 높이만큼 테두리가 생겨 **줄바꿈 지점마다
 * 끊기고**, 텍스트 선택 영역과 겹쳐 어긋난다.
 */

import React from "react";
import { GUIDE_VISUAL, guideLeftCss, type IndentInfo } from "./indentRules.js";

export interface IndentGuidesProps {
  /** `indentInfoFor` 가 준 결과. */
  info: IndentInfo;
  /**
   * 줄 번호 거터까지 포함한 **글자 시작 위치(`ch`)**.
   * 호출부가 거터 폭을 알고 있다 — 거터는 픽셀 고정이라 여기서 계산할 수 없다.
   */
  offsetCh: number;
  /** 선 색. 기본은 `theme/tokens.ts` 의 `LINE_NUM` 을 호출부가 준다. */
  color?: string;
}

/**
 * 한 줄의 가이드. **선이 없으면 아무것도 렌더하지 않는다** — 빈 `div` 를 남기는
 * 것이 DOM 을 늘리고, "있어야 할 선이 빠졌다" 와 구분되지 않게 한다.
 */
export function IndentGuides({ info, offsetCh, color }: IndentGuidesProps): React.ReactElement | null {
  if (info.guides.length === 0) return null;
  return (
    <>
      {info.guides.map((c) => (
        <span
          key={c}
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: guideLeftCss({ column: c, offsetCh }),
            width: GUIDE_VISUAL.width,
            background: color,
            opacity: GUIDE_VISUAL.opacity,
            pointerEvents: "none",
          }}
        />
      ))}
    </>
  );
}
