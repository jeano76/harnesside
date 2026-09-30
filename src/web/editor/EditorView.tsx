/**
 * 편집 가능한 파일 보기 (M6 · §5.1 · §3.4).
 *
 * 앞단(`FileView`)은 **읽기 전용** 미리보기였다. 이 컴포넌트가 실제 편집기이고,
 * 다음 셋을 함께 다룬다:
 *  1. **자동 저장** — 디바운스 후 PUT. `planSave` 가 언제 저장할지 판단한다.
 *  2. **충돌 해결** — 409 의 서버본문과 **나란히** 보여주고 세 선택지를 준다.
 *  3. **이전 세션 복구** — 창이 닫히기 전에 남긴 초안을 열 때 "복구할까요" 를 묻는다.
 *
 * "저장 실패" 를 알리지 않는 유일한 허용 상황은 **사용자가 그 실패를 알고 있고**
 * 내용을 잃지 않은 상황이다(임시 파일이나 초안으로 남아 있다).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError } from "../api.js";
import { planOpen, formatBytes } from "./model.js";
import {
  planSave,
  saveLocalDraft,
  loadLocalDraft,
  clearLocalDraft,
  conflictOptions,
  applyChoice,
  AUTOSAVE_DEBOUNCE_MS,
  type Buffer,
  type ConflictChoice,
} from "./autosave.js";

const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";

export interface FileInfo {
  path: string;
  content: string;
  version: number;
  size: number;
}

type SaveState =
  | { kind: "clean" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; version: number }
  | { kind: "failed"; detail: string }
  | { kind: "conflict"; server: { content: string; version: number } };

export function EditorView({
  client,
  info,
  onNotice,
}: {
  client: ApiClient;
  info: FileInfo;
  onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void;
}) {
  const plan = useMemo(() => planOpen({ path: info.path, name: info.path.split("/").pop() ?? "", size: info.size }, info.content), [info]);

  // **버퍼는 ref 다.** 재렌더마다 새로 만들면 타이핑할 때마다 dirtySince 이 초기화돼
  // 디바운스가 영영 끝나지 않는다 — 그래서 "자동 저장이 안 된다" 는 버그가 된다.
  const buf = useRef<Buffer>({ path: info.path, content: info.content, baseVersion: info.version, dirtySince: null });
  const [text, setText] = useState(info.content);
  const [state, setState] = useState<SaveState>({ kind: "clean" });
  const [restore, setRestore] = useState<{ content: string; baseVersion: number } | null>(null);

  // 다른 파일로 바뀌면 버퍼를 갈아끼운다. **이전 버퍼의 미저장 내용은 먼저 경고한다.**
  useEffect(() => {
    buf.current = { path: info.path, content: info.content, baseVersion: info.version, dirtySince: null };
    setText(info.content);
    setState({ kind: "clean" });
    const d = loadLocalDraft(typeof localStorage === "undefined" ? null : localStorage);
    // **이전 세션의 초안은 버리지 않고 묻는다.** 조용히 열면 사용자는 자기 편집을 잃고,
    // 조용히 버리면 "저장 안 한 것" 이 되어 이유를 알 수 없다.
    if (d && d.path === info.path && d.content !== info.content) setRestore({ content: d.content, baseVersion: d.baseVersion });
    else if (d && d.path === info.path) clearLocalDraft(typeof localStorage === "undefined" ? null : localStorage);
  }, [info.path, info.version, info.content]);

  /** 실제 저장 — 판정은 `planSave` 가, I/O 는 여기가. */
  const save = useCallback(
    async (override?: { content: string; baseVersion: number }) => {
      const b = override ? { ...buf.current, ...override, dirtySince: 1 } : buf.current;
      const d = planSave(b, Date.now());
      if (d.action !== "save") return;
      setState({ kind: "saving" });
      try {
        const r = await client.put<{ version: number }>("/api/fs/file", d.body);
        buf.current = { ...buf.current, content: d.body.content, baseVersion: r.version, dirtySince: null };
        setState({ kind: "saved", version: r.version });
        clearLocalDraft(typeof localStorage === "undefined" ? null : localStorage);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const server = e.conflict ?? { content: "", version: 0 };
          if (!server.content) {
            // **충돌인데 서버본문이 없다** — 방향을 잃지 않도록 "모름" 이라고 말한다.
            setState({ kind: "failed", detail: "충돌이 났지만 서버본문을 받지 못했습니다. 파일을 직접 확인하십시오." });
            return;
          }
          setState({ kind: "conflict", server });
          return;
        }
        // 실패해도 **내 편집은 버퍼에 남는다.** 버리면 "저장 실패" + 편집 손실 = 이중 손실.
        setState({ kind: "failed", detail: e instanceof ApiError ? e.message : String(e) });
        onNotice("error", "자동 저장 실패", `${info.path} — ${e instanceof ApiError ? e.message : String(e)}. 편집 내용은 화면에 남아 있습니다.`);
      }
    },
    [client, onNotice, info.path]
  );

  // 디바운스 타이머. 입력 멈춘 뒤에만 저장한다.
  useEffect(() => {
    if (buf.current.dirtySince === null) return;
    const id = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text, save]);

  // 창을 닫을 때 **미저장 내용을 남긴다**(창이 닫히는 게 아니라 창을 새로고침하는 경우 포함).
  useEffect(() => {
    const store = typeof localStorage === "undefined" ? null : localStorage;
    const onHide = () => {
      const b = buf.current;
      if (b.dirtySince === null) return;
      saveLocalDraft({ path: b.path, content: b.content, baseVersion: b.baseVersion, at: Date.now() }, store);
    };
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  const onEdit = useCallback((next: string) => {
    setText(next);
    // **깨끗한 상태에서 고쳐야 dirtySince 이 생긴다.** 저장 성공 직후의 다음 키입력도
    // 새로운 편집이므로 baseVersion 을 그대로 쓴다.
    buf.current = { ...buf.current, content: next, dirtySince: Date.now() };
    setState({ kind: "pending" });
  }, []);

  const resolve = useCallback(
    (choice: ConflictChoice) => {
      if (state.kind !== "conflict") return;
      const merged = applyChoice(choice, buf.current.content, state.server.content);
      buf.current = { ...buf.current, content: merged, baseVersion: state.server.version, dirtySince: 1 };
      setText(merged);
      void save({ content: merged, baseVersion: state.server.version });
    },
    [state, save]
  );

  // 읽기 전용이면 편집기를 띄우지 않는다 — **편집할 수 있는데 안 되는 화면** 이 더 나쁘다.
  if (plan.readOnly) {
    return <ReadOnlyView plan={plan} path={info.path} size={info.size} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 8px", borderBottom: `1px solid ${BORDER}`, flex: "0 0 auto" }}>
        <strong style={{ fontSize: 11 }}>{info.path.split("/").pop()}</strong>
        <span style={{ color: DIM, fontSize: 10 }}>{plan.language}</span>
        <span style={{ flex: 1 }} />
        <SaveBadge state={state} />
        <button type="button" onClick={() => void save()} style={btn} disabled={buf.current.dirtySince === null}>
          지금 저장
        </button>
      </div>

      {restore && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 8px", background: "#3d2b00", fontSize: 11 }}>
          <span>이전 세션에서 저장하지 않은 내용이 있습니다({restore.content.length}자).</span>
          <button
            type="button"
            onClick={() => {
              buf.current = { ...buf.current, content: restore.content, baseVersion: restore.baseVersion, dirtySince: Date.now() };
              setText(restore.content);
              setState({ kind: "pending" });
              setRestore(null);
            }}
            style={btn}
          >
            복구
          </button>
          <button
            type="button"
            onClick={() => {
              // 버리기로 한 초안 — 사용자가 명시했으니 조용히 지워도 된다.
              clearLocalDraft(typeof localStorage === "undefined" ? null : localStorage);
              setRestore(null);
            }}
            style={btn}
          >
            버리기
          </button>
        </div>
      )}

      {state.kind === "conflict" && <ConflictBar server={state.server} mine={buf.current.content} onResolve={resolve} />}

      <textarea
        value={text}
        onChange={(e) => onEdit(e.target.value)}
        spellCheck={false}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          margin: 0,
          padding: "6px 8px",
          border: 0,
          resize: "none",
          background: "transparent",
          color: FG,
          font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
          outline: "none",
        }}
      />
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  // **"저장됨" 을 안 보여주면 사용자는 저장이 되는지 모른다**(§11.3). 상태를 말해 준다.
  const map: Record<SaveState["kind"], { text: string; color: string }> = {
    clean: { text: "저장됨", color: DIM },
    pending: { text: "바뀜 · 곧 저장", color: "#d29922" },
    saving: { text: "저장 중", color: "#58a6ff" },
    saved: { text: `저장됨 (v${state.kind === "saved" ? state.version : "?"})`, color: "#3fb950" },
    failed: { text: "저장 실패", color: "#f85149" },
    conflict: { text: "충돌", color: "#f85149" },
  };
  const v = map[state.kind];
  return (
    <span style={{ color: v.color, fontSize: 10 }} title={state.kind === "failed" ? state.detail : undefined}>
      {v.text}
    </span>
  );
}

function ConflictBar({
  server,
  mine,
  onResolve,
}: {
  server: { content: string; version: number };
  mine: string;
  onResolve: (c: ConflictChoice) => void;
}) {
  const [which, setWhich] = useState<"mine" | "theirs">("theirs");
  return (
    <div style={{ borderBottom: `1px solid ${BORDER}`, padding: "6px 8px", display: "grid", gap: 6, flex: "0 0 auto" }}>
      <div style={{ color: "#f85149", fontSize: 11 }}>
        다른 곳에서 이 파일이 바뀌었습니다(서버 v{server.version}). 자동 덮어쓰지 않습니다.
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button type="button" onClick={() => setWhich("theirs")} style={{ ...btn, ...(which === "theirs" ? activeBtn : {}) }}>
          서버본문 보기
        </button>
        <button type="button" onClick={() => setWhich("mine")} style={{ ...btn, ...(which === "mine" ? activeBtn : {}) }}>
          내 편집 보기
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          maxHeight: 120,
          overflow: "auto",
          padding: "4px 6px",
          background: "#161b22",
          font: "11px/1.4 ui-monospace, Menlo, monospace",
          whiteSpace: "pre-wrap",
          border: `1px solid ${BORDER}`,
        }}
      >
        {which === "theirs" ? server.content : mine}
      </pre>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {conflictOptions(server).map((o) => (
          <button key={o.choice} type="button" onClick={() => onResolve(o.choice)} title={o.detail} style={btn}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReadOnlyView({ plan, path, size }: { plan: { language: string; reason: string | null; content: string }; path: string; size: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 8px", borderBottom: `1px solid ${BORDER}`, flex: "0 0 auto" }}>
        <strong style={{ fontSize: 11 }}>{path.split("/").pop()}</strong>
        <span style={{ color: DIM, fontSize: 10 }}>{plan.language}</span>
        <span style={{ color: "#d29922", fontSize: 10 }}>읽기 전용</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: DIM, fontSize: 10 }}>{formatBytes(size)}</span>
      </div>
      {plan.reason && <div style={{ padding: "4px 8px", color: "#d29922", fontSize: 11 }}>{plan.reason}</div>}
      <pre style={{ margin: 0, padding: "6px 8px", font: "11px/1.5 ui-monospace, Menlo, monospace", whiteSpace: "pre-wrap", overflow: "auto", flex: "1 1 auto", minHeight: 0, color: FG }}>
        {plan.content}
      </pre>
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

const activeBtn: React.CSSProperties = { background: "#1f6feb", color: "#fff" };
