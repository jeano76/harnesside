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

/**
 * 적용 마커 (R-6.1) — **교체한 것** 과 **실제로 실행된 것** 을 잇는 기록.
 *
 * 예전 마커에는 `asset`·`slot`·`swappedAt` 만 있었다. 그래서 다음 기동이
 * "어느 버전으로 떴는가" 를 남기지 못했다. 지금은 `target`(교체된 빌드)과
 * `treeSha256`(교체한 트리 해시)를 함께 읽고, **기동 시 재계산한 값과 비교**한다.
 */
export interface UpdateMarker {
  swappedAt?: number;
  tree?: string;
  slot?: string | null;
  treeSha256?: string | null;
  target?: { version?: string; date?: string | null; sha?: string | null; dirty?: boolean | null } | null;
}

export interface UpdateState {
  state: string;
  current: string;
  remote: { version: string; notes: string; url: string } | null;
  assets: { name: string; size: number }[];
  slots: string[];
  lastError: string | null;
  /**
   * 로컬 설치 사실 (R-2.3).
   *
   * **`null` 이 있다는 게 중요하다** — 모르는 것을 0 이나 빈 문자열로 메우지 않는다.
   * 화면은 "모름" 을 **그대로** 보여준다(§R-1 규칙).
   */
  local?: {
    version: string;
    /** **트리 단위** 설치 해시. 검증에 실패하면 null — 파일 하나의 해시를 대신 말하지 않는다. */
    sha: string | null;
    date: string | null;
    commit: string | null;
    dirty: boolean | null;
    builtAt: number | null;
    stamped: boolean;
    installPath: string;
  } | null;
  /** 의존성 게이트 결과 (Raiser R-1). */
  deps?: { ready: boolean | null; missing: string[]; external: string[]; detail: string } | null;
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
  /**
   * **검증된 트리** — 적용 라우트의 입력. 경로는 서버가 준 것만 쓴다(타이핑 금지).
   *
   * 예전엔 `staged` 에 **자산 파일**이 들어갔다. 배포물은 `dist/` **트리**이므로
   * 파일 하나를 인자로 넘길 수 없다 — 넘기면 **나머지가 옛 버전으로 남는다**(R-5).
   */
  const [staged, setStaged] = useState<{ name: string; tree: string; detail: string; manifest: unknown | null }[]>([]);
  /** 적용 2단계 확인 — 첫 클릭은 확인, 둘째 클릭이 실행이다. */
  const [confirmApply, setConfirmApply] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ marker: UpdateMarker | null; slots: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setSt(await client.get<UpdateState>("/api/update"));
    } catch {
      /* 나중에 온다 */
    }
    try {
      setVerify(await client.get<{ marker: UpdateMarker | null; slots: string[] }>("/api/update/verify"));
    } catch {
      /* 나중에 온다 */
    }
    try {
      const d = await client.get<{ ready: boolean | null; missing: string[]; external: string[]; detail: string }>("/api/update/deps");
      setSt((prev) => (prev ? { ...prev, deps: d } : prev));
    } catch {
      /* 모르면 모른다 — 0 으로 메우지 않는다 */
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

      {/* ── R-2.3 / R-7.1: "출처" — 릴리스 식별자와 빌드 신원을 **필드로** ──
          한 줄로 이으면 뒤에 뭐가 붙었는지 읽는 사람이 모른다(§0.1).
          그리고 **모르는 값은 그대로 모른다고** 쓴다 — 빈 칸으로 두면
          "확인 안 했다" 와 "없다" 가 같아진다. */}
      {st?.local && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8, display: "grid", gap: 3 }}>
          <div style={{ fontSize: 10, color: DIM }}>출처</div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>설치됨</span>
            <span style={{ fontSize: 11, color: FG }}>{st.local.version}</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>빌드</span>
            <span style={{ fontSize: 10, color: FG, fontFamily: "monospace" }} data-testid="update-build-date">
              {st.local.date ?? "날짜 모름"}
            </span>
            <span style={{ fontSize: 10, color: FG, fontFamily: "monospace" }} data-testid="update-build-sha">
              {st.local.commit ?? "해시 모름"}
            </span>
            {/* dirty 는 `false` 일 때 **아무것도 안 쓴다** — 깨끗한 게 기본이고
                이상할 때만 말한다. `null`(모름)이면 그것도 말한다. */}
            {(st.local.dirty === true || st.local.dirty === null) && (
              <span style={{ fontSize: 10, color: st.local.dirty === true ? "#d29922" : DIM }} data-testid="update-build-dirty">
                {st.local.dirty === true ? "더티" : "트리 상태 모름"}
              </span>
            )}
            {!st.local.stamped && (
              <span style={{ fontSize: 10, color: "#d29922" }} data-testid="update-build-unstamped">
                개발 실행 (빌드 신원 없음)
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>설치 해시</span>
            <span style={{ fontSize: 10, color: st.local.sha ? FG : "#d29922", fontFamily: "monospace" }} data-testid="update-tree-sha">
              {st.local.sha ? `${st.local.sha.slice(0, 12)}…` : "검증 안 됨"}
            </span>
            {/* **검증 실패인데 해시를 보고하지 않는다.** 파일 하나의 해시를 대신
                보여주면 "설치 확인됨" 으로 읽힌다 — 아orea 상태(절반만 갱신)를 놓친다. */}
            {st.local.sha === null && (
              <span style={{ fontSize: 10, color: "#d29922" }}>전체 트리를 자기 매니페스트로 대조하지 못했습니다</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>설치 경로</span>
            <span style={{ fontSize: 10, color: DIM, fontFamily: "monospace" }}>{st.local.installPath}</span>
          </div>
        </div>
      )}

      {/* Raiser R-1 — 의존성 게이트. 없는 걸 "문제없음" 으로 두지 않는다. */}
      {st?.deps && st.deps.ready !== true && (
        <div style={{ fontSize: 10, color: st.deps.ready === false ? "#f85149" : "#d29922" }} data-testid="update-deps">
          의존성: {st.deps.detail}
          {st.deps.ready === false && " — 새 버전은 실행 파일만 도착하므로 이 상태로는 뜨지 않습니다."}
        </div>
      )}

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
                disabled={staged.some((s) => s.name === a.name)}
                onClick={() =>
                  void act(async () => {
                    try {
                      // ── R-5: 자산만 받지 않는다. **검증을 통과한 트리** 를 받는다 ──
                      // `/api/update/bundle` 이 매니페스트 수신 → 아카이브 수신 → 해시 대조 →
                      // 풀기 → **목록 대조**를 한 뒤에만 트리를 준다. 여기서 받은 경로만
                      // `/api/update/apply` 의 입력이 될 수 있다.
                      const r = await client.post<{ ok: boolean; tree: string; detail: string; manifest: unknown | null; treeSha256: string | null }>("/api/update/bundle", { index: i });
                      if (r.ok) {
                        onNotice("info", "검증 완료", `${a.name} — ${r.detail}`);
                        // **매니페스트를 그대로** 들고 간다. 경로가 아니라 내용이라 임의
                        // 파일을 지정할 수 없고, 서버가 `/apply` 에서 **다시 검증**한다.
                        // 가공(발췌·재조립)하면 그 재검증에서 떨어진다 — 그래서 그대로.
                        if (r.tree)
                          setStaged((prev) =>
                            prev.some((s) => s.tree === r.tree) ? prev : [...prev, { name: a.name, tree: r.tree, detail: r.detail, manifest: r.manifest }]
                          );
                      } else onNotice("error", "검증 실패", r.detail);
                    } catch (e) {
                      // **검증 실패는 교체되지 않은 상태로 남는다.** 이건 조용히 아니다.
                      onNotice("error", "검증 실패", e instanceof ApiError ? e.message : String(e));
                    }
                  })
                }
                style={btn}
              >
                {staged.some((s) => s.name === a.name) ? `검증됨: ${a.name}` : `받기·검증: ${a.name}`}
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

      {/* P13 적용·되돌리기 — 다운로드는 위에서, 적용은 여기서. 경로는 서버가 준 것만 쓴다. */}
      {staged.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: DIM, fontSize: 10 }}>
            {/* "슬롯에 검증됨" — 실제로 말하는 것은 **목록까지** 대조했다는 것이다(R-5). */}
            적용 대기 중 (해시 + 파일 목록 검증 통과)
          </div>
          {staged.map((s) => (
            <div key={s.tree} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: FG }}>{s.name}</span>
              <span style={{ fontSize: 10, color: DIM }}>{s.detail}</span>
              <span style={{ flex: 1 }} />
              {confirmApply === s.tree ? (
                <>
                  {/* R-6.2 — 없는 걸 있다고 말하지 않는다. 이 서버는 자기 자신을
                      재시작할 수 없다. 자동 롤백은 **상위 감시기** 가 해야 하고 지금 없다. */}
                  <span style={{ fontSize: 10, color: "#d29922" }}>
                    <strong>dist/ 전체 트리</strong>를 교체합니다. 되돌릴 곳(슬롯)이 없으면 거절합니다.
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void act(async () => {
                        try {
                          const r = await client.post<{ ok: boolean; slot: string; treeSha256: string | null; next: string }>("/api/update/apply", {
                            tree: s.tree,
                            manifest: s.manifest,
                            confirm: true,
                          });
                          onNotice("info", "교체됨 — 재시작 필요", `${r.next} (트리 ${r.treeSha256?.slice(0, 7) ?? "미측정"} · 슬롯: ${r.slot})`);
                          setConfirmApply(null);
                          void load();
                        } catch (e) {
                          onNotice("error", "적용 실패", e instanceof ApiError ? e.message : String(e));
                          setConfirmApply(null);
                        }
                      })
                    }
                    style={{ ...btn, borderColor: "#f85149", color: "#f85149" }}
                  >
                    정말 적용
                  </button>
                  <button type="button" onClick={() => setConfirmApply(null)} style={btn}>
                    취소
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmApply(s.tree)} style={btn}>
                  적용
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {((verify?.slots.length ?? 0) > 0 || verify?.marker) && (
        <div style={{ display: "grid", gap: 4 }}>
          {/* ── R-6.1/R-7.2: 마커를 **무엇이 교체되었는지** 로 보인다 ──
              적용 전 버전을 그대로 두면 사용자는 "적용했는데 왜 옛 버전이 떠 있지" 를 본다. */}
          {verify?.marker && (
            <div style={{ fontSize: 10, color: "#d29922" }} data-testid="update-marker">
              적용 대기 마커 있음 — {verify.marker.target?.version ?? "버전 모름"} ·{" "}
              {verify.marker.target?.date ?? "날짜 모름"}-{verify.marker.target?.sha ?? "해시 모름"} · 트리{" "}
              {verify.marker.treeSha256?.slice(0, 7) ?? "미측정"} (재시작하면 이 기동이 확인합니다)
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM }}>{verify?.marker ? "롤백 슬롯 있음" : `롤백 슬롯 ${verify?.slots.length ?? 0}개`}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  try {
                    const r = await client.post<{ ok: boolean; detail: string }>("/api/update/rollback", { confirm: true });
                    onNotice("info", "되돌림", r.detail);
                    void load();
                  } catch (e) {
                    onNotice("error", "되돌리기 실패", e instanceof ApiError ? e.message : String(e));
                  }
                })
              }
              style={btn}
            >
              이전 버전으로 되돌리기
            </button>
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
  borderRadius: 4,
  padding: "1px 8px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 10,
};
