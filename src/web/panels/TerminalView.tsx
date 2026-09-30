/**
 * 터미널 화면 (M1).
 *
 * 탭 여러 개 + xterm. **PTY 출력은 WS 로 온다** — 라우트로 폴링하면 지연이 그대로
 * 사용자의 손에 닿고, "셸이 멈췄다" 고 보인다.
 *
 * 이 화면이 특히 조심하는 것:
 *  - **종료한 탭을 지우지 않는다.** exit code 가 붙은 채로 남는다 — "탭이 사라졌다" 와
 *    "셸이 죽었다" 를 구분할 수 있어야 한다.
 *  - **탭이 하나도 없으면 빈 화면을 두지 않는다.** 새 탭을 열라고 말한다.
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
  const [tabs, setTabs] = useState<TerminalSession[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const newTab = useCallback(async () => {
    try {
      const s = await client.post<TerminalSession>("/api/terminal", {});
      setTabs((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
      setActive(s.id);
      setLoaded(true);
    } catch (e) {
      // **열지 못했다는 사실을 알린다.** 조용히 실패하면 사용자는 "버튼이 고장났다" 고
      // 판단하고 (한도 초과인지 셸이 없는지) 알 수 없다.
      onNotice("warn", "터미널을 열지 못했습니다", e instanceof ApiError ? e.message : String(e));
    }
  }, [client, onNotice]);

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
        const r = await client.get<{ tabs: TerminalSession[] }>("/api/terminal");
        if (!alive) return;
        setTabs(r.tabs);
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
        onNotice("warn", "탭을 닫지 못했습니다", e instanceof ApiError ? e.message : String(e));
      });
      setTabs((prev) => {
        const next = prev.filter((x) => x.id !== id);
        setActive((a) => (a === id ? (next[0]?.id ?? null) : a));
        return next;
      });
    },
    [client, onNotice]
  );

  const session = useMemo(() => tabs.find((t) => t.id === active) ?? null, [tabs, active]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
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
        <XtermPane key={session.id} session={session} client={client} onNotice={onNotice} />
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
  onNotice,
}: {
  session: TerminalSession;
  client: ApiClient;
  onNotice: (kind: "info" | "warn" | "error", title: string, body: string) => void;
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
    });
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
          onNotice("warn", "셸이 이미 끝났습니다", `${session.title} — ${err.message}`);
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
  }, [session.id, client, onNotice, session.title]);

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
