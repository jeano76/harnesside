/**
 * 설정 · 모델 패널 (§7 · §5.13).
 *
 * P11 의 로직은 완성돼 있었는데 **누를 수 있는 경로** 가 없었다. 이 패널이 그 경로다.
 *
 * 배려한 것 두 가지:
 *  1. **★ 기본 추천** 은 점수와 무관하게 맨 위(§7.2). 점수 계산이 바뀌어도 순서는
 *     흔들리지 않는다 — 사용자가 "왜 저게 1순위지?" 에 대한 답이 흔들리면 안 된다.
 *  2. **폴백 사유** 를 보여준다. 계열을 못 찾았는데 조용히 다른 모델을 1순위로 올리면
 *     §7.2 가 금지한 그 행위가 된다(실천하지 않는다 — **말**한다).
 */

import React, { useCallback, useEffect, useState } from "react";
import { ApiClient, ApiError } from "../api.js";

const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";

interface Scored {
  model: { id: string; repo: string; file: string; bytes: number; downloads: number; license: string | null };
  score: number;
  family: string;
  quant: string | null;
  estimate: { vramGiB: number; ramGiB: number; tokensPerSec: number | null; why: string };
  pinned: boolean;
  notes: string[];
}

function gib(n: number): string {
  if (!n) return "크기 미상";
  return `${n.toFixed(1)}GiB`;
}

export function ModelPanel({ client, onNotice }: { client: ApiClient; onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void }) {
  const [dir, setDir] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [local, setLocal] = useState<{ file: string; path: string; bytes: number }[]>([]);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ ok: boolean; detail?: string; local?: string[]; pinned: Scored | null; top: Scored[]; fallbackReason: string | null; pinnedNote: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloads, setDownloads] = useState<{ id: string; file: string; state: string; progress: number; totalBytes: number; receivedBytes: number; error: string | null }[]>([]);

  const loadLocal = useCallback(async () => {
    try {
      const r = await client.get<{ dir: string; active: string | null; entries: { file: string; path: string; bytes: number }[] }>("/api/models");
      setDir(r.dir);
      setActive(r.active);
      setLocal(r.entries);
    } catch (e) {
      onNotice("error", "모델 목록을 읽지 못했습니다", e instanceof ApiError ? e.message : String(e));
    }
  }, [client, onNotice]);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const r = await client.get<typeof result>(`/api/models/search?q=${encodeURIComponent(q)}`);
      setResult(r);
      if (r && r.ok === false) onNotice("warn", "검색 실패", r.detail ?? "");
    } catch (e) {
      onNotice("error", "검색 요청이 실패했습니다", e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [client, q, onNotice]);

  const download = useCallback(
    async (m: Scored) => {
      try {
        const r = await client.post<{ item: { state: string; error: string | null } }>("/api/models/download", {
          repo: m.model.repo,
          file: m.model.file,
        });
        if (r.item.state === "done") {
          onNotice("info", "다운로드 완료", `${m.model.file} — llama 를 재시작해야 적용됩니다.`);
          void loadLocal();
        } else {
          onNotice("error", "다운로드 실패", r.item.error ?? "알 수 없는 오류");
        }
      } catch (e) {
        onNotice("error", "다운로드 요청 실패", e instanceof ApiError ? e.message : String(e));
      }
    },
    [client, onNotice, loadLocal]
  );

  const row = (s: Scored, isPinned: boolean) => (
    <div
      key={s.model.file}
      style={{
        border: `1px solid ${isPinned ? "#3fb950" : BORDER}`,
        borderRadius: 6,
        padding: 8,
        display: "grid",
        gap: 4,
        background: isPinned ? "#12261a" : "transparent",
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        {isPinned && <span style={{ color: "#3fb950", fontSize: 10 }}>★ 기본 추천</span>}
        <span style={{ fontSize: 12 }}>{s.model.id}</span>
        <span style={{ flex: 1 }} />
        {!isPinned && <span style={{ color: DIM, fontSize: 10 }}>적합 {s.score}</span>}
      </div>
      <div style={{ color: DIM, fontSize: 10 }}>
        {s.model.file.split("/").pop()} · {gib(s.model.bytes)} · {s.quant ?? "양자화 미상"} · VRAM ≈ {gib(s.estimate.vramGiB)} · 다운로드{" "}
        {s.model.downloads.toLocaleString("ko-KR")}
        {s.model.license ? ` · ${s.model.license}` : ""}
      </div>
      <div style={{ color: DIM, fontSize: 10 }}>{s.estimate.why}</div>
      {s.notes.map((n, i) => (
        <div key={i} style={{ color: "#d29922", fontSize: 10 }}>
          · {n}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={() => void download(s)}
          style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "1px 8px", cursor: "pointer", font: "inherit", fontSize: 11 }}
        >
          다운로드
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ padding: 8, display: "grid", gap: 8 }}>
      <div style={{ fontSize: 11 }}>
        <strong>모델</strong>
        <div style={{ color: DIM }}>저장 위치: {dir ?? "확인 중"}</div>
        <div style={{ color: DIM }}>사용 중: {active ?? "없음 (모델 서버가 adopt 했다면 그 서버가 사용 중입니다)"}</div>
      </div>

      {local.length > 0 && (
        <div style={{ display: "grid", gap: 2 }}>
          {local.map((m) => (
            <div key={m.path} style={{ fontSize: 11, color: m.path === active ? FG : DIM }}>
              {m.path === active ? "● " : "· "}
              {m.file} · {gib(m.bytes / 1024 ** 3)}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="HuggingFace 검색 (예: Ornith)"
          style={{ flex: 1, background: "#0d1117", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "3px 6px", font: "inherit", fontSize: 11, outline: "none" }}
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={busy}
          style={{ background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 5, padding: "2px 10px", cursor: busy ? "default" : "pointer", font: "inherit", fontSize: 11 }}
        >
          {busy ? "검색 중" : "검색"}
        </button>
      </div>

      {result && result.ok === false && (
        <div style={{ color: "#f85149", fontSize: 11 }}>
          {result.detail}
          {result.local && result.local.length > 0 && <div style={{ color: DIM }}>로컬 모델 {result.local.length}개를 그대로 쓸 수 있습니다.</div>}
        </div>
      )}

      {result?.fallbackReason && (
        <div style={{ color: "#d29922", fontSize: 11 }}>⚠ {result.fallbackReason}</div>
      )}

      {result?.pinned && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: "#3fb950", fontSize: 10 }}>기본 추천 (§7.2 — 점수와 무관하게 고정)</div>
          {result.pinnedNote && <div style={{ color: DIM, fontSize: 10 }}>{result.pinnedNote}</div>}
          {row(result.pinned, true)}
        </div>
      )}

      {result?.top && result.top.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: DIM, fontSize: 10 }}>그 밖의 후보 (적합도 순 · 상위 5개)</div>
          {result.top.map((s) => row(s, false))}
        </div>
      )}

      {downloads.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: DIM, fontSize: 10 }}>다운로드</div>
          {downloads.map((d) => (
            <div key={d.id} style={{ fontSize: 11, color: d.state === "failed" ? "#f85149" : FG }}>
              {d.state === "failed" ? "✗" : d.state === "done" ? "✓" : "▸"} {d.file.split("/").pop()} · {d.progress}%
              {d.error ? ` — ${d.error}` : ""}
            </div>
          ))}
        </div>
      )}

      <div style={{ color: DIM, fontSize: 10 }}>
        순차 다운로드입니다(중단 후 이어받기 지원). 병렬 조각 다운로드는 넣지 않았습니다 — 대역폭을 더 먹고 정확도는 같습니다.
      </div>
    </div>
  );
}
