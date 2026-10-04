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

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ApiClient, ApiError } from "../api.js";
import { subscribeWs } from "../wsBus.js";

const DIM = "#6e7681";
const FG = "#c9d1d9";
const BORDER = "#30363d";

/** 경로 조립 — 서버와 같은 규칙을 쓴다. 화면에서 `a + "/" + b` 를 흩어 쓰면
 *  이중 슬래시가 되고, 그 경로가 그대로 서버로 간다. */

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

  const [session, setSession] = useState<TerminalSession | null>(null);
  /**
   * 셸이 **아직 뜰 때부터** 아는 작업 디렉터리 (사용자 요구: "바로 쉘 현재 디렉토리를
   * 보여주고").
   *
   * 왜 별도로 들고 있나: `GET /api/terminal` 은 세션이 이미 있으면 **cwd 도 같이**
   * 준다. 세션이 없으면(첫 실행) 그 값이 화면에 나올 방법이 없다 — "연결 중" 만
   * 보여주면 사용자는 어디에서 작업이 시작되는지 모른다. 모르는 것을 빈 화면으로
   * 두지 않는다(§11.3).
   */
  const [cwd, setCwd] = useState<string | null>(null);

  // ── 셸 위쪽 탐색 (2026-10-01) ──────────────────────────────────────────────
  // 요구: "쉘 상단에 탐색기능을 통해 디렉토리 변경 을 제공하고 그 변경된 디렉토리가
  // 작업경로가 되고 쉘 창에는 변경된 디렉토리 리스가 최대로 나오게"
  //
  // **탐색기는 지워졌다.** 같은 일을 두 곳(왼쪽 트리 + 상단 목록)이 하는데, 왼쪽은
  // 화면 4분의 1을 영구히 차지하고 "프로젝트 전체" 와 "지금 여기" 를 구분하지 못한다.
  // 셸 위는 **지금 작업하는 곳** 만 다루고, 전체 구조를 보고 싶을 때 쓰는 곳은 없다.


  // ── 앱이 열리면 세션을 하나 생성한다 (+ 초기 cwd·최근 경로 불러오기) ──────────
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await client.get<{ tabs: TerminalSession[]; cwd: string; recent: string[] }>("/api/terminal");
        if (!alive) return;
        // 경로는 **세션이 있으든 없든** 먼저 보인다.
        setCwd(r.cwd || null);
        // 서버가 이미 세션을 하나만 두면 그것을 그대로 쓴다. 없으면 새로 연다.
        if (!r.tabs || r.tabs.length === 0) {
          // 기본 bash + `ls` (사용자 요구). bash 가 없으면 서버가 폴백하고
          // 실제 뜬 셸을 session.shell 로 알린다 — 헤더에 그대로 보인다.
          const s = await client.post<TerminalSession>("/api/terminal", { shell: "/bin/bash", init: "ls" });
          if (!alive) return;
          setSession(s);
        } else {
          if (!alive) return;
          setSession(r.tabs[0]);
        }
      } catch (e) {
        if (!alive) return;
        notice("warn", "터미널을 열지 못했습니다", e instanceof ApiError ? e.message : String(e));
      }
    })();

    // 앱의 **공유 WS** 로 상태를 따라간다. 소켓을 따로 열지 않는다 — 열면 패널이
    // 여러 개 생기고, 세션이 종료되는 시점을 놓친다.
    const unsub = subscribeWs((ev) => {
      if (!alive) return;
      const e = ev as unknown as { type?: string; id?: string; session?: TerminalSession };
      // 종료 신호 — 같은 세션이면 상태창에 반영한다(새로 만들지 않음).
      if (e.type === "terminal.exit" && e.session && session && e.session.id === session.id) {
        setSession(e.session);
      } else if (e.type === "terminal.closed" && e.id && e.id === session?.id) {
        // 서버가 이 세션을 완전히 닫았다는 신호 — 끝난 상태로 보인다.
        setSession((prev) => (prev ? { ...prev, state: "exited", exitCode: null } : prev));
      }
    });
    return () => {
      alive = false;
      // **구독을 해제한다.** 남으면 패널이 죽었는데 이벤트를 계속 받아 메모리가 산다.
      unsub();
    };
  }, [client, notice, session]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* nav bar removed 2026-10-04 (user): use left explorer or cd. */}
      {/* 세션이 생성되는 동안 빈 패널을 두지 않는다 — "연결 중" 을 말한다. */}
      {session ? (
        <XtermPane key={session.id} session={session} client={client} notice={notice} />
      ) : (
        // §11.3: 빈 화면은 결함이다. **"셸 열기" 버튼은 두지 않는다** (사용자 요구) —
        // 셸은 기본으로 열리므로 "열어야 한다" 는 사실이 아니고, 빈 화면에 버튼만
        // 두면 "앗 눌러야 되나" 로 읽힌다. 대신 **어디서 열리는지**(cwd)와
        // 기다리는 중이라는 사실만 말한다.
        <div style={{ padding: "8px 10px", color: DIM, fontSize: 11, display: "flex", gap: 8, alignItems: "baseline" }}>
          {cwd && <code style={{ color: FG }}>{cwd}</code>}
          <span>셸을 여는 중…</span>
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

