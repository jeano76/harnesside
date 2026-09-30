/**
 * 업데이트 화면 (§9.1 · §5.13.1).
 *
 * "지금 적용" 을 누를 수 있게 하려면 **되돌릴 수 있어야** 한다. 그래서 슬롯이 없으면
 * 적용 버튼 대신 "롤백 슬롯 만들기" 가 뜬다 — 핑계로 통과시키지 않는다(D14: 자동 업데이트
 * 설치는 기본 꺼짐, 롤백 슬롯을 못 만들면 시도 자체를 막는다).
 *
 * 진행 단계는 **WS** 로 온다. 라우트를 폴링하면 "확인 중" 인지 "3단계째" 인지
 * 구분할 수 없다.
 */

import React, { useCallback, useEffect, useState } from "react";
import { ApiClient, ApiError } from "../api.js";

const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";

export interface UpdateState {
  state: string;
  current: string;
  remote: { version: string; notes: string; url: string } | null;
  assets: { name: string; size: number }[];
  slots: string[];
  lastError: string | null;
}

export function UpdateSection({
  client,
  onNotice,
  onPhase,
}: {
  client: ApiClient;
  onNotice: (k: "info" | "warn" | "error", t: string, b: string) => void;
  onPhase: (p: { state: string; progress: number; message: string }) => void;
}) {
  const [st, setSt] = useState<UpdateState | null>(null);
  const [plan, setPlan] = useState<{ ok: boolean; items: string[]; blockers: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await client.get<UpdateState>("/api/update"));
    } catch {
      /* 나중에 온다 */
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
      }
    },
    []
  );

  return (
    <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 8, display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <strong style={{ fontSize: 11 }}>업데이트</strong>
        <span style={{ color: DIM, fontSize: 10 }}>현재 {st?.current ?? "?"}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              try {
                setSt(await client.post<UpdateState>("/api/update/check"));
              } catch (e) {
                onNotice("error", "업데이트 확인 실패", e instanceof ApiError ? e.message : String(e));
              }
            })
          }
          style={btn}
        >
          확인
        </button>
      </div>

      {st?.lastError && <div style={{ color: "#f85149", fontSize: 10 }}>⚠ {st.lastError}</div>}
      {st?.state === "available" && st.remote && <div style={{ fontSize: 11, color: "#3fb950" }}>새 버전 {st.remote.version} 있습니다</div>}
      {st?.state === "up-to-date" && <div style={{ fontSize: 11, color: DIM }}>최신입니다</div>}

      {st?.state === "available" && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {st.assets.length === 0 && <span style={{ color: "#d29922", fontSize: 10 }}>릴리스에 자산이 없습니다</span>}
            {st.assets.map((a, i) => (
              <button
                key={a.name}
                type="button"
                onClick={() =>
                  void act(async () => {
                    try {
                      const r = await client.post<{ ok: boolean; detail: string }>("/api/update/download", { index: i });
                      if (r.ok) onNotice("info", "다운로드 완료", `${a.name} — 슬롯에 저장했습니다.`);
                      else onNotice("error", "다운로드 실패", r.detail);
                    } catch (e) {
                      onNotice("error", "다운로드 실패", e instanceof ApiError ? e.message : String(e));
                    }
                  })
                }
                style={btn}
              >
                받기: {a.name}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  try {
                    const r = await client.post<{ decision: { ok: boolean; items: string[]; blockers: string[] } }>("/api/update/plan");
                    setPlan(r.decision);
                  } catch (e) {
                    onNotice("error", "적용 계획 실패", e instanceof ApiError ? e.message : String(e));
                  }
                })
              }
              style={btn}
            >
              적용 계획 보기
            </button>
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  try {
                    const r = await client.post<{ ok: boolean; detail: string }>("/api/update/slot");
                    onNotice(r.ok ? "info" : "error", r.ok ? "롤백 슬롯 생성" : "슬롯 생성 실패", r.detail);
                    void load();
                  } catch (e) {
                    onNotice("error", "슬롯 생성 실패", e instanceof ApiError ? e.message : String(e));
                  }
                })
              }
              style={btn}
            >
              롤백 슬롯 만들기
            </button>
          </div>
          {st.slots.length === 0 && (
            <div style={{ color: "#d29922", fontSize: 10 }}>
              되돌릴 곳이 없으므로 **적용을 막습니다**(기본 꺼짐 · D14). 슬롯을 먼저 만드십시오.
            </div>
          )}
        </div>
      )}

      {plan && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8, display: "grid", gap: 4 }}>
          {plan.items.map((t, i) => (
            <div key={i} style={{ fontSize: 10, color: DIM }}>
              · {t}
            </div>
          ))}
          {plan.blockers.map((t, i) => (
            <div key={i} style={{ fontSize: 10, color: "#f85149" }}>
              ✗ {t}
            </div>
          ))}
          <div style={{ color: plan.ok ? "#3fb950" : "#f85149", fontSize: 10 }}>
            {plan.ok ? "적용 가능" : "적용 불가 — 위 사유를 먼저 해결하십시오"}
          </div>
        </div>
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
