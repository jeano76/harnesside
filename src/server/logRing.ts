/**
 * 로그 링 버퍼 (§5.12.2) — 상시 디버그 패널의 급유.
 *
 * 상한은 **문자 수**로 준다(기본 500,000자). 왜 문자 단위인가:
 *  - 사용자가 아는 단위다 ("50만 자 넘으면 앞이 잘립니다")
 *  - 바이트는 UTF-16/UTF-8 이모지 때문에 들쭉날쭉해 설명이 안 된다
 *  - Node 문자열은 UTF-16 이라 **500,000자 ≈ 1 MB 힙** — Chrome 전체 RSS 1.54 GiB
 *    (실측) 에 비하면 무시 가능하고, 1,000만자(20 MB) 부터는 GC 압력이 눈에 보인다.
 *
 * 설계상 절대 지킨다(테스트로 막는다):
 *  - 상한을 넘으면 **가장 오래된 것부터** 버린다
 *  - **가장 최근 줄은 절대 버리지 않는다.** 지금 올라온 줄이 사라지면
 *    사용자는 "로그가 멈췄다"고 생각한다(§5.12.2)
 *  - 잘렸으면 **한 번만** 알린다(계속 알리면 패널이 지저분해진다)
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "server" | "llama" | "chrome" | "proc";

export interface LogEntry {
  /** 프로세스 수명 단위 단조 증가. 재접속 이어받기의 기준(§2.3). */
  seq: number;
  ts: number;
  level: LogLevel;
  source: LogSource;
  /** 모듈/스코프: `agent.loop`, `llama`, `browser` … */
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogRingOptions {
  /** 최대 보관 문자 수(기본 500,000) */
  maxChars?: number;
  /** 최대 보관 줄 수(기본 50,000) */
  maxLines?: number;
  /** 한 줄 최대 길이(기본 8,192자). 초과분은 잘리고 표시된다 */
  maxLineChars?: number;
  /** 파일 쓰기 여부. 데몬은 파일이 진실원이다(§3.7.1) */
  writer?: (line: string) => void;
}

export const DEFAULTS = {
  maxChars: 500_000,
  maxLines: 50_000,
  maxLineChars: 8_192,
} as const;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 명시값은 존중하되 0/음수/비수만 기본값으로 대체한다. */
function positive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export class LogRing {
  private entries: LogEntry[] = [];
  private chars = 0;
  private seq = 0;
  private droppedLines = 0;
  private droppedChars = 0;
  private lastTruncatedNotice = 0;
  private readonly maxChars: number;
  private readonly maxLines: number;
  private readonly maxLineChars: number;
  private readonly writer?: (line: string) => void;
  private listeners = new Set<(e: LogEntry) => void>();
  private statusListeners = new Set<(s: LogRingStatus) => void>();

  constructor(opts: LogRingOptions = {}) {
    // 명시값을 그대로 쓴다. 0/음수·비수만 막는다 — 상한을 임의로 올려버리면
    // "설정했는데 왜 안 지워지나" 가 되는, 정확히 피해야 할 종류의 조용한 무시다.
    this.maxChars = positive(opts.maxChars, DEFAULTS.maxChars);
    this.maxLines = positive(opts.maxLines, DEFAULTS.maxLines);
    this.maxLineChars = positive(opts.maxLineChars, DEFAULTS.maxLineChars);
    this.writer = opts.writer;
  }

  /** 로그 한 줄을 넣는다. 버퍼링하지 않는다 — "모으는 중" 인 것처럼 보여선 안 된다. */
  append(e: Omit<LogEntry, "seq"> & { seq?: number }): LogEntry {
    const message = this.truncateLine(e.message);
    const entry: LogEntry = { ...e, seq: e.seq ?? ++this.seq, message };
    if (e.seq !== undefined && e.seq > this.seq) this.seq = e.seq;

    this.entries.push(entry);
    this.chars += message.length + entry.scope.length + entry.source.length;
    this.writeOut(entry);

    this.evict();
    this.notify(entry);
    return entry;
  }

  private truncateLine(msg: string): string {
    // 코드포인트 기준으로 자른다. 앞에서 자르면 이모지가 깨진다(깨진 문자가
    // 로그를 읽을 수 없게 만드는 가장 빠른 방법).
    if (msg.length <= this.maxLineChars) return msg;
    const head = Array.from(msg).slice(0, this.maxLineChars - 20).join("");
    return `${head}… (+${msg.length - head.length}자 생략)`;
  }

  /** 상한 초과분 제거. 오래된 것부터, **최신 줄은 남긴다**. */
  private evict(): void {
    while (this.entries.length > this.maxLines) {
      if (!this.dropOldest()) break;
    }
    while (this.chars > this.maxChars && this.entries.length > 1) {
      if (!this.dropOldest()) break;
    }
  }

  /** 맨 앞(가장 오래된) 항목 하나를 버린다. */
  private dropOldest(): boolean {
    const dropped = this.entries.shift();
    if (!dropped) return false;
    // chars 를 **반드시** 줄인다. 줄이지 않으면 카운터가 단조 증가해
    // 상한 초과분과 무관하게 모든 항목이 사라진다(실제로 1줄만 남던 버그).
    this.chars -= this.sizeOf(dropped);
    if (this.chars < 0) this.chars = 0;
    this.countDrop(dropped);
    return true;
  }

  private sizeOf(e: LogEntry): number {
    return e.message.length + e.scope.length + e.source.length;
  }

  private countDrop(e: LogEntry): void {
    this.droppedLines++;
    this.droppedChars += e.message.length;
  }

  private writeOut(e: LogEntry): void {
    if (!this.writer) return;
    // NDJSON 한 줄. 사람이 읽는 문장은 message 다(§3.7.1).
    try {
      this.writer(JSON.stringify(e));
    } catch {
      // 파일 쓰기 실패가 로그를 막으면 안 된다 — 데몬은 사람이 보지 않는다
    }
  }

  private notify(e: LogEntry): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // 리스너 하나가 죽어도 나머지는 알림을 받아야 한다
      }
    }
    this.emitStatus();
  }

  /** 상한에 닿았을 때 **한 번만** 알린다. 계속 알리면 패널이 지저분해진다. */
  private emitStatus(force = false): void {
    const full = this.chars >= this.maxChars || this.entries.length >= this.maxLines;
    if (!full) return;
    if (!force && this.lastTruncatedNotice === this.droppedLines) return;
    this.lastTruncatedNotice = this.droppedLines;
    const s = this.status;
    for (const l of this.statusListeners) {
      try {
        l(s);
      } catch {
        // 격리
      }
    }
  }

  /** 최근 항목. `sinceSeq` 로 재접속 이어받기를 지원한다. */
  since(seq: number, limit = 2000): LogEntry[] {
    const out = this.entries.filter((e) => e.seq > seq);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  /** 전체(필터 적용). 정적 스냅샷을 돌려준다 — 밖에서 변형되면 상한 계산이 틀어진다. */
  query(f: { levels?: LogLevel[]; sources?: LogSource[]; scope?: string; limit?: number } = {}): LogEntry[] {
    let out = this.entries;
    if (f.levels?.length) out = out.filter((e) => f.levels!.includes(e.level));
    if (f.sources?.length) out = out.filter((e) => f.sources!.includes(e.source));
    if (f.scope) out = out.filter((e) => e.scope === f.scope);
    if (f.limit && out.length > f.limit) out = out.slice(out.length - f.limit);
    return out.slice();
  }

  get status(): LogRingStatus {
    return {
      seq: this.seq,
      keptChars: this.chars,
      keptLines: this.entries.length,
      droppedChars: this.droppedChars,
      droppedLines: this.droppedLines,
      // "가득 찼다" 가 아니라 **"실제로 뭔가 사라졌다"** 를 뜻한다. 정확히 상한에 닿았다는
      // 이유로 배너를 띄우면 아무것도 잃지 않았는데 "잘렸습니다" 라고 말하게 된다 —
      // 정확히 그 오해를 막기 위해 기준을 이쪽으로 바꿨다.
      bufferFull: this.droppedLines > 0 || this.chars >= this.maxChars || this.entries.length >= this.maxLines,
      maxChars: this.maxChars,
      maxLines: this.maxLines,
    };
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** 세션 링만 비운다(디스크 회전본은 보존) — §2.3 `log.clear` */
  clear(): void {
    this.entries = [];
    this.chars = 0;
    this.droppedLines = 0;
    this.droppedChars = 0;
    this.lastTruncatedNotice = 0;
    this.emitStatus(true);
  }

  /** 하위 시스템이 개별적으로 쓰기 위해 쓰는 편의 메서드들. */
  info(scope: string, message: string, source: LogSource = "server", data?: Record<string, unknown>) {
    return this.append({ ts: Date.now(), level: "info", scope, source, message, data });
  }
  warn(scope: string, message: string, source: LogSource = "server", data?: Record<string, unknown>) {
    return this.append({ ts: Date.now(), level: "warn", scope, source, message, data });
  }
  error(scope: string, message: string, source: LogSource = "server", data?: Record<string, unknown>) {
    return this.append({ ts: Date.now(), level: "error", scope, source, message, data });
  }
  debug(scope: string, message: string, source: LogSource = "server", data?: Record<string, unknown>) {
    return this.append({ ts: Date.now(), level: "debug", scope, source, message, data });
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: LogRingStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
}

export interface LogRingStatus {
  seq: number;
  keptChars: number;
  keptLines: number;
  droppedChars: number;
  droppedLines: number;
  bufferFull: boolean;
  maxChars: number;
  maxLines: number;
}

/** 프로세스 전역 싱글턴 — 분산 로깅은 반드시 누락된다(§3.5.1). */
let singleton: LogRing | null = null;
export function getLogRing(opts?: LogRingOptions): LogRing {
  if (!singleton) singleton = new LogRing(opts);
  return singleton;
}
/** 테스트용. 프로덕션 경로에서는 호출하지 않는다. */
export function resetLogRing(): void {
  singleton = null;
}

export function shouldLog(level: LogLevel, min: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
}

/** NDJSON 한 줄을 LogEntry 로. 자식 프로세스 stdout 을 파싱한다. */
export function parseNdjson(line: string): LogEntry | null {
  try {
    const o = JSON.parse(line) as Partial<LogEntry>;
    if (typeof o.message !== "string") return null;
    return {
      seq: typeof o.seq === "number" ? o.seq : 0,
      ts: typeof o.ts === "number" ? o.ts : Date.now(),
      level: (o.level as LogLevel) ?? "info",
      source: (o.source as LogSource) ?? "server",
      scope: typeof o.scope === "string" ? o.scope : "unknown",
      message: o.message,
      data: o.data,
    };
  } catch {
    return null; // 파싱 실패는 조용히 버리지 않는다 — 호출부가 raw 로 남긴다
  }
}
