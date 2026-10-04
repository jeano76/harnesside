/**
 * 추천 알림 목록 — M13 (§5.13.2).
 *
 * 판단은 서버(`NoticeService`)가 하고 여기는 보여주기만 한다.
 * - "읽음" = 이번 세션만 숨김 (dismiss)
 * - "다시 보지 않기" = 영구 무시 (silence) — 같은 항목은 다시 뜨지 않는다
 * - 둘을 섞으면 재시작 후 동작이 거짓말이 되므로 버튼 문구에 그대로 적는다
 */
import React, { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../api.js";
import { COLOR, FONT, RADIUS } from "../theme/tokens.js";
import { ErrorState, LoadingState } from "./BlockStates.js";

export interface Notice {
  id: string;
  kind: "model" | "llama" | "harnesside" | "warn";
  title: string;
  body: string;
  fit: number;
  at: number;
  severity: "info" | "warn" | "action";
}

function tone(sev: Notice["severity"]): string {
  if (sev === "action") return COLOR.GREEN;
  if (sev === "warn") return COLOR.YELLOW;
  return COLOR.DIM;
}

export function NoticeSection({ client }: { client: ApiClient }) {
  const [items, setItems] = useState<Notice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await client.get<{ notices: Notice[] }>("/api/notices");
      setItems(r.notices);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await client.post<{ notices: Notice[] }>("/api/notices/refresh", {});
      setItems(r.notices);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const act = useCallback(
    async (id: string, how: "dismiss" | "silence") => {
      try {
        await client.post(`/api/notices/${encodeURIComponent(id)}/${how}`, {});
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, load]
  );

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: COLOR.DIM, fontSize: FONT.META }}>추천 알림</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          style={{
            background: COLOR.SURFACE_3, color: COLOR.FG, border: `1px solid ${COLOR.BORDER}`,
            borderRadius: RADIUS.S, font: "inherit", fontSize: FONT.META, padding: "0 8px", cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "확인 중…" : "지금 확인"}
        </button>
      </div>
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {items === null && !error && <LoadingState label="알림을 읽는 중…" />}
      {items !== null && items.length === 0 && (
        <div style={{ color: COLOR.DIM, fontSize: FONT.AUX }}>새 알림이 없습니다 — 모델 디렉터리에 새 GGUF 가 들어오면 여기 뜹니다.</div>
      )}
      {items !== null &&
        items.map((n) => (
          <div
            key={n.id}
            style={{
              border: `1px solid ${COLOR.BORDER}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1,
              padding: "6px 8px", fontSize: FONT.AUX, color: COLOR.FG,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: tone(n.severity) }} aria-hidden="true">
                {n.severity === "info" ? "ℹ️" : "⚠️"}
              </span>
              <span style={{ fontWeight: 700 }}>{n.title}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: COLOR.DIM, fontSize: FONT.META }}>적합도 {n.fit}</span>
            </div>
            <div style={{ color: COLOR.DIM, marginTop: 2 }}>{n.body}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => void act(n.id, "dismiss")}
                title="이번에만 숨깁니다. 서버를 재시작하면 다시 보입니다."
                style={{
                  background: "transparent", color: COLOR.BLUE, border: 0, cursor: "pointer",
                  font: "inherit", fontSize: FONT.AUX, padding: 0, textDecoration: "underline",
                }}
              >
                읽음
              </button>
              <button
                type="button"
                onClick={() => void act(n.id, "silence")}
                title="같은 항목을 다시 알리지 않습니다."
                style={{
                  background: "transparent", color: COLOR.BLUE, border: 0, cursor: "pointer",
                  font: "inherit", fontSize: FONT.AUX, padding: 0, textDecoration: "underline",
                }}
              >
                다시 보지 않기
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
