/**
 * 에이전트 스트림 블록 (§5.6) — 서버 쪽 상태 머신.
 *
 * 이 파일이 지키는 계약은 세 가지이며, **모두 성능과 조작성**에 대한 것이다:
 *  1) 블록은 **완료 순서가 아니라 시작 순서**로 정렬된다(안정 정렬). 위치가 튀면
 *     사용자가 "이게 뭐야" 를 물으며, 도구가 느린 것만이 아니다.
 *  2) 갱신은 **버전이 바뀔 때만** 알린다. 스트리밍 중 매 토큰마다 전체를 보내면
 *     네트워크와 리렌더가 둘 다 죽는다(원본 실측: 스키마만으로 1,238 토큰/요청).
 *  3) 대용량 출력은 **앞/뒤만** 보내고 원본은 서버가 보관한다.
 */

export type BlockKind =
  | "user"
  | "reasoning"
  | "text"
  | "tool"
  | "diff"
  | "run"
  | "plan"
  | "note"
  | "compaction"
  | "error"
  | "log"
  | "approval";

export type BlockStatus = "pending" | "running" | "ok" | "error" | "aborted";

export interface Block {
  id: string;
  kind: BlockKind;
  title: string;
  status: BlockStatus;
  /** 갱신마다 증가 — UI 는 version 이 바뀔 때만 리렌더한다. */
  version: number;
  createdAt: number;
  updatedAt: number;
  collapsed: boolean;
  content: unknown;
  /** 시작 순서(정렬 기준). 같은 값이면 id 로 안정 정렬. */
  seq: number;
}

export interface BlockPatch {
  type: "appendText" | "setStatus" | "setTitle" | "setContent";
  text?: string;
  status?: BlockStatus;
  title?: string;
  content?: unknown;
}

/** 접힘 요약 라벨(§5.1) — "무엇이 몇 개나 있었나" 를 한 줄로. */
export function summarizeBlock(b: Pick<Block, "kind" | "title" | "content">): string {
  const len = (s: string) => s.length.toLocaleString("ko-KR");
  switch (b.kind) {
    case "reasoning":
      return `사고 과정 · ${len(String(textOf(b.content)))}자`;
    case "tool":
      return `${b.title} · ${len(String(textOf(b.content)))}자`;
    case "text":
    case "user":
      return `${b.title} · ${len(String(textOf(b.content)))}자`;
    case "run":
      return `${b.title} · ${len(String(textOf(b.content)))}자`;
    default:
      return b.title;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const t = (content as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * 블록 저장소. 순서·버전·상한을 한 곳에서 관리한다.
 * "블록이 200개 쌓였는데 다 리렌더한다" 는一类의 버그를 여기서 막는다.
 */
export class BlockStore {
  private blocks = new Map<string, Block>();
  private order: string[] = [];
  private counter = 0;
  private maxBlocks: number;

  constructor(opts: { maxBlocks?: number } = {}) {
    this.maxBlocks = opts.maxBlocks ?? 500;
  }

  create(input: { id?: string; kind: BlockKind; title: string; content?: unknown }): Block {
    const id = input.id ?? `b${++this.counter}`;
    const now = Date.now();
    const b: Block = {
      id,
      kind: input.kind,
      title: input.title,
      status: "running",
      version: 1,
      createdAt: now,
      updatedAt: now,
      collapsed: false,
      content: input.content ?? { text: "" },
      seq: ++this.order.length,
    };
    this.blocks.set(id, b);
    this.order.push(id);
    this.evict();
    return { ...b };
  }

  /** 오래된 블록을 버린다 — **완료된 것부터** 버린다(진행 중을 버리면 안 된다). */
  private evict(): void {
    while (this.blocks.size > this.maxBlocks) {
      const idx = this.order.findIndex((id) => {
        const b = this.blocks.get(id);
        return b && (b.status === "ok" || b.status === "error" || b.status === "aborted");
      });
      if (idx < 0) return; // 전부 진행 중이면 버리지 않는다 — 데이터 손실이 나쁘다
      const [id] = this.order.splice(idx, 1);
      this.blocks.delete(id!);
    }
  }

  get(id: string): Block | undefined {
    const b = this.blocks.get(id);
    return b ? { ...b } : undefined;
  }

  /** 시작 순서로 정렬된 목록. **항상 그 순서**여야 한다. */
  list(): Block[] {
    return this.order
      .map((id) => this.blocks.get(id))
      .filter((b): b is Block => !!b)
      .map((b) => ({ ...b }));
  }

  /** 갱신 후 **버전이 실제로 바뀌었을 때만** true 를 돌려준다(불필요한 렌더 방지). */
  apply(id: string, patch: BlockPatch): { changed: boolean; block?: Block } {
    const b = this.blocks.get(id);
    if (!b) return { changed: false };
    let changed = false;
    switch (patch.type) {
      case "appendText": {
        const cur = b.content as { text?: string };
        b.content = { ...cur, text: (cur?.text ?? "") + (patch.text ?? "") };
        changed = true;
        break;
      }
      case "setStatus":
        if (b.status !== patch.status) {
          b.status = patch.status!;
          changed = true;
        }
        break;
      case "setTitle":
        if (b.title !== patch.title) {
          b.title = patch.title!;
          changed = true;
        }
        break;
      case "setContent":
        b.content = patch.content;
        changed = true;
        break;
    }
    if (!changed) return { changed: false, block: { ...b } };
    b.version++;
    b.updatedAt = Date.now();
    return { changed: true, block: { ...b } };
  }

  finish(id: string, status: BlockStatus = "ok"): void {
    this.apply(id, { type: "setStatus", status });
    // **완료할 때도 상한을 본다.** create 에서만 보면 턴이 끝난 뒤 블록이 상한을
    // 넘은 상태로 남고, 다음 블록이 올 때까지 메모리를 붙잡는다(실제 버그였다).
    this.evict();
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const b = this.blocks.get(id);
    if (!b || b.collapsed === collapsed) return;
    b.collapsed = collapsed;
    b.version++;
    b.updatedAt = Date.now();
  }

  /** 진행 중인 것만 — 턴 중단 시 이것들에 abort 를 찍는다. */
  running(): Block[] {
    return this.list().filter((b) => b.status === "running" || b.status === "pending");
  }

  clear(): void {
    this.blocks.clear();
    this.order = [];
  }

  get size(): number {
    return this.blocks.size;
  }
}

/**
 * 스트리밍 버퍼 (§5.6) — 50ms 마다 한 번 커밋.
 *
 * "문자 단위 DOM 갱신" 은 초당 수백 번 리렌더가 되고, rAF 마다 커밋하면 초당 60회다.
 * 50ms 는 사람이 지연을 느끼지 못하는 선(=100ms 근처)이면서 리렌더를 20회로 눌러준다.
 */
export class StreamBuffer {
  private pending: { blockId: string; text: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(
    private onFlush: (items: { blockId: string; text: string }[]) => void,
    opts: { intervalMs?: number } = {}
  ) {
    this.intervalMs = opts.intervalMs ?? 50;
  }

  push(blockId: string, text: string): void {
    if (!text) return;
    this.pending.push({ blockId, text });
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const items = this.pending;
    this.pending = [];
    this.onFlush(items);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}

/** 도구 출력 상한(§5.6) — 2,000줄을 넘으면 앞/뒤만 남기고 원본은 서버가 보관. */
export function clampOutput(text: string, maxLines = 2000, tailLines = 200): { text: string; omitted: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, omitted: 0 };
  const head = lines.slice(0, maxLines - tailLines);
  const tail = lines.slice(lines.length - tailLines);
  const omitted = lines.length - head.length - tail.length;
  return {
    text: [...head, `… ${omitted.toLocaleString("ko-KR")}줄 생략 (전체는 서버 로그에 있음) …`, ...tail].join("\n"),
    omitted,
  };
}
