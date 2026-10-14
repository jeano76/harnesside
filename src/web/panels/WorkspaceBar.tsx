/**
 * 워크스페이스 표시 + 폴더 탐색기 (§8.3 · 요구 13).
 *
 * 헤더 한 줄의 존재 이유: 지금 어디에 쓰고 있는지가 언제나 보여야 한다. 도구가 쓰는 곳을 사용자가
 * 모르는 상태는 "이어폰을 낀 채로 걷는 것" 이고, 문제는 **실행 후에야** 알 수 있다.
 *
 * 그 한 줄을 누르면 탐색기가 열린다(2026-10-14). 경로를 외워서 입력하지 않고 폴더를 따라 내려가며
 * 고른다. 예전의 "폴더 바꾸기" 버튼은 셸 위 탐색 막대와 같은 일을 하는 두 번째 입구라 없앴었다
 * (2026-10-01). 그런데 셸 탐색 막대는 루트 **안**에서만 움직여서 **다른 프로젝트로 옮기는 길**이
 * 화면에서 사라져 있었다. 이 탐색기가 그 길이다 — 셸 탐색 막대와 역할이 다르다(이쪽은 루트를 바꾼다).
 *
 * 전환은 **확인을 거쳐야** 한다. 미리보기(plan)는 부수효과가 없어야 하며, 경고가 하나도 없더라도
 * "무엇이 바뀌는지"를 한 번은 보여준다 — 조용한 변경은 나중에 원인이 되지 못한다.
 */

import React, { useCallback, useEffect, useState } from "react";
import { ApiClient, ApiError } from "../api.js";
import type { WorkspaceFingerprint } from "../../server/workspace.js";
import type { DirListing } from "../../server/dirBrowser.js";
import { useI18n } from "../i18n/index.js";

const BG = "#0d1117";
const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";
const ACCENT = "#58a6ff";

export interface SwitchPreview {
  to: WorkspaceFingerprint;
  warnings: string[];
  orphanedTabs: string[];
  tabs: { path: string; ok: boolean }[];
  carriesPriorContext: boolean;
  note: string;
}

const KIND_KEY: Record<string, string> = {
  node: "ws.kind.node",
  python: "ws.kind.python",
  rust: "ws.kind.rust",
  go: "ws.kind.go",
  java: "ws.kind.java",
  dotnet: "ws.kind.dotnet",
  unknown: "ws.kind.unknown",
};

/** 종류 라벨. 알 수 없는 종류("unknown")는 정보가 아니라 빈칸이라 보여주지 않는다. */
export function kindLabels(kinds: string[], t: (k: string) => string): string {
  return kinds.filter((k) => k !== "unknown").map((k) => t(KIND_KEY[k] ?? "ws.kind.unknown")).join("/");
}

/** `/a/b/c` → [{name:"/",path:"/"},{name:"a",path:"/a"},…] — 경로 막대의 각 칸. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    out.push({ name: p, path: acc });
  }
  return out;
}

const btn = (extra: React.CSSProperties = {}): React.CSSProperties => ({
  background: "#21262d",
  color: FG,
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  padding: "2px 10px",
  cursor: "pointer",
  font: "inherit",
  ...extra,
});

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
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useI18n();

  const browse = useCallback(
    async (path: string, hidden: boolean) => {
      setLoading(true);
      setBrowseError(null);
      setPreview(null);
      try {
        const q = `path=${encodeURIComponent(path)}${hidden ? "&hidden=1" : ""}`;
        const l = await client.get<DirListing>(`/api/workspace/dirs?${q}`);
        setListing(l);
        setPathInput(l.path);
      } catch (e) {
        // 목록을 못 읽어도 직전 목록은 그대로 둔다 — 탐색기가 빈 화면이 되면 돌아갈 곳이 없다.
        setBrowseError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [client]
  );

  const openPanel = useCallback(() => {
    setOpen(true);
    void browse(current?.root ?? "", showHidden);
  }, [browse, current?.root, showHidden]);

  const close = useCallback(() => {
    setOpen(false);
    setPreview(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const plan = useCallback(async () => {
    if (!listing) return;
    setBusy(true);
    try {
      setPreview(await client.post<SwitchPreview>("/api/workspace/plan", { path: listing.path, openTabs }));
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, [client, listing, openTabs, onError]);

  const apply = useCallback(async () => {
    if (!listing) return;
    setBusy(true);
    try {
      const r = await client.post<{ current: WorkspaceFingerprint; change: { to: WorkspaceFingerprint; tabs: { path: string; ok: boolean }[] } }>(
        "/api/workspace/switch",
        { path: listing.path, openTabs, confirm: true }
      );
      onSwitched({ to: r.current, tabs: r.change.tabs });
      close();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [client, listing, openTabs, onError, onSwitched, close]);

  const alreadyHere = !!listing && listing.path === current?.root;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}>
      {/* 지금 어디에 쓰고 있는지. **항상** 보이고, 누르면 탐색기가 열린다. */}
      <button
        type="button"
        onClick={() => (open ? close() : openPanel())}
        title={`${current?.root ?? ""}\n${t("ws.explorer.open")}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ background: "none", border: 0, color: DIM, fontSize: 11, cursor: "pointer", font: "inherit", padding: 0 }}
      >
        📁 {current ? `${current.name}` : t("ws.checking")}
        {current && kindLabels(current.kind, t) ? ` · ${kindLabels(current.kind, t)}` : ""}
        {current?.git ? " · git" : ""} ▾
      </button>

      {open && (
        <>
          {/* 바깥을 누르면 닫힌다. */}
          <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
          <div
            role="dialog"
            aria-label={t("ws.explorer.title")}
            style={{
              position: "absolute",
              top: 24,
              left: 0,
              zIndex: 60,
              width: 480,
              maxWidth: "92vw",
              background: "#161b22",
              border: `1px solid ${BORDER}`,
              borderRadius: 6,
              padding: 10,
              display: "grid",
              gap: 8,
              boxShadow: "0 8px 24px rgba(1,4,9,0.6)",
            }}
          >
            <div style={{ color: DIM, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={t("ws.explorer.desc")}>
              {t("ws.explorer.desc")}
            </div>

            {/* 경로 막대: 각 칸을 눌러 그 폴더로 */}
            <div
              ref={(el) => {
                if (el) el.scrollLeft = el.scrollWidth; // 길어도 현재 폴더(끝)가 보이게
              }}
              style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", gap: 2, fontSize: 11, overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "none" }}
            >
              {listing &&
                breadcrumbs(listing.path).map((b, i, arr) => (
                  <React.Fragment key={b.path}>
                    <button
                      type="button"
                      onClick={() => void browse(b.path, showHidden)}
                      style={{ background: "none", border: 0, color: i === arr.length - 1 ? FG : ACCENT, cursor: "pointer", font: "inherit", padding: "0 2px" }}
                    >
                      {b.name}
                    </button>
                    {i > 0 && i < arr.length - 1 && <span style={{ color: DIM }}>/</span>}
                  </React.Fragment>
                ))}
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={() => listing?.parent && void browse(listing.parent, showHidden)} disabled={!listing?.parent} style={btn()}>
                ↑ {t("ws.explorer.up")}
              </button>
              <button type="button" onClick={() => listing && void browse(listing.home, showHidden)} disabled={!listing} style={btn()}>
                {t("ws.explorer.home")}
              </button>
              <input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void browse(pathInput, showHidden);
                }}
                placeholder={t("ws.explorer.pathPlaceholder")}
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, background: BG, color: FG, border: `1px solid ${BORDER}`, borderRadius: 4, padding: "2px 8px", font: "inherit", outline: "none" }}
              />
            </div>

            {browseError && <div style={{ color: "#f85149", fontSize: 11 }}>{browseError}</div>}

            <div
              style={{ border: `1px solid ${BORDER}`, borderRadius: 4, background: BG, maxHeight: 260, overflowY: "auto", opacity: loading ? 0.6 : 1 }}
              aria-busy={loading}
            >
              {loading && !listing && <div style={{ padding: 8, color: DIM, fontSize: 11 }}>{t("ws.explorer.loading")}</div>}
              {listing && listing.entries.length === 0 && <div style={{ padding: 8, color: DIM, fontSize: 11 }}>{t("ws.explorer.empty")}</div>}
              {listing?.entries.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  onClick={() => void browse(e.path, showHidden)}
                  title={e.path}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: 0, color: FG, cursor: "pointer", font: "inherit", padding: "3px 8px" }}
                >
                  📁 {e.name}
                </button>
              ))}
              {listing?.truncated && <div style={{ padding: 8, color: "#d29922", fontSize: 11 }}>{t("ws.explorer.truncated", { n: listing.entries.length })}</div>}
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 6, color: DIM, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => {
                  setShowHidden(e.target.checked);
                  if (listing) void browse(listing.path, e.target.checked);
                }}
              />
              {t("ws.explorer.hidden", { n: listing?.hiddenCount ?? 0 })}
            </label>

            {!preview && (
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
                {alreadyHere && <span style={{ color: DIM, fontSize: 11 }}>{t("ws.explorer.alreadyHere")}</span>}
                <button type="button" onClick={close} style={btn({ background: "none", border: 0, color: DIM })}>
                  {t("ws.explorer.close")}
                </button>
                <button
                  type="button"
                  onClick={() => void plan()}
                  disabled={busy || !listing || alreadyHere}
                  style={btn({ background: "#238636", color: "#fff", border: 0, opacity: busy || !listing || alreadyHere ? 0.5 : 1 })}
                >
                  {t("ws.explorer.here")}
                </button>
              </div>
            )}

            {preview && (
              <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 11 }}>
                  <span style={{ color: DIM }}>{t("ws.explorer.newFolder")}</span> {preview.to.root}
                  <span style={{ color: DIM }}>
                    {" "}
                    {kindLabels(preview.to.kind, t) ? ` · ${kindLabels(preview.to.kind, t)}` : ""} · {t("ws.explorer.rules", { n: preview.to.rules.length })}
                  </span>
                </div>
                {preview.warnings.length === 0 && <div style={{ color: DIM, fontSize: 11 }}>{t("ws.explorer.noWarnings")}</div>}
                {preview.warnings.map((w, i) => (
                  <div key={i} style={{ color: "#d29922", fontSize: 11 }}>
                    · {w}
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
                  <button type="button" onClick={() => setPreview(null)} style={btn({ background: "none", border: 0, color: DIM })}>
                    {t("ws.explorer.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void apply()}
                    disabled={busy}
                    style={btn({ background: "#238636", color: "#fff", border: 0, padding: "3px 12px", cursor: busy ? "default" : "pointer" })}
                  >
                    {t("ws.explorer.confirm")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
