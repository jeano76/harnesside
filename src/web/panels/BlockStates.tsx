/**
 * 블록 3상태 공용 컴포넌트 — PROMPT_UX_COMMERCIAL.md §3.4.
 *
 * 모든 비동기 블록(검색·파일·모델·로그·터미널)은 로딩/빈/오류를 같은 양식으로 말한다.
 * 금지: `ok:true`로 아무것도 안 하기, 404를 올바른 문장으로 덮기, 빈 화면을 한 줄 글자로 채우기.
 */
import React from "react";
import { COLOR, FONT, RADIUS, SPACE } from "../theme/tokens.js";
import { useI18n } from "../i18n/index.js";

const box: React.CSSProperties = {
  border: `1px solid ${COLOR.BORDER}`,
  borderRadius: RADIUS.M,
  background: COLOR.SURFACE_1,
  padding: `${SPACE.BLOCK_PAD_Y}px ${SPACE.BLOCK_PAD_X}px`,
  fontSize: FONT.AUX,
  lineHeight: FONT.LINE_BODY,
};

export function LoadingState({ label, onCancel }: { label: string; onCancel?: () => void }) {
  const t = useI18n();
  return (
    <div style={{ ...box, color: COLOR.DIM }} role="status" aria-live="polite">
      <span aria-hidden="true">○ </span>
      {label}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          style={{
            marginLeft: 8, background: COLOR.SURFACE_3, color: COLOR.FG,
            border: `1px solid ${COLOR.BORDER}`, borderRadius: RADIUS.S,
            font: "inherit", fontSize: FONT.META, padding: "0 6px", cursor: "pointer",
          }}
        >
          {t("state.cancel")}
        </button>
      )}
    </div>
  );
}

/** Empty result — says *what·where* was searched plus one next action. */
export function EmptyState({ query, scope, actionLabel, onAction }: {
  query: string;
  scope: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const t = useI18n();
  return (
    <div style={{ ...box, color: COLOR.DIM }} role="status">
      {t("state.emptyResult", { query, scope })}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          style={{
            marginLeft: 8, background: "transparent", color: COLOR.BLUE,
            border: 0, textDecoration: "underline", cursor: "pointer", font: "inherit", fontSize: FONT.AUX,
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/**
 * 오류 — 404는 404라고 보인다. 올바른 문장으로 덮지 않는다.
 * `code`가 있으면 ` · 코드`까지 함께 노출한다.
 */
export function ErrorState({ message, code, onRetry }: {
  message: string;
  code?: string;
  onRetry?: () => void;
}) {
  const t = useI18n();
  return (
    <div style={{ ...box, color: COLOR.ERROR }} role="alert">
      <span aria-hidden="true">✗ </span>
      {t("state.failed")}: {message}
      {code ? <span style={{ color: COLOR.DIM }}> · {code}</span> : null}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginLeft: 8, background: COLOR.SURFACE_3, color: COLOR.FG,
            border: `1px solid ${COLOR.BORDER}`, borderRadius: RADIUS.S,
            font: "inherit", fontSize: FONT.META, padding: "0 6px", cursor: "pointer",
          }}
        >
          {t("state.retry")}
        </button>
      )}
    </div>
  );
}

/** 순수 판정 — 빈 검색어(공백만)는 요청하지 않는다 (저장소 전체 읽기 방지). */
export function isBlankQuery(q: string): boolean {
  return q.trim().length === 0;
}
