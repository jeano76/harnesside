/**
 * 앱 셸 (§5.0 레이아웃 골격 · §5.7 입력창 · §5.4 도킹).
 *
 * 이전에는 부팅 시퀀스만 보여주는 화면이었다. 이제 **실제 IDE** 다:
 * 좌(탐색기) · 중앙(편집기/diff) · 우(에이전트/모니터) · 하(로그, 닫을 수 없음).
 *
 * 두 가지가 이 파일의 존재 이유다:
 *  1. **빈 상태를 채운다**(§11.3). 빈 화면은 결함이다. 각 영역은 "무엇을 할 수 있나"
 *     와 예시 버튼을 보여준다.
 *  2. **멈춘 것처럼 보이지 않는다**(§11.3). WS 상태, 계측, 대기 시간을 항상 보인다.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError, type BootStep, type GpuInfo } from "./api.js";
import { resolveToken } from "./session.js";
import { LogPanel } from "./panels/LogPanel.js";
import { WorkspaceBar } from "./panels/WorkspaceBar.js";
import { AgentPanel, applyEvent, type AgentBlock } from "./panels/AgentPanel.js";
import { openView, toggleView, collapseView, addSlash, finishSlash, toggleSlashFold, restartSlash } from "../session/blocks.js";
import { ModelPanel } from "./panels/ModelPanel.js";
import { initialThink, finish, ingest, adoptServerThink, type ThinkState, type ThinkStyle } from "./agent/think.js";
import { itemTopInContent, scrollTopToShow } from "./agent/slashScroll.js";
import {
  buildHistory,
  historyState,
  recallUp,
  recallDown,
  cancelBrowse,
  shouldRecallUp,
  shouldRecallDown,
  type PromptHistoryState,
} from "./agent/promptHistory.js";
import type { WorkspaceFingerprint } from "../server/workspace.js";
import { MonitorStrip } from "./panels/MonitorPanel.js";
import { EditorView } from "./editor/EditorView.js";
import { dispatchWs } from "./wsBus.js";
import { TerminalView } from "./panels/TerminalView.js";
import { parseSlash, renderHelpText, slashMatches, webSlashCommands } from "../shared/slashCommands.js";
import { CLI_PROVIDERS, CLI_SUBCOMMANDS } from "../shared/cliProviders.js";
import { describeBootFailure } from "../shared/bootFailure.js";
import { CommitBox } from "./panels/CommitBox.js";
import { ResumeBanner } from "./panels/ResumeBanner.js";
import { CrashBanner } from "./panels/CrashBanner.js";
import "@xterm/xterm/css/xterm.css";
import { WsClient } from "./wsClient.js";
import { DEFAULT_LAYOUT, movePanel, keyboardMove, type PanelId, type Zone } from "./layout/engine.js";
import { loadDraft, saveDraft, clearDraft, searchCommands, toastView, type Command, type Toast } from "./panels/notify.js";
import { filterEntries, defaultFilter, visibleTail, bufferFullLabel, filterLabel, type Filter, type LogLevel } from "./panels/logFilter.js";
import { useI18n } from "./i18n/index.js";
import { ApprovalCard } from "./panels/ApprovalCard.js";
import type { ApprovalRequest } from "./panels/ApprovalCard.js";
// 이 import 가 카탈로그를 **등록한다**. 훅만 쓰고 여기 안 쓰면 사전이 비어 있고,
// `t()` 는 키 문자열을 그대로 돌려준다(2026-09-30 까지 실제로 그랬다).
import "./i18n/install.js";
import type { LogEntry } from "../server/logRing.js";
import type { Metrics } from "../shared/metrics.js";

const { token, cleanHref } = resolveToken(
  typeof location !== "undefined" ? location.href : "/",
  typeof sessionStorage !== "undefined" ? sessionStorage : undefined,
);
if (typeof history !== "undefined" && typeof location !== "undefined") {
  history.replaceState(null, "", cleanHref);
}

const client = new ApiClient({ token });

const BG = "#0d1117";
const FG = "#c9d1d9";
const DIM = "#6e7681";
const BORDER = "#30363d";

/** §11.3 빈 상태: "무엇을 할 수 있나" 와 예시 프롬프트. */
const EXAMPLES = [
  "이 저장소의 구조를 한 문단으로 설명해 주세요",
  "최근 변경 파일을 찾아 Likely 버그를 하나만 골라 주세요",
  "테스트를 실행하고 실패한 것만 정리해 주세요",
];

/** 패널 제목. 존과 무관하게 **같은 이름** 이어야 한다 — 제목을 존에서 만들면
 *  패널이 옮겨갈 때 제목까지 바뀐다(사용자가 못 찾는다).
 *
 *  값이 아니라 **키** 다(M9): 문장은 카탈로그가 정본이다. 키가 사전에 없으면 화면에
 *  `panel.editor` 가 그대로 찍힌다 — 그게 "옮기지 않은 문자열" 을 눈에 보이게 하는
 *  방법이고, 조용히 옛 문자열로 되돌리면 배치가 거짓말을 하게 된다(§5.8). */
const TITLE_KEY: Record<string, string> = {
  explorer: "panel.explorer",
  agent: "panel.agent",
  editor: "panel.editor",
  terminal: "panel.terminal",
  diff: "panel.diff",
  monitor: "panel.monitor",
  log: "panel.log",
  settings: "panel.settings",
};

/** 2026-10-04: dead panel shells removed. See layout comment below. */

/**
 * 슬래시 버튼 툴팁 — 마우스를 올리면 **무엇을 하고, 무엇을 바꾸고, 어떻게 쓰는지** 를 말한다.
 * 서버나 설정을 바꾸는 명령은 그 사실과 확인 절차를 반드시 적는다(모르고 누르지 않게).
 */
const SLASH_TIPS: Record<string, string> = {
  quit: "/quit — 정상 종료\n체크포인트와 세션을 저장한 뒤 서버를 끕니다. 채택한 외부 llama-server는 그대로 둡니다.\n실수 방지: 15초 안에 한 번 더 눌러야 종료됩니다.",
  queue: "/queue — 대기열 보기\n에이전트가 일하는 중에 보낸 메시지가 어떤 순서로 처리될지 보여줍니다.\n보기만 하며 아무것도 바꾸지 않습니다. (순서 변경·비우기는 입력창 위 대기 칩에서)",
  compact: "/compact — 컨텍스트 압축\n지금 대화를 요약해 컨텍스트 사용량을 줄입니다. 임계치에 닿으면 자동으로도 실행됩니다.\n대화가 아직 없으면 압축할 것이 없다고 알려줍니다.",
  skills: "/skills — 스킬 목록\n현재 작업 폴더에서 불러온 스킬(.harnesside/skills/*.md)의 이름과 트리거 설명을 보여줍니다.\n보기만 합니다.",
  rules: "/rules — 룰 목록\n시스템 프롬프트에 적용 중인 룰 파일(.harnesside/rules/, .clinerules)의 경로를 보여줍니다.\n보기만 합니다.",
  improve: "/improve — 자기개선 제안\n반복된 실패 패턴을 분석해 룰 제안을 만듭니다.\n제안만 보여주고 디스크에는 아무것도 쓰지 않습니다. 저장은 /improve-apply 로 합니다.",
  "improve-apply": "/improve-apply — 제안 저장\n마지막 /improve 제안을 룰 파일로 저장합니다. 다음 세션부터 시스템 프롬프트에 자동 반영됩니다.\n저장할 제안이 없으면 먼저 /improve 를 실행하라고 알려줍니다.",
  "plan-clear": "/plan-clear — 계획 표시 초기화\n멈춘 계획 진행 표시와 체크포인트를 지웁니다.\n작업 중이던 계획 정보가 사라지므로 계획이 멈춰 있을 때만 사용하세요.",
  term: "/term — 터미널/브라우저 정보\n이 창의 브라우저, 플랫폼, 화면 크기·배율, 클립보드 사용 가능 여부를 보여줍니다.\n콘솔 전용 항목(제어문자·대체화면 등)은 웹 창에 해당이 없습니다.",
  cli: "/cli — AI CLI 를 tmux 탭으로\n/cli : 설치된 CLI 와 살아 있는 세션 목록 (아무것도 만들지 않음)\n/cli claude | gemini | codex | shell : 해당 CLI 탭을 하단에 엽니다. 같은 폴더의 살아 있는 세션이 있으면 새로 만들지 않고 붙습니다.\n/cli <이름> new : 새 세션 · /cli <이름> resume : 지난 대화 이어가기(확인된 CLI만)\n/cli kill <세션명> confirm : hs-… 세션 종료(confirm 없으면 미리보기)\n탭을 닫아도 CLI 는 tmux 안에서 계속 실행됩니다. 이 탭의 작업은 harnesside 승인 게이트 밖에서 실행됩니다.",
  models: "/models — 구동 가능한 로컬 모델\n이 PC의 VRAM·RAM 기준으로 모델별 구동 가능 여부(✅ VRAM / ⚠️ RAM 스트리밍 / ❌)를 표로 보여줍니다.\n선택: 입력창에 /models <번호>. 실행 중인 서버를 바꾸려면 /models <번호> confirm 이 필요합니다(서버가 잠시 내려갑니다).",
  server: "/server — 모델 서버 상태\n지금 떠 있는 llama-server의 포트·모델·빌드와 재시작 시 계획을 보여줍니다.\n재시작: 입력창에 /server restart (변경 내용 미리보기) → /server restart confirm 으로 확정. 확정하면 실행 중인 서버를 내렸다 올립니다.\n캘리브레이션: /server calibrate 는 지금 실제로 남은 VRAM과 모델 헤더(KV 비용·레이어 수)를 읽어 -ngl·컨텍스트·--n-cpu-moe·KV 캐시·스레드를 다시 계산합니다. 산술 추정 대신 실측 기준이라, 계산이 틀린 값(예: -ngl 999 → 32)을 잡아냅니다. 미리보기 → /server calibrate confirm 으로 적용하며, 새 설정으로 뜨지 않으면 예전 설정으로 되돌립니다.",
  reset: "/reset — 설정 초기화\n현재 GPU·VRAM·RAM에 맞게 컨텍스트·스레드·오프로드 등 llama 설정을 다시 계산합니다.\n그냥 실행하면 미리보기만 하며 아무것도 바꾸지 않습니다. 적용은 /reset confirm (설정 파일을 덮어쓰며, 실행 중인 서버에는 /server restart 로 따로 반영).",
};

export default function App() {
  // M9: 문자열은 여기서 키로 바꾼다. 훅이 **함수** 를 돌려주는 이유는 로케일이
  // 바뀌면 다시 그려야 해서다 — 함수를 그대로 받아쓰면 stale 이 된다.
  const t = useI18n();
  const [steps, setSteps] = useState<BootStep[] | null>(null);
  const [bootFailHidden, setBootFailHidden] = useState(false);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logStatus, setLogStatus] = useState<import("./panels/logFilter.js").LogStatus | null>(null);
  const [filter, setFilter] = useState<Filter>(defaultFilter());
  const [wsState, setWsState] = useState<"connecting" | "open" | "closed">("connecting");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricSeries, setMetricSeries] = useState<(number | null)[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** 만료된 토스트를 치우는 시계 — TTL이 있으니 시간이 가야 사라진다. */
  const [toastNow, setToastNow] = useState(() => Date.now());
  const toastLive = useMemo(() => toastView(toasts, toastNow).live, [toasts, toastNow]);
  // 알림 센터용 — 만료된 오류는 남긴다. 팝업은 사라져도 "왜 실패했지" 를 볼 수 있어야
  // 한다(M4: 오류는 수동 닫기 + 센터에 잔류). info/warn 은 팝업과 함께 사라진다.
  const bellItems = useMemo(() => {
    const liveIds = new Set(toastLive.map((t) => t.id));
    return [...toastLive, ...toasts.filter((t) => !liveIds.has(t.id) && t.kind === "error")];
  }, [toasts, toastLive]);
  useEffect(() => {
    const next = toastView(toasts, Date.now()).nextExpiry;
    if (next === null) return;
    const t = setTimeout(() => setToastNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [toasts, toastNow]);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const focusDraft = useCallback(() => draftRef.current?.focus(), []);
  const [draft, setDraft] = useState(() => loadDraft(typeof localStorage !== "undefined" ? localStorage : null)?.text ?? "");

  /**
   * 프롬프트 히스토리 — `↑` `↓` 로 지난 말을 다시 꺼낸다 (2026-10-05).
   *
   * 판단은 전부 `promptHistory.ts` 의 순수 함수가 한다. 여기서는 배선만 한다.
   *
   * 전부 `blocks` 에서 뽑지 않는다. 아직 보내지 않은 **대기열**은 히스토리가 아니다 —
   * 지금 보낸 것이 바로 다음에 나오는 게 맞다.
   */
  const histRef = useRef<PromptHistoryState>(historyState([]));
  /**
   * 히스토리 개수 — **ref 로는 부족하다.** 안내문(`promptHint`)이 이 값을 읽는데,
   * ref 는 렌더를 다시 그리지 않으므로 `useMemo` 가 갱신 시점을 알 수 없다.
   * 그래서 개수만 state 로 둔다(목록 자체는 ref — 타이핑마다 만들지 않기 위해).
   */
  const [histCount, setHistCount] = useState(0);
  /** 과거 목록을 고친다 — 사용자가 프롬프트를 보낼 때마다. */
  const pushHistory = useCallback((sent: string) => {
    const st = histRef.current;
    const next = buildHistory([...st.items, sent]);
    histRef.current = historyState(next);
    setHistCount(next.length);
  }, []);
  /** 꺼내기로 입력창 글자를 바꿨을 때 — 커서를 맨 끝에 둔다. */
  const applyRecall = useCallback((text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = draftRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }, []);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  // 승인 대기 — 서버가 보낸 요청을 **대화 위에 떠 있는 카드**로 표시한다.
  // `id` 마다 하나 (`Map` 이 아니라 배열): 두 요청이 동시에 떠야 사용자도 그렇다.
  const [approvals, setApprovals] = useState<Map<string, ApprovalRequest>>(() => new Map());
  const [modelName, setModelName] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; oldText: string; newText: string } | null>(null);
  // 열려 있는 파일(§5.1). 없으면 빈 패널이 아니라 "무엇을 열 수 있나" 를 보여준다.
  const [openFile, setOpenFile] = useState<{ path: string; content: string; version: number; size: number } | null>(null);
  const refreshTree = useCallback(async () => {
    try {
      await client.get("/api/fs/tree?path=.");
    } catch {
      /* 탐색기는 별도 패널에서 처리한다 */
    }
  }, []);
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [monitorCollapsed, setMonitorCollapsed] = useState(false);
  // §8.3 워크스페이스. **헤더에 항상** 루트를 보여야 한다 — 도구가 어디에 쓰는지
  // 모르는 상태로 일하게 두지 않는다.
  const [workspace, setWorkspace] = useState<WorkspaceFingerprint | null>(null);
  const [tree, setTree] = useState<{ name: string; kind: "dir" | "file"; size: number }[] | null>(null);
  // §5.3 Think + §5.4 블록. 델타는 WS 로 온다(폴링이 아니다).
  // ── 프롬프트 대상: harnesside 에이전트 ↔ 활성 AI CLI 탭 ─────────────────────
  // 활성 터미널 탭이 tmux 위의 AI CLI 면 입력창이 **그 CLI 의 입력창**이 된다(슬래시 추천도
  // 그 CLI 의 것). 대상은 입력창에 항상 보인다 — 엉뚱한 곳으로 보내지 않게.
  interface CliTarget { terminalId: string; provider: string; sessionName: string; title: string; cwd: string; alive: boolean; /** 사람이 연/고른 활성화인가 — 새로고침 복원은 false(복원 직후엔 로컬 대화로 시작한다) */ auto?: boolean; yolo?: boolean }
  const [cliTarget, setCliTarget] = useState<CliTarget | null>(null);
  const [promptTo, setPromptTo] = useState<"agent" | "cli">("agent");
  const [cliCmds, setCliCmds] = useState<{ provider: string; commands: { name: string; description: string; source: string; label: string }[]; notes: string[]; stale: boolean } | null>(null);
  const toCli = promptTo === "cli" && cliTarget !== null;

  /**
   * 입력창의 기본 안내문 — **대상이 누구인지, 무엇을 누르는지**를 한 줄에 담는다.
   *
   * 예전엔 "무엇을 할까요? (Enter 로 전송 · Shift+Enter 줄바꿈)" 뿐이었다. 그런데
   * `/` 로 명령이 열린다는 사실을 **안내문에 쓰지 않았다**(CLI 대상으로 바꿨을 때만
   * 붙어 있었다 — 대상을 바꾸면 오히려 그쪽에서만 보이는 문장이 못했다).
   * 슬래시 명령은 14개나 되는데 발견할 방법이 입력창 밖에 있었다.
   *
   * 히스토리가 있으면 `↑↓` 도 함께 알린다 — 키만으로 되는 기능은 알려지지 않는다.
   */
  const promptHint = useMemo(() => {
    if (toCli && cliTarget) return `${cliTarget.title} 로 보냅니다 (Enter 로 전송 · Shift+Enter 줄바꿈 · / 로 이 CLI 의 명령)`;
    const base = "무엇을 할까요? (Enter 로 전송 · Shift+Enter 줄바꿈 · / 로 명령";
    return histCount > 0 ? `${base} · ↑↓ 지난 프롬프트)` : `${base})`;
  }, [toCli, cliTarget, histCount]);

  // CLI 대상일 때 터미널을 **메시지 출력창 자리**에 크게 보인다. harnesside 대화를 보려면 대상을 로컬로 바꾼다.
  const msgRef = useRef<HTMLDivElement | null>(null);
  const [msgRect, setMsgRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const termOverlay = toCli;
  // 사용자 환경에 **등록(설치)된** 모델/CLI 목록 — 프롬프트 옆 선택기의 항목이다.
  const [cliProviders, setCliProviders] = useState<{ id: string; label: string; installed: boolean | null; installHint: string }[]>([]);
  const [focusReq, setFocusReq] = useState<{ n: number; session: unknown } | null>(null);
  const [blocks, setBlocks] = useState<AgentBlock[]>([]);
  const [think, setThink] = useState<ThinkState>(() => initialThink());
  const [turnRunning, setTurnRunning] = useState(false);
  /** 파일 생성 중 실시간 초안(도구 인자 조각). 블록이 아니라 별도 줄로 보인다 — 끝나면 비운다. */
  const [liveDraft, setLiveDraft] = useState<{ index: number; name: string; args: string } | null>(null);
  /** 실행 중 들어온 입력의 대기열 — 서버 `agent.queue` 이벤트를 그대로 보여준다. */
  const [queueItems, setQueueItems] = useState<string[]>([]);
  /** 압축 진행·결과 — 서버 `agent.compaction` 이벤트. null이면 숨김. */
  const [compaction, setCompaction] = useState<{ phase: "running" | "complete" | "failed"; droppedCount?: number; droppedTokens?: number; keptCount?: number; keptTokens?: number; summary?: string; droppedPreview?: string[] } | null>(null);
  /** §7.4 진행 중인 다운로드 목록(WS 로 온다). */
  const [downloads, setDownloads] = useState<{ id: string; file: string; state: string; progress: number; totalBytes: number; receivedBytes: number; error: string | null }[]>([]);
  /** 복원했음을 사용자에게 **한 번** 말한다 — 조용히 복원되면 "왜 대화가 있지?" 가 된다. */
  const [restored, setRestored] = useState(0);
  const blocksRef = useRef<AgentBlock[]>([]);
  blocksRef.current = blocks;

  /**
   * WS 핸들러가 **지금 열려 있는 파일**을 알아야 한다.
   *
   * 그 effect 의 의존성은 `[pushToast]` 뿐이라(값이 자주 바뀌면 소켓을 다시 붙이므로
   * 일부러 좁혔다), 핸들러 안의 `openFile` 은 **첫 렌더 값**에 묶여 있다 — 처음에는
   * `null` 이다. 그대로 읽으면 `openFile && …` 이 **영영 거짓**이 되어, 파일을
   * 다시 읽는 코드가 도달하지 않는다(실측: 고쳤다고 생각했는데 아무 일도 없었다).
   *
   * 그래서 ref 로 읽는다. `blocksRef` 와 같은 관례다 — WS 밖에서 오는 값은 ref,
   * 렌더에 쓰는 값은 state.
   */
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  /** 열린 탭 목록 — 전환 계획을 서버에 보낼 때 필요하다(탭이 새 루트 밖에 있으면 닫혀야 한다). */
  const openTabs = useMemo(() => (openFile ? [openFile.path] : []), [openFile]);


  const pushToast = useCallback((t: Toast) => {
    setToasts((prev) => [t, ...prev.filter((x) => x.id !== t.id)].slice(0, 5));
  }, []);

  useEffect(() => {
    if (restored <= 0) return;
    pushToast({
      id: "session:restored",
      kind: "info",
      title: "이전 대화를 복원했습니다",
      body: `블록 ${restored}개 — 창을 닫아도 남습니다.`,
      at: Date.now(),
      ttlMs: 10_000,
      requiresAck: false,
      source: "session",
    });
  }, [restored, pushToast]);

  /**
   * 턴을 보낸다.
   *
   * **응답을 기다리지 않는다** — 델타는 WS 로 온다. 여기서 기다리면 "보냈는데 아무 반응이
   * 없다" 는 12초짜리 침묵이 생기고, 그 침묵을 사용자는 멈춘 것으로 읽는다. 요청이
   * 실패하면 **즉시** 말하고, 성공 여부도 서버가 WS 로 알려 준다.
   */
  const sendTurn = useCallback(async () => {
    const text = draft.trim();
    // 실행 중이어도 받는다 — 서버 대기열에 넣는다(거절하지 않는다, O4).
    if (!text) return;
    // 슬래시 명령을 입력창에 직접 써도 된다(`/models 3`, `/copy 20`) — 모델로 보내지 않고
    // 명령으로 실행한다. 등록된 명령이 아니면(`/home/...`) 평범한 문장이라 그대로 보낸다.
    const sl = parseSlash(text);
    // CLI 대상일 때는 `/cli` 만 harnesside 명령이다 — 그 밖의 `/…` 은 CLI 자신의 명령이라 그대로 전달한다.
    if (sl && (!toCli || sl.key === "cli") && webSlashCommands().some((c) => c.key === sl.key)) {
      setDraft("");
      void runSlash(sl.key, sl.arg);
      return;
    }
    if (toCli && cliTarget) {
      if (!cliTarget.alive) {
        pushToast({ id: "cli:dead", kind: "warn", title: `${cliTarget.title} 이(가) 끝났습니다`, body: "/cli 로 다시 여세요.", at: Date.now(), ttlMs: 8_000, requiresAck: false, source: "agent" });
        return;
      }
      // 여러 줄은 bracketed paste 로 한 번에, 한 줄은 그대로 + Enter. 입력 경로는 attach PTY 하나다.
      const data = text.includes("\n") ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`;
      // CLI 로 보낸 것도 사람이 보낸 말이다 — `↑` 로 다시 꺼낼 수 있게 한다.
      pushHistory(text);
      setDraft("");
      try {
        await client.post(`/api/terminal/${encodeURIComponent(cliTarget.terminalId)}/input`, { data });
      } catch (e) {
        setDraft(text);
        pushToast({ id: "cli:send", kind: "error", title: `${cliTarget.title} 로 보내지 못했습니다`, body: e instanceof ApiError ? e.message : String(e), at: Date.now(), ttlMs: 12_000, requiresAck: false, source: "agent" });
      }
      return;
    }
    setTurnRunning(true);
    // 사용자 입력을 대화 기록에 **먼저** 남긴다. WS 가 늦게 와도 순서가 뒤집히지 않는다.
    // **사람이 보낸 말을 블록으로 남긴다** — 이것이 대화 묶음의 경계다(2026-10-01).
    // 예전에는 `전송: …` 라는 **상태 줄** 로만 남겼다. 그래서 묶음의 시작을 알 수
    // 없었고, "어떤 물음에 대한 답인지" 가 화면에 남지 않았다.
    setBlocks((prev) => applyEvent(prev, { type: "agent.user", text, at: Date.now() }));
    // **보낸 말을 히스토리에 넣는다.** 전송 후에 넣어야 한다 — 넣지 않으면 방금 보낸
    // 말을 `↑` 로 한 번 더 꺼내게 되고, `↓` 로 되돌아오면 방금 보낸 말이 나온다.
    pushHistory(text);
    setDraft("");
    try {
      const r = await client.post<{ ok: boolean; detail: string; queued?: boolean }>("/api/agent/turn", { text });
      if (!r.ok) {
        setTurnRunning(false);
        pushToast({ id: "turn:fail", kind: "error", title: "턴을 시작하지 못했습니다", body: r.detail, at: Date.now(), ttlMs: 15_000, requiresAck: false, source: "agent" });
      } else if (r.queued) {
        pushToast({ id: `turn:queued:${Date.now()}`, kind: "info", title: "대기열에 넣었습니다", body: r.detail, at: Date.now(), ttlMs: 8_000, requiresAck: false, source: "agent" });
      }
    } catch (e) {
      setTurnRunning(false);
      pushToast({ id: "turn:fail", kind: "error", title: "턴 요청이 실패했습니다", body: e instanceof ApiError ? e.message : String(e), at: Date.now(), ttlMs: 15_000, requiresAck: false, source: "agent" });
    }
    // `pushHistory` 는 `useCallback([])` 이므로 안정적이라 넣어도 재계산되지 않는다.
  }, [draft, pushToast, pushHistory, toCli, cliTarget]);

  /**
   * 슬래시 버튼 — 구 TUI(2026-10-04 삭제)의 `onSlashCommand` 와 **같은 내용**을 웹에서 실행하고,
   * 결과를 **대화 안 블록**(접고 펼 수 있음)으로 남긴다. 서버에 진입점이 없는
   * 명령(`copy`·`quit`)과 콘솔 전용(`term`·`mouse`)은 버튼으로 만들지 않는다.
   */
  /**
   * 슬래시 버튼 — **바로 실행하지 않고 입력창에 명령을 채운다**(자동완성).
   * 인자를 받는 명령(`/models 3` 등)은 뒤에 공백을 남겨 바로 이어 쓸 수 있게 하고,
   * Enter 로 보내면 실행된다. 이미 쓰던 글이 있으면 명령으로 바꾼다.
   */
  const fillSlash = useCallback((key: string) => {
    const withArg = key === "models" || key === "server" || key === "reset" || key === "cli";
    const text = `/${key}${withArg ? " " : ""}`;
    // 이 버튼들은 **harnesside 의 명령**이다 — CLI 대상 상태로 두면 Enter 가 CLI 로 가 버린다
    // (`/quit` 이 CLI 를 끌 수 있다). `/cli` 만 대상과 무관하다.
    if (key !== "cli") setPromptTo("agent");
    setDraft(text);
    requestAnimationFrame(() => {
      const el = draftRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }, []);

  const refreshProviders = useCallback(() => {
    void client.get<{ providers: { id: string; label: string; installed: boolean | null; installHint: string }[] }>("/api/cli/providers")
      .then((r) => setCliProviders(r.providers))
      .catch(() => { /* 목록을 못 읽어도 local 은 항상 고를 수 있다 */ });
  }, []);
  useEffect(() => { refreshProviders(); }, [refreshProviders]);
  /**
   * 프롬프트 대상 선택 — `local`(harnesside 의 로컬 모델 에이전트) 또는 CLI 프로바이더.
   * CLI 를 고르면 **그 CLI 의 탭을 열거나(없으면 만들고) 활성화**한다 — 대상과 보이는 탭이 항상 같다.
   */
  const [yoloAsk, setYoloAsk] = useState(false);
  const pickTarget = useCallback(async (id: string, opts: { yolo?: boolean; resume?: boolean } = {}) => {
    if (id === "local") { setPromptTo("agent"); return; }
    try {
      const r = await client.post<{ session: unknown }>("/api/cli/sessions", { provider: id, yolo: opts.yolo === true, resume: opts.resume === true });
      setFocusReq({ n: Date.now(), session: r.session });
      setPromptTo("cli");
    } catch (e) {
      pushToast({ id: "cli:pick", kind: "error", title: "CLI 를 열지 못했습니다", body: e instanceof ApiError ? e.message : String(e), at: Date.now(), ttlMs: 12_000, requiresAck: false, source: "agent" });
    }
  }, [pushToast]);
  useEffect(() => {
    const el = msgRef.current;
    if (!el) return;
    const upd = () => { const r = el.getBoundingClientRect(); setMsgRect({ left: r.left, top: r.top, width: r.width, height: r.height }); };
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    window.addEventListener("resize", upd);
    return () => { ro.disconnect(); window.removeEventListener("resize", upd); };
  }, []);
  const onActiveCli = useCallback((t: CliTarget | null) => setCliTarget(t), []);
  // 활성 탭이 바뀌면 대상을 맞춘다(CLI 탭 → CLI, 그 밖 → harnesside). 그 뒤의 수동 전환은 존중한다.
  useEffect(() => {
    // 복원(auto=false)은 대상을 **바꾸지 않는다** — 복원 응답이 사람의 선택보다 늦게 와도 그 선택을 덮지 않는다.
    if (!cliTarget) setPromptTo("agent");
    else if (cliTarget.auto) setPromptTo("cli");
  }, [cliTarget?.terminalId, cliTarget?.auto]);
  // 이 CLI 의 슬래시 명령 — 내장 표 + 작업 폴더/홈에서 스캔한 사용자 정의.
  useEffect(() => {
    if (!cliTarget) { setCliCmds(null); return; }
    let alive = true;
    void client.get<{ provider: string; commands: { name: string; description: string; source: string; label: string }[]; notes: string[]; stale: boolean }>(`/api/cli/commands?provider=${encodeURIComponent(cliTarget.provider)}&cwd=${encodeURIComponent(cliTarget.cwd)}`)
      .then((r) => { if (alive) setCliCmds(r); })
      .catch(() => { if (alive) setCliCmds(null); });
    return () => { alive = false; };
  }, [cliTarget?.provider, cliTarget?.cwd]);

  // ── 슬래시 자동완성 ─────────────────────────────────────────────────────────
  // 입력이 `/` 로 시작하면 후보를 띄운다. 첫 토큰은 명령명, `/cli ` 뒤는 **두 번째 토큰**
  // (프로바이더·`kill`), `/cli <프로바이더> ` 뒤는 세 번째 토큰(`new`·`resume`)을 추천한다.
  // 후보는 웹에서 실행되는 명령만이다. 프로바이더 이름은 `shared/cliProviders` 가 정본이다.
  interface SlashItem { fill: string; exact: string; label: string; description: string; tip?: string; dim?: boolean }
  const [slashIdx, setSlashIdx] = useState(0);
  // 슬래시 메뉴의 스크롤 컨테이너. 선택 표시가 화면 밖으로 나가면 **여기**만 움직인다.
  const slashListRef = useRef<HTMLDivElement | null>(null);
  const [slashHidden, setSlashHidden] = useState(false);
  const [cliInstalled, setCliInstalled] = useState<Record<string, boolean | null>>({});
  const wantsCli = /^\/cli\s/i.test(draft);
  useEffect(() => {
    if (!wantsCli) return;
    let alive = true;
    void client.get<{ providers: { id: string; installed: boolean | null }[] }>("/api/cli/providers")
      .then((r) => { if (alive) setCliInstalled(Object.fromEntries(r.providers.map((p) => [p.id, p.installed]))); })
      .catch(() => { /* 설치 여부를 몰라도 후보는 보인다 */ });
    return () => { alive = false; };
  }, [wantsCli]);
  const slashItems = useMemo<SlashItem[]>(() => {
    if (!draft.startsWith("/") || draft.includes("\n")) return [];
    const third = /^\/cli\s+(claude|gemini|codex|shell)\s+(\S*)$/i.exec(draft);
    if (third) {
      const q = third[2]!.toLowerCase();
      return (["new", "resume"] as const).filter((x) => x.includes(q)).map((x) => ({
        fill: `/cli ${third[1]!.toLowerCase()} ${x}`, exact: `/cli ${third[1]!.toLowerCase()} ${x}`, label: x,
        description: x === "new" ? "같은 폴더에 이미 있어도 새 세션" : "지난 대화 이어가기(확인된 CLI만)",
      }));
    }
    const second = /^\/cli\s+(\S*)$/i.exec(draft);
    if (second) {
      const q = second[1]!.toLowerCase();
      const provs: SlashItem[] = CLI_PROVIDERS.filter((p) => p.id.includes(q)).map((p) => {
        const inst = cliInstalled[p.id];
        return {
          fill: `/cli ${p.id}`, exact: `/cli ${p.id}`, label: p.id,
          description: `${p.label}${inst === false ? " — 설치 안 됨" : inst === true ? "" : ""}`,
          tip: inst === false ? p.installHint : undefined, dim: inst === false,
        };
      });
      const subs: SlashItem[] = CLI_SUBCOMMANDS.filter((x) => x === "kill" && x.includes(q)).map((x) => ({
        fill: `/cli ${x} `, exact: `/cli ${x}`, label: x, description: "hs-… 세션 종료 (/cli kill <세션명> confirm)",
      }));
      return [...provs, ...subs];
    }
    // ── 인자를 받는 harnesside 명령(`/models` `/server` `/reset`) — 버튼이 뒤에 공백을 남기므로 **공백 뒤에도**
    // 추천이 이어져야 한다. 첫 항목은 "인자 없이 실행"이라 Enter 로 바로 목록/상태/미리보기를 볼 수 있다.
    if (!toCli) {
      const arg3 = /^\/(server\s+(?:restart|calibrate)|models\s+\S+)\s+(\S*)$/i.exec(draft);
      if (arg3) {
        const q = arg3[2]!.toLowerCase();
        const base = `/${arg3[1]!.replace(/\s+/g, " ").toLowerCase()}`;
        return "confirm".includes(q)
          ? [{ fill: `${base} confirm`, exact: `${base} confirm`, label: "confirm", description: base.startsWith("/server") ? "실행 중인 서버를 내렸다 올립니다(확정)" : "교체를 확정합니다(실행 중인 서버가 잠시 내려갑니다)" }]
          : [];
      }
      const arg2 = /^\/(models|server|reset)\s+(\S*)$/i.exec(draft);
      if (arg2) {
        const cmd = arg2[1]!.toLowerCase();
        const q = arg2[2]!.toLowerCase();
        const none: SlashItem = { fill: `/${cmd}`, exact: `/${cmd}`, label: `/${cmd}`, description: cmd === "models" ? "인자 없이 실행 — 구동 가능한 모델 목록" : cmd === "server" ? "인자 없이 실행 — 서버 상태 보기" : "인자 없이 실행 — 변경 미리보기(아무것도 바꾸지 않음)", tip: SLASH_TIPS[cmd] };
        const more: SlashItem[] =
          cmd === "server"
            ? [
                { fill: "/server restart", exact: "/server restart", label: "restart", description: "재시작 미리보기 → 이어서 confirm" },
                { fill: "/server calibrate", exact: "/server calibrate", label: "calibrate", description: "실측(남은 VRAM·모델 헤더)으로 최적값 재계산 → 이어서 confirm" },
              ]
          : cmd === "reset" ? [{ fill: "/reset confirm", exact: "/reset confirm", label: "confirm", description: "설정을 다시 계산해 덮어씁니다(확정)" }]
          : ["1", "2"].map((n) => ({ fill: `/models ${n}`, exact: `/models ${n}`, label: n, description: `목록의 ${n}번으로 교체 — 먼저 /models 로 목록을 확인하세요` }));
        // 이미 쓴 글이 어느 후보와 정확히 같으면 그것을 맨 위로 — Enter 가 곧바로 실행된다.
        const typed = draft.trim().toLowerCase();
        return [none, ...more.filter((m) => m.label.startsWith(q) || q === "")].sort((a, b) => Number(b.exact === typed) - Number(a.exact === typed));
      }
    }
    if (/\s/.test(draft.trimStart().slice(1))) return [];
    if (toCli && cliCmds && !/^\/cli$/i.test(draft)) {
      // CLI 대상: 그 CLI 의 명령만 추천한다(+ harnesside 의 `/cli` 하나). 이름이 겹쳐도 CLI 것이 우선이다.
      const q = draft.slice(1).toLowerCase();
      const hits = cliCmds.commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)));
      const items: SlashItem[] = hits.map((c) => ({
        fill: `/${c.name}`, exact: `/${c.name}`, label: `/${c.name}`,
        description: `${c.source === "custom" ? `[${c.label}] ` : ""}${c.description}`,
        tip: `${c.description || c.name}\n출처: ${c.label}`,
      }));
      if ("cli".includes(q) && q.length > 0) items.push({ fill: "/cli ", exact: "/cli", label: "/cli", description: "[harnesside] AI CLI 탭 관리" });
      return items;
    }
    const web = new Set(webSlashCommands().map((c) => c.key));
    const typed = draft.slice(1).toLowerCase();
    return slashMatches(draft).filter((c) => web.has(c.key)).sort((a, b) => Number(b.key.startsWith(typed)) - Number(a.key.startsWith(typed))).map((c) => ({
      fill: `/${c.key}${c.key === "models" || c.key === "server" || c.key === "reset" || c.key === "cli" ? " " : ""}`,
      exact: `/${c.key}`, label: c.label, description: c.description, tip: SLASH_TIPS[c.key],
    }));
  }, [draft, cliInstalled, toCli, cliCmds]);
  const slashOpen = slashItems.length > 0 && !slashHidden;
  useEffect(() => { setSlashIdx(0); setSlashHidden(false); }, [draft]);

  // ── 선택 표시가 목록 밖으로 나가지 않게 한다 ───────────────────────────────
  //
  // 고장: 리스트박스는 `maxHeight:240, overflowY:auto` 라 스크롤이 되는데
  // **아무도 스크롤하지 않았다.** 그래서 ArrowDown 을 계속 누르면 **표시만
  // 화면 아래로 사라지고 목록이 멈춘다**(실측 결함 — 사양: 아래로 갈 때 목록이 따라온다).
  //
  // `scrollIntoView` 를 **안 쓰는 이유**: 조상 전체를 스크롤해서 **대화까지 같이
  // 올라가며** 읽던 자리를 빼앗긴다(§11.3). 컨테이너의 `scrollTop` 만 직접 바꾼다.
  //
  // `draft` 가 바뀌면 `slashIdx` 가 0 으로 리셋되므로 **선택 표시가 위로 순간이동**한다.
  // 그래서 목록이 위로 튀지 않게 **top 은 건드리지 않고 아래쪽 경계만 본다.**
  useEffect(() => {
    const box = slashListRef.current;
    if (!box) return;
    const sel = box.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!sel) return;
    const next = slashIdx === 0
      ? Math.min(box.scrollTop, scrollTopToShow({ scrollTop: 0, clientHeight: box.clientHeight, itemTop: itemTopInContent(box, sel), itemHeight: sel.offsetHeight }))
      : scrollTopToShow({ scrollTop: box.scrollTop, clientHeight: box.clientHeight, itemTop: itemTopInContent(box, sel), itemHeight: sel.offsetHeight });
    if (next !== box.scrollTop) box.scrollTop = Math.max(0, next);
  }, [slashIdx, slashOpen, slashItems.length]);
  /** 후보를 입력창에 **완성**한다 — 실행은 하지 않는다(Enter 로 보낸다). */
  const completeSlash = useCallback((text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = draftRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }, []);

  const quitArmedAt = useRef(0);
  const runSlash = useCallback(async (key: string, arg = "", fromButton = true) => {
    // harnesside 명령의 결과는 대화창에 쌓인다 — 터미널이 그 자리를 덮고 있으면(CLI 대상에서 `/cli …` 를 친 경우)
    // 대상을 로컬로 돌려 결과가 보이게 한다. `/cli <이름>` 처럼 CLI 를 여는 명령은 끝에서 다시 CLI 대상으로 바꾼다.
    setPromptTo("agent");
    // `/quit` 는 두 번 눌러야 종료한다(구 TUI도 확인 없이 끝내지 않는다).
    if (key === "quit") {
      const at = Date.now();
      const armed = at - quitArmedAt.current < 15_000;
      const qid = `slash-${at}-quit`;
      setBlocks((prev) => addSlash(prev, qid, key, at));
      if (!armed) {
        quitArmedAt.current = at;
        setBlocks((prev) => finishSlash(prev, qid, "정상종료합니다 — 체크포인트와 세션을 저장한 뒤 서버가 꺼집니다.\n정말 종료하려면 15초 안에 /quit 를 한 번 더 누르세요.", true));
        return;
      }
      quitArmedAt.current = 0;
      try {
        const r = await client.post<{ ok: boolean; detail: string }>("/api/system/quit", {});
        setBlocks((prev) => finishSlash(prev, qid, r.detail, r.ok));
      } catch (e) {
        setBlocks((prev) => finishSlash(prev, qid, e instanceof ApiError ? e.message : String(e), false));
      }
      return;
    }
    // 같은 버튼을 다시 누르면 **새로 쌓지 않는다** — 열려 있으면 접고, 접혀 있으면
    // 펼치면서 다시 실행한다(설정 버튼과 같은 규칙). 인자가 있는 입력(`/models 3`)은
    // 매번 **새 대화**다 — 다른 요청이기 때문이다.
    // 인자 없는 같은 명령의 결과만 대상이다 — `/cli kill …` 같은 인자 있는 결과를 접어 버리면 안 된다.
    const existing = fromButton && !arg
      ? [...blocksRef.current].reverse().find((b) => b.kind === "view" && b.view?.what === "slash" && b.view.path === key && blocksRef.current.find((u) => u.id === `${b.id}-user`)?.text === `/${key}`)
      : undefined;
    let id: string;
    if (existing) {
      if (existing.view?.viewCollapsed !== true && existing.view?.slashState !== "running") {
        setBlocks((prev) => toggleSlashFold(prev, existing.id));
        return;
      }
      id = existing.id;
      setBlocks((prev) => restartSlash(prev, id));
    } else {
      const at = Date.now();
      id = `slash-${at}-${Math.random().toString(36).slice(2, 6)}`;
      setBlocks((prev) => addSlash(prev, id, key, at));
      // 인자가 있으면 사람이 보낸 말에도 인자가 보이게 한다(`/models 3`).
      if (arg) setBlocks((prev) => prev.map((b) => (b.id === `${id}-user` ? { ...b, text: `/${key} ${arg}` } : b)));
    }
    const done = (text: string, ok = true) => setBlocks((prev) => finishSlash(prev, id, text, ok));
    try {
      if (key === "queue") {
        const r = await client.get<{ items: string[] }>("/api/agent/queue");
        done(r.items.length ? `Queue (${r.items.length}):\n${r.items.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "The queue is empty.");
      } else if (key === "skills") {
        const r = await client.get<{ skills: { name: string; trigger: string }[] }>("/api/agent/context-files");
        done(r.skills.length ? `Loaded skills:\n${r.skills.map((x) => `- ${x.name}: ${x.trigger}`).join("\n")}` : "No skills registered (.harnesside/skills/*.md).");
      } else if (key === "rules") {
        const r = await client.get<{ rules: { path: string }[] }>("/api/agent/context-files");
        done(r.rules.length ? `Loaded rules:\n${r.rules.map((x) => `- ${x.path}`).join("\n")}` : "No rules applied (.harnesside/rules/ or .clinerules).");
      } else if (key === "improve") {
        const r = await client.post<{ ok: boolean; detail: string; proposal: { summary: string; ruleMarkdown: string } | null }>("/api/agent/improve", {});
        done(
          r.proposal
            ? [`[self-improvement proposal] ${r.proposal.summary}`, "", r.proposal.ruleMarkdown, "", "Run /improve-apply to apply it (nothing is written to disk until you do)."].join("\n")
            : r.detail,
          r.ok
        );
      } else if (key === "cli") {
        const toks = arg.trim().split(/\s+/).filter(Boolean);
        if (toks.length === 0) {
          const [st, ss] = await Promise.all([
            client.get<{ tmux: { installed: boolean; version: string | null; socket?: string }; providers: { id: string; label: string; installed: boolean | null; version: string | null; installHint: string; resumeSupported: boolean }[] }>("/api/cli/status"),
            client.get<{ sessions: { name: string; cwd: string; attachedClients: number; dead: boolean; exitCode: number | null }[]; socket?: string }>("/api/cli/sessions"),
          ]);
          let last = "";
          try { last = localStorage.getItem("harnesside.cli.last") ?? ""; } catch { /* 기억 못 해도 동작한다 */ }
          const order = [...st.providers].sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : 0));
          done([
            `tmux: ${st.tmux.installed ? `${st.tmux.version ?? "?"} (소켓 ${st.tmux.socket ?? "기본"})` : "없음 — sudo apt install tmux"}`,
            "",
            "CLI",
            ...order.map((p) => `  ${p.id.padEnd(7)} ${p.label.padEnd(14)} ${p.installed === true ? `✅ 설치됨${p.version ? ` (${p.version})` : ""}` : p.installed === false ? `❌ 설치 안 됨 — ${p.installHint}` : "❔ 확인하지 못함(시간 초과)"}${p.id === last ? "  ← 마지막 선택" : ""}`),
            "",
            ss.sessions.length ? "살아 있는 세션 (hs-*)" : "살아 있는 세션이 없습니다.",
            ...ss.sessions.map((x) => `  ${x.name}  ${x.dead ? `종료됨(코드 ${x.exitCode ?? "?"})` : `실행 중 · 붙은 창 ${x.attachedClients}`}  ${x.cwd}\n    외부에서 붙기: tmux${ss.socket ? ` -L ${ss.socket}` : ""} attach -t ${x.name}`),
            "",
            "열기: /cli claude · /cli gemini · /cli codex · /cli shell   (새 세션 /cli claude new · 이어가기 /cli claude resume)",
            "종료: /cli kill <세션명> confirm",
          ].join("\n"));
        } else if (toks[0] === "kill") {
          const name = toks[1] ?? "";
          if (!name) return done("사용법: /cli kill <세션명> [confirm]", false);
          const r = await client.post<{ ok: boolean; detail: string }>(`/api/cli/sessions/${encodeURIComponent(name)}/kill`, { confirm: toks[2] === "confirm" });
          done(r.detail, r.ok || toks[2] !== "confirm");
        } else {
          const provider = toks[0]!;
          const sub = toks[1];
          if (sub && sub !== "new" && sub !== "resume") return done(`알 수 없는 옵션입니다: ${sub} (new · resume)`, false);
          const r = await client.post<{ sessionName: string; reused: boolean; attachCommand: string; session: { title: string; cwd: string }; notes: string[] }>("/api/cli/sessions", { provider, forceNew: sub === "new", resume: sub === "resume" });
          try { localStorage.setItem("harnesside.cli.last", provider); } catch { /* 무시 */ }
          // 이미 열린 세션에 다시 붙은 경우엔 `terminal.open` 이 오지 않는다 — 직접 그 탭을 띄우고 대상을 맞춘다.
          setFocusReq({ n: Date.now(), session: r.session });
          setPromptTo("cli");
          done([
            `${r.session.title} 탭을 ${r.reused ? "다시 붙였습니다 (살아 있는 세션)" : "열었습니다"} — 메시지창 자리에 터미널이 떴습니다.`,
            `  세션 ${r.sessionName} · 폴더 ${r.session.cwd}`,
            `  외부에서 붙기: ${r.attachCommand}`,
            "  탭을 닫아도 CLI 는 계속 실행됩니다. 이 탭의 작업은 harnesside 승인 게이트 밖에서 실행됩니다.",
            ...r.notes.map((n) => `  ! ${n}`),
          ].join("\n"));
        }
      } else if (key === "models" || key === "server" || key === "reset") {
        // 서버가 오래 걸리는 일(내려받기·재시작)을 하므로 작업으로 돌리고 출력을 따라간다.
        let job = await client.post<{ id: string; text: string; done: boolean; ok: boolean }>("/api/slash/run", { key, arg });
        for (;;) {
          setBlocks((prev) => (job.done ? finishSlash(prev, id, job.text, job.ok) : prev.map((b) => (b.id === id ? { ...b, text: job.text } : b))));
          if (job.done) break;
          await new Promise((r) => setTimeout(r, 800));
          job = await client.get(`/api/slash/job/${encodeURIComponent(job.id)}`);
        }
      } else if (key === "help") {
        // `/help` — 이 프로그램의 명령 목록. **그리는 규칙은 `renderHelpText`(순수 함수)에 있다.**
        //
        // 왜 이게 필요했나: `/help` 와 `/keys` 는 `where: "tui"` 였다. TUI 가
        // 삭제된 뒤(Q-2) **실행되는 곳이 하나도 남지 않은 명령**이 되었고, 더 나쁘게도
        // `/help` 를 친 사용자에게는 "웹에서 지원하지 않는 명령입니다" 가 떴다 —
        // 사용자가 이미 웹 창에 있는데 웹이 명령을 모른다고 말하는 셈이었다.
        //
        // 왜 여기서 목록을 그리지 않나: 여기에도 한번 적으면 **두 벌**이 되고,
        // 새 명령이 조용히 한쪽만 빠진다. 이 저장소에서 가장 많이 기록된 실패 유형이다.
        // (브라우저 실측이 필요해서라고 여기서 그렸던 버전을 2026-10-04 에 되돌렸다 —
        //  출력물을 검사할 수 없다는 이유로 규칙을 복제하는 건 순서가 반대다.)
        done(renderHelpText());
      } else if (key === "term") {
        const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
        done([
          `창          : 웹 브라우저 (콘솔 터미널이 아님)`,
          `브라우저    : ${navigator.userAgent}`,
          `플랫폼      : ${nav.userAgentData?.platform ?? navigator.platform}`,
          `화면        : ${window.innerWidth}×${window.innerHeight}px · 배율 ${window.devicePixelRatio} · 색 ${screen.colorDepth}bit`,
          `유니코드    : 켜짐 (브라우저 렌더링)`,
          `마우스      : 항상 켜짐`,
          `클립보드    : ${typeof navigator.clipboard?.writeText === "function" ? "사용 가능" : "사용 불가 (https/localhost 필요)"}`,
          "",
          "콘솔(TUI)의 제어문자·대체화면·동기화 출력 같은 항목은 웹 창에는 해당이 없습니다.",
        ].join("\n"));
      } else {
        const path = { compact: "/api/agent/compact", "improve-apply": "/api/agent/improve/apply", "plan-clear": "/api/agent/plan/clear" }[key];
        if (!path) return done("웹에서 지원하지 않는 명령입니다", false);
        const r = await client.post<{ ok: boolean; detail: string }>(path, {});
        done(r.detail, r.ok);
      }
    } catch (e) {
      done(e instanceof ApiError ? e.message : String(e), false);
    }
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const t = await client.get<{ entries: { name: string; kind: "dir" | "file"; size: number }[] }>("/api/fs/tree?path=.");
      setTree(t.entries);
    } catch (e) {
      // **빈 배열이 아니라 실패를 보인다.** 탐색기가 조용히 비면 "폴더가 비었다" 로 읽힌다.
      setTree(null);
      pushToast({
        id: "tree:error",
        kind: "error",
        title: "탐색기를 읽지 못했습니다",
        body: e instanceof ApiError ? e.message : String(e),
        at: Date.now(),
        ttlMs: 10_000,
        requiresAck: false,
        source: "fs",
      });
    }
  }, [pushToast]);

  /**
   * 에디터가 알림을 올릴 때 쓰는 경로 — **안정된 함수**로 둔다.
   *
   * 예전에 JSX 안에서 화살표 함수를 그대로 넘겼다. `EditorView` 의 `save` 가 그것을
   * 의존성으로 잡아 **매 렌더 새로 만들어졌고**, 자동 저장 타이머가 매번 지워졌다 —
   * 화면에는 "자동 저장" 이라고 적혀 있는데 **실제로는 한 번도 저장되지 않았다**
   * (WS·계측 스트림이 매초 다시 그리므로 타이머가 끝나기 전에 항상 지워진다).
   *
   * 자식 쪽도 참조로 감싸지만(그래야 부모의 갱신 빈도에 묶이지 않는다), 부모가
   * 처음부터 안정된 함수를 주는 편이 옳다.
   */
  const onEditorNotice = useCallback(
    (kind: "info" | "warn" | "error", title: string, body: string) =>
      pushToast({ id: "edit:" + title, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: kind === "error", source: "fs" }),
    [pushToast],
  );

  const openFileByPath = useCallback(async (path: string) => {
    try {
      const f = await client.get<{ path: string; content: string; version: number; size: number }>(
        `/api/fs/file?path=${encodeURIComponent(path)}`
      );
      setOpenFile(f);
    } catch (e) {
      pushToast({
        id: `open:${path}`,
        kind: "error",
        title: "파일을 열지 못했습니다",
        body: `${path} — ${e instanceof ApiError ? e.message : String(e)}`,
        at: Date.now(),
        ttlMs: 10_000,
        requiresAck: false,
        source: "fs",
      });
    }
  }, [pushToast]);

  // 부팅 상태 폴링 + 워크스페이스 지문
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const w = await client.get<{ current: WorkspaceFingerprint }>("/api/workspace");
        if (!alive) return;
        setWorkspace(w.current);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
      await loadTree();
    })();
    return () => {
      alive = false;
    };
  }, [loadTree]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [b, g] = await Promise.all([client.get<{ steps: BootStep[] }>("/api/bootstrap"), client.get<GpuInfo>("/api/gpu")]);
        if (!alive) return;
        setSteps(b.steps);
        setGpu(g);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : String(e));
      }
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // thinking 초기 동기화 — 서버가 정본이다.
  // 웹 기본값(ON)과 서버 기본값(OFF)이 어긋나면 체크는 켜져 있는데 아무것도 안
  // 나온다(실측: 사고 토큰 항상 0). 부팅 1회만 맞춘다. 이후 토글은 기존 경로.
  useEffect(() => {
    let alive = true;
    void client
      .get<{ thinking?: { enabled?: boolean }; turn?: { running?: boolean } }>("/api/agent/state")
      .then((s) => {
        if (!alive) return;
        if (typeof s.thinking?.enabled === "boolean") {
          const on = s.thinking.enabled;
          setThink((prev) => initialThink({ enabled: on, style: prev.style }));
        }
        if (s.turn?.running === true) setTurnRunning(true);
      })
      .catch(() => {
        // 못 읽으면 웹 기본값 유지 — 다음 토글 때 서버와 맞춘다.
      });
    return () => {
      alive = false;
    };
  }, []);

  // 로그 + 계측 스트리밍 (§2.3 · §5.5)
  useEffect(() => {
    const idePort = Number(new URL(location.href).port || 7317);
    const ws = new WsClient({
      port: idePort,
      token,
      onEvent: (ev) => {
        // **모든 패널이 이 소켓을 공유한다**(wsBus). 패널이 따로 열면 재연결이 N 배로
        // 되고 PTY 출력을 놓친다.
        dispatchWs(ev);
        const evType = String(ev.type);
        if (ev.type === "log.append") {
          const e2 = ev.entry as LogEntry | undefined;
          if (!e2) return;
          setLogs((prev) => {
            const last = prev[prev.length - 1];
            if (last && e2.seq <= last.seq) return prev;
            const next = [...prev, e2];
            return next.length > 2000 ? next.slice(next.length - 2000) : next;
          });
        } else if (ev.type === "log.status") {
          setLogStatus(ev.status as typeof logStatus);
        } else if (ev.type === "sys.metrics") {
          const m = (ev.metrics ?? null) as Metrics | null;
          setMetrics(m);
          if (m) setMetricSeries((prev) => [...prev, m.cpu.overall].slice(-120));
        } else if (ev.type === "model.download") {
          // §7.4 진행률. **모르면 모른다고 말하는 값** 을 그대로 옮긴다(0% 는 "0 바이트" 다).
          const item = ev.item as { id: string; file: string; state: string; progress: number; totalBytes: number; receivedBytes: number; error: string | null } | undefined;
          if (item) setDownloads((prev) => [...prev.filter((d) => d.id !== item.id), item]);
        } else if (evType.startsWith("agent.")) {
          // **모든 에이전트 이벤트를 한 곳에서** 블록으로 바꾼다. 분기마다 따로
          // 처리하면 순서가 뒤집히고(상태 문구가 답변 뒤에 붙는다) 되돌리기 어렵다.
          if (evType === "agent.queue") {
            // 대기열은 대화 블록이 아니라 UI 상태다 — 블록으로 쌓으면 "명령 두 개" 로 보인다.
            const items = ev.queue;
            if (Array.isArray(items)) setQueueItems(items.filter((x): x is string => typeof x === "string"));
            return;
          }
          if (evType === "agent.compaction") {
            // 압축 진행·결과도 UI 상태다. 블록으로 쌓으면 요약이 대화를 오염시킨다.
            const c = ev.compaction as { phase?: string; droppedCount?: number; droppedTokens?: number; keptCount?: number; keptTokens?: number; summary?: string; droppedPreview?: string[] } | undefined;
            if (c && (c.phase === "running" || c.phase === "complete" || c.phase === "failed")) {
              setCompaction({ ...c, phase: c.phase });
            }
            return;
          }
          if (evType === "agent.thinking") {
            // **서버의 추론 상한을 따른다** (2026-10-05 실측).
            //
            // 웹은 상한을 자기 기본값(4,096)으로 셌다. 서버가 설정을 따라 64 로
            // 좁혀도 웹은 4096 으로 쟀고, 그래서 서버가 조용히 도구 호출을 강제하는데
            // **화면에는 아무 설명이 없었다.** 서버가 정본이므로 여기서 맞춘다.
            //
            // 델타를 받기 **전에** 맞춰야 한다 — 델타를 첫 처리하는 순간 임계 비교가
            // 이미 잘못된 상한으로 이뤄진다.
            setThink((prev) => adoptServerThink(prev, { enabled: ev.enabled, maxReasoningTokens: ev.maxReasoningTokens }));
          }
          if (evType === "agent.reasoning") {
            setThink((s) => ({ ...ingest(s, { reasoning: String(ev.text ?? "") }), startedAt: s.startedAt ?? Date.now() }));
          }
          if (evType === "agent.delta" && typeof ev.text === "string" && ev.text) {
            // 답변 토큰도 속도 분자에 넣는다 — 사고만 재면 답변이 긴 턴이 느리게 보인다.
            // 상한(예산) 계산에는 쓰지 않는다(ingest가 text를 예산에서 뺀다).
            setThink((s) => ({ ...ingest(s, { text: ev.text as string }), startedAt: s.startedAt ?? Date.now() }));
          }
          if (evType === "agent.tool.draft") {
            // 파일 본문이 생성되는 순간 — 두 가지를 같이 한다.
            //  1. 별도 초안 줄에 보여 준다(Thinking 과 분리된 UI 요소).
            //  2. 인자 조각을 출력 토큰으로 세서 tok/s 에 반영한다. 호출이 끝난 뒤에 세면
            //     파일을 쓰는 동안의 속도가 0 으로 보이고, 한꺼번에 튀어 오른다.
            const d = ev.draft as { index: number; name: string; args: string } | undefined;
            if (d) {
              setLiveDraft((prev) => ({ index: d.index, name: d.name || prev?.name || "", args: (prev && prev.index === d.index ? prev.args : "") + d.args }));
              setThink((s) => ({ ...ingest(s, { tool: d.args }), startedAt: s.startedAt ?? Date.now() }));
            }
            return;
          }
          if (evType === "agent.tool" && (ev.tool as { done?: boolean } | undefined)?.done) {
            // 호출이 끝나면 초안은 사라지고 완성된 블록(아래 applyEvent)이 그 자리를 잇는다.
            setLiveDraft(null);
          }
          if (evType === "agent.status" && /응답 중/.test(String(ev.text ?? ""))) setLiveDraft(null);
          if (evType === "agent.done" || evType === "agent.error") setLiveDraft(null);
          if (evType === "agent.done" || evType === "agent.error") {
            // 대기열이 남았으면 다음 턴이 바로 돈다 — 실행 중 표시를 내리면 깜빡인다.
            const pending = typeof ev.queue === "number" ? ev.queue : 0;
            if (evType === "agent.error" || pending === 0) setTurnRunning(false);
            else setTurnRunning(true);
          }
          if (evType === "agent.status" && /응답 중/.test(String(ev.text ?? ""))) setTurnRunning(true);
          if (evType === "agent.done" || evType === "agent.error") setThink((s) => finish(s));
          setBlocks((prev) =>
            applyEvent(prev, {
              type: evType,
              text: (ev.text ?? ev.path) as string | undefined,
              tool: ev.tool as AgentBlock["tool"],
              at: Number(ev.at ?? Date.now()),
            })
          );
        } else if (ev.type === "approval.request") {
          // 승인 대기 — 서버가 보낸 요청을 **대화 위에 떠 있는 카드**로 연다.
          // 이미 같은 id 가 있으면 무시(재연결/중복 broadcast 방지).
          const r = ev.request as ApprovalRequest | undefined;
          if (r?.id) setApprovals((prev) => {
            if (prev.has(r.id)) return prev;
            const next = new Map(prev);
            next.set(r.id, r);
            return next;
          });
        } else if (ev.type === "approval.done") {
          // 결정이 돌아오면 카드를 닫는다. "승인이 끝났는데 카드가 안 사라졌다" 가 없도록.
          const id = ev.id as string | undefined;
          if (id) setApprovals((prev) => prev.has(id) ? (() => { const n = new Map(prev); n.delete(id); return n; })() : prev);
        } else if (ev.type === "model.changed") {
          // **서빙 중인 모델이 바뀌었다**(2026-10-05 실측).
          //
          // 예전엔 `modelName` 을 부팅 시 **한 번만** 읽었다. 그래서 `/models <n>
          // confirm` 으로 9B 로 바꿔도 select 는 35B 를 계속 가리켰다 — 화면이 옛
          // 값을 그대로 믿고 있었다. 서버 값만 고쳐서는 부족했고, **그 사실을 알려
          // 주는 신호**가 있어야 화면이 따라온다.
          const m = typeof ev.model === "string" ? ev.model : null;
          if (m) setModelName(m);
        } else if (ev.type === "workspace.changed") {
          // 다른 곳(팔레트·다른 창)에서 루트가 바뀌었다. 화면을 **모으지 않으면** 사용자는
          // 옛 폴더에 계속 쓰게 된다.
          const change = ev.change as { to?: WorkspaceFingerprint; switchPlan?: { warnings?: string[] } } | undefined;
          if (change?.to) setWorkspace(change.to);
          setOpenFile(null); // 열린 파일은 새 루트 밖에 있을 수 있다 — 닫고 다시 고른다
          void loadTree();
          for (const w of change?.switchPlan?.warnings ?? []) {
            pushToast({
              id: `ws:${w.slice(0, 12)}`,
              kind: "warn",
              title: "워크스페이스가 바뀌었습니다",
              body: w,
              at: Date.now(),
              ttlMs: 15_000,
              requiresAck: false,
              source: "workspace",
            });
          }
        } else if (ev.type === "fs.changed") {
          // 자기 쓰기가 아니므로 외부 편집이다 — 사용자에게 **왜** 알리는지 말해야 한다.
          const p = String(ev.path ?? "");
          if (p) {
            pushToast({
              id: `fs:${p}`,
              kind: "info",
              title: "디스크에서 변경됨",
              body: `${p} — 버퍼가 최신이 아닐 수 있습니다. 새로고침 하십시오.`,
              at: Date.now(),
              ttlMs: 10_000,
              requiresAck: false,
              source: "fs",
            });
            // **지금 열려 있는 그 파일**이면 내용을 다시 읽는다(2026-10-05 실측으로 고친 결함).
            //
            // 예전엔 알림만 남기고 **아무것도 하지 않았다** — 화면에는 계속 옛 내용이
            // 있었다. 그런데 "알렸으니 직접 새로고침 하라" 는 답이 아니었다.
            //
            // ── 경로를 **맞춰야** 한다 (이게 첫 시도에서 놓친 지점) ──────────────
            // 감시기가 보내는 `ev.path` 는 **루트 기준 상대 경로**다(`src/index.ts`).
            // 그런데 `openFile.path` 는 **절대 경로**다. 둘을 그대로 `===` 로 비교하면
            // **영영 맞지 않아** 새 내용을 읽는 코드가 도달하지 않는다 — 계측 없이
            // "고쳤다"고 말하기 딱 좋은 형태였다. 그래서 워크스페이스 루트로 잇는다.
            //
            // **덮어쓸지는 EditorView 가 판단한다**(`planExternalChange`): 안 고친 버퍼면
            // 디스크를 따르고, **미저장 편집이 있으면 보존한다.** 여기서 곧장
            // `setOpenFile` 로 갈아끼우면 사용자의 편집을 지운다 — 그래서 읽기만 하고
            // 판단은 넘긴다.
            // **ref 로 읽는다** — 이 effect 는 `openFile` 을 의존하지 않으므로
            // 그대로 읽으면 첫 렌더 값(`null`)에 묶여 있다(위 주석 참고).
            const root = workspaceRef.current?.root;
            const abs = root ? `${root.replace(/\/+$/, "")}/${p}` : null;
            if (abs && openFileRef.current && openFileRef.current.path === abs) {
              void client
                .get<{ path: string; content: string; version: number; size: number }>(
                  `/api/fs/file?path=${encodeURIComponent(abs)}`
                )
                .then((f) => setOpenFile(f))
                .catch(() => {
                  // **읽기에 실패하면 모르는 상태로 두고 알린다.** 방금 읽은 값이
                  // 옛 값일 수 있으니 조용히 성공한 것처럼 두지 않는다.
                  pushToast({
                    id: `fs:reload:${p}`,
                    kind: "warn",
                    title: "바뀐 내용을 다시 읽지 못했습니다",
                    body: `${p} — 화면은 연 시점의 내용을 그대로 보입니다. 직접 다시 열어 확인하십시오.`,
                    at: Date.now(),
                    ttlMs: 12_000,
                    requiresAck: false,
                    source: "fs",
                  });
                });
            }
          }
        }
      },
      onStatus: (s) => setWsState(s),
    });
    ws.connect();

    void (async () => {
      try {
        const r = await client.get<{ entries: LogEntry[]; status: typeof logStatus }>("/api/logs?limit=500");
        setLogs((prev) => (prev.length > 0 ? prev : r.entries));
        setLogStatus(r.status);
      } catch {
        /* WS 로 이어진다 */
      }
      try {
        const m = await client.get<{ latest: Metrics | null; series: (number | null)[] }>("/api/metrics");
        setMetrics(m.latest);
        setMetricSeries(m.series ?? []);
      } catch {
        /* 계측은 나중에 온다 */
      }
      try {
        const v = await client.get<{ model: string | null }>("/api/system/version");
        setModelName(v.model);
      } catch {
        /* 없으면 모델 미연결 상태를 보여준다 */
      }
    })();

    return () => ws.close();
  }, [pushToast]);

  // M7: 입력창 드래프트 자동 저장 — **서버 상태와 무관하게** (창 스코프)
  useEffect(() => {
    saveDraft({ text: draft, savedAt: Date.now(), attachments: [] }, typeof localStorage !== "undefined" ? localStorage : null);
  }, [draft]);

  // §5.10 — **새로고침/서버 재시작** 에서만 세션을 복원한다.
  // WS 재연결에서 이걸 부르면 스트리밍 중 화면이 통째로 바뀐다(§5.10 금지).
  // 구분은 `planRestore` 가 하고, 여기서는 WS 상태가 **닫힘→열림** 을 거친 경우에만
  // 복원을 시도한다. 최초 로드에서도 복원을 시도하는 것이 "새로고침" 이다.
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (wsState !== "open" || restoredOnce.current) return;
    restoredOnce.current = true;
    void (async () => {
      try {
        const cur = await client.get<{ id: string | null; blocks: { id: string; kind: string; title: string; content: unknown; createdAt: number }[]; saved: boolean }>(
          "/api/session/current"
        );
        if (!cur.id || cur.blocks.length === 0) return;
        // **빈 화면으로 덮지 않는다.** 지금 화면에 블록이 있으면(스트리밍 중) 붙인다.
        if (blocksRef.current.length > 0) return;
        setBlocks(
          // `view` 블록(설정·슬래시 결과)은 저장 형식에 모양이 없어 복원할 수 없다 —
          // 복원하면 "이 화면을 열 수 없습니다" 만 남는다.
          cur.blocks.filter((b) => b.kind !== "view").map((b, i) => ({
            id: b.id || `restored-${i}`,
            kind: (b.kind as AgentBlock["kind"]) ?? "text",
            text: typeof b.content === "string" ? b.content : (b.title ?? ""),
            at: b.createdAt ?? Date.now(),
          }))
        );
        setRestored(cur.blocks.length);
      } catch {
        // 복원 실패는 조용히 넘어간다 — 창이 뜨는 것을 막을 이유는 없다.
      }
    })();
  }, [wsState]);

  // M5 팔레트
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // **Ctrl+K / Ctrl+P 는 모두 팔레트** — 하나의 기능에 두 단축이 걸치면 사용자는
      // "어느 키가 정답일까" 하고 헤맬 필요가 없다. 둘 다 자주 누르는 라우팅 명령이라
      // 겹쳐도 괜찮고, 한쪽이 죽어도 반대쪽에서 열린다. (VS Code 는 P 를 파일 열기에
      // 쓰지만 여기선 팔레트를 여는 단축으로 재지정한다 — 겹쳐도 기능은 하나다.)
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      } else if (e.altKey && e.key.startsWith("Arrow")) {
        // §5.8: 드래그 없이도 패널을 이동할 수 있어야 한다
        const map: Record<string, Zone> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" };
        const target = map[e.key];
        if (!target) return;
        e.preventDefault();
        setLayout((l) => {
          const focused = l.panels.find((p) => !p.collapsed && p.zone !== "center") ?? l.panels[0];
          const next = keyboardMove(focused.zone, target === "left" ? -1 : target === "right" ? 1 : 0, target === "top" ? -1 : target === "bottom" ? 1 : 0);
          return movePanel(l, focused.id as PanelId, next);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 헤더·셸·설정이 **같은 알림 경로**를 쓴다 — 한 종류의 알림이 화면 한 곳에 모인다. */
  const notice = useCallback(
    (kind: "info" | "warn" | "error", title: string, body: string, source = "app") =>
      pushToast({ id: `${source}:${title}`, kind, title, body, at: Date.now(), ttlMs: 12_000, requiresAck: false, source }),
    [],
  );

  const onModelPhase = useCallback((p: { state: string; progress: number; message: string }) => {
    setBlocks((prev) => applyEvent(prev, { type: "agent.status", text: `[업데이트] ${p.message}`, at: Date.now() }));
  }, []);

  /**
   * 명령 팔레트 (M5) — 2026-10-01.
   *
   * 여기의 `run` 은 예전부터 **문자열**이었고 **아무도 실행하지 않았다**(실측:
   * `grep '\.run' src/web/` 의 결과는 검색 대상 비교뿐). 팔레트에서 Enter 를 눌러도
   * 아무 일도 없었고, 화면은 **정상처럼** 명령 목록을 보여줬다. 조용히 안 되는 메뉴는
   * 죽었다고 알아채기 가장 어렵다.
   *
   * 그래서 **함수**로 바꿨다. 그리고 목록에 있던 세 항목이 **실제로 무엇을 하는지** 를
   * 지금 있는 기능에 맞췄다 — 없는 기능을 팔레트에 적어두면 그것도 조용한 거짓말이다.
   */
  const commands: Command[] = useMemo(
    () => [
      { id: "view.toggleLog", title: "서버 로그 접기/펼치기", category: "보기", keys: [], run: () => setLogOpen((v) => !v) },
      {
        id: "view.openSettings",
        title: "설정 열기",
        category: "설정",
        keys: [],
        // **별도 패널이 아니라 대화 안의 블록**으로 연다(2026-10-01 요구).
        // 상단 우측 ⚙ 아이콘과 같은 동작이다 — 팔레트는 키보드 경로다.
        // **같은 규칙**(`toggleView`) — 아이콘으로 눌러도 팔레트로 눌러도 똑같이 닫힌다.
        run: () => setBlocks((prev) => toggleView(prev, { what: "settings" }, Date.now())),
      },

      { id: "palette.open", title: "명령 팔레트", category: "기타", keys: ["Ctrl+K"], run: () => setPaletteOpen((v) => !v) },
    ],
    [client, notice],
  );

  /**
   * 설정 화면 — **`BODY` 보다 먼저** 만든다.
   *
   * 순서가 중요한 이유: 설정은 대화 **안의 블록**으로 그려지는데, 그 블록을 그리는
   * `AgentPanel` 은 `BODY` **안**에 있다. 즉 `BODY` 가 설정 노드를 필요로 하고,
   * `BODY` 안의 `AgentPanel` 이 같은 노드를 다시 받아야 한다 — 순서가 뒤집히면
   * "선언 전 사용" 이 된다. 그래서 먼저 만들고 **두 곳이 공유**한다.
   *
   * deps 가 안정적이어야 한다 — `ModelPanel` 은 이 값으로 `useEffect` 를 돌고,
   * 값이 매 렌더 바뀌면 무한 요청이 된다(2026-10-01 실측: `/api/models` 5초 3303회).
   */
  const settingsNode = useMemo(
    () => <ModelPanel client={client} onNotice={notice} onPhase={onModelPhase} />,
    [client, notice, onModelPhase],
  );
  // ── 설정 — **대화 안의 블록**으로 연다. 여는 곳은 상단 우측 ⚙ 아이콘
  // (헤더)과 명령 팔레트뿐이다. 측면 아이콘·디렉터리·변경 검토 진입로는 제거됨
  // (사용자 지정: 설정만 남긴다). 저장된 옛 dirs/diff 블록은 ToolBlock이
  // "제거되었습니다" 로 정직하게 말한다.
  const viewExtra = useMemo(() => ({ settings: settingsNode }), [settingsNode]);

  // ── 승인 게이트 — **대화 위에 떠 있는 카드** (§8.2) ────────────────────────────
  // 서버가 approval.request 를 보내면 이 맵에 넣고, done 이면 지운다. 카드는 아래
  // `pendingApprovals` 로 AgentPanel→Ide.overlay 에 그린다(대화 흐름을 가리되 별도
  // 패널이 아닌, "무엇을 하려다가 승인했나" 가 스크롤로 이어지게).
  const pendingApprovals = useMemo(() => Array.from(approvals.values()), [approvals]);

  // 승인 카드 — **대화 위에 떠 있는 카드** (§8.2). 여러 개가 동시에 떠 있어도
  // 각기 `id` 가 다르니 두 번 그린다. 대화 흐름을 가리지만 별도 패널이 아니라,
  // "무엇을 하려다가 승인했나" 가 스크롤로 이어진다. 카드는 IDE 본문 위에 오버레이로.
  const approvalOverlay = pendingApprovals.length ? (
    <div style={{ position: "absolute", right: 16, bottom: 80, display: "flex", flexDirection: "column", gap: 8, zIndex: 30 }}>
      {pendingApprovals.map((r) => (
        <ApprovalCard key={r.id} client={client} request={r} onNotice={(kind, title, body) => pushToast({ id: `approval:${title}`, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "approval" })} />
      ))}
    </div>
  ) : null;

  /**
   * 설정 열기/닫기 — **헤더 ⚙ 아이콘과 블록 안 ▸/✕ 가 같은 함수**를 쓴다.
   *
   * 경로마다 따로 만들면 "아이콘에서는 닫히는데 블록에서는 쌓인다" 가 된다 —
   * 이 저장소가 가장 많이 기록한 실패 유형("같은 일을 두 곳에 두지 않는다").
   * `collapseView` 는 블록 하나만 접고 **지우지 않는다** — 지우면 되돌릴 수 없다.
   */
  const onToggleView = useCallback(() => {
    setBlocks((prev) => toggleView(prev, { what: "settings" }, Date.now()));
  }, []);
  const onCloseView = useCallback((b: AgentBlock) => {
    setBlocks((prev) => collapseView(prev, b.id));
  }, []);

  /**
   * 패널 본문. **존과 무관하게** 같은 내용 — 패널이 옮겨가면 내용까지 바뀌면
   * 사용자는 "어디로 옮긴 거지?" 하고 헤더만 찾게 된다.
   */
  const BODY: Partial<Record<PanelId, React.ReactNode>> & Record<string, React.ReactNode> = {
    agent: (
      <>
        {/* M10 크래시 안내 — **있을 때만** 나타난다. 재개는 ResumeBanner 가 맡는다. */}
        <CrashBanner client={client} />
        {/* Q-5 부팅 실패 — **어느 단계 · 무엇 · 왜 · 다음** 을 창에도 보인다(로그와 같은 함수). 실패가 있을 때만. */}
        {!bootFailHidden && (steps ?? []).some((st) => describeBootFailure(st)) && (
          <div role="alert" aria-label="부팅 문제" style={{ border: "1px solid #d29922", borderRadius: 6, background: "#161b22", padding: "6px 8px", fontSize: 12, color: FG, margin: "0 0 6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden="true" style={{ color: "#d29922" }}>⚠</span>
              <strong>부팅 중 문제가 있었습니다 — 서버와 창은 계속 동작합니다</strong>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setBootFailHidden(true)} style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", fontSize: 11 }}>닫기</button>
            </div>
            {(steps ?? []).map((st) => describeBootFailure(st)).filter((f): f is NonNullable<typeof f> => !!f).map((f) => (
              <dl key={f.where} style={{ margin: "4px 0 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "1px 8px" }}>
                <dt style={{ color: DIM }}>단계</dt><dd style={{ margin: 0 }}>{f.where}</dd>
                <dt style={{ color: DIM }}>무엇</dt><dd style={{ margin: 0 }}>{f.what}</dd>
                <dt style={{ color: DIM }}>왜</dt><dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>{f.why}</dd>
                <dt style={{ color: DIM }}>다음</dt><dd style={{ margin: 0 }}>{f.next}</dd>
              </dl>
            ))}
          </div>
        )}
        {/* M3 재개 배너 — **있을 때만** 나타난다. 항상 보이면 경고가 무시된다. */}
        <ResumeBanner
          client={client}
          running={turnRunning}
          onResumed={() => setBlocks((prev) => prev)}
          onNotice={(kind, title, body) =>
            pushToast({ id: `agent:${title}`, kind, title, body, at: Date.now(), ttlMs: 10_000, requiresAck: false, source: "agent" })
          }
        />
      <AgentPanel
        blocks={blocks}
        client={client}
        notices={bellItems}
        onDismissNotice={(id) => setToasts((p) => p.filter((x) => x.id !== id))}
        compaction={compaction}
        onDismissCompaction={() => setCompaction(null)}
        viewExtra={viewExtra}
        onToggleView={onToggleView}
        onCloseView={onCloseView}
        onToggleBlock={(b: AgentBlock) => setBlocks((prev) => toggleSlashFold(prev, b.id))}
        // 파일 미리보기 `편집` → 편집기. **연결이 없다면 편집기는 도달 불가능**하다(실측).
        onEditFile={(p: string) => void openFileByPath(p)}
        overlay={approvalOverlay}
        running={turnRunning}
        liveDraft={liveDraft}
        // 상태바 — 이미 **앱 전체가 하나씩** 붙들고 있는 값을 **읽기만** 넘긴다.
        // 여기서 WS 를 새로 붙들면 소켓이 두 개 생기고 재연결이 두 배가 된다.
        wsState={wsState}
        context={metrics?.context ?? null}
        think={think}
        onCancel={() => void client.post("/api/agent/cancel")}
        // 예시는 **채우기만** 한다. 바로 보내면 사용자가 고칠 기회를 잃는다 —
        // "누르는 즉시 실행" 은 되돌리기 어렵다(§5.10: 무엇을 했는지 말해야 한다).
        onExample={(text) => {
          setDraft(text);
          focusDraft();
        }}
      />

      {/* 파일 편집기 — **2026-10-05 실측으로 발견해 연결했다.**
          `EditorView` 는 import만 되어 있고 렌더되는 곳이 없었다. 즉 `openFileByPath` ·
          `openFile` 상태 · `openTabs` 는 전부 있었는데 **열 방법이 없었다**.
          ① 편집창 신택스 색과 ③ 인덴트 가이드가 화면에 없던 이유가 이것이다.

          위치: 대화 **위**(승인 카드와 같은 층). 전용 패널을 새로 만드는 게 아니라
          "지금 한 파일을 보고 있다" 를 잠깐 덮는 것으로 충분하다고 판단했다 — 새 존을
          더하면 레이아웃이 무너지는 축이다(저장소 §3.11). */}
      {openFile && (
        <div
          role="dialog"
          aria-label={`파일 편집 · ${openFile.path}`}
          style={{
            position: "fixed",
            inset: "34px 6px 26px 6px",
            zIndex: 40,
            display: "flex",
            flexDirection: "column",
            background: "#0d1117",
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            boxShadow: "0 12px 32px rgba(1,4,9,0.6)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", borderBottom: `1px solid ${BORDER}`, background: "#161b22" }}>
            <span style={{ fontSize: 10, color: "#8b949e" }}>편집 중 · 자동 저장</span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => setOpenFile(null)} style={{ fontSize: 10, background: "#21262d", color: "#c9d1d9", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "1px 8px", cursor: "pointer" }}>
              닫기
            </button>
          </div>
          <div style={{ flex: "1 1 auto", minHeight: 0 }}>
            {/* EditorView 의 `onNotice` 는 (종류, 제목, 본문) 을 받는다. 토스트 makers(pushToast·
                notice) 와 **모양이 다르므로 래퍼를 한 번 거친다** — 함수를 잘못 넘기면
                화면에 아무 것도 안 뜬다(타입은 잡아 주지만 그건 "조용히 실패" 다). */}
            <EditorView
              client={client}
              info={openFile}
              onNotice={onEditorNotice}
            />
          </div>
        </div>
      )}

      </>
    ),
    // §9.3 커밋. diff(한 파일 비교)와 **커밋(저장소 전체)** 은 다른 일이라 같은
    // 존에 둘 수 있지만 같은 패널은 아니다 — 요구 16 의 커밋 단계가 여기다.
    terminal: (
      <TerminalView
        client={client}
        onNotice={notice}
        onActiveCli={onActiveCli}
        focusRequest={focusReq as never}
      />
    ),
    // ── 설정은 **대화 안의 블록**이다 (2026-10-01) ────────────────
    // 여는 곳은 상단 우측 ⚙ 아이콘뿐 — 별도 패널 항목은 두지 않는다.
    // (사용자 지정: 설정만 남기고 설정 패널 부분은 제거)

  };

  const visible = useMemo(() => visibleTail(filterEntries(logs, filter), 2000), [logs, filter]);
  const hits = useMemo(() => searchCommands(commands, paletteQuery, 12), [commands, paletteQuery]);
  const full = bufferFullLabel(logStatus);
  const bootDone = steps?.filter((s) => s.ok).length ?? 0;

  // ── 화면 구조 (2026-10-04) ──────────────────────────────────────────────
  //   메시지창(1fr) → 프롬프트 → 모니터 줄 → 서버 로그(접힘)
  // **하단 셸 창은 없다**(사용자 요구: 완전 제거). 터미널은 AI CLI 를 고른 때만 메시지창 자리에 뜬다.
  /** 로그 접힘 — **기본 접힘**(2026-10-01). 데몬 상태 창이지 매번 보는 창이 아니다. */
  const [logOpen, setLogOpen] = useState(() => {
    try {
      return localStorage.getItem("harnesside.logOpen") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("harnesside.logOpen", logOpen ? "1" : "0");
    } catch {
      /* 저장 불가 — 접힘 상태만 이번 실행에 적용된다 */
    }
  }, [logOpen]);

  // ── 입력창·하단 쉘 높이 (2026-10-04: 좌측 밴드 삭제 — 10-01 확정 구조로 복귀) ──
  // 입력 창 높이(세로 가변) — localStorage 저장.
  //
  // ── 높이를 줄로 환산하는 법 (실측) ──────────────────────────────────────────
  //
  // 저장값과 "보이는 줄" 의 관계를 **직접 쟀다**(`textarea.clientHeight` 를
  // `line-height` 로 나눈다). 관계는 이렇다:
  //
  //     clientHeight ≈ 저장값 − 35      (테두리 2 + 위아래 패딩 16 + 버튼 여백)
  //     보이는 줄 = floor((clientHeight − 16) / 18)
  //
  // 계측한 값(달라진 곳은 계측값을 그대로 쓴다):
  //
  //     저장 86 → clientHeight 51 → 1줄
  //     저장 70 → clientHeight 35 → 1줄  (최소값)
  //     저장 68 → clientHeight 32 → **0줄(글자가 하나도 보이지 않는다)**
  //
  // ── 옛 주석이 틀렸던 이유 ──────────────────────────────────────────────────
  //
  // 예전 주석은 "104 = 3줄 + 패딩 16 + 하단 바 34" 라고 적었다. **하단 바는 이 상자의
  // 형제다** — 안에 있는 줄이 아니다. 그래서 3으로 잘못 세었고, 실제 기본값은
  // **2줄**이었다. 숫자를 적어두고 확인하지 않은 것이 가장 오래 남는 오류다.
  //
  // **기본 104 = 2줄.**
  //
  // 86(1줄)로 줄였다가 **한 줄 더 넓혀 달라는** 요청을 받아 104 로 되돌렸다
  // (2026-10-05). 계측 기준 그대로 **2줄**이 된다. 줄 수는 계산이 아니라 측정이다:
  // `clientHeight` 가 51 이면 1줄, 69 이면 2줄이다.
  //
  // **드래그 간격은 18px**(계측한 줄 높이). 예전엔 16px 였는데, 그러면 저장값이 줄
  // 단위에서 벗어나 86+16=102 같은 값에 걸린다. 줄로 세어지는 상자의 높이는 줄
  // 단위로 움직여야 한다.
  //
  // **최소값은 70(1줄)** — 예전엔 48이었는데, 거기까지 줄이면 `clientHeight` 가 32가
  // 되어 **타이핑한 글자가 하나도 보이지 않는다**(실측). 입력을 못 보는 상태는
  // 장식이 아니라 사고다.
  const INPUT_H_DEFAULT = 104;
  const INPUT_H_STEP = 18;
  const INPUT_H_MIN = 70;
  const [inputH, setInputH] = useState(() => {
    try {
      const v = Number(localStorage.getItem("harnesside.inputH")) || INPUT_H_DEFAULT;
      return Math.max(INPUT_H_MIN, Math.min(400, v));
    } catch {
      return INPUT_H_DEFAULT;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("harnesside.inputH", String(Math.round(inputH)));
    } catch {
      /* 저장 불가 — 이번 실행에만 적용 */
    }
  }, [inputH]);

  // 입력창·하단 쉘 포인터 드래그 — **한 번만** 붙인다. 각 mousedown마다
  // 스냅샷을 잡고 pointerup에서 리스너를 제거하므로 렌더마다 중복이 없다.
  // 입력창 높이 드래그 — 위로 올리면 커지고 내리면 작아진다. 48~400px.
  const onInputSepDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = inputH;
    const move = (ev: MouseEvent) => setInputH(Math.max(INPUT_H_MIN, Math.min(400, startH - (ev.clientY - startY))));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };


  /* LeftBand/SeparatorV removed 2026-10-04 (see layout note above). */



  return (
    <div
      style={{
        display: "grid",
        // 열은 하나다. 행은 상단 바 · 중앙 열(대화→입력) · 모니터 줄 · 로그.
        gridTemplateColumns: "1fr",
        gridTemplateRows: `28px minmax(0, 1fr) auto auto`,
        height: "100vh",
        background: BG,
        color: FG,
        font: "12px/1.5 system-ui, -apple-system, 'Noto Sans KR', sans-serif",
      }}
    >
      {/* 상단 바 */}
      <header style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 12, padding: "0 10px", borderBottom: `1px solid ${BORDER}`, background: "#161b22" }}>
        <strong>harnesside</strong>
        {/* 지금 어디에 쓰고 있는지 — **항상** 보인다(§8.3). */}
        <WorkspaceBar
          client={client}
          current={workspace}
          openTabs={openTabs}
          onError={(m) => {
            setError(m);
            pushToast({ id: "ws:error", kind: "error", title: "워크스페이스 전환 실패", body: m, at: Date.now(), ttlMs: 15_000, requiresAck: false, source: "workspace" });
          }}
          onSwitched={({ to }) => {
            setWorkspace(to);
            setOpenFile(null);
            void loadTree();
            pushToast({
              id: "ws:switched",
              kind: "info",
              title: "워크스페이스를 바꿨습니다",
              body: `${to.name} — 도구 호출 기준도 여기로 바뀝니다.`,
              at: Date.now(),
              ttlMs: 10_000,
              requiresAck: false,
              source: "workspace",
            });
          }}
        />
        <span style={{ color: DIM }}>{modelName ?? "모델 미연결"}</span>
        {steps && <span style={{ color: DIM }}>{t("app.booting", { stage: bootDone, total: steps.length })}</span>}
        {full && <span style={{ color: full.color, fontSize: 11 }} title="로그 상한">{full.text}</span>}
        {error && <span style={{ color: "#f85149" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        {/* 설정 — 유일하게 남긴 패널 진입로. 대화 안에 블록으로 열린다.
            측면 액티비티바는 두지 않는다(사용자 지정). */}
        <button
          type="button"
          aria-label="설정 열기"
          title="설정 열기/닫기"
          onClick={() => setBlocks((prev) => toggleView(prev, { what: "settings" }, Date.now()))}
          style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", fontSize: 14, padding: "0 4px" }}
        >
          <span aria-hidden="true">⚙</span>
        </button>
        <span style={{ fontSize: 11, color: wsState === "open" ? "#3fb950" : wsState === "connecting" ? "#d29922" : "#f85149" }} title="WebSocket 연결 상태">
          {wsState === "open" ? "● 실시간" : wsState === "connecting" ? "○ 연결 중" : "▲ 끊김"}
        </span>
      </header>


      {/* ── 중앙 열 (2026-10-04): 탐색기 완전 제거 — 출력 → 입력 → 쉘 순서. */}
      <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, minWidth: 0 }}>
        <div ref={msgRef} className="elev-1" style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", padding: 6 }}>
          {BODY.agent}
        </div>
        {slashOpen && (
          <div style={{ position: "relative", height: 0, flex: "0 0 auto", zIndex: 5 }}>
            <div ref={slashListRef} role="listbox" aria-label="슬래시 명령 추천" style={{ position: "absolute", left: 8, bottom: 4, minWidth: 380, maxWidth: "calc(100% - 16px)", maxHeight: 240, overflowY: "auto", background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,.5)" }}>
              {slashItems.map((c, i) => (
                <div
                  key={c.fill}
                  role="option"
                  aria-selected={i === slashIdx}
                  title={c.tip ?? c.description}
                  onMouseEnter={() => setSlashIdx(i)}
                  onMouseDown={(e) => { e.preventDefault(); completeSlash(c.fill); }}
                  style={{ display: "flex", gap: 10, padding: "4px 10px", cursor: "pointer", background: i === slashIdx ? "#1f6feb33" : "transparent", fontSize: 12 }}
                >
                  <span style={{ color: c.dim ? DIM : FG, fontWeight: 700, minWidth: 110 }}>{c.label}</span>
                  <span style={{ color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.description}</span>
                </div>
              ))}
              <div style={{ padding: "2px 10px", fontSize: 10, color: DIM, borderTop: `1px solid ${BORDER}` }}>
                {toCli && cliTarget ? `${cliTarget.title} 명령 · ` : ""}↑↓ 선택 · Tab/Enter 완성 · Esc 닫기
                {toCli && cliCmds?.stale ? " · ⚠ 내장 명령 표가 오래됐거나 미확인일 수 있음" : ""}
              </div>
            </div>
          </div>
        )}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="입력창 높이 조절"
          title="드래그 또는 ↑↓키로 입력창 높이 조절"
          tabIndex={0}
          onPointerDown={onInputSepDown}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") { e.preventDefault(); setInputH((h) => Math.min(400, h + INPUT_H_STEP)); }
            if (e.key === "ArrowDown") { e.preventDefault(); setInputH((h) => Math.max(INPUT_H_MIN, h - INPUT_H_STEP)); }
          }}
          style={{ flex: "0 0 auto", height: 6, cursor: "row-resize", background: "transparent" }}
        />
        <div className="elev-1" style={{ flex: "0 0 auto", height: inputH, minHeight: INPUT_H_MIN, display: "flex", flexDirection: "column", overflow: "hidden", border: 0, borderTop: `2px solid ${toCli ? (cliTarget?.yolo ? "#f85149" : "#a371f7") : BORDER}`, borderRadius: 0, margin: 0, background: "#161b22" }}>
          <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <textarea
            ref={draftRef}
            className="no-focus-ring"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              // **글 을 고치면 브라우즈를 그만둔다** — 다음 `↑` 가 최신부터 다시 시작해야
              // 한다. 그대로 두면 한참 전 말에서 계속 뒤로 가게 된다.
              histRef.current = cancelBrowse(histRef.current);
            }}
            onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (slashOpen) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashItems.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
              if (e.key === "Escape") { e.preventDefault(); setSlashHidden(true); return; }
              const pick = slashItems[Math.min(slashIdx, slashItems.length - 1)];
              if (e.key === "Tab") { e.preventDefault(); completeSlash(pick.fill); return; }
              // Enter: 이미 이 후보를 정확히 썼으면 실행, 아니면 선택한 후보로 **완성**한다.
              if (e.key === "Enter" && !e.shiftKey && draft.trim().toLowerCase() !== pick.exact) { e.preventDefault(); completeSlash(pick.fill); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (draft.trim()) void sendTurn(); }
            // 프롬프트 히스토리 (`↑` `↓`).
            //
            // **순서가 중요하다.** ① 슬래시 메뉴(후보 이동) ② 히스토리 ③ 기본 커서 이동.
            // 메뉴가 좁고 급하므로 언제나 먼저다. 히스토리는 메뉴가 닫혔을 때만.
            //
            // 그리고 **커서가 있는 줄을 먼저 본다** — 여러 줄 프롬프트를 고치는 중에
            // 과거가 끼어들면 본문을 못 고친다. 그래서 첫 줄에서만 `↑`,
            // 끝에서만 `↓` 가 히스토리다(순수 함수가 판단한다).
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              const el = e.currentTarget;
              const caret = el.selectionStart ?? 0;
              const up = e.key === "ArrowUp";
              if (up ? !shouldRecallUp(draft, caret) : !shouldRecallDown(draft, caret)) return;
              const r = up ? recallUp(histRef.current, draft) : recallDown(histRef.current);
              if (!r) return;
              // **조용히 커서를 움직이지 않는다.** 히스토리가 없으면 기본 동작에 맡긴다.
              e.preventDefault();
              histRef.current = r.next;
              applyRecall(r.text);
              return;
            }
          }} placeholder={promptHint} aria-label="프롬프트 입력" style={{ background: "transparent", color: FG, border: 0, outline: "none", resize: "none", flex: 1, padding: 8, font: "inherit", minHeight: 0 }} />
          <button type="button" disabled={!draft.trim()} onClick={() => void sendTurn()} style={{ flex: "0 0 auto", alignSelf: "stretch", margin: 6, padding: "0 16px", background: "#21262d", color: FG, border: `1px solid ${BORDER}`, borderRadius: 4, cursor: draft.trim() ? "pointer" : "default", font: "inherit" }}>
            {toCli ? "CLI로 보내기" : turnRunning ? "대기열에 추가" : "보내기"}
          </button>
          </div>
          {/* O4 대기열 — 실행 중 들어온 입력과 순서 변경. 칩의 ↑↓로 순서를 바꾼다. */}
          {queueItems.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", padding: "2px 8px", borderTop: `1px solid ${BORDER}`, fontSize: 10 }}>
              <span style={{ color: DIM }}>대기 {queueItems.length}</span>
              {queueItems.map((q, i) => (
                <span key={`${i}:${q.slice(0, 24)}`} style={{ display: "inline-flex", gap: 2, alignItems: "center", background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 999, padding: "0 2px 0 6px", color: FG, maxWidth: 220 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i + 1}. {q.slice(0, 40)}</span>
                  <button type="button" aria-label={`대기 ${i + 1}번째를 앞으로`} title="앞으로" disabled={i === 0} onClick={() => void client.post("/api/agent/queue/move", { from: i, to: i - 1 }).catch(() => {})} style={{ background: "none", border: 0, color: i === 0 ? "#484f58" : DIM, cursor: i === 0 ? "default" : "pointer", font: "inherit", padding: "0 2px" }}>↑</button>
                  <button type="button" aria-label={`대기 ${i + 1}번째를 뒤로`} title="뒤로" disabled={i === queueItems.length - 1} onClick={() => void client.post("/api/agent/queue/move", { from: i, to: i + 1 }).catch(() => {})} style={{ background: "none", border: 0, color: i === queueItems.length - 1 ? "#484f58" : DIM, cursor: i === queueItems.length - 1 ? "default" : "pointer", font: "inherit", padding: "0 2px" }}>↓</button>
                </span>
              ))}
              <button type="button" onClick={() => void client.post("/api/agent/queue/clear", {}).catch(() => {})} style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", textDecoration: "underline" }}>비우기</button>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderTop: `1px solid ${BORDER}`, flex: "0 0 auto" }}>
            <span style={{ fontSize: 11, color: FG, fontWeight: 700 }}>프롬프트</span>
            <button type="button" onClick={() => { clearDraft(typeof localStorage !== "undefined" ? localStorage : null); setDraft(""); }} style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", fontSize: 11 }}>지우기</button>
            <select
              aria-label="프롬프트 대상"
              title="이 입력창이 보내는 곳 — 로컬 모델(harnesside 에이전트) 또는 사용자 환경에 설치된 AI CLI. 고르면 그 모델에 맞는 슬래시 명령이 제공됩니다."
              value={toCli && cliTarget ? cliTarget.provider : "local"}
              onFocus={refreshProviders}
              onChange={(e) => void pickTarget(e.target.value)}
              style={{ background: toCli ? "#a371f733" : "#1f6feb33", color: "#f0f6fc", border: `2px solid ${toCli ? "#a371f7" : "#58a6ff"}`, borderRadius: 6, font: "inherit", fontSize: 13, fontWeight: 700, padding: "3px 10px", minWidth: 260, maxWidth: 380, cursor: "pointer", colorScheme: "dark" }}
            >
              <option value="local" style={{ background: "#161b22", color: "#f0f6fc" }}>local_model{modelName ? ` · ${modelName.split("/").pop()}` : ""}</option>
              {cliProviders.filter((p) => p.id !== "shell").map((p) => (
                <option key={p.id} value={p.id} style={{ background: "#161b22", color: p.installed === false ? "#6e7681" : "#f0f6fc" }} disabled={p.installed === false} title={p.installed === false ? p.installHint : undefined}>
                  ◆ {p.label}{p.installed === false ? " — 설치 안 됨" : p.installed === null ? " — 확인 못 함" : ""}
                </option>
              ))}
            </select>
                        {toCli && cliTarget && (() => {
              const prov = CLI_PROVIDERS.find((p) => p.id === cliTarget.provider);
              const supported = !!prov?.yoloArgs;
              return (
                <label title={supported ? "YOLO — 승인·확인 요청을 모두 자동 허용합니다(파일 수정·명령 실행이 묻지 않고 진행). 켜면 이 폴더에서 YOLO 세션을 새로 시작합니다(이전 대화는 이어가기)." : `${prov?.label ?? "이 CLI"} 의 YOLO 인자를 확인하지 못했습니다(미확인) — 지원하지 않습니다.`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: cliTarget.yolo ? "#f85149" : supported ? FG : DIM, fontWeight: cliTarget.yolo ? 700 : 400, cursor: supported ? "pointer" : "not-allowed" }}>
                  <input type="checkbox" checked={!!cliTarget.yolo} disabled={!supported} onChange={(e) => (e.target.checked ? setYoloAsk(true) : void pickTarget(cliTarget.provider, { yolo: false }))} />
                  YOLO
                </label>
              );
            })()}
            {toCli && cliTarget && yoloAsk && (
              <span role="alertdialog" aria-label="YOLO 켜기 확인" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "#f85149", border: "1px solid #f85149", borderRadius: 4, padding: "1px 8px", background: "#f8514922" }}>
                ⚠ 승인 요청을 모두 자동 허용합니다 — 파일 수정·명령 실행이 묻지 않고 진행되고, claude 의 폴더 신뢰·우회 모드 경고도 대신 수락합니다.
                <button type="button" onClick={() => { setYoloAsk(false); void pickTarget(cliTarget.provider, { yolo: true, resume: !!CLI_PROVIDERS.find((p) => p.id === cliTarget.provider)?.resumeArgs }); }} style={{ background: "#da3633", color: "#fff", border: 0, borderRadius: 4, cursor: "pointer", font: "inherit", padding: "1px 8px" }}>켜기</button>
                <button type="button" onClick={() => setYoloAsk(false)} style={{ background: "none", color: FG, border: `1px solid ${BORDER}`, borderRadius: 4, cursor: "pointer", font: "inherit", padding: "1px 8px" }}>취소</button>
              </span>
            )}
            {/* 슬래시 버튼 줄은 없다(사용자 지정, 2026-10-04) — 명령은 `/` 자동완성으로 쓴다. */}
          </div>
        </div>
      </div>
      {/* 터미널(AI CLI) — 하단 셸 창은 없다. CLI 대상일 때만 메시지창 자리에 오버레이로 뜨고,
          그 밖에는 **마운트만 유지**한 채 숨긴다(탭 복원·`terminal.open` 수신·tmux 상태를 잃지 않게). */}
      <div
        data-term-host={termOverlay ? "overlay" : "hidden"}
        style={termOverlay && msgRect
          ? { position: "fixed", left: msgRect.left, top: msgRect.top, width: msgRect.width, height: msgRect.height, zIndex: 3, background: "#0d1117", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: cliTarget?.yolo ? "inset 0 0 0 2px #f85149" : undefined }
          : { display: "none" }}
      >
        {BODY.terminal}
      </div>
      <MonitorStrip latest={metrics} />

      {/* 로그 — **닫을 수 없는 기본 탭**(§5.12)이지만 **접을 수 있다**(2026-10-01).
          "닫을 수 없음" 은 사라져서는 안 된다는 뜻이지, 항상 펼쳐 두어야 한다는 뜻이 아니다.
          접었을 때 **마지막 줄** 이 보인다 — 로그가 무언가를 하고 있다는 사실 자체가
          제일 중요한 신호이고, 그걸 숨기면 "멈췄다" 고 읽힌다. */}
      <footer
        style={{
          gridColumn: "1 / -1",
          borderTop: `1px solid ${BORDER}`,
          background: BG,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {!logOpen && (
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            aria-expanded={false}
            title={t("panel.log") + " 펼치기"}
            style={{
              display: "flex", gap: 8, alignItems: "center",
              background: "none", border: 0, color: DIM, cursor: "pointer",
              font: "inherit", fontSize: 11, padding: "4px 10px", textAlign: "left", width: "100%",
            }}
          >
            <span>▴ {t("panel.log")}</span>
            {/* **내용이 있으면 접어도 보여준다.** 몇 줄인지 말하지 않으면
                "접었으니 0 건" 으로 읽힌다 — 실제로는 계속 쌓이고 있다. */}
            {visible.length > 0 && (
              <span style={{ color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {visible[visible.length - 1].message}
              </span>
            )}
            <span style={{ marginLeft: "auto" }}>
              {visible.length.toLocaleString("ko-KR")}줄
            </span>
          </button>
        )}
        {logOpen && (
          <>
            <button
              type="button"
              onClick={() => setLogOpen(false)}
              aria-expanded={true}
              style={{
                display: "flex", gap: 8, alignItems: "center",
                background: "none", border: 0, color: DIM, cursor: "pointer",
                font: "inherit", fontSize: 11, padding: "2px 10px", textAlign: "left",
              }}
            >
              <span>▾ {t("panel.log")}</span>
              <span style={{ marginLeft: "auto" }}>접기</span>
            </button>
            <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
              <LogPanel entries={visible} status={logStatus ?? undefined} level={filter.level as LogLevel} onSetLevel={(l) => setFilter((f) => ({ ...f, level: l }))} height={layout.logHeight} filterLabel={filterLabel(filter)} />
            </div>
          </>
        )}
      </footer>

      {/* 팔레트 */}
      {paletteOpen && (
        <div onClick={() => setPaletteOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,0.6)", display: "grid", placeItems: "start center", paddingTop: "12vh", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} className="elev-3" style={{ width: 520, background: "#161b22", border: `1px solid ${BORDER}`, borderRadius: 6, overflow: "hidden" }}>
            <input
              autoFocus
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              placeholder="명령 검색…"
              style={{ width: "100%", background: "transparent", border: 0, borderBottom: `1px solid ${BORDER}`, color: FG, padding: 10, outline: "none", font: "inherit" }}
            />
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              {hits.length === 0 && <div style={{ padding: 12, color: DIM }}>일치하는 명령이 없습니다</div>}
              {/* **이 항목들은 선택 가능하다.** 예전에는 `div` 였고 `onClick` 도
                  `Enter` 처리도 **없었다** — 화면은 "메뉴" 처럼 보이는데 눌러도 아무
                  일도 없었다(2026-10-01 실측). 조용히 안 되는 메뉴는 죽었다고
                  알아채기 가장 어렵다: 목록이 보이므로 "기능이 없다" 가 아니라
                  "이 몇 개가 말썽이다" 고 읽힌다.

                  그래서 `button` 이고, 고른 항목은 **반드시 `run` 을 실행**한다.
                  실패하면 **사유를 말한다** — 조용히 닫으면 "뭘 눌렀는지" 가 사라져
                  아무 일도 없었다고 읽힌다. */}
              {hits.map((h) => (
                <button
                  key={h.cmd.id}
                  type="button"
                  onClick={() => {
                    setPaletteOpen(false);
                    try {
                      void h.cmd.run();
                    } catch (e) {
                      notice("error", "명령을 실행하지 못했습니다", e instanceof Error ? e.message : String(e));
                    }
                  }}
                  style={{
                    display: "flex", gap: 8, width: "100%", textAlign: "left",
                    padding: "6px 10px", background: "none", border: 0,
                    borderBottom: "1px solid #21262d", color: FG,
                    cursor: "pointer", font: "inherit",
                  }}
                >
                  <span style={{ flex: 1 }}>{h.cmd.title}</span>
                  <span style={{ color: DIM, fontSize: 10 }}>{h.cmd.category}</span>
                  {h.cmd.keys.length > 0 && <span style={{ color: DIM, fontSize: 10 }}>{h.cmd.keys.join(" ")}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 우하단 팝업 제거됨(2026-10-04): 알림은 대화창 상단의 🔔 센터가 전담한다.
          두 곳에 띄우면 같은 소식을 두 번 읽게 된다. 상태(toasts)는 센터가 읽는다. */}
    </div>
  );
}

const el = document.getElementById("root");
if (el) {
  const { createRoot } = await import("react-dom/client");
  createRoot(el).render(<App />);
}
