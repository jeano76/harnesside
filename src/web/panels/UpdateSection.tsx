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
import { useI18n } from "../i18n/index.js";

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
  /** 이 머신(서버)이 적용할 수 있는 포터블 zip 이름 — `harnesside-portable-<platform>-<arch>.zip`. */
  bundle?: string;
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
  const t = useI18n();

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
        <strong style={{ fontSize: 11 }}>{t("settings.update.title")}</strong>
        <span style={{ fontSize: 10, color: DIM }}>{t("settings.update.current", { v: st?.current ?? "?" })}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              try {
                setSt(await client.post<UpdateState>("/api/update/check"));
              } catch (e) {
                onNotice("error", t("settings.update.checkFailed"), e instanceof ApiError ? e.message : String(e));
              }
            })
          }
          style={btn}
        >
          {t("settings.update.check")}
        </button>
      </div>

      {/* ── R-2.3 / R-7.1: "출처" — 릴리스 식별자와 빌드 신원을 **필드로** ──
          한 줄로 이으면 뒤에 뭐가 붙었는지 읽는 사람이 모른다(§0.1).
          그리고 **모르는 값은 그대로 모른다고** 쓴다 — 빈 칸으로 두면
          "확인 안 했다" 와 "없다" 가 같아진다. */}
      {st?.local && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: 8, display: "grid", gap: 3 }}>
          <div style={{ fontSize: 10, color: DIM }}>{t("settings.update.source")}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>{t("settings.update.installed")}</span>
            <span style={{ fontSize: 11, color: FG }}>{st.local.version}</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>{t("settings.update.build")}</span>
            <span style={{ fontSize: 10, color: FG, fontFamily: "monospace" }} data-testid="update-build-date">
              {st.local.date ?? t("settings.update.dateUnknown")}
            </span>
            <span style={{ fontSize: 10, color: FG, fontFamily: "monospace" }} data-testid="update-build-sha">
              {st.local.commit ?? t("settings.update.hashUnknown")}
            </span>
            {/* dirty prints **nothing** when `false` — clean is the default and only
                anomalies speak. `null` (unknown) says so too. */}
            {(st.local.dirty === true || st.local.dirty === null) && (
              <span style={{ fontSize: 10, color: st.local.dirty === true ? "#d29922" : DIM }} data-testid="update-build-dirty">
                {st.local.dirty === true ? t("settings.update.dirty") : t("settings.update.treeUnknown")}
              </span>
            )}
            {!st.local.stamped && (
              <span style={{ fontSize: 10, color: "#d29922" }} data-testid="update-build-unstamped">
                {t("settings.update.devRun")}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>{t("settings.update.installHash")}</span>
            <span style={{ fontSize: 10, color: st.local.sha ? FG : "#d29922", fontFamily: "monospace" }} data-testid="update-tree-sha">
              {st.local.sha ? `${st.local.sha.slice(0, 12)}…` : t("settings.update.unverified")}
            </span>
            {/* **A failed verify reports no hash.** Showing one file's hash instead
                reads as "install verified" — and misses the half-updated state. */}
            {st.local.sha === null && (
              <span style={{ fontSize: 10, color: "#d29922" }}>{t("settings.update.treeMismatch")}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM, minWidth: 58 }}>{t("settings.update.installPath")}</span>
            <span style={{ fontSize: 10, color: DIM, fontFamily: "monospace" }}>{st.local.installPath}</span>
          </div>
        </div>
      )}

      {/* Raiser R-1 — dependency gate. A missing one is never "no problem". */}
      {st?.deps && st.deps.ready !== true && (
        <div style={{ fontSize: 10, color: st.deps.ready === false ? "#f85149" : "#d29922" }} data-testid="update-deps">
          {t("settings.update.deps", { detail: st.deps.detail })}
          {st.deps.ready === false && t("settings.update.depsMissing")}
        </div>
      )}

      {st?.lastError && <div style={{ color: "#f85149", fontSize: 10 }}>⚠ {st.lastError}</div>}
      {st?.state === "available" && st.remote && <div style={{ fontSize: 11, color: "#3fb950" }}>{t("settings.update.newVersion", { version: st.remote.version })}</div>}
      {st?.state === "up-to-date" && <div style={{ fontSize: 11, color: DIM }}>{t("settings.update.upToDate")}</div>}

      {st?.state === "available" && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {/* Distros are per-platform portable zips. Only this machine's zip shows
                as a button (manifests · SHA256SUMS · foreign-platform zips only fail). */}
            {!st.assets.some((a) => a.name === st.bundle) && (
              <span style={{ color: "#d29922", fontSize: 10 }}>{t("settings.update.noBundle", { bundle: st.bundle ?? t("settings.update.bundleUnknown") })}</span>
            )}
            {st.assets.map((a, i) => a.name !== st.bundle ? null : (
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
                        onNotice("info", t("settings.update.verified"), `${a.name} — ${r.detail}`);
                        // **매니페스트를 그대로** 들고 간다. 경로가 아니라 내용이라 임의
                        // 파일을 지정할 수 없고, 서버가 `/apply` 에서 **다시 검증**한다.
                        // 가공(발췌·재조립)하면 그 재검증에서 떨어진다 — 그래서 그대로.
                        if (r.tree)
                          setStaged((prev) =>
                            prev.some((s) => s.tree === r.tree) ? prev : [...prev, { name: a.name, tree: r.tree, detail: r.detail, manifest: r.manifest }]
                          );
                      } else onNotice("error", t("settings.update.verifyFailed"), r.detail);
                    } catch (e) {
                      // **A failed verify stays unswapped.** And not silently.
                      onNotice("error", t("settings.update.verifyFailed"), e instanceof ApiError ? e.message : String(e));
                    }
                  })
                }
                style={btn}
              >
                {staged.some((s) => s.name === a.name) ? t("settings.update.verifiedAsset", { name: a.name }) : t("settings.update.fetchVerify", { name: a.name })}
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
                    onNotice("error", t("settings.update.planFailed"), e instanceof ApiError ? e.message : String(e));
                  }
                })
              }
              style={btn}
            >
              {t("settings.update.planTitle")}
            </button>
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  try {
                    const r = await client.post<{ ok: boolean; detail: string }>("/api/update/slot");
                    onNotice(r.ok ? "info" : "error", r.ok ? t("settings.update.slotCreated") : t("settings.update.slotFailed"), r.detail);
                    void load();
                  } catch (e) {
                    onNotice("error", t("settings.update.slotFailed"), e instanceof ApiError ? e.message : String(e));
                  }
                })
              }
              style={btn}
            >
              {t("settings.update.slotCreate")}
            </button>
          </div>
          {st.slots.length === 0 && (
            <div style={{ color: "#d29922", fontSize: 10 }}>
              {t("settings.update.noSlot")}
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
            {plan.ok ? t("settings.update.planOk") : t("settings.update.planBlocked")}
          </div>
        </div>
      )}

      {/* P13 적용·되돌리기 — 다운로드는 위에서, 적용은 여기서. 경로는 서버가 준 것만 쓴다. */}
      {staged.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ color: DIM, fontSize: 10 }}>
            {/* "Verified into the slot" — what it actually says is the **list** matched too (R-5). */}
            {t("settings.update.stagedTitle")}
          </div>
          {staged.map((s) => (
            <div key={s.tree} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: FG }}>{s.name}</span>
              <span style={{ fontSize: 10, color: DIM }}>{s.detail}</span>
              <span style={{ flex: 1 }} />
              {confirmApply === s.tree ? (
                <>
                  {/* R-6.2 — never claim what isn't there. This server cannot
                      restart itself. Auto-rollback needs a **parent supervisor**,
                      and there is none now. */}
                  <span style={{ fontSize: 10, color: "#d29922" }}>
                    <strong>dist/</strong> {t("settings.update.applyWarn")}
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
                          onNotice("info", t("settings.update.swappedRestart"), `${r.next} ${t("settings.update.swappedBody", { tree: r.treeSha256?.slice(0, 7) ?? t("settings.update.unmeasured"), slot: r.slot })}`);
                          setConfirmApply(null);
                          void load();
                        } catch (e) {
                          onNotice("error", t("settings.update.applyFailed"), e instanceof ApiError ? e.message : String(e));
                          setConfirmApply(null);
                        }
                      })
                    }
                    style={{ ...btn, borderColor: "#f85149", color: "#f85149" }}
                  >
                    {t("settings.update.applyConfirm")}
                  </button>
                  <button type="button" onClick={() => setConfirmApply(null)} style={btn}>
                    {t("action.cancel")}
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmApply(s.tree)} style={btn}>
                  {t("settings.update.apply")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {((verify?.slots.length ?? 0) > 0 || verify?.marker) && (
        <div style={{ display: "grid", gap: 4 }}>
          {/* ── R-6.1/R-7.2: the marker shows **what was swapped** ──
              Leaving the pre-apply version in place shows "applied but the old
              version is still up". */}
          {verify?.marker && (
            <div style={{ fontSize: 10, color: "#d29922" }} data-testid="update-marker">
              {t("settings.update.markerPending", {
                version: verify.marker.target?.version ?? t("settings.update.versionUnknown"),
                build: `${verify.marker.target?.date ?? t("settings.update.dateUnknown")}-${verify.marker.target?.sha ?? t("settings.update.hashUnknown")}`,
                tree: verify.marker.treeSha256?.slice(0, 7) ?? t("settings.update.unmeasured"),
              })}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: DIM }}>{verify?.marker ? t("settings.update.slotSome") : t("settings.update.slotCount", { count: verify?.slots.length ?? 0 })}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  try {
                    const r = await client.post<{ ok: boolean; detail: string }>("/api/update/rollback", { confirm: true });
                    onNotice("info", t("settings.update.rolledBack"), r.detail);
                    void load();
                  } catch (e) {
                    onNotice("error", t("settings.update.rollbackFailed"), e instanceof ApiError ? e.message : String(e));
                  }
                })
              }
              style={btn}
            >
              {t("settings.update.rollback")}
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
