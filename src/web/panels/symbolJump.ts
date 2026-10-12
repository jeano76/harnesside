/**
 * 기호 점프 화면 로직 — 순수 함수 (FilePreview 렌더와 분리).
 *
 * 왜 분리인가: 토큰→열 계산이 틀리면 엉뚱한 정의로 간다. 브라우저 없이
 * 검사할 수 있게 렌더(`FilePreview.tsx`)와 규칙(여기)을 나눈다 —
 * `/help` 렌더 분리(2026-10-05)와 같은 이유다.
 */

import type { Token, TokenKind } from "../editor/highlight.js";

/**
 * 정의 점프를 걸 토큰인가.
 *
 * 식별자처럼 보이는 것만: `function`·`type`·`property`·`plain`.
 * 키워드·문자열·주석·숫자·구두점을 누르면 컴파일러는 빈 목록을 주는데,
 * 그건 "정의가 없다" 가 아니라 **"누를 곳이 아니다"** — 요청을 보내지 않는다.
 */
export function isJumpableKind(kind: TokenKind): boolean {
  return kind === "function" || kind === "type" || kind === "property" || kind === "plain";
}

/** 토큰 목록에서 i번째 토큰의 시작 열(1-based). 이어붙이면 원문이다. */
export function tokenColumn(tokens: Token[], index: number): number {
  let col = 1;
  for (let i = 0; i < index && i < tokens.length; i++) col += tokens[i]!.text.length;
  return col;
}

/** 토큰 텍스트가 식별자처럼 보이는가 (빈 조각·공백만 제외). */
export function isIdentifierText(text: string): boolean {
  return /[A-Za-z_$]/.test(text);
}
