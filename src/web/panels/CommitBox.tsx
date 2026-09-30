/**
 * 커밋 상자 (§9.3 · 요구 16 의 "커밋").
 *
 * 파일을 고르고 메시지를 써서 커밋한다. 화면에 두는 이유가 하나다:
 * **커밋 경로가 없으면 요구 16 의 clone → 열기 → 커밋 → pull 중 하나가 통째로
 * 빠져 있다**(PROGRESS 의 ◐ 정의 — "돌면 되지만 실행하지 않는다").
 *
 * 조심하는 것 두 가지:
 *  1. **저장소가 아니면** git 이 아니다 — "커밋" 버튼을 보여주고 실패하게 하지 않는다.
 *     요약 조회가 400 으로 오는 것을 "커밋할 수 없습니다" 로 말한다.
 *  2. **shallow(얕은 복사)** 에서 ahead/behind 는 계산되지 않는다. 0 을 "동기됨" 으로
 *     말하지 않는다(서버가 구분해 준 값을 그대로 보여준다).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient, ApiError } from "../api.js";

const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";

interface GitFile {
  path: string;
  code: string;
  staged: boolean;
  status: string;
}
interface Summary {
  branch: string | null;
  ahead: number;
  behind: number;
  shallow: boolean;
  files: GitFile[];
  clean: boolean;
}

const CODE_LABEL: Record<string, string> = {
  M: "수정",
  A: "추가",
  D: "삭제",
  R: "이름 변경",
  "?": "미추적",
  "??": "미추적",
  C: "복사",
};

export function CommitBox({
  client,
  onNotice,
  onCommitted,
}: {
  client: ApiClient;
  onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void;
  onCommitted?: () => void;
}) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await client.get<Summary>("/api/git/summary");
      setSum(s);
      setErr(null);
      // 기본으로 **모든 변경을 고른다.** 아무것도 안 고른 상태로 "커밋" 을 누르면
      // git 이 "아무것도 안 했습니다" 라고 말하는데, 그건 화면의 실수지 사용자의 실수가 아니다.
      setPicked(new Set(s.files.map((f) => f.path)));
    } catch (e) {
      // **저장소가 아니면 그 사실** 을 말한다. 빈 화면으로 두면 사용자가 왜 안 되는지 모른다.
      setSum(null);
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback((p: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const doCommit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await client.post<{ hash: string; message: string }>("/api/git/commit", {
        message: msg,
        paths: [...picked],
        all: false,
      });
      setMsg("");
      onNotice("info", "커밋했습니다", `${r.hash.slice(0, 7)} — ${r.message}`);
      void load();
      onCommitted?.();
    } catch (e) {
      // 실패 사유를 그대로 보여준다 — 서버가 이미 사람이 읽을 문장으로 바꿨다.
      const detail = e instanceof ApiError ? e.message : String(e);
      setErr(detail);
      onNotice("error", "커밋하지 못했습니다", detail);
    } finally {
      setBusy(false);
    }
  }, [client, msg, picked, onNotice, load, onCommitted]);

  const files = sum?.files ?? [];
  const canCommit = useMemo(() => msg.trim().length > 0 && picked.size > 0 && !busy, [msg, picked.size, busy]);

  if (err && !sum) {
    return (
      <div style={{ padding: 8, fontSize: 11, color: DIM, display: "grid", gap: 6 }}>
        <div>커밋할 수 없습니다 — {err}</div>
        <div style={{ fontSize: 10 }}>저장소가 아니거나 git 이 설치되어 있지 않습니다.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 0, padding: "6px 8px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11 }}>
        <strong>커밋</strong>
        <span style={{ color: DIM, fontSize: 10 }}>{sum?.branch ?? "?"}</span>
        {sum?.shallow && <span style={{ color: "#d29922", fontSize: 10 }}>얕은 복사 — 원격 차이 계산 불가</span>}
        {!!sum?.ahead && <span style={{ color: "#d29922", fontSize: 10 }}>미전송 {sum.ahead}</span>}
        {!!sum?.behind && <span style={{ color: "#d29922", fontSize: 10 }}>미반영 {sum.behind} (마지막 fetch 기준)</span>}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => void load()} style={btn}>
          새로고침
        </button>
      </div>

      {files.length === 0 ? (
        // **빈 화면을 두지 않는다**(§11.3) — 왜 비었는지 말한다.
        <div style={{ fontSize: 11, color: DIM }}>바뀐 파일이 없습니다 — 커밋할 것이 없습니다.</div>
      ) : (
        <div style={{ display: "grid", gap: 2, maxHeight: 140, overflow: "auto" }}>
          {files.map((f) => (
            <label key={f.path} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(f.path)} onChange={() => toggle(f.path)} />
              <span style={{ color: "#d29922", fontSize: 10, width: 42 }}>{CODE_LABEL[f.code] ?? f.code}</span>
              <span style={{ color: FG, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
              {f.staged && <span style={{ color: DIM, fontSize: 10 }}>이미 스테이징됨</span>}
            </label>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            // **빈 메시지는 서버가 막는다.** 여기서 조용히 막아도 되지만,
            // 왜 안 되는지 말해야 하므로 서버에 보내 그 문장을 그대로 받는다.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) void doCommit();
          }}
          placeholder="커밋 메시지"
          style={{
            flex: 1,
            background: "#0d1117",
            border: `1px solid ${BORDER}`,
            borderRadius: 5,
            color: FG,
            padding: "3px 6px",
            font: "inherit",
            fontSize: 11,
            outline: "none",
          }}
        />
        <button type="button" onClick={() => void doCommit()} disabled={!canCommit} style={{ ...btn, opacity: canCommit ? 1 : 0.5 }}>
          {busy ? "커밋 중" : `커밋 (${picked.size})`}
        </button>
      </div>

      {err && sum && <div style={{ color: "#f85149", fontSize: 10 }}>⚠ {err}</div>}
      {msg.trim() && picked.size === 0 && (
        <div style={{ color: "#d29922", fontSize: 10 }}>커밋할 파일을 하나 이상 고르십시오.</div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "#21262d",
  color: FG,
  border: `1px solid ${BORDER}`,
  borderRadius: 5,
  padding: "1px 8px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 10,
};
