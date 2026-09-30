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

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError } from "../api.js";
import { UpdateSection } from "./UpdateSection.js";

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

export function ModelPanel({ client, onNotice, onPhase }: { client: ApiClient; onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void; onPhase: (p: { state: string; progress: number; message: string }) => void }) {
  const [dir, setDir] = useState<string | null>(null);
  // 진행 단계는 **한 줄로** 보인다(§11.3: 무언가 happening 하고 있어야 한다).
  // `setBlocks` 도 deps 에 넣으면 동일한 무한 루프가 되므로 ref 로 거둔다.
  const phaseRef = useRef(onPhase);
  phaseRef.current = onPhase;
  const [active, setActive] = useState<string | null>(null);
  /**
   * **실제로 서빙 중인 모델 이름.** 채택한 서버가 있으면 경로가 아닐 수 있다.
   * 2026-10-01 실측: 실제 llama-server 가 `Ornith-1.5-35B-Q4_K_M.gguf` 를 서빙하는데
   * 화면은 "사용 중: 없음 (adopt 했다면 그 서버가 사용 중입니다)" 라고 **추측 문장**을
   * 붙였다. 답을 모른다고 말하는 자리였고, 알고 있었다 — 단계 6 이 이미 알고 있다.
   */
  const [served, setServed] = useState<string | null>(null);
  const [servedByAdopted, setServedByAdopted] = useState(false);
  const [local, setLocal] = useState<{ file: string; path: string; bytes: number }[]>([]);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ ok: boolean; detail?: string; local?: string[]; pinned: Scored | null; top: Scored[]; fallbackReason: string | null; pinnedNote: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloads, setDownloads] = useState<{ id: string; file: string; state: string; progress: number; totalBytes: number; receivedBytes: number; error: string | null }[]>([]);
  /** 교체 확인 다이얼로그 내용(서버가 `planSwap` 으로 만든 경고). */
  const [plan, setPlan] = useState<{ path: string; warnings: string[]; steps: string[] } | null>(null);

  const [llama, setLlama] = useState<{ situation: string; remedy: string; running?: { baseUrl: string; model: string } | null } | null>(null);

  // ── 콜백이 **매 렌더마다 새로 만들어져** 의존성 배열이 계속 바뀐다 ─────────────
  //
  // 이 버그는 이미 있었다(실측: `ModelPanel` 을 켠 상태에서 `/api/models` 가 5초에
  // **3303회** 호출됨). 부모가 인라인 화살표를 넘겨 `onNotice`·`client` 의 동일성이
  // 매번 바뀌고, `loadLocal` 이 그걸 의존하므로 `useEffect` 가 **무한히** 다시 돈다.
  // `setState` → 렌더 → 새 콜백 → `useEffect` → 요청… 이 순환은 눈에 안 보이지만
  // 서버를 계속 때린다(§11.3: "멈춘 것처럼 보이지 않는다" 의 반대 — 멈추지 않는다).
  //
  // **`onNotice` 는 오류 경로에서만 쓰인다.** 그래서 ref 에 담아 deps 에서 뺀다:
  // 값은 항상 최신이고 재렌더는 유발하지 않는다. `client` 는 모듈 레벨 단하나라 안정적이다.
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const notice = useCallback(
    (kind: "info" | "warn" | "error", title: string, body: string) => noticeRef.current(kind, title, body),
    [],
  );
  /** `onPhase` 도 같다 — 부모가 매 렌더 새 함수를 넘기면 진행 단계가 루프를 만든다. */
  const onPhaseStable = useCallback(
    (p: { state: string; progress: number; message: string }) => phaseRef.current(p),
    [],
  );

  const loadLocal = useCallback(async () => {
    try {
      const r = await client.get<{
        dir: string;
        active: string | null;
        /** 실행 중인 서버가 실제로 서빙 중인 이름. 경로가 아닐 수 있다. */
        servedModel?: string | null;
        servedByAdopted?: boolean;
        entries: { file: string; path: string; bytes: number }[];
      }>("/api/models");
      setDir(r.dir);
      setActive(r.active);
      setServed(r.servedModel ?? null);
      setServedByAdopted(!!r.servedByAdopted);
      setLocal(r.entries);
    } catch (e) {
      notice("error", "모델 목록을 읽지 못했습니다", e instanceof ApiError ? e.message : String(e));
    }
    // llama.cpp 상태는 **판정만** 받는다. 이 화면이 여는 일이 설치를 시작하면 안 된다 —
    // 사용자는 무엇이 일어나는지 모른다. 설치는 `harnesside doctor --install`.
    try {
      setLlama(await client.get<typeof llama>("/api/llama/status"));
    } catch {
      // **판정에 실패해도 화면은 계속된다.** 상태를 모른다고 모델 관리가 막히면 안 된다.
      setLlama(null);
    }
  }, [client, notice]);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const r = await client.get<typeof result>(`/api/models/search?q=${encodeURIComponent(q)}`);
      setResult(r);
      if (r && r.ok === false) notice("warn", "검색 실패", r.detail ?? "");
    } catch (e) {
      notice("error", "검색 요청이 실패했습니다", e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [client, q, notice]);

  const download = useCallback(
    async (m: Scored) => {
      try {
        const r = await client.post<{ item: { state: string; error: string | null } }>("/api/models/download", {
          repo: m.model.repo,
          file: m.model.file,
        });
        if (r.item.state === "done") {
          notice("info", "다운로드 완료", `${m.model.file} — llama 를 재시작해야 적용됩니다.`);
          void loadLocal();
        } else {
          notice("error", "다운로드 실패", r.item.error ?? "알 수 없는 오류");
        }
      } catch (e) {
        notice("error", "다운로드 요청 실패", e instanceof ApiError ? e.message : String(e));
      }
    },
    [client, notice, loadLocal]
  );

  /**
   * 교체 — **확인 없이 하지 않는다**(§7.1: 되돌릴 곳이 없는 변경).
   * 서버는 응답 확인 전까지 성공으로 세지 않는다(§5.13.1 의 "설치 성공 = 성공" 함정).
   */
  const activate = useCallback(
    async (path: string, file: string, confirm = false) => {
      try {
        const r = await client.post<{ ok: boolean; needsConfirm?: boolean; warnings?: string[]; steps?: string[]; path: string; reason?: string }>(
          "/api/models/activate",
          { path, confirm }
        );
        if (r.needsConfirm) {
          setPlan({ path, warnings: r.warnings ?? [], steps: r.steps ?? [] });
          return;
        }
        setPlan(null);
        if (r.ok) {
          notice("info", "모델 교체 완료", `${file} — 새 모델이 응답하는 것을 확인했습니다.`);
          void loadLocal();
        } else {
          notice("error", "모델 교체 실패", r.reason ?? "알 수 없는 오류");
        }
      } catch (e) {
        notice("error", "교체 요청 실패", e instanceof ApiError ? e.message : String(e));
      }
    },
    [client, notice, loadLocal]
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
        {/* **사용 중인 모델** — 경로가 있으면 경로, 없으면 실행 중인 서버가 말한 이름.
            둘 다 없을 때만 "없음" 이다. 그리고 **어디서 온 건지** 를 밝힌다 —
            다른 곳에서 띄운 서버면 그 파일은 ~/.harnesside/models 에 없을 수 있다. */}
        <div style={{ color: served || active ? FG : DIM }}>
          사용 중:{" "}
          {active ??
            (served ? (
              <>
                {served}
                {servedByAdopted && (
                  <span style={{ color: DIM }}> (외부에서 띄운 서버가 서빙 중 — 이 디렉터리에 없을 수 있습니다)</span>
                )}
              </>
            ) : (
              "없음"
            ))}
        </div>
      </div>

      {/* llama.cpp 상태 — **세 경우를 각각 말한다.** "모델 없음" 과 "llama-server 없음" 과
          "이건 남의 서버" 는 다른 상황이고 다른 remedies 다. 한 문장으로 접으면 사용자는
          뭘 해야 할지 모른다. 설치 여부는 여기서 하지 않는다 — 방법은 말한다. */}
      {llama && (
        <div style={{ fontSize: 11, display: "grid", gap: 2 }}>
          <div style={{ color: DIM }}>
            llama.cpp:{" "}
            {llama.situation === "running"
              ? `실행 중${llama.running ? ` — ${llama.running.baseUrl} (${llama.running.model})` : ""}`
              : llama.situation === "installed"
                ? "설치됨 · 미구동"
                : "설치되어 있지 않음"}
          </div>
          <div style={{ color: DIM }}>{llama.remedy}</div>
        </div>
      )}

      {local.length > 0 && (
        <div style={{ display: "grid", gap: 2 }}>
          {local.map((m) => (
            <div key={m.path} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 11 }}>
              <span style={{ color: m.path === active ? FG : DIM, flex: 1 }}>
                {m.path === active ? "● " : "· "}
                {m.file} · {gib(m.bytes / 1024 ** 3)}
              </span>
              {m.path !== active && (
                <button
                  type="button"
                  onClick={() => void activate(m.path, m.file)}
                  style={{ background: "none", border: 0, color: "#3fb950", cursor: "pointer", font: "inherit", fontSize: 10 }}
                >
                  이 모델로 교체
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {plan && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8, display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11 }}>교체 전 확인 — {plan.path.split("/").pop()}</div>
          {plan.warnings.map((w, i) => (
            <div key={i} style={{ color: "#d29922", fontSize: 10 }}>
              · {w}
            </div>
          ))}
          <div style={{ color: DIM, fontSize: 10 }}>순서: {plan.steps.join(" → ")}</div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setPlan(null)} style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit" }}>
              취소
            </button>
            <button
              type="button"
              onClick={() => void activate(plan.path, plan.path.split("/").pop() ?? "", true)}
              style={{ background: "#238636", color: "#fff", border: 0, borderRadius: 5, padding: "2px 10px", cursor: "pointer", font: "inherit", fontSize: 11 }}
            >
              교체하기
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          aria-label="HuggingFace 모델 검색"
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
      {/* `notice` 는 deps 가 안정적이다 — `onNotice` 를 그대로 넘기면 그쪽에서 같은
          순환이 다시 시작된다. */}
      <UpdateSection client={client} onNotice={notice} onPhase={onPhaseStable} />
    </div>
  );
}
