/**
 * 세션 영속화 (§5.10).
 *
 * 이 모듈에서 가장 중요한 규칙은 **하나** 다:
 *
 * > **WS 재연결과 페이지 새로고침을 구분한다.**
 * > WS 재연결은 메모리 상태를 유지하므로 세션을 재적재하지 않는다.
 * > 페이지 새로고침만 디스크에서 읽는다.
 *
 * 둘을 섞으면 스트리밍 도중 화면이 **통째로 바뀐다** — 사용자가 보던 도구 블록이
 * 사라지고 다시 쌓인다. §5.10 이 이것을 명시적으로 금지한다.
 *
 * 그래서 복원 결과에 **출처**(`source`)를 붙인다. UI 는 이것으로 "붙여 넣기" 와
 * "처음부터 그리기" 를 구분한다.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, writeFile, readdir, unlink, stat } from "node:fs/promises";

export type RestoreSource = "fresh" | "reload" | "reconnect" | "server-restart";

export interface PersistedBlock {
  id: string;
  kind: string;
  title: string;
  status: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  collapsed: boolean;
  content: unknown;
}

export interface SessionDoc {
  id: string;
  /** 워크스페이스별 분류(§8.3·§5.10). */
  workspace: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  messages: { role: "user" | "assistant" | "system"; text: string; at: number }[];
  blocks: PersistedBlock[];
  plan: { step: string; done: boolean }[] | null;
  /** 컴팩션 이력. */
  compactions: { at: number; from: number; to: number; summary: string }[];
  /** 중단된 턴이 있었다 — 복원하면 "어디까지 했는지" 가 남아 있다(§5.10). */
  abortedTurn: { blockIds: string[]; at: number } | null;
  /** 도구 결과 중 전문을 별도 파일로 뺀 것(§5.10 대용량 보호). */
  spilled: { blockId: string; file: string; bytes: number }[];
  /** 총 크기(상한 초과는 gzip 으로 압축한다). */
  bytes: number;
  version: 1;
}

/** §5.10: 이 크기를 넘으면 gzip 압축하고 도구 결과 전문을 분리한다. */
export const COMPRESS_THRESHOLD = 2 * 1024 * 1024;
/** 블록당 인라인 보관 상한 — 넘으면 앞/뒤만 남기고 전문을 spill 한다(§5.6 과 동일 원칙). */
export const INLINE_BLOCK_LIMIT = 32 * 1024;
export const SAVE_DEBOUNCE_MS = 1000;

const BLOCK_HEAD = 2000;
const BLOCK_TAIL = 2000;

/** 블록 내용을 인라인 보관 가능한 형태로 줄인다. 전문은 `spill` 로 나간다. */
export function clampBlock(content: unknown): { content: unknown; spilled: string | null } {
  const text = typeof content === "string" ? content : safeStringify(content);
  if (text.length <= INLINE_BLOCK_LIMIT) return { content, spilled: null };
  const head = text.slice(0, BLOCK_HEAD);
  const tail = text.slice(-BLOCK_TAIL);
  const omitted = text.length - head.length - tail.length;
  return {
    content: { head, tail, omittedLines: omitted, note: `${omitted.toLocaleString("ko-KR")}자 생략 — 전문은 별도 파일에 있습니다` },
    spilled: text,
  };
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function sessionId(root: string, at = Date.now()): string {
  // 사람이 읽고 정렬 가능한 ID — 목록에서 "언제 세션" 이 한눈에 보인다.
  const stamp = new Date(at).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const salt = createHash("sha1").update(`${root}:${at}`).digest("hex").slice(0, 6);
  return `s-${stamp}-${salt}`;
}

export function sessionsDir(stateDir: string): string {
  return join(stateDir, "sessions");
}

/**
 * 디바운스 저장. **1초마다 저장하지 않는다** — 스트리밍 중 매 델타마다 저장하면
 * 디스크 I/O 가 스트리밍을 끊는다(그리고 파일이 수십 개 남는다).
 */
export class SessionStore {
  private timers = new Map<string, NodeJS.Timeout>();
  /** 디바운스 대기 중인 최신 문서. (메서드 `latest()` 와 이름이 달라야 한다) */
  private queued = new Map<string, SessionDoc>();

  constructor(
    private stateDir: string,
    private debounceMs = SAVE_DEBOUNCE_MS,
  ) {}

  /** 저장을 예약한다. 같은 세션의 연속 저장은 하나로 합쳐진다. */
  schedule(doc: SessionDoc): void {
    this.queued.set(doc.id, doc);
    const prev = this.timers.get(doc.id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(doc.id);
      void this.flush(doc.id).catch(() => undefined);
    }, this.debounceMs);
    t.unref?.();
    this.timers.set(doc.id, t);
  }

  /** 즉시 저장 — 종료 시점·체크포인트 경로. */
  async flush(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    const doc = this.queued.get(id);
    if (!doc) return;
    await this.write(doc);
  }

  async write(doc: SessionDoc): Promise<string> {
    const dir = sessionsDir(this.stateDir);
    await mkdir(dir, { recursive: true });
    const body = { ...doc, updatedAt: Date.now() };
    const json = JSON.stringify(body);
    const path = join(dir, `${doc.id}.json`);
    if (json.length > COMPRESS_THRESHOLD) {
      // gzip 으로 옆에 두되, 확장자 .gz 로 구분한다(복원 시 자동으로 읽는다).
      const { gzip } = await import("node:zlib");
      // promisify(gzip) 의 타입이 Buffer 반환에 맞지 않아 직접 감싼다.
      const out = await new Promise<Buffer>((res, rej) =>
        gzip(json, (err, b) => (err ? rej(err) : res(b))),
      );
      await writeFile(`${path}.gz`, out);
      await unlink(path).catch(() => undefined);
      return `${path}.gz`;
    }
    await writeFile(path, json, "utf8");
    return path;
  }

  async read(id: string): Promise<SessionDoc | null> {
    const dir = sessionsDir(this.stateDir);
    const plain = join(dir, `${id}.json`);
    const gz = `${plain}.gz`;
    try {
      const st = await stat(plain);
      return JSON.parse(await readFile(plain, "utf8")) as SessionDoc;
    } catch {
      // 압축본이 있으면 그걸 쓴다 — 안 읽히면 "없음" 이 아니라 오류를 말해야 하지만,
      // 복원 경로에서는 조용히 null 로 두고 UI 가 "복구 실패" 를 말하게 한다.
      try {
        await stat(gz);
        const { gunzip } = await import("node:zlib");
        const raw = await readFile(gz);
        const buf = await new Promise<Buffer>((res, rej) => gunzip(raw, (err, b) => (err ? rej(err) : res(b))));
        return JSON.parse(buf.toString("utf8")) as SessionDoc;
      } catch {
        return null;
      }
    }
  }

  async list(workspace?: string): Promise<{ id: string; name: string | null; updatedAt: number; workspace: string; bytes: number }[]> {
    const dir = sessionsDir(this.stateDir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: { id: string; name: string | null; updatedAt: number; workspace: string; bytes: number }[] = [];
    for (const n of names) {
      if (!n.endsWith(".json") && !n.endsWith(".json.gz")) continue;
      const id = n.replace(/\.json(\.gz)?$/, "");
      const doc = await this.read(id);
      if (!doc) continue;
      if (workspace && doc.workspace !== workspace) continue;
      out.push({ id, name: doc.name, updatedAt: doc.updatedAt, workspace: doc.workspace, bytes: doc.bytes });
    }
    // updatedAt 이 같을 때(같은 밀리초에 저장)는 **id** 로 결정적 순서를 만든다.
    // 비교 함수가 0 을 돌려주면 정렬 결과가 실행마다 달라질 수 있다(같은 목록이
    // 두 번 조회에서 다른 순서로 보인다 — 버그처럼 보인다).
    return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 마지막 세션(가장 최근 갱신). 서버 재시작 복원 경로(§5.10 3번). */
  async latest(workspace?: string): Promise<SessionDoc | null> {
    const l = await this.list(workspace);
    if (!l.length) return null;
    return this.read(l[0].id);
  }

  async remove(id: string): Promise<void> {
    const dir = sessionsDir(this.stateDir);
    await unlink(join(dir, `${id}.json`)).catch(() => undefined);
    await unlink(join(dir, `${id}.json.gz`)).catch(() => undefined);
  }

  /** 대기 중인 저장을 모두 즉시 쓴다 — 프로세스 종료 전에 필수. */
  async flushAll(): Promise<void> {
    for (const id of [...this.timers.keys()]) await this.flush(id);
  }

  get pending(): number {
    return this.timers.size;
  }
}

export interface RestorePlan {
  source: RestoreSource;
  doc: SessionDoc | null;
  /**
   * **기존 화면을 유지해야 하는가.**
   * - `reconnect` → false. 메모리에 이미 있다(WS 재연결은 재적재하지 않는다).
   * - `reload` / `server-restart` → true. 디스크에서 온 것이므로 화면을 갈아엔다.
   */
  replaceScreen: boolean;
  /** 스트리밍 중 복원인지 — 블록을 **버전 그대로** 붙여야 한다. */
  streaming: boolean;
  /** 사용자에게 보여줄 한 줄 설명. */
  note: string;
}

/**
 * 복원 계획을 만든다. UI 는 `replaceScreen` 을 보고 붙여 넣기/교체를 결정한다.
 * 이 구분 없이 항상 교체하면 스트리밍 도중 화면이 통째로 바뀐다(§5.10 금지).
 */
export function planRestore(source: RestoreSource, doc: SessionDoc | null, inMemoryBlocks = 0): RestorePlan {
  if (source === "reconnect") {
    return {
      source,
      // WS 재연결은 메모리 상태를 유지한다. 디스크에서 다시 읽으면 스트리밍 중
      // 화면이 통째로 바뀐다 — 그래서 null 이어야 한다.
      doc: null,
      replaceScreen: false,
      streaming: inMemoryBlocks > 0,
      note: inMemoryBlocks > 0 ? `WebSocket 재연결 — 메모리 상태 유지 (블록 ${inMemoryBlocks}개)` : "WebSocket 재연결",
    };
  }
  if (!doc) {
    return { source, doc: null, replaceScreen: false, streaming: false, note: "저장된 세션이 없습니다" };
  }
  const label = source === "reload" ? "새로고침" : "서버 재시작";
  return {
    source,
    doc,
    replaceScreen: true,
    streaming: doc.abortedTurn !== null,
    note: `${label} — 세션 ${doc.id} 복원 (메시지 ${doc.messages.length}개, 블록 ${doc.blocks.length}개)`,
  };
}

/**
 * 복원된 블록을 화면 블록으로 변환. **버전은 그대로** 가져간다 — 새로 매기면
 * "새로 온 블록" 으로 취급되어 스크롤이 튀고, 스트리밍 중이면 내용이 뒤집힌다.
 */
export function hydrateBlocks(doc: SessionDoc): PersistedBlock[] {
  return [...doc.blocks].sort((a, b) => a.createdAt - b.createdAt).map((b) => ({ ...b }));
}
