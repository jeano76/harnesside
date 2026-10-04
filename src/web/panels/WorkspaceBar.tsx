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
      {/* ── "폴더 바꾸기" 버튼을 **없앴다** (2026-10-01) ──────────────────────────
          요구: "상위 폴더 바꾸기 버튼 기능은 쉘 위에 있는 디렉토리 탐색 기능으로 하면될거
          같아". 셸 위 탐색 막대가 같은 일을 하므로 같은 일을 하는 버튼이 두 개면
          하나가 "어느 쪽이 진짜지" 가 된다(§5.8: 라벨이 거짓말을 하는 배치가 나쁘다).

          **그래서 말해야 하는trade-off**: 이 버튼은 **워크스페이스 루트**(서버가
          도구를 실행하는 기준 디렉터리)를 바꿨고, 셸 탐색 막대는 그 루트 **안에서만**
          움직인다(루트 밖은 승인 게이트를 무의미하게 하므로 막았다). 즉 **다른
          프로젝트로 옮기는 기능**이 화면에서 사라진다 — 시작 디렉터리가 곧 루트가 된다.
          되돌리려면 셸 탐색 막대의 "위로" 가 루트에 닿았을 때 **루트를 바꾸는 경로**로
          연결해야 한다(아직 아니다 — 말하지 않고 구현했다고 하면 거짓말이 된다). */}

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
            style={{ width: 560, background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 6, padding: 12, display: "grid", gap: 10 }}
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
                style={{ flex: 1, background: BG, color: FG, border: `1px solid ${BORDER}`, borderRadius: 4, padding: "4px 8px", font: "inherit", outline: "none" }}
              />
              <button
                type="button"
                onClick={() => void plan()}
                disabled={busy || !path.trim()}
                style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 4, padding: "2px 10px", cursor: busy ? "default" : "pointer", font: "inherit" }}
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
                    style={{ background: "#238636", color: "#fff", border: 0, borderRadius: 4, padding: "3px 12px", cursor: busy ? "default" : "pointer", font: "inherit" }}
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
