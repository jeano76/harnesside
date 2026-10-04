/**
 * 블록 헤더 — 대화출력창 9종 공통 머리 (PROMPT_UX_COMMERCIAL.md §3.12).
 *
 * 계약: `도형+이름+대상+상태+시간` 1줄. 색만으로 알리지 않고 기호+말을 함께 쓴다.
 * 복사 버튼은 본문만 복사한다 (헤더 제외).
 */
import React from "react";
import { BLOCK_KIND_META, COLOR, FONT, type BlockKindKey } from "../theme/tokens.js";

export interface BlockHeaderProps {
  kind: BlockKindKey;
  /** 대상 — 경로·명령·검색어 등. 길면 말줄임, 원문은 title. */
  target?: string;
  /** 상태 꼬리 — `exit 0 · 0.8s`, `120줄`, `12건` 등. */
  status?: string;
  /** HH:MM. 없으면 생략 (지어내지 않는다). */
  time?: string;
  /** 완료 여부. 셸·도구 블록만 쓴다. 없으면 상태점 없음. */
  done?: boolean;
  /** 복사할 본문. 없으면 복사 버튼 없음. */
  copyText?: string;
}

export function headerLabel(kind: BlockKindKey): { glyph: string; label: string } {
  return { glyph: BLOCK_KIND_META[kind].glyph, label: BLOCK_KIND_META[kind].label };
}

/** 헤더 한 줄 문자열 (테스트·로그용, 렌더와 같은 순서). */
export function headerText(kind: BlockKindKey, target?: string, status?: string): string {
  const m = BLOCK_KIND_META[kind];
  const parts = [`${m.glyph} ${m.label}`];
  if (target && target.trim()) parts.push(target.trim());
  if (status && status.trim()) parts.push(status.trim());
  return parts.join(" · ");
}

export function BlockHeader({ kind, target, status, time, done, copyText }: BlockHeaderProps) {
  const m = BLOCK_KIND_META[kind];
  const [copied, setCopied] = React.useState(false);
  const dot = done === undefined ? null : done ? (
    <span style={{ color: COLOR.GOOD }} aria-label="완료">✓</span>
  ) : (
    <span style={{ color: COLOR.YELLOW }} aria-label="실행 중">▸</span>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: FONT.META, color: COLOR.DIM, marginBottom: 2, minWidth: 0 }}>
      <span aria-hidden="true">{m.glyph}</span>
      {dot}
      <span style={{ color: COLOR.DIM, flexShrink: 0 }}>{m.label}</span>
      {target ? (
        <code
          title={target}
          style={{
            color: COLOR.FG, fontSize: FONT.META, minWidth: 0, flex: "1 1 auto",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {target}
        </code>
      ) : (
        <span style={{ flex: "1 1 auto" }} />
      )}
      {status ? <span style={{ flexShrink: 0 }}>{status}</span> : null}
      {time ? <span style={{ flexShrink: 0 }}>{time}</span> : null}
      {copyText !== undefined && (
        <button
          type="button"
          aria-label="블록 복사"
          title={copied ? "복사됨" : "복사"}
          onClick={() => {
            try {
              void navigator.clipboard?.writeText(copyText);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              /* 클립보드 실패는 조용히 둔다 — 토스트로 덮지 않는다 */
            }
          }}
          style={{
            flexShrink: 0, background: "transparent", color: copied ? COLOR.GOOD : COLOR.DIM,
            border: 0, cursor: "pointer", font: "inherit", fontSize: FONT.META, padding: "0 2px",
          }}
        >
          {copied ? "✓" : "⧉"}
        </button>
      )}
    </div>
  );
}
