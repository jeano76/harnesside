/**
 * 워크스페이스 전환 UI (§8.3 · 요구 13).
 *
 * 이 패널의 존재 이유는 **헤더 한 줄** 이다: 지금 어디에 쓰고 있는지가 언제나 보여야 한다.
 * 도구가 쓰는 곳을 사용자가 모르는 상태는 "이어폰을 낀 채로 걷는 것" 이고, 문제는
 * **실행 후에야** 알 수 있다.
 *
 * 전환은 **확인 다이얼로그를 거쳐야** 한다. 미리보기(plan)는 부수효과가 없어야 하며,
 * 경고가 하나도 없더라도 "무엇이 바뀌는지"를 한 번은 보여준다 — 조용한 변경은
 * 나중에 원인이 되지 못한다.
 */

import React, { useCallback, useEffect, useState } from "react";
import { ApiClient, ApiError } from "../api.js";
import type { WorkspaceFingerprint } from "../../server/workspace.js";

const BG = "#0d1117";
const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";

export interface SwitchPreview {
  to: WorkspaceFingerprint;
  warnings: string[];
  orphanedTabs: string[];
  tabs: { path: string; ok: boolean }[];
  carriesPriorContext: boolean;
  note: string;
}

const KIND_LABEL: Record<string, string> = {
  node: "Node",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  dotnet: ".NET",
  unknown: "알 수 없음",
};

export function WorkspaceBar({
  client,
  current,
  openTabs,
  onSwitched,
  onError,
}: {
  client: ApiClient;
  current: WorkspaceFingerprint | null;
  openTabs: string[];
  onSwitched: (e: { to: WorkspaceFingerprint; tabs: { path: string; ok: boolean }[] }) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const openEditor = useCallback(() => {
    setEditing(true);
    setPreview(null);
    setPath("");
  }, []);

  const plan = useCallback(async () => {
    if (!path.trim()) return;
    setBusy(true);
    try {
      const p = await client.post<SwitchPreview>("/api/workspace/plan", { path, openTabs });
      setPreview(p);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, [client, path, openTabs, onError]);

  const apply = useCallback(async () => {
    setBusy(true);
    try {
      const r = await client.post<{ current: WorkspaceFingerprint; change: { to: WorkspaceFingerprint; tabs: { path: string; ok: boolean }[] } }>(
        "/api/workspace/switch",
        { path, openTabs, confirm: true }
      );
      onSwitched({ to: r.current, tabs: r.change.tabs });
      setEditing(false);
      setPreview(null);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [client, path, openTabs, onError, onSwitched]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {/* 지금 어디에 쓰고 있는지. **항상** 보인다. */}
      <span style={{ color: DIM, fontSize: 11 }} title={current?.root ?? ""}>
        {current ? `${current.name}` : "워크스페이스 확인 중"}
        {current && current.kind.length ? ` · ${current.kind.map((k) => KIND_LABEL[k] ?? k).join("/")}` : ""}
        {current?.git ? " · git" : ""}
      </span>
      <button
        type="button"
        onClick={openEditor}
        style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "1px 6px", cursor: "pointer", font: "inherit", fontSize: 11 }}
      >
        폴더 바꾸기
      </button>

      {editing && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(1,4,9,0.6)",
            display: "grid",
            placeItems: "center",
            zIndex: 60,
          }}
          onClick={() => setEditing(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 560, background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12, display: "grid", gap: 10 }}
          >
            <div>
              <strong>워크스페이스 전환</strong>
              <div style={{ color: DIM, fontSize: 11 }}>
                파일 트리 · 도구가 쓰는 기준 폴더 · 규칙 파일이 **한꺼번에** 바뀝니다. 대화는 유지됩니다.
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                autoFocus
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !preview) void plan();
                }}
                placeholder="/home/jeano/내-프로젝트"
                style={{ flex: 1, background: BG, color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "4px 8px", font: "inherit", outline: "none" }}
              />
              <button
                type="button"
                onClick={() => void plan()}
                disabled={busy || !path.trim()}
                style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "2px 10px", cursor: busy ? "default" : "pointer", font: "inherit" }}
              >
                무엇이 바뀌나
              </button>
            </div>

            {preview && (
              <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 11 }}>
                  <span style={{ color: DIM }}>새 폴더</span> {preview.to.root}
                  <span style={{ color: DIM }}>
                    {" "}
                    · {preview.to.kind.map((k) => KIND_LABEL[k] ?? k).join("/")} · 규칙 {preview.to.rules.length}개
                  </span>
                </div>
                {preview.warnings.length === 0 && <div style={{ color: DIM, fontSize: 11 }}>경고 없음</div>}
                {preview.warnings.map((w, i) => (
                  <div key={i} style={{ color: "#d29922", fontSize: 11 }}>
                    · {w}
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit" }}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={() => void apply()}
                    disabled={busy}
                    style={{ background: "#238636", color: "#fff", border: 0, borderRadius: 5, padding: "3px 12px", cursor: busy ? "default" : "pointer", font: "inherit" }}
                  >
                    전환하기
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
