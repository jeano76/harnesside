/**
 * 세션 이어받기 배선 (§5.10) — `SessionStore` 를 **실제로** 쓰게 한다.
 *
 * `store.ts` 는 완성되어 있고 테스트도 통과하는데, 호출하는 곳이 없었다. 그래서
 * 창을 닫으면 대화가 사라졌다(§5.10 의 존재 이유가 그대로 무력화).
 *
 * 이 파일이 지키는 것 — 세 가지 구분:
 *  1. **WS 재연결 ≠ 새로고침.** 재연결은 메모리를 유지한다(디스크에서 다시 읽으면
 *     스트리밍 중 화면이 통째로 바뀐다). 이 구분을 `planRestore` 가 만들고,
 *     여기는 **출처를 정확히 판정**한다.
 *  2. **저장은 디바운스된다.** 스트리밍 중 매 델타마다 쓰면 디스크 I/O 가 스트리밍을
 *     끊는다. 그래서 턴이 끝나고(그리고 주기적으로) 한 번만 예약한다.
 *  3. **저장 실패는 조용히 삼키지 않는다.** 복구할 수 없는 상태를 "저장됐다" 고 말하면
 *     사용자는 창을 닫고 돌아왔을 때만 알게 된다 — 가장 나쁜 순간에.
 */

import { SessionStore, planRestore, sessionId, type SessionDoc, type PersistedBlock, type RestoreSource } from "./store.js";
import type { AgentBlock } from "./blocks.js";

/** 주기적 저장 간격(초). 스트리밍이 오래 이어질 때 마지막 상태를 잃지 않기 위한 안전망. */
export const PERIODIC_SAVE_SEC = 30;

/**
 * 도구 인자 JSON 상한. 넘기면 **빼고 사유를 남긴다** — 잘라 붙이면 경로·명령이
 * 깨져 엉뚱한 파일을 가리킨다(§7.1: 추측 금지). 보통 인자는 수백 바이트다.
 */
export const MAX_TOOL_ARGS_JSON = 8192;

/** 화면 도구 호출 → 저장 형식. JSON에 못 담는 인자는 버리고 말한다. */
export function packTool(tool: { name: string; done?: boolean; args?: unknown }): NonNullable<PersistedBlock["tool"]> {
  const out: NonNullable<PersistedBlock["tool"]> = { name: tool.name };
  if (typeof tool.done === "boolean") out.done = tool.done;
  if (tool.args === undefined) return out;
  let json = "";
  try {
    json = JSON.stringify(tool.args) ?? "";
  } catch {
    out.argsNote = "인자가 JSON으로 바꿀 수 없어 저장하지 않았습니다";
    return out;
  }
  if (json.length > MAX_TOOL_ARGS_JSON) {
    out.argsNote = `인자 ${json.length.toLocaleString("ko-KR")}자가 상한(${MAX_TOOL_ARGS_JSON.toLocaleString("ko-KR")}자)을 넘어 저장하지 않았습니다`;
    return out;
  }
  out.args = tool.args;
  return out;
}

export interface SessionBridgeOptions {
  stateDir: string;
  /** 워크스페이스별 분류용 루트(전환되면 바뀐다). */
  workspace: () => string;
  /** 복원 결과를 알린다 — UI 가 이걸로 화면을 교체할지 붙일지 정한다. */
  onRestore?: (plan: ReturnType<typeof planRestore>) => void;
  onSaved?: (doc: SessionDoc, path: string) => void;
  onError?: (message: string) => void;
  debounceMs?: number;
  now?: () => number;
}

export class SessionBridge {
  private store: SessionStore;
  private current: SessionDoc | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastSaveError: string | null = null;
  /** 이번 실행에서 저장한 적 있는가 — "복구할 것이 없습니다" 와 구분한다. */
  private everSaved = false;

  constructor(private opts: SessionBridgeOptions) {
    this.store = new SessionStore(opts.stateDir, opts.debounceMs);
  }

  get doc(): SessionDoc | null {
    return this.current;
  }

  get pending(): number {
    return this.store.pending;
  }

  get lastError(): string | null {
    return this.lastSaveError;
  }

  /** 이 워크스페이스에 해당하는 세션을 **새로 만든다**(id 는 사람이 읽을 수 있게). */
  start(): SessionDoc {
    const now = (this.opts.now ?? Date.now)();
    this.current = {
      id: sessionId(this.opts.workspace(), now),
      workspace: this.opts.workspace(),
      name: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
      blocks: [],
      plan: null,
      compactions: [],
      abortedTurn: null,
      spilled: [],
      bytes: 0,
      version: 1,
    };
    return this.current;
  }

  /**
   * 복원을 **판정**한다. `source` 가 틀리면 UI 가 잘못된 결정을 내린다 —
   * 그래서 판정 표를 코드에 한 번만 쓴다(`planRestore`).
   */
  restore(source: RestoreSource, inMemoryBlocks = 0): ReturnType<typeof planRestore> {
    const plan = planRestore(source, source === "reconnect" ? null : this.current, inMemoryBlocks);
    this.opts.onRestore?.(plan);
    return plan;
  }

  /**
   * 화면 블록을 세션 문서에 **반영**하고 저장을 예약한다.
   *
   * `streaming` 을 받는 이유: 스트리밍 중 블록은 계속 늘어난다. 그때마다 저장하면
   * 디스크 I/O 가 스트리밍을 끊고, 안 하면 종료 시 마지막 몇 초가 사라진다. 그래서
   * **디바운스**로 합친다(저장 자체는 블록 수가 0 이 아닐 때만 예약한다).
   */
  capture(blocks: AgentBlock[], opts: { streaming?: boolean } = {}): void {
    if (!this.current) this.start();
    const doc = this.current!;
    doc.blocks = blocks.map<PersistedBlock>((b) => ({
      id: b.id,
      kind: b.kind,
      title: b.kind === "tool" ? (b.tool?.name ?? "도구") : b.kind === "reasoning" ? "사고" : b.kind === "text" ? "답변" : b.kind,
      status: b.tool?.done ? "done" : b.kind === "error" ? "error" : "open",
      version: 1,
      createdAt: b.at,
      updatedAt: b.at,
      collapsed: b.kind === "reasoning",
      // 사고 전체를 저장하지 않는다 — 화면에서 접혀 있고, 예산 낭비다.
      content: b.kind === "reasoning" ? `${b.text.length.toLocaleString("ko-KR")}자` : b.text,
      // 도구 호출을 버리지 않는다 — 인자·완료 표시가 없으면 복원 블록이
      // 라이브 블록과 다른 모양이 된다(2026-10-12 실측: content:"run_shell"만 남음).
      tool: b.kind === "tool" && b.tool ? packTool(b.tool) : undefined,
    }));
    if (blocks.length === 0) return;
    this.store.schedule(doc);
    this.ensurePeriodic();
    void opts.streaming;
  }

  /**
   * 워크스페이스가 전환됐다 — 진행 중 세션의 분류 루트를 **새 루트로 옮긴다.**
   * `start()` 에서만 기록하면 전환 뒤에도 옛 루트로 남아, 새 루트에서
   * `list()`/`latest()` 가 이 세션을 찾지 못한다(2026-10-15 실측).
   */
  rebindWorkspace(): void {
    const doc = this.current;
    if (!doc) return;
    const root = this.opts.workspace();
    if (doc.workspace === root) return;
    doc.workspace = root;
    this.store.schedule(doc);
  }

  /** 사용자가 보낸 메시지를 대화에 넣는다 — "내가 뭐라고 했나" 가 세션의 핵심이다. */
  noteUser(text: string): void {
    if (!this.current) this.start();
    this.current!.messages.push({ role: "user", text, at: (this.opts.now ?? Date.now)() });
    this.store.schedule(this.current!);
  }

  /** 주기적 안전망. 스트리밍이 끝나도 예약이 남지 않게 턴 종료 때 지운다. */
  private ensurePeriodic(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.saveNow();
    }, PERIODIC_SAVE_SEC * 1000);
    this.timer.unref?.();
  }

  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 즉시 저장 — 턴 종료·프로세스 종료 시점. */
  async saveNow(): Promise<{ ok: boolean; path?: string; detail: string }> {
    if (!this.current) return { ok: false, detail: "저장할 세션이 없습니다" };
    try {
      await this.store.flush(this.current.id);
      this.everSaved = true;
      this.lastSaveError = null;
      this.opts.onSaved?.(this.current, this.current.id);
      return { ok: true, path: this.current.id, detail: "저장했습니다" };
    } catch (e) {
      // **조용히 삼키지 않는다.** 복구 불가능한 순간에야 알게 되는 실패가 있다.
      const detail = e instanceof Error ? e.message : String(e);
      this.lastSaveError = detail;
      this.opts.onError?.(detail);
      return { ok: false, detail };
    }
  }

  /** 이번 실행에서 한 번이라도 저장했는가. "복구할 것이 없습니다" 와 구분한다. */
  get saved(): boolean {
    return this.everSaved;
  }

  /** 저장된 세션 목록 — 워크스페이스별로만(§5.10 의 분류). */
  list() {
    return this.store.list(this.current?.workspace ?? this.opts.workspace());
  }

  latest() {
    return this.store.latest(this.current?.workspace ?? this.opts.workspace());
  }
}
