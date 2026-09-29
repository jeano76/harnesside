/**
 * 서버 측 에이전트 (§5.3 Think · §5.4 블록 · §2.3 WS 스트리밍).
 *
 * 왜 이 파일이 필요한가: `AgentLoop` 과 도구 레지스트리는 있고 테스트도 통과했는데
 * **서버에서 아무것도 호출하지 않았다.** 그래서 입력창의 "보내기" 는 눌러도 아무 일도
 * 없었고(버튼조차 비활성), `reasoning_content` 를 화면에 보여줄 경로도 없었다.
 * 로직만 있고 실행되지 않는 것은 있는 기능이 아니다(§④ 의 ◐).
 *
 * 이 파일이 하는 일은 **하나** 다: 턴 하나를 받고, 델타를 WS 로 흘리고, 블록으로
 * 기록한다. 판단(압축·도구 선택·자기 보호)은 전부 이미 검증된 `AgentLoop` 안에 있다 —
 * 여기서 다시 판단하면 두 개의 진실원이 된다.
 *
 * 특히 **deliberately 하지 않은 것**:
 *  - thinking 을 켜지 않는다. 기본 OFF(§5.3). 실측: 예산을 전부 쓰고 tool_call 이
 *    하나도 안 나온다. 켜려면 설정에서 명시해야 한다.
 *  - 도구 승인 게이트를 우회하지 않는다. 위험한 도구는 `approval` 모듈이 막는다.
 */

import { AgentLoop } from "../agent/loop.js";
import { OpenAICompatibleClient } from "../backend/openaiClient.js";
import type { ModelBackend } from "../backend/types.js";
import type { CompactionThresholds } from "../compaction/compactor.js";
import { applyEvent, type AgentBlock } from "../session/blocks.js";

/**
 * 압축 임계값의 기본값.
 *
 * §2.5 표의 기본 컨텍스트(32k)·트리거 비율(60%)을 쓴다. **하드코딩이 아니라 상수다** —
 * 이 값을 손대려면 §2.5 를 함께 고쳐야 하니까 한 곳에 둔다.
 */
export const DEFAULT_THRESHOLDS: CompactionThresholds = { autoTriggerRatio: 0.6, contextWindowTokens: 32_768 };

export interface AgentEvent {
  type: "agent.delta" | "agent.reasoning" | "agent.done" | "agent.error" | "agent.tool" | "agent.status";
  /** `agent.reasoning` 은 사고 델타, `agent.delta` 는 답변 델타다. */
  text?: string;
  tool?: { name: string; args?: string; done?: boolean; ok?: boolean };
  at?: number;
}

/**
 * 턴 하나에 대한 진행 상태.
 *
 * `cancelled` 를 따로 들는 이유: 취소된 턴과 끝난 턴은 **사용자에게 다르게 보인다.**
 * "끝났다" 고만 말하면 모델이 멈춘 줄 알고, 아무 말도 안 하면 멈춘 줄도 모른다.
 */
export interface TurnState {
  running: boolean;
  startedAt: number | null;
  cancelled: boolean;
  lastError: string | null;
}

export interface AgentServiceOptions {
  /** 현재 워크스페이스 기준 디렉터리(전환되면 바뀐다 — 캡처하지 않는다). */
  baseDir: () => string;
  /** 모델 서버 주소(llama 포트 · adopt 여부에 따라 정해진다). */
  baseUrl: () => string;
  /**
   * 모델 이름. **함수로 넘길 수 있다** — llama 포트와 모델은 부팅 6·7단계 뒤에 정해지므로
   * 이 시점의 값은 아직 없다. 상수로 박으면 "모델 미연결" 상태로 굳는다.
   */
  model: string | (() => string);
  /**
   * 시스템 프롬프트. **함수로 넘겨라** — 상수로 넘기면 워크스페이스 전환 후에도
   * 옛 규칙이 프롬프트에 남는다(규칙이 적용됐다는 말과 실제가 어긋남).
   */
  systemPrompt: string | (() => string);
  /** WS 로 이벤트 보낸다. */
  emit: (e: AgentEvent) => void;
  /** diff 를 웹이 그릴 수 있는 형태로. */
  diff?: (path: string, diff: string) => void;
  /**
   * 모델 백엔드. **주입해야 한다** — 주입 경로가 없으면 이 서비스는 HTTP 가 붙은
   * 실제 서버 없이는 테스트할 수 없다. 실제로 그랬다: 테스트가 "fake backend" 를 넘겼는데
   * 이 클래스가 `new OpenAICompatibleClient()` 를 새로 만들어 **주입을 무시**했고,
   * 그 결과 모든 테스트가 "모델에 닿지 못함" 으로 조용히 실패했다(실측).
   * 주입이 조용히 무시되는 것은 없는 것보다 나쁘다 — 테스트가 통과한 것처럼 보인다.
   */
  backend?: ModelBackend | (() => ModelBackend);
  enableThinking?: boolean;
  thresholds?: CompactionThresholds;
  logger?: (line: string) => void;
  /** 턴이 끝났을 때(성공/실패/취소 무관) — 세션 저장 훅이 이걸 듣는다(§5.10). */
  onTurnEnd?: (s: TurnState) => void;
  now?: () => number;
}

/** §5.3 Think — 서버가 강제하는 기본 정책. 웹의 상태 머신과 **값이 달라지면 안 된다.** */
export interface ThinkPolicy {
  enabled: boolean;
  maxReasoningTokens: number;
}

export const DEFAULT_THINK: ThinkPolicy = { enabled: false, maxReasoningTokens: 1024 };

export class AgentService {
  private loop: AgentLoop | null = null;
  private state: TurnState = { running: false, startedAt: null, cancelled: false, lastError: null };
  /** 이번 턴의 도구 호출 수 — "도구가 안 불렸다" 를 사용자에게 말할 수 있어야 한다. */
  private toolCalls = 0;
  /** 이번 턴의 사고 토큰(휴리스틱). §5.3 의 상한 비교에 쓴다. */
  private reasoningTokens = 0;
  /** 상한을 넘으면 강제 전환(§5.3) — 그리고 그 사실을 사용자에게 **말한다**. */
  private forcedToolChoice = false;
  /** 표시가 꺼져 있는데 사고 델타가 왔음을 **한 번만** 알렸는가. */
  private hiddenReasoningNotified = false;
  /** 이 실행의 대화 블록(저장·복원의 원본). */
  private blocks: AgentBlock[] = [];
  private think: ThinkPolicy = { ...DEFAULT_THINK };

  constructor(private opts: AgentServiceOptions) {}

  get turn(): TurnState {
    return { ...this.state };
  }

  /**
   * 이벤트를 WS 로 보낸다. 한 곳에서만 부른다 — 경로가 둘이면 순서가 뒤집힌다.
   *
   * **여기서 블록도 함께 쌓는다.** 웹에도 블록이 생기지만(화면에 그려야 하니까),
   * 세션 저장은 **서버** 가 한다. 서버가 블록을 모으지 않으면 저장은 "빈 대화" 가 되고
   * 복원했을 때 사용자는 대화를 잃었다고 생각한다. 양쪽이 같은 규칙
   * (`session/blocks.ts`) 을 쓰므로 화면과 저장이 어긋나지 않는다.
   */
  private emit(e: AgentEvent): void {
    this.blocks = applyEvent(this.blocks, {
      type: e.type,
      text: e.text ?? (e.tool ? e.tool.name : undefined),
      tool: e.tool,
      at: e.at,
    });
    this.opts.emit(e);
  }

  /** 지금까지의 대화 블록(저장·복원용). */
  get conversation(): AgentBlock[] {
    return this.blocks;
  }

  /** 사용자 입력을 대화에 넣는다 — "내가 뭐라고 했나" 가 세션의 핵심이다. */
  addUserMessage(text: string): void {
    this.emit({ type: "agent.status", text: `전송: ${text.slice(0, 80)}`, at: (this.opts.now ?? Date.now)() });
  }

  get ready(): boolean {
    return !!this.modelName;
  }

  private get modelName(): string {
    return typeof this.opts.model === "function" ? this.opts.model() : this.opts.model;
  }

  /** §5.3 — thinking 을 **명시적으로** 켠다. 기본은 꺼짐(실측 근거는 think.ts). */
  setThinking(on: boolean): { enabled: boolean; maxReasoningTokens: number } {
    this.think = { ...this.think, enabled: on === true };
    // 값이 바뀌면 루프를 버린다 — 이전 설정으로 만들어진 루프가 남아 있으면
    // "켰는데 안 켜진 것처럼" 보인다(설정만 바뀌고 동작은 그대로).
    this.invalidate();
    return { ...this.think };
  }

  get thinking(): { enabled: boolean; maxReasoningTokens: number; forcedToolChoice: boolean; usedTokens: number } {
    return { ...this.think, forcedToolChoice: this.forcedToolChoice, usedTokens: this.reasoningTokens };
  }

  /**
   * 루프는 **매 턴 지연 생성**한다. 워크스페이스가 전환되면 기준 디렉터리가 바뀌므로,
   * 부팅 때 만들어 둔 루프는 옛 폴더를 계속 본다(조용히 엉뚱한 곳에 쓰는 경로).
   */
  private ensureLoop(): AgentLoop {
    const existing = this.loop;
    if (existing) return existing;
    const now = this.opts.now ?? Date.now;
    // 주입된 백엔드가 있으면 **그것을 쓴다.** 새로 만들면 테스트용 주입이 조용히
    // 무시된다(실제로 그렇게 모든 테스트가 가짜 백엔드를 못 썼다).
    const backend =
      typeof this.opts.backend === "function"
        ? this.opts.backend()
        : (this.opts.backend ?? new OpenAICompatibleClient(this.opts.baseUrl(), this.modelName));
    const loop = new AgentLoop({
      // `baseDir()` 를 **호출 시점에** 읽는다 — 전환된 뒤의 값을 본다.
      projectRoot: this.opts.baseDir(),
      model: this.modelName,
      backend,
      // 프롬프트도 **호출 시점**의 값을 쓴다. 규칙 파일 전환이 반영되려면
      // 상수를 캡처해서는 안 된다.
      systemPrompt: typeof this.opts.systemPrompt === "function" ? this.opts.systemPrompt() : this.opts.systemPrompt,
      thresholds: this.opts.thresholds ?? DEFAULT_THRESHOLDS,
      // §5.3: 기본 OFF. 실측 근거가 think.ts 주석에 있다.
      enableThinking: this.think.enabled,
      now,
      onTurnStart: () => {
        this.state = { ...this.state, running: true, startedAt: now(), cancelled: false, lastError: null };
        this.toolCalls = 0;
        this.reasoningTokens = 0;
        this.forcedToolChoice = false;
        this.hiddenReasoningNotified = false;
        this.emit({ type: "agent.status", text: "모델이 응답 중입니다", at: now() });
      },
      onReasoningDelta: (text) => {
        this.reasoningTokens += Math.max(1, Math.ceil(text.length / 3.4));
        if (!this.think.enabled) {
          // **숨겨도 예산은 이미 소비됐다.** 모델 쪽에서 이미 토큰을 썼으므로
          // "안 켜서 안 씁니다" 라고 말하면 그 사실이 사라진다. 한 번만 알린다.
          if (!this.hiddenReasoningNotified) {
            this.hiddenReasoningNotified = true;
            this.emit({
              type: "agent.status",
              text: `모델이 사고 델타를 보냈지만 표시가 꺼져 있습니다(예산은 이미 소비됨: ${this.reasoningTokens} 토큰).`,
              at: now(),
            });
          }
          return;
        }
        if (this.reasoningTokens > this.think.maxReasoningTokens && !this.forcedToolChoice) {
          // §5.3: 초과하면 thinking 을 끄고 도구 호출을 강제한다. **왜 바뀌었는지 말하지
          // 않으면** 사용자는 "도구가 왜 안 불리지?" 하고 기다린다(think.ts 와 같은 계층).
          this.forcedToolChoice = true;
          this.think = { ...this.think, enabled: false };
          this.invalidate();
          this.emit({
            type: "agent.status",
            text: `사고 토큰이 상한(${this.think.maxReasoningTokens.toLocaleString("ko-KR")})을 넘어 thinking 을 끄고 도구 호출을 강제합니다.`,
            at: now(),
          });
        }
        this.emit({ type: "agent.reasoning", text, at: now() });
      },
      onAssistantDelta: (text) => this.emit({ type: "agent.delta", text, at: now() }),
      onAssistantDone: () => undefined,
      onToolCall: (name, args) => {
        this.toolCalls++;
        this.emit({ type: "agent.tool", tool: { name, args, done: false }, at: now() });
      },
      onToolCallDone: (name, args) => this.emit({ type: "agent.tool", tool: { name, args, done: true }, at: now() }),
      onToolResult: (command, output) => this.opts.logger?.(`[tool] ${command}: ${output.slice(0, 200)}`),
      onDiff: (path, diff) => {
        this.opts.diff?.(path, diff);
        this.emit({ type: "agent.status", text: `${path} 변경됨`, at: now() });
      },
      onStatus: (status) => this.emit({ type: "agent.status", text: status, at: now() }),
      onPlanProgress: (done, total) => this.emit({ type: "agent.status", text: `계획 ${done}/${total}`, at: now() }),
      onCompactionStatus: (s) => this.emit({ type: "agent.status", text: `압축 ${s}`, at: now() }),
      onContextUsage: (used, total) => this.emit({ type: "agent.status", text: `컨텍스트 ${used}/${total}`, at: now() }),
    });
    this.loop = loop;
    return loop;
  }

  /** 루프를 **버린다** — 워크스페이스 전환 후 이전 루프가 옛 기준 디렉터리를 들고 있으므로. */
  invalidate(): void {
    this.loop = null;
  }

  /**
   * 턴을 시작한다. **중복으로 겹치지 않는다** — 겹치면 두 턴이 같은 대화 기록을
   * 고치므로 메시지가 뒤섞인다(사용자가 보기에 "모델이 두 개" 처럼 보인다).
   */
  async send(text: string): Promise<{ ok: boolean; detail: string }> {
    const body = text.trim();
    if (!body) return { ok: false, detail: "보낼 문장이 없습니다" };
    if (this.state.running) return { ok: false, detail: "이전 턴이 아직 진행 중입니다" };
    const now = (this.opts.now ?? Date.now)();
    this.state = { running: true, startedAt: now, cancelled: false, lastError: null };
    try {
      await this.ensureLoop().send(body);
      const cancelled = this.state.cancelled;
      this.emit({
        type: "agent.done",
        text: cancelled
          ? "취소되었습니다"
          : this.toolCalls === 0
            ? // 도구를 한 번도 안 불렀다 — 조용히 끝내면 "왜 파일을 안 고쳤지?" 가 된다.
              "답변만 왔고 도구 호출은 없었습니다"
            : `도구 ${this.toolCalls}회 사용`,
        at: (this.opts.now ?? Date.now)(),
      });
      return { ok: true, detail: cancelled ? "취소됨" : "완료" };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.state = { ...this.state, lastError: detail };
      this.emit({ type: "agent.error", text: detail, at: (this.opts.now ?? Date.now)() });
      return { ok: false, detail };
    } finally {
      this.state = { ...this.state, running: false, startedAt: null };
      this.opts.onTurnEnd?.(this.turn);
    }
  }

  /** M3 — 현재 턴을 취소한다. 상태를 **명시적으로** 남긴다(무음 종료 금지). */
  async cancel(): Promise<{ ok: boolean; detail: string }> {
    if (!this.state.running) return { ok: false, detail: "진행 중인 턴이 없습니다" };
    this.state = { ...this.state, cancelled: true };
    await this.loop?.cancelCurrentTurn();
    this.emit({ type: "agent.status", text: "취소 요청됨", at: (this.opts.now ?? Date.now)() });
    return { ok: true, detail: "취소했습니다" };
  }
}
