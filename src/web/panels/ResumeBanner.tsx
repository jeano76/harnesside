/**
 * 재개 배너 (M3).
 *
 * 취소한 턴은 체크포인트에 남고 **다음 턴에서 자동으로** 이어진다. 사용자는 그것을
 * 볼 수도, 알 수도 없다 — 아무 일도 일어나지 않은 것처럼 보인다. 그래서 배너가
 * **있을 때만** 나타나고, 무엇을 재개하는지(**목표 원문**)와 진행 상황을 말한다.
 *
 * 배너를 **항상** 보여주면 안 된다. "재개할 수 있습니다" 가 거짓말이 되고, 사용자는
 * 진짜로 필요한 순간에 경고를 무시하게 된다.
 */

import React from "react";
import { ApiClient, ApiError } from "../api.js";

export interface ResumeState {
  present: boolean;
  goal: string | null;
  reason: string | null;
  stepsDone: number;
  stepsTotal: number;
  savedAt: string | null;
  steps: Array<{ description: string; status: "done" | "in_progress" | "todo" }>;
  pendingToolCall: { name: string; argumentsJson: string; reason: string } | null;
}

const REASON_LABEL: Record<string, string> = {
  "auto-threshold": "대화 압축으로 저장됨",
  manual: "수동 저장",
  "plan-progress": "진행 상황이 저장됨",
};

export function ResumeBanner({
  client,
  running,
  onResumed,
  onNotice,
}: {
  client: ApiClient;
  running: boolean;
  onResumed: () => void;
  onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void;
}) {
  const [st, setSt] = React.useState<ResumeState | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setSt(await client.get<ResumeState>("/api/agent/resume"));
    } catch {
      // 조회 실패는 "없음" 이 **아니다.** 모르는 상태를 "없음" 으로 두면 배너가
      // 사라져 사용자가 저장된 작업을 놓친다 — 그래서 이전 값을 그대로 둔다.
      setSt((prev) => prev);
    }
  }, [client]);

  React.useEffect(() => {
    void load();
    // 턴이 끝날 때마다 다시 본다 — 재개되면 체크포인트가 사라지므로 배너도 사라져야 한다.
  }, [load, running]);

  // **주기적으로 다시 본다.** 체크포인트는 아무 때나 생긴다 — 압축이 돌아갈 때,
  // plan 이 갱신될 때, 이전 실행이 죽어서 남긴 것이라 창이 뜬 뒤에 발견될 때.
  // 마운트 시 1회만 보면 "파일이 나중에 생겼는데 배너가 안 뜬다"(실측)가 된다.
  // 비용은 로컬 JSON 한 건 읽기이므로 5초면 충분하다.
  React.useEffect(() => {
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const [open, setOpen] = React.useState(false);

  if (!st?.present) return null;

  const progress = st.stepsTotal > 0 ? `단계 ${st.stepsDone}/${st.stepsTotal}` : null;
  const remaining = (st.steps ?? []).filter((s) => s.status !== "done");
  const remainingText = remaining.map((s, i) => `${i + 1}. ${s.description}`).join("\n");
  // 마우스 오버 + 펼침으로 남은 작업을 미리 본다 — 개수만 보이면 "뭐가 남았지" 가 된다.

  return (
    <>
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        padding: "3px 6px",
        background: "#1c2b1c",
        borderBottom: "1px solid #30363d",
        fontSize: 10,
      }}
    >
      <span style={{ color: "#3fb950", flex: "0 0 auto" }}>이어서 할 작업이 남아 있습니다</span>
      {/* **목표 원문을 그대로** 보여준다. 요약하면 "뭘 재개한다는 말인가" 를 되묻게 된다. */}
      {st.goal && (
        <span style={{ color: "#6e7681", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={st.goal}>
          {st.goal}
        </span>
      )}
      {progress && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={remainingText || progress}
          style={{ background: "none", border: 0, color: "#6e7681", cursor: remaining.length > 0 ? "pointer" : "default", font: "inherit", flex: "0 0 auto" }}
        >
          {progress} {remaining.length > 0 ? (open ? "▾" : "▸") : null}
        </button>
      )}
      {st.reason && <span style={{ color: "#6e7681", flex: "0 0 auto" }}>{REASON_LABEL[st.reason] ?? st.reason}</span>}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        disabled={busy || running}
        title={running ? "진행 중인 턴이 끝난 뒤에 재개할 수 있습니다" : "저장된 작업을 이어서 진행합니다"}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await client.post<{ ok: boolean; detail: string }>("/api/agent/resume");
            if (r.ok) {
              onResumed();
              void load();
            } else {
              onNotice("warn", "재개하지 못했습니다", r.detail);
            }
          } catch (e) {
            onNotice("error", "재개 요청 실패", e instanceof ApiError ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        style={{
          background: busy || running ? "#21262d" : "#238636",
          color: "#fff",
          border: "1px solid #30363d",
          borderRadius: 4,
          font: "inherit",
          fontSize: 10,
          padding: "1px 6px",
          cursor: busy || running ? "default" : "pointer",
          flex: "0 0 auto",
        }}
      >
        {busy ? "재개 중" : "이어서 진행"}
      </button>
    </div>
      {open && remaining.length > 0 && (
        <div style={{ padding: "2px 6px 4px 22px", background: "#1c2b1c", borderBottom: "1px solid #30363d", fontSize: 10, display: "grid", gap: 1 }}>
          {remaining.map((s, i) => (
            <div key={i} style={{ color: s.status === "in_progress" ? "#d29922" : "#8b949e" }}>
              {s.status === "in_progress" ? "▸" : "○"} {s.description}
            </div>
          ))}
          {st.pendingToolCall && (
            <div style={{ color: "#6e7681" }}>다음: {st.pendingToolCall.name} — {st.pendingToolCall.reason}</div>
          )}
        </div>
      )}
  </>
  );
}
