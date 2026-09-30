/**
 * 알림(Toast) + 오류 센터 (M4) · 드래프트 자동 저장 (M7) · 명령 팔레트 (M5) 로직.
 *
 * 이 세 개의 공통점은 **"사라지면 안 되는 것"** 을 지키는 일이다:
 *  - 오류 센터: 창이 곧 IDE 다. 눈을 안 돌렸다가 오류가 조용히 지나가면
 *    사용자는 "왜 안 되지?" 하며 minutes을 보낸다.
 *  - 드래프트: 실수로 창을 닫아도 프롬프트가 사라지지 않아야 한다(M7).
 *  - 팔레트: M5.
 *
 * 규칙: **중요한 것은 자동으로 사라지지 않는다.** 사라져야 하는 것은 시간/스택 크기
 * 로 명시적으로 닫을 수 있게 한다. 조용히 사라지면 "안 왔나?" 가 된다.
 */

export type ToastKind = "info" | "success" | "warn" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body: string;
  at: number;
  /** null 이면 **자동으로 사라지지 않는다**. */
  ttlMs: number | null;
  /** 사람이 반드시 **확인해야** 닫히는 항목인가(오류 센터로 보낼 대상). */
  requiresAck: boolean;
  source: string;
  action?: { label: string; kind: string };
}

/** 정보성 토스트는 짧게, **오류는 확인 전까지** — 요구: "메시지가 사라져서 놓친다". */
export function defaultTtl(kind: ToastKind): number | null {
  if (kind === "error") return null;
  if (kind === "warn") return 15_000;
  if (kind === "success") return 4_000;
  return 6_000;
}

export function makeToast(id: string, kind: ToastKind, title: string, body: string, now = Date.now(), extra: Partial<Toast> = {}): Toast {
  return {
    id,
    kind,
    title,
    body,
    at: now,
    ttlMs: extra.ttlMs ?? defaultTtl(kind),
    requiresAck: extra.requiresAck ?? kind === "error",
    source: extra.source ?? "app",
    action: extra.action,
  };
}

export interface ToastView {
  toasts: Toast[];
  /** 지금 떠 있는 것. 같은 id 는 하나만(중복 방지). */
  live: Toast[];
  /** 확인 대기 중인 오류 수 — 배지에 숫자로 보여야 "놓치지 않는다". */
  unacked: number;
  /** 다음에 사라질 시각(null 이면 아무것도 안 사라진다). */
  nextExpiry: number | null;
}

export function toastView(items: Toast[], now = Date.now()): ToastView {
  const live = items.filter((t) => t.ttlMs === null || now - t.at < t.ttlMs);
  const unacked = live.filter((t) => t.requiresAck && !acked(t)).length;
  const ttls = live.map((t) => (t.ttlMs === null ? null : t.at + t.ttlMs)).filter((x): x is number => x !== null);
  return { toasts: items, live, unacked, nextExpiry: ttls.length ? Math.min(...ttls) : null };
}

// 확인 여부는 별도 집합으로 관리한다(토스트 자체를 변형하지 않는다).
let ackedIds = new Set<string>();
export function ackToast(id: string): void {
  ackedIds.add(id);
}
export function resetAcks(): void {
  ackedIds = new Set();
}
function acked(t: Toast): boolean {
  return ackedIds.has(t.id);
}

export function dismiss(items: Toast[], id: string): Toast[] {
  ackedIds.add(id);
  return items.filter((t) => t.id !== id);
}

/**
 * 새 토스트를 넣는다. **같은 id 는 교체**된다 — 동일 작업이 반복될 때
 * 토스트가 10개 쌓이면 "이게 한 건인지 열 건인지" 알 수 없다.
 */
export function pushToast(items: Toast[], t: Toast, max = 5): Toast[] {
  const filtered = items.filter((x) => x.id !== t.id);
  const next = [t, ...filtered];
  return next.length > max ? next.slice(0, max) : next;
}

/** 오류 센터: 시간이 지난 오류를 **아카이브**로 옮긴다. 사라지지는 않는다. */
export interface ErrorCenter {
  active: Toast[];
  archived: Toast[];
  maxActive: number;
}

export function errorCenter(items: Toast[], maxActive = 10): ErrorCenter {
  const errors = items.filter((t) => t.kind === "error");
  const active = errors.slice(0, maxActive);
  return { active, archived: errors.slice(maxActive), maxActive };
}

/**
 * §11.3: **사람이 읽는 문장**으로 바꾼다.
 * `TypeError: fetch failed` 를 그대로 띄우면 사용자는 원인을 모른다.
 * 원본에서도 이 함정을 고친 이력이 있다 — 웹에서도 같은 기준을 적용한다.
 */
export function humanizeError(e: unknown, context = "요청"): { message: string; retryable: boolean } {
  const raw = e instanceof Error ? e.message : String(e);
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
    return { message: `${context} 중 서버에 연결하지 못했습니다. 서버가 멈췄는지 확인하십시오.`, retryable: true };
  }
  if (/AbortError|aborted/i.test(raw)) {
    return { message: `${context}가 중단되었습니다.`, retryable: true };
  }
  if (/ENOSPC|no space left/i.test(raw)) {
    return { message: `디스크가 가득 찼습니다. 로그를 정리한 뒤 다시 시도하십시오.`, retryable: false };
  }
  if (/EACCES|EPERM|permission denied/i.test(raw)) {
    return { message: `권한이 없습니다. ${context} 실패했습니다.`, retryable: false };
  }
  if (/409|conflict/i.test(raw)) {
    return { message: `${context}가 충돌했습니다. 다른 곳에서 먼저 변경되었습니다.`, retryable: true };
  }
  if (/5\d\d|internal server/i.test(raw)) {
    return { message: `서버 오류로 ${context}에 실패했습니다. 잠시 뒤 다시 시도하십시오.`, retryable: true };
  }
  // 원인은 남기되 앞에 사람이 읽을 문장을 붙인다.
  return { message: `${context}에 실패했습니다: ${raw}`, retryable: false };
}

// ------------------------------------------------------------------ 드래프트 (M7)

export interface Draft {
  text: string;
  savedAt: number;
  /** 입력창에 붙어 있던 첨부/컨텍스트. */
  attachments: string[];
}

const DRAFT_KEY = "harnesside.draft";

/**
 * 입력창 드래프트를 **localStorage** 에 보관한다. 서버가 죽어도 프롬프트는 살아있다.
 * 세션 스코프가 아니라 **창 스코프** 다 — 서버 상태와 무관해야 "서버가 멈춰도" 남는다.
 */
export function saveDraft(d: Draft, storage: { setItem(k: string, v: string): void; removeItem?(k: string): void } | null): void {
  if (!storage) return;
  // 빈 프롬프트를 저장하면 다음에 "지난 프롬프트" 가 뜬다 — 지운 걸 되살리는 셈.
  if (!d.text.trim() && d.attachments.length === 0) {
    storage.removeItem?.(DRAFT_KEY);
    return;
  }
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // 용량 초과면 조용히 버린다 — 프롬프트 입력을 막아서는 안 된다
  }
}

export function loadDraft(storage: { getItem(k: string): string | null } | null): Draft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (typeof d?.text !== "string") return null;
    return { text: d.text, savedAt: d.savedAt ?? 0, attachments: Array.isArray(d.attachments) ? d.attachments : [] };
  } catch {
    return null; // 깨진 드래프트가 앱 전체를 막으면 안 된다
  }
}

export function clearDraft(storage: { removeItem?(k: string): void } | null): void {
  storage?.removeItem?.(DRAFT_KEY);
}

/** 전송 성공 후에만 지운다 — 전송 실패한 프롬프트는 **지우면 안 된다**. */
export function draftAfterSend(sent: boolean, d: Draft | null): Draft | null {
  if (sent) return null;
  return d;
}

// ------------------------------------------------------------------ 팔레트 (M5)

export interface Command {
  id: string;
  title: string;
  /** 접두사 라벨 — 로그/에이전트/설정/모Delimiter */
  category: "파일" | "에이전트" | "보기" | "설정" | "기타";
  keys: string[];
  when?: string;
  /**
   * **실제로 실행되는 함수.**
   *
   * 여기는 예전부터 문자열이었다(`run: "view.toggleLog()"`). 그리고 **아무도 그 문자열을
   * 실행하지 않았다** — 호출부가 `cmd.run` 을 찾지 못했다. 그래서 팔레트에서 Enter 를
   * 눌러도 **아무 일도 일어나지 않았다**(2026-10-01 실측: `grep '\.run' src/web/` 의
   * 결과는 `searchCommands` 안의 문자열 비교뿐).
   *
   * 조용히 안 되는 메뉴는 **없다고 알아채기 더 어렵다** — 목록은 보이는데 아무것도
   * 안 하는 항목이 몇 개 있으면 사용자는 "이 프로그램의 몇몇 기능이 죽었네" 하고
   * 프로그램 전체를 의심한다. 그래서 **문자열이 아니라 함수**로 바꿨다.
   */
  run: () => void | Promise<void>;
  /** 검색에만 쓰이는 대표 문자열(그래프·스크립트). 화면에는 안 나온다. */
  runHint?: string;
}

export interface FuzzyHit {
  cmd: Command;
  score: number;
  /** 어느 부분이 맞았는지 — 표시용. */
  matched: string;
}

/**
 * 퍼지 매칭. **부분 문자열** 과 연속 부분 수열을 모두 고려한다.
 * 연속으로 이어지는 문자가 많을수록 높은 점수 — "gt" 가 "git" 을 먼저 찾도록.
 */
export function fuzzyScore(needle: string, hay: string): { score: number; matched: string } | null {
  if (!needle) return { score: 1, matched: hay };
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const direct = h.indexOf(n);
  if (direct === 0) return { score: 1000, matched: hay };
  if (direct > 0) return { score: 700 - direct, matched: hay };
  // 연속 부분 수열
  let hi = 0;
  let score = 0;
  let run = 0;
  let matched = "";
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found < 0) return null;
    run = found === hi && hi > 0 ? run + 1 : 1;
    score += 10 + run * 5 - Math.min(9, found - hi);
    matched += ch;
    hi = found + 1;
  }
  return { score, matched };
}

export function searchCommands(cmds: Command[], query: string, limit = 20): FuzzyHit[] {
  const hits: FuzzyHit[] = [];
  for (const c of cmds) {
    const byTitle = fuzzyScore(query, c.title);
    const byId = fuzzyScore(query, c.id);
    // `run` 은 이제 **함수**다(2026-10-01). 검색은 문자열만 대상이므로 `runHint` 을 쓴다.
    // `runHint` 이 없으면 **id** 로 대체한다 — 그래야 "log" 로 "view.toggleLog" 가 잡힌다.
    const byRun = fuzzyScore(query, c.runHint ?? c.id);
    const best = [byTitle, byId, byRun].filter((x): x is { score: number; matched: string } => x !== null).sort((a, b) => b.score - a.score)[0];
    if (best) hits.push({ cmd: c, score: best.score, matched: best.matched });
  }
  return hits.sort((a, b) => b.score - a.score || a.cmd.title.localeCompare(b.cmd.title)).slice(0, limit);
}

/** 팔레트는 **한 번만** 실행된다 — 두 번 실행되면 파일이 두 번 저장된다. */
export class CommandRunner {
  private running = new Set<string>();
  private history: { cmd: string; at: number; ok: boolean; error?: string }[] = [];

  async run(id: string, fn: () => Promise<void> | void, now = Date.now()): Promise<{ ran: boolean; reason?: string }> {
    if (this.running.has(id)) return { ran: false, reason: "이미 실행 중입니다" };
    this.running.add(id);
    try {
      await fn();
      this.history.push({ cmd: id, at: now, ok: true });
      return { ran: true };
    } catch (e) {
      const h = humanizeError(e, "명령 실행");
      this.history.push({ cmd: id, at: now, ok: false, error: h.message });
      return { ran: false, reason: h.message };
    } finally {
      this.running.delete(id);
    }
  }

  get history_(): { cmd: string; at: number; ok: boolean; error?: string }[] {
    return this.history;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }
}

/** M8 접근성: 키보드 전용으로 도달할 수 있는 최소 키 집합. */
export const REQUIRED_KEYS = [
  "Ctrl+K", // 팔레트
  "Ctrl+Shift+P", // 팔레트(전역)
  "Ctrl+B", // 사이드 도크 토글
  "Ctrl+`", // 터미널
  "Ctrl+S", // 저장
  "Ctrl+Alt+D", // 전체 화면 diff
  "Escape", // 닫기
  "Alt+ArrowLeft", // 패널 이동 (§5.4 드래그 대안)
  "Alt+ArrowRight",
  "Alt+ArrowUp",
  "Alt+ArrowDown",
];

export function describeKeyCoverage(keys: string[]): { covered: string[]; missing: string[]; ok: boolean } {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  const covered = REQUIRED_KEYS.filter((k) => set.has(k.toLowerCase()));
  const missing = REQUIRED_KEYS.filter((k) => !set.has(k.toLowerCase()));
  return { covered, missing, ok: missing.length === 0 };
}
