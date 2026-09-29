/**
 * 도구 실행 승인 게이트 (§3.6) — 웹에서 새로 생기는 요구.
 *
 * 왜 이것이 서버의 책임인가: 원본 CLI 는 헤드리스라 **모든 도구 호출이 곧 사용자 행위**로
 * 성립했다. 웹 IDE 는 사용자의 다른 작업 중에 떠 있으므로, 파괴적·부수효과 도구는
 * 기본적으로 확인을 거쳐야 한다. 그리고 그 확인을 **서버가 소유**해야 한다 —
 * 모델이 스스로 "승인했다"고 말할 수 있는 구조라면 승인 게이트가 장식이 된다.
 *
 * 원칙:
 *  - 무응답은 **거절**이다(승인보다 안전).
 *  - 승인 대기는 **에이전트를 블로킹**하되, UI 에는 "승인 대기 중" 으로 명시한다.
 *  - 창이 닫히면 대기는 **즉시 거절**로 바뀐다(데몬에서 무한 대기 = 좀비).
 *  - 화이트리스트는 **사용자가 명시적으로** 등록한 것만.
 */

export type RiskLevel = "auto" | "ask" | "deny";

export interface ToolRequest {
  tool: string;
  /** 사람이 읽을 요약(승인 화면에 그대로 보인다). */
  summary: string;
  args?: Record<string, unknown>;
  /** 도구별 위험 등급. 기본은 `ask` — 모르는 도구는 무조건 물어본다. */
  risk?: RiskLevel;
}

export interface ApprovalRequest extends ToolRequest {
  id: string;
  requestedAt: number;
  /** 창이 닫히면 이 시각에 자동 거절된다(좀비 방지). */
  expiresAt: number;
}

export type ApprovalDecision = "allow-once" | "allow-always" | "reject" | "timeout";

export interface ApprovalPolicy {
  /** 항상 허용할 도구/패턴(사용자 화이트리스트). */
  allowlist: string[];
  /** 절대 하지 않을 도구. 정책이 allowlist 보다 먼저다. */
  denylist: string[];
  /** 승인 대기 타임아웃(초). 기본 60초 — 무한 대기는 좀비다. */
  timeoutSec: number;
  /** 창이 닫혔을 때 대기 중인 요청을 거절할지(데몬에서는 필수). */
  rejectOnWindowClosed: boolean;
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  allowlist: ["read_file", "list_dir", "git_status", "git_diff", "note", "search_files", "load_skill"],
  denylist: [],
  timeoutSec: 60,
  rejectOnWindowClosed: true,
};

/** 위험 등급 기본값. 모르는 도구는 `ask` 다 — "모른다"는 이유로 자동 허용하면 안 된다. */
export function riskOf(tool: string, policy: ApprovalPolicy = DEFAULT_POLICY): RiskLevel {
  if (policy.denylist.includes(tool)) return "deny";
  if (policy.allowlist.includes(tool)) return "auto";
  return "ask";
}

export interface GateEvents {
  /** 화면에 노출할 승인 요청(모달). */
  onRequest?: (req: ApprovalRequest) => void;
  onDecision?: (req: ApprovalRequest, decision: ApprovalDecision, by?: string) => void;
}

export class ApprovalGate {
  private waiting = new Map<string, { resolve: (d: ApprovalDecision) => void; req: ApprovalRequest; timer: NodeJS.Timeout }>();
  private counter = 0;
  private policy: ApprovalPolicy;

  constructor(policy: Partial<ApprovalPolicy> = {}, private events: GateEvents = {}) {
    // **배열은 반드시 복사한다.** `{ ...DEFAULT_POLICY }` 같은 얕은 복사를 하면
    // allowlist/denylist 가 **기본값과 공유**된다. 한 세션에서 "항상 허용" 한 번이
    // 다른 모든 세션(과 다음 실행)의 기본값까지 조용히 바꿔 버린다 — 승인 게이트가
    // 세션을 넘어 남는, 가장 위험한 종류의 버그다.
    // (§6.4 설정 병합에서 같은 계열의 "중첩 공유" 버그를 이미 겪었다)
    this.policy = {
      ...DEFAULT_POLICY,
      ...policy,
      allowlist: [...(policy.allowlist ?? DEFAULT_POLICY.allowlist)],
      denylist: [...(policy.denylist ?? DEFAULT_POLICY.denylist)],
    };
  }

  get pending(): ApprovalRequest[] {
    return [...this.waiting.values()].map((w) => w.req);
  }

  get pendingCount(): number {
    return this.waiting.size;
  }

  /**
   * 승인을 요구한다. 즉시 결정될 수 있다(자동 허용/거절) — 그러면 Promise 가 바로 풀린다.
   * **타임아웃으로 거절**하는 것도 같은 경로로 표현한다(승인 없음 = 거절).
   */
  request(req: ToolRequest): Promise<ApprovalDecision> {
    const risk = req.risk ?? riskOf(req.tool, this.policy);
    if (risk === "deny") {
      this.events.onDecision?.({ ...req, id: "denied", requestedAt: Date.now(), expiresAt: 0 }, "reject", "policy");
      return Promise.resolve("reject");
    }
    if (risk === "auto") {
      this.events.onDecision?.({ ...req, id: "auto", requestedAt: Date.now(), expiresAt: 0 }, "allow-once", "allowlist");
      return Promise.resolve("allow-once");
    }

    const full: ApprovalRequest = {
      ...req,
      id: `a${++this.counter}`,
      requestedAt: Date.now(),
      expiresAt: Date.now() + this.policy.timeoutSec * 1000,
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(full.id, "timeout");
      }, this.policy.timeoutSec * 1000);
      // **unref 하지 않는다.** 대기 중인 승인은 "진짜로 기다리는 중" 이므로 이벤트 루프를
      // 붙잡아야 한다 — unref 하면 결정도 되지 않은 채 프로세스만 끝나버린다(테스트에서
      // 타임아웃이 아예 발화하지 않았다). 좀비 방지는 종료 시 `rejectAll()` 로 한다.
      this.waiting.set(full.id, { resolve, req: full, timer });
      this.events.onRequest?.(full);
    });
  }

  /** 사용자가 결정했다. */
  decide(id: string, decision: ApprovalDecision, by?: string): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    if (decision === "allow-always" && w.req.tool) {
      if (!this.policy.allowlist.includes(w.req.tool)) this.policy.allowlist.push(w.req.tool);
    }
    this.settle(id, decision, by);
    return true;
  }

  private settle(id: string, decision: ApprovalDecision, by?: string): void {
    const w = this.waiting.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(id);
    this.events.onDecision?.(w.req, decision, by);
    w.resolve(decision);
  }

  /**
   * 창이 닫혔다 — 대기 중인 요청을 **모두 거절**한다.
   * 데몬 모드에서 이게 없으면 사용자는 창을 닫은 뒤 영원히 대기 상태로 남는다.
   */
  rejectAll(reason = "창이 닫혀 승인이 불가능합니다"): number {
    const ids = [...this.waiting.keys()];
    for (const id of ids) {
      const w = this.waiting.get(id);
      if (w) {
        w.req.summary = `${w.req.summary} — ${reason}`;
      }
      this.settle(id, "reject", reason);
    }
    return ids.length;
  }

  allow(tool: string): void {
    if (!this.policy.allowlist.includes(tool)) this.policy.allowlist.push(tool);
  }

  deny(tool: string): void {
    if (!this.policy.denylist.includes(tool)) this.policy.denylist.push(tool);
    this.policy.allowlist = this.policy.allowlist.filter((t) => t !== tool);
  }

  getPolicy(): ApprovalPolicy {
    return { ...this.policy, allowlist: [...this.policy.allowlist], denylist: [...this.policy.denylist] };
  }
}

/** 도구 인자를 사람이 읽을 한 줄로 — 승인 화면에 그대로 보여야 한다(§3.6). */
export function summarizeArgs(args: Record<string, unknown> | undefined, max = 200): string {
  if (!args || Object.keys(args).length === 0) return "(인자 없음)";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let s: string;
    if (typeof v === "string") s = v;
    else {
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
      }
    }
    // 시크릿처럼 보이는 값은 가린다 — 승인 화면도 스크린샷에 찍힌다(§3.6).
    if (/token|secret|password|key/i.test(k) && s.length > 4) s = `${s.slice(0, 2)}***`;
    parts.push(`${k}=${s}`);
  }
  const line = parts.join(" ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
