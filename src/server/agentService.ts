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
 * 특히 **deliberately 하지 않은 것** (2026-10-04 변경: 사용자 명시로 기본 ON):
 *  - thinking 기본 ON. 예산 폭주 우려는 `maxReasoningTokens` 상한+강제 전환이
 *    그대로 받는다. 표시(UI)는 항상 Thinking 으로 고정(체크박스·선택기 삭제).
 *  - 도구 승인 게이트를 우회하지 않는다. 위험한 도구는 `approval` 모듈이 막는다.
 */

import { AgentLoop } from "../agent/loop.js";
import type { ApprovalGate } from "./approval.js";
import { OpenAICompatibleClient } from "../backend/openaiClient.js";
import type { ChatMessage, ModelBackend } from "../backend/types.js";
import type { CompactionThresholds } from "../compaction/compactor.js";
import type { CompactionDetail } from "../compaction/compactor.js";
import { estimateTextTokens } from "../shared/textTokens.js";
import { estimateTokens } from "../compaction/compactor.js";
import { DEFAULT_MAX_REASONING, clampReasoningBudget, MIN_REASONING_FLOOR, MAX_REASONING_CEILING } from "../shared/reasoning.js";
import { activeToolDefs } from "../tools/index.js";
import { applyEvent, normalizeTool, type AgentBlock } from "../session/blocks.js";
import { resumeInfo, type ResumeInfo } from "../compaction/checkpoint.js";

/**
 * 압축 임계값의 기본값.
 *
 * §2.5 표의 기본 컨텍스트(32k)·트리거 비율(60%)을 쓴다. **하드코딩이 아니라 상수다** —
 * 이 값을 손대려면 §2.5 를 함께 고쳐야 하니까 한 곳에 둔다.
 */
export const DEFAULT_THRESHOLDS: CompactionThresholds = { autoTriggerRatio: 0.6, contextWindowTokens: 32_768 };

/** thresholds 옵션이 값이면 그대로, 팩토리면 호출 시점에 푼다. */
export function resolveThresholds(
  t: CompactionThresholds | (() => CompactionThresholds) | undefined
): CompactionThresholds {
  if (typeof t === "function") return t();
  return t ?? DEFAULT_THRESHOLDS;
}

export interface AgentEvent {
  type: "agent.delta" | "agent.reasoning" | "agent.done" | "agent.error" | "agent.tool" | "agent.status" | "agent.queue" | "agent.compaction" | "agent.thinking" | "agent.tool.draft";
  /** `agent.reasoning` 은 사고 델타, `agent.delta` 는 답변 델타다. */
  text?: string;
  tool?: { name: string; args?: string; done?: boolean; ok?: boolean; /** edit/write/append 결과 diff (성공 시만). 같은 블록에서 보여준다. */ diff?: string; /** 호출·완료를 묶는 id — 같으면 시간 창과 무관하게 합친다. */ callId?: string };
  /** `agent.tool.draft` — 파일 생성 중 인자 조각(실시간 초안). 블록이 아니라 화면의 별도 줄이다. */
  draft?: { index: number; name: string; args: string };
  /** `agent.queue` 의 대기 목록. `agent.done` 에는 남은 개수. */
  thinking?: { enabled: boolean; forcedToolChoice: boolean };
  queue?: string[] | number;
  /** `agent.compaction` 의 단계와 상세 (시작·진행·완료·실패). */
  compaction?: {
    phase: "running" | "complete" | "failed";
    droppedCount?: number;
    droppedTokens?: number;
    keptCount?: number;
    keptTokens?: number;
    summary?: string;
    droppedPreview?: string[];
  };
  at?: number;
}

/** 대기열 상한 — 무한히 쌓으면 서버가 turnRunning 을 영영 못 끈다. */
export const MAX_QUEUE = 20;

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
  /**
   * 사고 토큰 상한 — **설정(`agent.maxReasoningTokens`) 을 실제로 따른다.**
   *
   * 왜 이 옵션이 없었나: 스키마에는 `사고 토큰 상한` 이 사용자에게 노출되어 있고
   * `label`·`type:number`·`min`·`max` 까지 붙어 있었다. 그런데 **아무것도 읽지 않았다.**
   * 서버는 항상 `DEFAULT_MAX_REASONING`(4,096) 을 썼다. 더 나쁜 것은, 예산 초과 로그가
   * 사용자에게 "설정의 사고 토큰 상한 을 올리십시오" 라고 안내한 것이었다 —
   * **존재하지 않는 손잡이를 가리키는 안내**였다(설정에 적어도 아무 반응이 없었다).
   *
   * 범위는 여기서 한 번만 좁힌다 — 정본(`shared/reasoning.ts`)의 floor/ceiling 이
   * 규칙이다. 값을 세 군데에서 각각 좁히면 셋이 어긋난다.
   */
  maxReasoningTokens?: number;
  /**
   * Compaction thresholds, or a factory returning them.
   *
   * A factory (rather than a snapshot) because the calibrated context size is
   * only known AFTER bootstrap, while this service is constructed BEFORE it —
   * the same reason `baseUrl`/`model` above are already factories. The loop is
   * created lazily per turn (ensureLoop), so by the time thresholds are read
   * the calibration has landed. server/index.ts passes
   * `recommendThresholds(boot?.tuning?.contextSize ?? fallback)` here.
   */
  thresholds?: CompactionThresholds | (() => CompactionThresholds);
  logger?: (line: string) => void;
  /** 턴이 끝났을 때(성공/실패/취소 무관) — 세션 저장 훅이 이걸 듣는다(§5.10). */
  onTurnEnd?: (s: TurnState) => void;
  now?: () => number;
  /** 승인 게이트 — 파괴적 도구 호출을 통과시킨다(테스트용이면 null/미설정). */
  approvalGate?: ApprovalGate | null;
}

/** §5.3 Think — 서버가 강제하는 기본 정책. 웹의 상태 머신과 **값이 달라지면 안 된다.** */
export interface ThinkPolicy {
  enabled: boolean;
  maxReasoningTokens: number;
}

// 정본은 `src/shared/reasoning.ts` — 여기서 숫자를 다시 적지 않는다.
// 예전엔 이 한 줄과 `think.ts`·`schema.ts` 에 1024 가 각자 적혀 있었다(3벌).
// 주석이 "값이 달라지면 안 된다" 고 말하면서 정본을 세 개 둔 셈이다.
export const DEFAULT_THINK: ThinkPolicy = { enabled: true, maxReasoningTokens: DEFAULT_MAX_REASONING };

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
  /** 채택한 서버를 쓰고 있는가 — **교체 대상이 아니다**(사용자의 것이라 §6.2). */
  private adoptedServer = false;
  private think: ThinkPolicy = { ...DEFAULT_THINK };
  /** 마지막 실측 컨텍스트 — 턴 중 `onContextUsage` 로 갱신, 유휴 시는 부팅 시 1회 계산. */
  private lastUsage: { usedTokens: number; totalTokens: number } | null = null;
  /** 실행 중 들어온 입력 — 순차 처리한다(거절하지 않는다, O4). */
  private queue: string[] = [];
  /** estimateTokens 에 쓰는 백엔드 (ensureLoop 이 만든 것과 같은 인스턴스). */
  private backend: ModelBackend | null = null;

  constructor(private opts: AgentServiceOptions) {
    // 명시 옵션이 있으면 기본값보다 우선한다 (테스트·임베딩용).
    if (typeof opts.enableThinking === "boolean") this.think.enabled = opts.enableThinking;
    // **설정의 상한을 따른다** — 범위 좁히기는 여기서 **한 번만** 한다.
    if (typeof opts.maxReasoningTokens === "number") {
      const n = clampReasoningBudget(opts.maxReasoningTokens);
      if (n !== this.think.maxReasoningTokens) {
        this.think = { ...this.think, maxReasoningTokens: n };
      }
    }
  }

  /** 게이트 설정 — HTTP/WS 가 준비된 후 부른다. */
  setApprovalGate(gate?: ApprovalGate | null): void {
    this.opts.approvalGate = gate;
    // 루프가 아직 안 만들어졌거나, 만들어졌더라도 다음 턴에서 새로운 옵션을 본다.
    // `ensureLoop()`는 게이트가 있는 새 옵션으로 루프를 재만든다.
    this.invalidate();
  }

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
      // `args` 는 서버에서 **문자열** 로 온다(OpenAI 규격). `normalizeTool` 이
      // 객체로 편다 — 여기서 손대지 않으면 블록 타입이 두 모양을 다뤄야 하고,
      // 그 차이는 화면 쪽에서 버그로 나타난다.
      tool: normalizeTool(e.tool),
      at: e.at,
    });
    this.opts.emit(e);
  }

  /** 지금까지의 대화 블록(저장·복원용). */
  get conversation(): AgentBlock[] {
    return this.blocks;
  }

  /**
   * llama-server 를 **새 모델로** 다시 띄운다(§7.1 교체 → 재기동).
   *
   * 순서를 지킨다: **이전 자식만** 확실히 죽이고 → 새 자식 → 헬스체크.
   * 채택한 서버는 건드리지 않는다(사용자의 것 — §6.2). 그 경로에서 "교체" 라는 말 자체가
   * 틀리기 때문에, 이 메서드는 spawn 한 자식이 있을 때만 동작한다.
   *
   * 되돌리기는 **호출자가** 한다. 여기서는 사실만 말한다(교체했는지, 새 모델이 응답하는지) —
   * 롤백 판단을 여기서 하면 두 곳에서 판단하게 된다.
   */
  async swapModel(opts: { modelPath: string; stopChild: () => Promise<void>; spawn: () => Promise<boolean> }): Promise<{ ok: boolean; step: string; reason: string; responseOk: boolean }> {
    if (this.adopted) {
      // adopt 된 서버를 죽이고 재기동하면 **사용자의 서버를 죽인다.** 그래서 막는다.
      return {
        ok: false,
        step: "check",
        reason: "이미 떠 있는 서버를 채택한 상태입니다 — 그 서버는 사용자의 것이라 교체하지 않았습니다. 서버를 직접 내린 뒤 다시 실행하십시오.",
        responseOk: false,
      };
    }
    try {
      await opts.stopChild();
    } catch (e) {
      return { ok: false, step: "stop-llama", reason: `이전 llama 종료 실패: ${msgOf(e)}`, responseOk: false };
    }
    let ready: boolean;
    try {
      ready = await opts.spawn();
    } catch (e) {
      return { ok: false, step: "restart", reason: `재기동 실패: ${msgOf(e)}`, responseOk: false };
    }
    // §5.13.1: **"설치 성공 = 성공" 은 함정이다.** 새 모델이 실제로 응답해야 성공이다.
    return {
      ok: ready,
      step: "verify",
      reason: ready
        ? "새 모델이 응답합니다(/v1/models 200)"
        : "교체는 끝났지만 새 모델이 응답하지 않습니다 — '성공' 으로 세지 않습니다",
      responseOk: ready,
    };
  }

  /**
   * 지금 **재개할 수 있는가**.
   *
   * 재개는 다음 턴에서 자동으로 일어난다. 사용자 입장에서 보면 아무 일도 없다 —
   * 그래서 화면이 묻는다. "없음" 과 "있지만 아직 안 보임" 을 구분해서 돌려준다.
   */
  async resumeInfo(): Promise<ResumeInfo> {
    return resumeInfo(this.opts.baseDir());
  }

  /** 채택한 서버를 쓰고 있는가. */
  get adopted(): boolean {
    return this.adoptedServer;
  }

  setAdopted(on: boolean): void {
    this.adoptedServer = on;
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
    this.backend = backend;
    const loop = new AgentLoop({
      // `baseDir()` 를 **호출 시점에** 읽는다 — 전환된 뒤의 값을 본다.
      projectRoot: this.opts.baseDir(),
      model: this.modelName,
      backend,
      // 프롬프트도 **호출 시점**의 값을 쓴다. 규칙 파일 전환이 반영되려면
      // 상수를 캡처해서는 안 된다.
      systemPrompt: typeof this.opts.systemPrompt === "function" ? this.opts.systemPrompt() : this.opts.systemPrompt,
      thresholds: resolveThresholds(this.opts.thresholds),
      // 기본 ON(사용자 명시). 예산 폭주는 상한+강제 전환이 받는다.
      enableThinking: this.think.enabled,
      now,
      onTurnStart: () => {
        this.state = { ...this.state, running: true, startedAt: now(), cancelled: false, lastError: null };
        this.toolCalls = 0;
        this.reasoningTokens = 0;
        // **이 턴의 추론 예산을 알린다.**
        //
        // 웹은 상한을 **자기 기본값(4,096)** 으로 계산하고 있었다. 서버가 설정을 따라
        // 64 로 좁혔어도 웹은 4096 으로 쟀으므로, 서버가 조용히 도구 호출을 강제하는데
        // **화면에는 아무 설명이 없었다.** 규칙이 어긋나면 화면이 거짓말이 된다.
        //
        // 서버가 정본이다 — 매 턴 시작에 그 값을 알린다.
        //
        // `agent.thinking` 은 **선언만 있고 아무것도 publish 하지 않던** 타입이었다
        // (`agent.state` 도 마찬가지였다). 정본을 알릴 자리가 있는데 비어 있었다.
        this.emit({ type: "agent.thinking", ...this.thinking, at: now() });
        // 강제 OFF였으면 매 턴 시작에 ON 으로 되돌린다(Thinking 상시).
        // 예산을 넘기면 그 턴 안에서 다시 꺼진다 — 매 턴 예산이 리셋되는 셈이다.
        // invalidate 로 다음 턴의 루프가 새 값을 보게 한다(실행 중인 루프는 로컬 참조로 돈다).
        const wasForced = this.forcedToolChoice;
        this.forcedToolChoice = false;
        this.hiddenReasoningNotified = false;
        if (wasForced && !this.think.enabled) {
          this.think = { ...this.think, enabled: true };
          this.invalidate();
        }
        this.emit({ type: "agent.status", text: "모델이 응답 중입니다", at: now() });
      },
      onReasoningDelta: (text) => {
        // **언어별 추정**을 쓴다 — 예전 `길이 / 3.4` 은 영문 기준이라 한글 사고의
        // 실제 토큰을 절반밖에 못 세었다. 웹(`think.ts`)과 **같은 함수**를 쓴다.
        this.reasoningTokens += estimateTextTokens(text);
        if (!this.think.enabled) {
          // **숨겨도 예산은 이미 소비됐다.** 모델 쪽에서 이미 토큰을 썼으므로
          // "안 켜서 안 씁니다" 라고 말하면 그 사실이 사라진다. 한 번만 알린다.
          if (!this.hiddenReasoningNotified) {
            this.hiddenReasoningNotified = true;
            this.emit({
              type: "agent.status",
              // **조치 방법까지 말한다.** 예전 문구는 "꺼져 있습니다" 라고만 해서
              // 사용자가 무엇을 해야 하는지 알 수 없었다(실측 질문).
              text:
                `사고 상한(${this.think.maxReasoningTokens.toLocaleString("ko-KR")} 토큰)을 넘어 thinking 표시를 껐습니다 ` +
                `— 모델이 이미 쓴 예산이라 되돌릴 수 없습니다. 다음 턴부터 다시 켜집니다. ` +
                // **존재하지 않는 손잡이를 가리키지 않는다.**
                //
                // 예전엔 "설정의 사고 토큰 상한 을 올리십시오" 라고 적었는데, 그 설정은
                // **아무것도 읽지 않았다**(스키마에만 있고 배선이 없었다). 사용자는 지시를
                // 따라도 아무 반응이 없는 화면을 마주했다.
                //
                // 이제는 실제로 읽는다 — 그래서 **어디를 고쳐야 하는지**를 경로로 말한다.
                // 웹 화면에 숫자 입력란은 없다(없다고 말하는 게 낫다). 이 파일을 고치면 된다.
                `더 오래 보고 싶으면 프로젝트의 .harnesside/config.yaml 의 agent.maxReasoningTokens 를 올리십시오 (지금 ${this.think.maxReasoningTokens.toLocaleString("ko-KR")}, 허용 ${MIN_REASONING_FLOOR}~${MAX_REASONING_CEILING.toLocaleString("ko-KR")}).`,
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
          // 대화에 상태 줄을 남기지 않는다(사용자 지정: thinking 은 기본 ON 이라 이 안내는 소음).
          // 강제 도구 호출 자체는 그대로 동작한다.
          this.opts.logger?.(
            `[think] 사고 토큰이 상한(${this.think.maxReasoningTokens})을 넘어 thinking 을 끄고 도구 호출을 강제합니다 ` +
              `(추정치 ${this.reasoningTokens} — estimateTextTokens 기준, 실제 토큰 카운터가 아니다)`,
          );
        }
        this.emit({ type: "agent.reasoning", text, at: now() });
      },
      onAssistantDelta: (text) => this.emit({ type: "agent.delta", text, at: now() }),
      onToolArgsDelta: (d) => this.emit({ type: "agent.tool.draft", draft: d, at: now() }),
      onAssistantDone: () => undefined,
      onToolCall: (name, args, callId) => {
        this.toolCalls++;
        this.emit({ type: "agent.tool", tool: { name, args, done: false, callId }, at: now() });
      },
      onToolCallDone: (name, args, diff, callId) => this.emit({ type: "agent.tool", tool: { name, args, done: true, diff, callId }, at: now() }),
      onToolResult: (command, output) => this.opts.logger?.(`[tool] ${command}: ${output.slice(0, 200)}`),
      onDiff: (path, diff) => {
        this.opts.diff?.(path, diff);
        this.emit({ type: "agent.status", text: `${path} 변경됨`, at: now() });
      },
      onStatus: (status) => this.emit({ type: "agent.status", text: status, at: now() }),
      onPlanProgress: (done, total) => this.emit({ type: "agent.status", text: `계획 ${done}/${total}`, at: now() }),
      onCompactionStatus: (s) => {
        // 시작·진행을 전용 이벤트로도 흘린다 — 상태 줄 텍스트만으로는
        // "지금 압축 중인가 끝났나" 를 화면이 알 수 없다.
        this.emit({ type: "agent.compaction", compaction: { phase: s }, at: now() });
        this.emit({ type: "agent.status", text: `압축 ${s}`, at: now() });
      },
      onCompactionDetail: (d: CompactionDetail) => {
        // 요약 본문까지 보여준다 — "무엇이 잊혀지고 무엇이 강조됐는지" 가 없으면
        // 압축은 블랙박스다. 요약 자체가 대화에 남으므로 길이는 자르지 않고 접는다.
        this.emit({
          type: "agent.compaction",
          compaction: {
            phase: "complete",
            droppedCount: d.droppedCount,
            droppedTokens: d.droppedTokens,
            keptCount: d.keptCount,
            keptTokens: d.keptTokens,
            summary: d.summary,
            droppedPreview: d.droppedPreview,
          },
          at: now(),
        });
      },
      onContextUsage: (used, total) => {
        // 실측값만 들고 있는다 — 하단 상태바(1Hz 계측기 + AgentPanel)가 읽는다.
        // 예전엔 텍스트 상태 줄(`컨텍스트 N/M`)도 함께 내보냈는데, 출력마다
        // `· 컨텍스트 …` 가 붙어 상태바와 중복이었다(실측 지적). 말하지 않는다.
        this.lastUsage = { usedTokens: used, totalTokens: total };
      },
      approvalGate: this.opts.approvalGate ?? undefined,
    });
    this.loop = loop;
    return loop;
  }

  /** 루프를 **버린다** — 워크스페이스 전환 후 이전 루프가 옛 기준 디렉터리를 들고 있으므로. */
  invalidate(): void {
    this.loop = null;
  }

  /**
   * 마지막 실측 컨텍스트. 턴 중에는 `onContextUsage` 가 갱신하고,
   * 유휴 시에는 부팅 시 `refreshContext()` 가 1회 계산한다.
   * 둘 다 없으면 null — "모름" 을 0 으로 말하지 않는다.
   */
  contextUsage(): { usedTokens: number; totalTokens: number } | null {
    return this.lastUsage;
  }

  /**
   * 유휴 시 1회 계산 — 복원된 대화가 있으면 그 토큰 수를 잰다.
   * live 턴과 같은 추정(`estimateTokens` + 도구 스키마)을 써서 기준이 갈리지 않는다.
   * 백엔드가 없어도 글자 기반 근사로 답한다(모른다고 비워두지 않는다).
   */
  async refreshContext(): Promise<void> {
    try {
      const loop = this.ensureLoop();
      const msgs = (loop as unknown as { messages?: ChatMessage[] }).messages;
      if (!msgs || msgs.length <= 1) return;
      const backend = this.backend;
      const tools = activeToolDefs();
      const used = await estimateTokens(msgs, backend ?? undefined, JSON.stringify(tools), tools);
      const total = resolveThresholds(this.opts.thresholds).contextWindowTokens;
      this.lastUsage = { usedTokens: used, totalTokens: total };
    } catch {
      // 계산 실패는 조용히 둔다 — 다음 턴의 실측이 덮는다. 빈 화면보다 낫지 않으므로
      // 실패를 배너로 띄우지 않는다.
    }
  }

  /** 대기열 보기 (읽기 전용 복사). */
  queueView(): string[] {
    return this.queue.slice();
  }

  private emitQueue(): void {
    this.emit({ type: "agent.queue", queue: this.queue.slice(), at: (this.opts.now ?? Date.now)() });
  }

  /**
   * 대기열을 비운다 (실행 중인 턴은 건드리지 않는다).
   * 취소와 분리한 이유: "지금 것만 멈추고 다음은 이어간다" 가 있어야 한다.
   */
  clearQueue(): { cleared: number } {
    const n = this.queue.length;
    this.queue = [];
    if (n > 0) this.emitQueue();
    return { cleared: n };
  }

  /**
   * 대기열 순서 변경 — "급한 것을 먼저" (사용자 요구).
   * 실행 중인 턴은 건드리지 않고 대기 중인 것만 재배열한다.
   * 범위를 벗어나면 false (400 으로 알린다).
   */
  moveQueue(from: number, to: number): boolean {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length) return false;
    if (from === to) return true;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item!);
    this.emitQueue();
    return true;
  }

  /**
   * 턴을 시작한다. **중복으로 겹치지 않는다** — 겹치면 두 턴이 같은 대화 기록을
   * 고치므로 메시지가 뒤섞인다(사용자가 보기에 "모델이 두 개" 처럼 보인다).
   *
   * 실행 중에 들어온 입력은 **거절하지 않고 대기열에** 넣는다(O4).
   * 대기열은 이 턴이 끝나면 순서대로 돈다. 항목 사이에는 await 이 없으므로
   * 다른 send 가 끼어들 수 없다(직렬 보장).
   */
  async send(text: string): Promise<{ ok: boolean; detail: string; queued?: boolean }> {
    const body = text.trim();
    if (!body) return { ok: false, detail: "보낼 문장이 없습니다" };
    if (this.state.running) {
      if (this.queue.length >= MAX_QUEUE) {
        return { ok: false, detail: `대기열이 찼습니다(${MAX_QUEUE}개) — 끝난 뒤 보내십시오` };
      }
      this.queue.push(body);
      this.emitQueue();
      return { ok: true, detail: `대기열 ${this.queue.length}번째에 넣었습니다 — 지금 턴이 끝나면 돕니다`, queued: true };
    }
    const r = await this.runOne(body);
    // 대기열 비우기 — 항목 사이 await 없음 (직렬 보장, 위 주석).
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.emitQueue();
      await this.runOne(next);
    }
    return r;
  }

  private async runOne(body: string): Promise<{ ok: boolean; detail: string }> {
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
        queue: this.queue.length,
        at: (this.opts.now ?? Date.now)(),
      });
      return { ok: true, detail: cancelled ? "취소됨" : "완료" };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.state = { ...this.state, lastError: detail };
      this.emit({ type: "agent.error", text: detail, queue: this.queue.length, at: (this.opts.now ?? Date.now)() });
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
    // 취소는 전부 멈춤이다 — 대기열까지 비운다. "다음 것만" 이어가려면
    // 취소 대신 끝까지 두면 된다. 비운 개수를 말하지 않으면 조용히 사라진다.
    const dropped = this.queue.length;
    this.queue = [];
    if (dropped > 0) this.emitQueue();
    await this.loop?.cancelCurrentTurn();
    this.emit({ type: "agent.status", text: "취소 요청됨", at: (this.opts.now ?? Date.now)() });
    return { ok: true, detail: dropped > 0 ? `취소했습니다 (대기열 ${dropped}개도 비웠습니다)` : "취소했습니다" };
  }

  // ── 슬래시 명령용 경로 (사용자 요구: 웹 프롬프트에서도 콘솔의 쉘 기능) ────────
  //
  // 구 Ink TUI(2026-10-04 삭제, Q-2)는 이 작업을 `AgentLoop` 에 **직접** 있었다.
  // 웹 창에는 루프가 없고 라우트만 있다 — 그래서 라우트가 부를 수 있는 **이름 있는 진입점** 이
  // 필요하다. 여기서 루프를 **처음부터** 만들면 안 된다: 턴이 아직 없는 세션에서
  // `/compact` 를 눌렀다고 백엔드가 붙는 것은 부수효과다. 그래서 루프가 이미 있을
  // 때만 되고, 없으면 **그 사실**을 말한다(조용히 성공시키지 않는다).

  /** `/compact` — 지금 컨텍스트를 압축한다. 루프가 없으면 왜 못 했는지 말한다. */
  async forceCompact(): Promise<{ ok: boolean; detail: string }> {
    const loop = this.loop;
    if (!loop) return { ok: false, detail: "아직 대화가 없어 압축할 것이 없습니다" };
    await loop.forceCompact();
    return { ok: true, detail: "압축을 실행했습니다" };
  }

  /**
   * `/improve` — 반복 실패를 분석해 룰 제안을 만든다. **아무것도 쓰지 않는다.**
   * 저장은 `/improve-apply` 만 한다(사용자가 확인하기 전엔 디스크를 못 건드린다).
   */
  async proposeImprovement(): Promise<{ ok: boolean; detail: string; proposal: { summary: string; ruleMarkdown: string } | null }> {
    const loop = this.loop;
    if (!loop) return { ok: false, detail: "아직 대화가 없어 분석할 실패 기록이 없습니다", proposal: null };
    const proposal = await loop.proposeSelfImprovement();
    return proposal
      ? { ok: true, detail: proposal.summary, proposal: { summary: proposal.summary, ruleMarkdown: proposal.ruleMarkdown } }
      : { ok: true, detail: "반복된 실패 패턴이 없습니다. 제안할 것이 없습니다", proposal: null };
  }

  /** `/improve-apply` — 마지막 제안을 룰 파일로 저장한다. 경로를 돌려준다. */
  async applyImprovement(): Promise<{ ok: boolean; detail: string; path: string | null }> {
    const loop = this.loop;
    if (!loop) return { ok: false, detail: "저장할 제안이 없습니다. 먼저 /improve 를 실행하십시오", path: null };
    const path = await loop.applyPendingImprovement();
    return path
      ? { ok: true, detail: `${path} 에 저장했습니다 (다음 세션부터 시스템 프롬프트에 반영)`, path }
      : { ok: false, detail: "저장할 제안이 없습니다. 먼저 /improve 를 실행하십시오", path: null };
  }

  /** `/plan-clear` — 멈춘 계획 표시와 체크포인트를 지운다. */
  async clearPlan(): Promise<{ ok: boolean; detail: string }> {
    const loop = this.loop;
    if (!loop) return { ok: false, detail: "대화가 없어 지울 계획도 없습니다" };
    await loop.clearPlan();
    return { ok: true, detail: "계획 표시를 초기화했습니다" };
  }

  /** 현재 루프를 **만들지 않고** 본다 — 위 진입점들이 "없다" 고 말할 근거. */
  get hasConversation(): boolean {
    return this.loop !== null;
  }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
