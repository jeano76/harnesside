/**
 * **승인 게이트 UI** (S-6 §8.2) — 되돌릴 수 없는 조작은 확인을 받는다.
 *
 * ── 왜 화면이 "확인창" 이 아니라 **대화 속 블록** 인가 ──────────────────────────
 *
 * 2026-10-01 에 설정·변경 검토를 대화 안의 블록으로 옮겼고, 탐색기 패널은 **삭제**했다.
 * 승인은 그보다 더 대화 안에 있어야 한다 — "무엇을 하려다가 무엇을 승인했나" 가
 * 한 스크롤로 이어져야 나중에 되돌아갈 수 있다.
 *
 * 또 하나: **기본 취소다.** 창이 중앙에 뜬다" 하는 순간 사용자는 아무것도 누르지 않은
 * 채 기다린다. 명령이 **실행된다는 사실**(승인이 지난 뒤)을 블록에 남겨야 나중에
 * "내가 뭘 승인했나" 를 확인할 수 있다.
 *
 * ── 요구 그대로 ──────────────────────────────────────────────────────────────
 *
 * - *"되돌릴 수 없는 조작은 확인을 받는다."* → `irreversible` / `unknown` 은 여기서 온다.
 * - *"명령 실행 직후 되돌릴 방법을 함께 말한다. 되돌릴 수 없으면 **그 말부터** 한다."*
 *   → `headline()` 이 **판정 뒤가 아니라 앞**에 온다. 이 순서가 요구다.
 * - *"승인 게이트는 뚫리지 않는다."* → 경계를 넘은 경로는 여기서 열지 않는다.
 *
 * ── 색만이 아니다 ────────────────────────────────────────────────────────────
 *
 * 위험은 **색**(`#f85149`)으로만 말하지 않는다. **"되돌릴 수 없습니다"** 라는
 * **문장**이 앞에 오고, 버튼도 **"거절"** 이라는 글자로 말한다(§2 불변 15).
 */

import React, { useEffect, useState } from "react";
import type { ApiClient } from "../api.js";
import { useI18n } from "../i18n/index.js";
import { judgeCommand, headline, type Verdict } from "../../tools/irreversible.js";

const DIM = "#8b949e";
const FG = "#c9d1d9";
const BORDER = "#30363d";
const WARN = "#d29922";
const ERROR = "#f85149";

export interface ApprovalRequest {
  id: string;
  tool: string;
  summary: string;
  args?: Record<string, unknown>;
  requestedAt: number;
  expiresAt: number;
}

/** 남은 초 — 순수 함수로 분리해 테스트한다(60초 자동 거절의 화면 근거). */
export function secondsLeft(r: ApprovalRequest, now: number): number {
  return Math.max(0, Math.ceil((r.expiresAt - now) / 1000));
}

/** 승인 이벤트 → 대기 맵. 순수 함수로 분리해 테스트한다.
 *  request면 카드를 열고(done이면 닫는다). 같은 id 중복은 무시(재연결 broadcast 방지). */
export function applyApprovalEvent(
  prev: Map<string, ApprovalRequest>,
  ev: { type: string; request?: ApprovalRequest; id?: string }
): Map<string, ApprovalRequest> {
  if (ev.type === "approval.request") {
    const r = ev.request;
    if (!r?.id || prev.has(r.id)) return prev;
    const next = new Map(prev);
    next.set(r.id, r);
    return next;
  }
  if (ev.type === "approval.done") {
    if (!ev.id || !prev.has(ev.id)) return prev;
    const next = new Map(prev);
    next.delete(ev.id);
    return next;
  }
  return prev;
}

export function ApprovalCard({
  client,
  request,
  onNotice,
}: {
  client: ApiClient;
  request: ApprovalRequest;
  onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void;
}) {
  const [deciding, setDeciding] = useState(false);
  // **매초 다시 그린다** — 남은 시간이 줄어야 사용자가 "언제까지" 안다.
  // 그리고 **초과하면 거절된 것으로 보여야 한다**(무응답 = 거절, `ApprovalGate` 와 같다).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const t = useI18n();

  const left = secondsLeft(request, now);
  const expired = left <= 0;

  /** 도구 인자에서 셸 명령을 꺼낸다 — **있어야만** 되돌림 판정을 한다. */
  const command = readCommand(request);
  const verdict: Verdict = command ? judgeCommand(command) : { how: "unknown", because: t("approval.unknownCommand") };

  const decide = async (decision: "allow-once" | "allow-always" | "reject") => {
    setDeciding(true);
    try {
      await client.post(`/api/approval/${request.id}`, { decision });
      // **실행되었다고 말하지 않는다.** 서버가 결정만 받았고 실행 여부는 별개다 —
      // 거짓말로 "실행됨" 을 말하면 사용자는 확인을 건너뛴다(§5.10).
      onNotice(
        decision === "reject" ? "warn" : "info",
        decision === "reject" ? t("approval.rejectedTitle") : decision === "allow-always" ? t("approval.allowAlwaysTitle") : t("approval.allowOnceTitle"),
        decision === "reject" ? t("approval.rejectedBody") : `${t("approval.resultHint")} ${verdict.how === "undoable" ? (verdict.undo ?? "") : t("approval.checkIrreversible")}`.trim(),
      );
    } catch (e) {
      // **결정이 안 갔는데 "거절했습니다" 라고 말하면 안 된다.** 실패를 말하고
      // 다시 고르게 둔다 — 그게 무응답 = 거절과 같아 안전하다.
      onNotice("error", t("approval.decideFailed"), e instanceof Error ? e.message : String(e));
      setDeciding(false);
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${verdict.how === "irreversible" ? ERROR : WARN}`,
        borderRadius: 6,
        background: "#161b22",
        padding: "8px",
        display: "grid",
        gap: 6,
      }}
    >
      {/* ── **첫 줄이 판정이다** (요구: "되돌릴 수 없으면 그 말부터") ──────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: verdict.how === "irreversible" ? ERROR : WARN, fontSize: 12 }}>{expired ? t("approval.expiredTitle") : t("approval.needApproval")}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: DIM, fontSize: 10 }}>{expired ? t("approval.expired") : t("approval.autoReject", { left })}</span>
      </div>

      {/* **판정 문장** — 색이 아니라 말로. 이것이 요구의 중심이다. */}
      <div style={{ color: verdict.how === "irreversible" ? ERROR : FG, fontSize: 11, fontWeight: 600 }}>{headline(verdict)}</div>

      {/* **무엇을 실행하려는지** — 판정만으로는 부족하다. 경로와 인자가 보인다. */}
      <div style={{ color: DIM, fontSize: 10 }}>
        {t("approval.tool")}: {request.tool}
        {command ? (
          <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", font: "11px/1.4 ui-monospace, monospace", color: FG }}>{command}</pre>
        ) : (
          <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", font: "11px/1.4 ui-monospace, monospace", color: FG }}>{JSON.stringify(request.args ?? {})}</pre>
        )}
      </div>

      {/* ── 결정 ────────────────────────────────────────────────────────────────
          **기본은 거절이다.** 승인 버튼을 먼저 크고 밝게 놓으면 사용자는 **읽지 않고
          누른다.** 그리고 그게 `rm -rf` 를 approve 하는 가장 흔한 경로다. */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" disabled={deciding || expired} onClick={() => void decide("reject")} style={btn(DIM, true)}>
          {t("approval.reject")}
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" disabled={deciding || expired} onClick={() => void decide("allow-once")} style={btn(FG)}>
          {t("approval.allowOnce")}
        </button>
        <button type="button" disabled={deciding || expired} onClick={() => void decide("allow-always")} title={t("approval.allowAlwaysHint")} style={btn(FG)}>
          {t("approval.allowAlways")}
        </button>
      </div>
    </div>
  );
}

/** 인자에서 **셸 명령** 을 꺼낸다. 없으면 `null` — 지어내지 않는다. */
function readCommand(r: ApprovalRequest): string | null {
  const a = r.args;
  if (!a) return null;
  for (const k of ["command", "cmd", "script"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function btn(color: string, strong = false): React.CSSProperties {
  return {
    background: strong ? "none" : "#21262d",
    color,
    border: `1px solid ${BORDER}`,
    borderRadius: 4,
    font: "inherit",
    fontSize: 11,
    padding: "2px 10px",
    cursor: "pointer",
  };
}
