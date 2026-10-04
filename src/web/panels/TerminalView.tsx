/**
 * 터미널 화면 (M1) — **세션은 하나만** 유지한다.
 *
 * 과거에는 탭 여러 개 + "새 셸" 버튼 + ×닫기가 있었다(2026-10-03 사용자 피드백:
 * "터미널 하나만 있으면 됩니다"). 요구를 그대로 반영해 **한 번 열면 같은 셸**을
 * 끝까지 쓴다. 여는 즉시 세션을 생성하고, 그 세션으로만 입력·리사이즈·출력을 받는다.
 *
 * 이 화면이 특히 조심하는 것:
 *  - **세션이 종료되면 다시 만들지 않는다.** 종료 코드/신호가 붙은 채로 상태창에
 *    표시한다 — "셸이 멈췄다" 와 "터미널이 없다" 를 구분할 수 있어야 한다. 끝난 셸에
 *    다시 입력하면 서버는 409 로 알려주고, 화면은 그걸로 입력을 막는다.
 *  - **입력을 보내지 못한 사실** 을 말하지 않으면 사용자는 타이핑이 먹혔다고 믿는다.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ApiClient, ApiError } from "../api.js";
import { subscribeWs } from "../wsBus.js";

const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";

/** 경로 조립 — 서버와 같은 규칙을 쓴다. 화면에서 `a + "/" + b` 를 흩어 쓰면
 *  이중 슬래시가 되고, 그 경로가 그대로 서버로 간다. */
const joinPath = (base: string, name: string): string => `${base.replace(/\/+$/, "")}/${name}`;

const dirBtn: React.CSSProperties = {
  background: "#161b22",
  border: `1px solid ${BORDER}`,
  color: FG,
  cursor: "pointer",
  font: "inherit",
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 3,
};

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  state: "running" | "exited";
  startedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: number | null;
  openError: string | null;
  cols: number;
  rows: number;
  /** 실제로 뜬 셸 — 요청과 다를 수 있다. */
  shell?: string | null;
}

/** 종료 상태 문장 — 서버의 `exitLabel` 와 **같은 규칙** 을 화면에서도 쓴다. */
function exitLabel(s: TerminalSession): string | null {
  if (s.state !== "exited") return null;
  if (s.openError) return `셸 열기 실패 — ${s.openError}`;
  if (s.exitSignal !== null) return `신호로 종료 (${s.exitSignal})`;
  if (s.exitCode === null) return "종료됨 (코드 없음)";
  return s.exitCode === 0 ? "종료됨 (0)" : `종료됨 (${s.exitCode})`;
}

export function TerminalView({
  client,
  onNotice,
}: {
  client: ApiClient;
  onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void;
}) {
  // ── 콜백이 매 렌더 새로 만들어져 deps 를 오염시킨다 (2026-10-01 실측) ──────────
  //
  // 부모(`main.tsx`)는 인라인 화살표를 넘긴다. 그래서 `onNotice` 의 동일성이 매 렌더마다
  // 바뀌고, `newTab`·`close`·그리고 **`XtermPane` 의 effect** 가 그걸 의존하므로 계속
  // 다시 돈다. `XtermPane` 의 effect 는 그 안에서 **xterm 을 dispose 하고 새로 만든다** —
  // 그래서 입력한 줄이 사라지고 스크롤이 리셋되며 PTY 출력이 뜨다 사라진다.
  //
  // **증거**(실측): 서버 PTY 는 멀쩡했다(셸 생성 200 · `echo` 입력 200 · 탭 `running`).
  // 그런데 브라우저의 `/api/terminal/{id}/resize` 가 **10초에 17회** 갔다 — 새
  // ResizeObserver 가 붙을 때마다 한 번씩. 재마운트가 돌고 있다는 뜻이다.
  //
  // `ModelPanel` 에서 **같은 버그**가 `/api/models` 5초 3303회로 측정됐다. 한 번이면
  // 실수가 두 번 나지 않는다.
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const notice = useCallback(
    (kind: "info" | "warn" | "error", title: string, body: string) => noticeRef.current(kind, title, body),
    [],
  );

  const [tabs, setTabs] = useState<TerminalSession[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // ── 셸 위쪽 탐색 (2026-10-01) ──────────────────────────────────────────────
  // 요구: "쉘 상단에 탐색기능을 통해 디렉토리 변경 을 제공하고 그 변경된 디렉토리가
  // 작업경로가 되고 쉘 창에는 변경된 디렉토리 리스가 최대로 나오게"
  //
  // **탐색기는 지워졌다.** 같은 일을 두 곳(왼쪽 트리 + 상단 목록)이 하는데, 왼쪽은
  // 화면 4분의 1을 영구히 차지하고 "프로젝트 전체" 와 "지금 여기" 를 구분하지 못한다.
  // 셸 위는 **지금 작업하는 곳** 만 다루고, 전체 구조를 보고 싶을 때 쓰는 곳은 없다.
  const [cwd, setCwd] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [dirs, setDirs] = useState<{ path: string; parent: string | null; dirs: string[] } | null>(null);
  const [navigatorOpen, setNavigatorOpen] = useState(false);

  const loadDirs = useCallback(
    async (path?: string) => {
      try {
        const q = path ? `?path=${encodeURIComponent(path)}` : "";
        setDirs(await client.get(`/api/terminal/dirs${q}`));
      } catch (e) {
        // **사유를 말한다.** 목록이 안 뜨면 사용자는 "디렉터리가 없다" 고 읽는다.
        notice("warn", "디렉터리를 읽지 못했습니다", e instanceof ApiError ? e.message : String(e));
      }
    },
    [client, notice],
  );

  const changeCwd = useCallback(
    async (path: string) => {
      try {
        const r = await client.post<{ cwd: string; detail: string }>("/api/terminal/cwd", { path });
        setCwd(r.cwd);
        await loadDirs();
        setNavigatorOpen(false);
      } catch (e) {
        // **거절 사유를 그대로 보인다** — 서버가 이유를 말했는데 화면이 삼킨다.
        notice("warn", "디렉터리를 옮기지 못했습니다", e instanceof ApiError ? e.message : String(e));
      }
    },
    [client, loadDirs, notice],
  );

  const newTab = useCallback(async () => {
    try {
      const s = await client.post<TerminalSession>("/api/terminal", {});
      setTabs((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
      setActive(s.id);
      setLoaded(true);
    } catch (e) {
      // **열지 못했다는 사실을 알린다.** 조용히 실패하면 사용자는 "버튼이 고장났다" 고
      // 판단하고 (한도 초과인지 셸이 없는지) 알 수 없다.
      notice("warn", "터미널을 열지 못했습니다", e instanceof ApiError ? e.message : String(e));
    }
  }, [client, notice]);

  // 앱의 **공유 WS** 로 상태를 따라간다. 소켓을 따로 열지 않는다 — 열면 재연결이
  // 패널 수만큼 생기고, 다른 패널이 탭을 닫을 때 출처를 잃는다.
  useEffect(() => {
    let alive = true;
    const unsub = subscribeWs((ev) => {
      if (!alive) return;
      const e = ev as unknown as { type?: string; id?: string; session?: TerminalSession };
      if (e.type === "terminal.open" && e.session) {
        setTabs((prev) => (prev.some((x) => x.id === e.session!.id) ? prev : [e.session!, ...prev]));
        setLoaded(true);
      } else if (e.type === "terminal.exit" && e.session) {
        setTabs((prev) => prev.map((x) => (x.id === e.session!.id ? e.session! : x)));
      } else if (e.type === "terminal.closed" && e.id) {
        setTabs((prev) => {
          const next = prev.filter((x) => x.id !== e.id);
          setActive((a) => (a === e.id ? (next[0]?.id ?? null) : a));
          return next;
        });
      }
    });
    void (async () => {
      try {
        const r = await client.get<{ tabs: TerminalSession[]; cwd: string; recent: string[] }>("/api/terminal");
        if (!alive) return;
        setTabs(r.tabs);
        setCwd(r.cwd);
        setRecent(r.recent ?? []);
        setLoaded(true);
        setActive((a) => a ?? r.tabs[0]?.id ?? null);
      } catch {
        /* 나중에 온다 */
      }
    })();
    return () => {
      alive = false;
      // **구독을 해제한다.** 남으면 패널이 죽었는데 이벤트를 계속 받아 메모리가 산다.
      unsub();
    };
  }, [client]);

  const close = useCallback(
    (id: string) => {
      void client.post(`/api/terminal/${encodeURIComponent(id)}/close`).catch((e) => {
        notice("warn", "탭을 닫지 못했습니다", e instanceof ApiError ? e.message : String(e));
      });
      setTabs((prev) => {
        const next = prev.filter((x) => x.id !== id);
        setActive((a) => (a === id ? (next[0]?.id ?? null) : a));
        return next;
      });
    },
    [client, notice]
  );

  const session = useMemo(() => tabs.find((t) => t.id === active) ?? null, [tabs, active]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* ── 셸 상단 탐색 막대 (2026-10-01) ──────────────────────────────────────
          요구: "쉘 상단에 탐색기능을 통해 디렉토리 변경 을 제공하고 그 변경된
          디렉토리가 작업경로가 되고 쉘 창에는 변경된 디렉토리 리스가 최대로 나오게"

          "최대로" = **자주 가는 곳이 위에 오는 순서**. 그래서 목록이 아니라
          **최근 순**이며, 같은 곳을 다시 고르면 맨 위로 올라간다. 알파벳 정렬은
          "자주 가는 곳" 을 전혀 반영하지 못한다.

          탐색기가 없어졌으므로 **여기가 유일한 "어디로 가나" 수단**이다. 그래서
          지금 경로와 목록이 **항상** 보인다(펼치기 상태를 한 번에 잃으면 돌아올
          방법이 화면에 없다). */}
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          padding: "3px 6px",
          borderBottom: `1px solid ${BORDER}`,
          flex: "0 0 auto",
          fontSize: 10,
          background: "#161b22",
        }}
      >
        <button
          type="button"
          onClick={() => {
            setNavigatorOpen((v) => !v);
            if (!navigatorOpen) void loadDirs();
          }}
          aria-expanded={navigatorOpen}
          title="디렉터리 탐색"
          style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", fontSize: 10 }}
        >
          {navigatorOpen ? "▾" : "▸"} 탐색
        </button>
        {/* **지금 경로는 항상 보인다.** 이것을 접으면 사용자는 "어디서 실행되고
            있나" 를 알 수 없다 — 셸이 하는 일의 전제가 된다. */}
        <button
          type="button"
          onClick={() => void changeCwd(cwd ?? ".")}
          title="현재 경로 — 클릭하면 이 경로를 목록의 맨 위로 올립니다"
          style={{
            background: "none",
            border: 0,
            color: FG,
            cursor: "pointer",
            font: "inherit",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {/* **뒷부분만** 보여준다. 경로의 앞부분(루트)은 늘 같아서 정보가 없고,
              유효한 부분은 끝(디렉터리 이름)이다. `direction: rtl` 로 뒤집으면
              **슬래시까지 거꾸로** 보여 경로가 이상해진다 — 하지 않는다. */}
          {cwd ?? "확인 중…"}
        </button>
        <span style={{ flex: 1 }} />
        {recent.slice(0, 4).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => void changeCwd(r)}
            title={r}
            style={{
              background: "#21262d",
              border: 0,
              color: DIM,
              cursor: "pointer",
              font: "inherit",
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 3,
              maxWidth: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.split("/").pop() || "/"}
          </button>
        ))}
      </div>

      {navigatorOpen && (
        <div
          style={{
            flex: "0 0 auto",
            maxHeight: 150,
            overflow: "auto",
            padding: "4px 6px",
            borderBottom: `1px solid ${BORDER}`,
            background: "#0d1117",
            display: "grid",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: DIM }}>여기:</span>
            {dirs?.parent && (
              <button type="button" onClick={() => void loadDirs(dirs.parent!)} style={dirBtn}>
                .. (위로)
              </button>
            )}
            {(dirs?.dirs ?? []).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => void changeCwd(joinPath(dirs!.path, d))}
                style={dirBtn}
                title={joinPath(dirs!.path, d)}
              >
                {d}
              </button>
            ))}
            {dirs && dirs.dirs.length === 0 && <span style={{ color: DIM }}>디렉터리가 없습니다</span>}
            {!dirs && <span style={{ color: DIM }}>읽는 중…</span>}
          </div>
          {recent.length > 1 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ color: DIM }}>최근:</span>
              {recent.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => void changeCwd(r)}
                  style={{ ...dirBtn, opacity: 1 - i * 0.08 }}
                  title={r}
                >
                  {i + 1}. {r.split("/").pop() || "/"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "3px 6px", borderBottom: `1px solid ${BORDER}`, flex: "0 0 auto", overflowX: "auto" }}>
        {tabs.map((t) => {
          const label = exitLabel(t);
          const isActive = t.id === active;
          return (
            <span
              key={t.id}
              style={{
                display: "inline-flex",
                gap: 4,
                alignItems: "center",
                padding: "1px 6px",
                borderRadius: 4,
                border: `1px solid ${isActive ? "#1f6feb" : BORDER}`,
                background: isActive ? "#161b22" : "transparent",
                color: t.state === "exited" ? DIM : FG,
                fontSize: 10,
                whiteSpace: "nowrap",
              }}
            >
              <button
                type="button"
                onClick={() => setActive(t.id)}
                title={label ?? `cwd: ${t.cwd}`}
                style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", font: "inherit", padding: 0 }}
              >
                {t.title}
                {label ? ` — ${label}` : ""}
              </button>
              <button
                type="button"
                onClick={() => close(t.id)}
                aria-label={`${t.title} 닫기`}
                style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", padding: 0 }}
              >
                ×
              </button>
            </span>
          );
        })}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => void newTab()} style={btn}>
          + 새 셸
        </button>
      </div>

      {session ? (
        <XtermPane key={session.id} session={session} client={client} notice={notice} />
      ) : (
        // **빈 패널을 두지 않는다**(§11.3) — 여는 방법부터 말한다.
        <div style={{ padding: 16, color: DIM, display: "grid", gap: 8, justifyItems: "start" }}>
          <div style={{ color: FG, fontSize: 13 }}>터미널이 없습니다</div>
          <div style={{ fontSize: 12 }}>
            {loaded ? "셸을 열면 여기에 나타납니다." : "불러오는 중…"}
          </div>
          <button type="button" onClick={() => void newTab()} style={btn}>
            셸 열기
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * xterm 한 개.
 *
 * **PTY 데이터를 버퍼에 쌓아 둔다.** 탭을 다시 선택하면 xterm 이 새로 마운트되고
 * 스크롤이 사라진다. 사용자 입력이 그대로 보이지 않는 터미널은 버그다.
 */
function XtermPane({
  session,
  client,
  notice,
}: {
  session: TerminalSession;
  client: ApiClient;
  /** TerminalView 의 안정적인 래퍼. 값은 항상 최신, 동일성은 고정. */
  notice: (kind: "info" | "warn" | "error", title: string, body: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal({
      cols: session.cols,
      rows: session.rows,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      convertEol: false,
      scrollback: 5000,
      theme: { background: "#0d1117", foreground: FG, cursor: FG },
      // **xterm 은 스크롤바를 자기 DOM 으로 그린다** — 브라우저 기본 스크롤바가
      // 아니다. 그래서 `index.html` 의 `::-webkit-scrollbar` 규칙이 통하지 않는다.
      // 여기서 색을 준다. 안 주면 xterm 기본(밝은 회색)이 어두운 터미널에 그대로
      // 나온다 — 2026-10-01 실측.
      //
      // 두께는 **바꾸지 않는다.** xterm 의 `scrollbarWidth` 는 `fit()` 이 계산한 열 수와
      // 묶여 있다 — 여기서 좁히면 줄이 화면 밖으로 넘어가고 줄바꿈이 어긋난다.
      // 위에서 `t.options.scrollbarWidth` 로 따로 지정한 이유다.
    });
    // **한 번만** 지정한다. `scrollbarWidth` 가 지원되는 xterm 버전은
    // `scrollback` 옵션이 아니라 이 속성을 쓴다 — 둘 다 주면 마지막 것이 이긴다.
    try {
      (t.options as { scrollbarWidth?: number }).scrollbarWidth = 10;
    } catch {
      /* 지원하지 않는 버전이면 기본 두께로 둔다 — 열 계산이 깨지는 쪽이 더 나쁘다 */
    }
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t;
    fit.current = f;

    // **창 크기가 바뀌면 PTY 에도 알려야 한다.** 안 하면 줄이 화면 폭을 넘어가서
    // 가로 스크롤이 생기고, 이후 출력 전부 어긋난다.
    const ro = new ResizeObserver(() => {
      try {
        f.fit();
        if (t.cols > 1 && t.rows > 1) {
          void client.post(`/api/terminal/${encodeURIComponent(session.id)}/resize`, { cols: t.cols, rows: t.rows });
        }
      } catch {
        /* 화면이 아직 0×0 */
      }
    });
    ro.observe(el);
    setTimeout(() => {
      try {
        f.fit();
      } catch {
        /* 무시 */
      }
    }, 30);

    const unsub = subscribeWs((ev) => {
      const e = ev as unknown as { type?: string; id?: string; data?: string };
      if (e.type === "terminal.data" && e.id === session.id && typeof e.data === "string") t.write(e.data);
    });

    // 입력은 WS 가 아니라 **라우트** 로 보낸다(왕복이 짧고 실패를 HTTP 로 알 수 있다).
    const sub = t.onData((d) => {
      void client.post(`/api/terminal/${encodeURIComponent(session.id)}/input`, { data: d }).catch((err) => {
        // **먹혔다고 말하지 않는다.** 죽은 셸에 계속 쓰면 사용자는 "터미널이 얼었다" 고
        // 판단하고, 사실은 "셸이 끝났는데 화면이 살아 있다" 다.
        if (err instanceof ApiError && err.status === 409) {
          setDead(true);
          notice("warn", "셸이 이미 끝났습니다", `${session.title} — ${err.message}`);
        }
      });
    });

    return () => {
      ro.disconnect();
      sub.dispose();
      unsub();
      t.dispose();
      term.current = null;
    };
  }, [session.id, client, notice, session.title]);

  const label = exitLabel(session);
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 8px", fontSize: 10, color: DIM, flex: "0 0 auto" }}>
        <span>{session.cwd}</span>
        <span style={{ flex: 1 }} />
        {label ? <span style={{ color: dead ? "#d29922" : DIM }}>{label}</span> : <span style={{ color: "#3fb950" }}>실행 중</span>}
      </div>
      <div ref={host} style={{ flex: "1 1 auto", minHeight: 0, padding: 2 }} />
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
