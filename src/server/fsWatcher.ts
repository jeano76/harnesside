/**
 * 파일 변경 감지 (§5.2 표의 "파일 변경" 행) — 디스크 ↔ 편집기 버퍼.
 *
 * 두 가지가 이 프로그램에서 중요하고, 둘 다 여기서 다룬다:
 *
 * 1. **debounce.** `writeFile`(tmp→rename) 는 최소 2개의 이벤트를 만든다. debounce
 *    가 없으면 "파일이 변경되었습니다" 가 두 번 울리고, diff 가 두 번 그려진다.
 * 2. **자기 쓰기 무시.** 우리가 저장한 직후엔 버퍼가 이미 최신이므로 "바뀝습니다" 를
 *    보내면 사용자가 자기 저장을 "외부 변경" 으로 오해하고 충돌 창을 본다.
 *
 * 감시는 **워크스페이스 루트 아래로** 한정한다. 한 단계 위(`..`)로 새면 `/home` 을
 * 순회하기 시작하고, 사용자의 다른 작업까지 "변경됨" 으로 알린다.
 */

import { watch, type FSWatcher } from "chokidar";
import { relative, isAbsolute, sep } from "node:path";

/** 자주 생기지 않는 경로만 — node_modules 는 애초에 감시 대상이 아니다. */
export const DEFAULT_IGNORED = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.harnesside/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/*.harnesside-tmp",
];

export interface ChangeEvent {
  path: string;
  kind: "add" | "change" | "unlink";
  /** 서버가 방금 쓴 파일이면 true — 클라이언트는 알림을 무시해야 한다. */
  self: boolean;
}

export interface FileWatcherOptions {
  root: string;
  onChange: (e: ChangeEvent) => void;
  debounceMs?: number;
  ignore?: string[];
  /** 사람이 직접 저장했을 때 시각(ms). 이 구간 안의 이벤트는 자기 쓰기로 본다. */
  markSelfWrite?: (path: string) => number;
  selfWriteWindowMs?: number;
  /** 감시 자체가 실패했을 때(예: 파일 한도 초과). 조용히 삼키지 않는다. */
  onError?: (message: string) => void;
}

export class WorkspaceWatcher {
  private w: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  /** 우리가 직접 쓴 시각. */
  private selfWrites = new Map<string, number>();
  private debounceMs: number;
  private selfWindow: number;
  private externalMark: (path: string) => number;
  /** 큐에 올라간 종류 — 같은 파일이 add/change 로 두 번 오면 한 번만 보낸다. */
  private pendingKind = new Map<string, ChangeEvent["kind"]>();

  constructor(private opts: FileWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 120;
    this.selfWindow = opts.selfWriteWindowMs ?? 1500;
    this.externalMark = opts.markSelfWrite ?? (() => 0);
  }

  start(): void {
    if (this.w) return;
    this.w = watch(this.opts.root, {
      ignoreInitial: true,
      ignored: this.opts.ignore ?? DEFAULT_IGNORED,
      // 폴더만 따라간다. **한 단계 위**로 새면 /home 을 순회한다.
      depth: 12,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 30 },
    });
    const emit = (kind: ChangeEvent["kind"]) => (p: string) => this.onEvent(kind, p);
    this.w.on("add", emit("add"));
    this.w.on("change", emit("change"));
    this.w.on("unlink", emit("unlink"));
    this.w.on("error", (e) => this.opts.onError?.(String(e)));
  }

  private onEvent(kind: ChangeEvent["kind"], rawPath: string): void {
    const rel = this.relativize(rawPath);
    if (!rel) return;
    const prev = this.timers.get(rel);
    if (prev) clearTimeout(prev);
    // 같은 파일에서 add/change 가 겹치면 **먼저 온 종류**를 유지한다.
    // change 로 덮으면 이미 있는 파일이 "새 파일" 로 보인다(사라진 파일이 생긴 셈).
    if (!this.pendingKind.has(rel)) this.pendingKind.set(rel, kind);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        const k = this.pendingKind.get(rel) ?? kind;
        this.pendingKind.delete(rel);
        const written = Math.max(this.selfWrites.get(rel) ?? 0, this.externalMark(rel));
        this.selfWrites.delete(rel);
        const self = written > 0 && Date.now() - written <= this.selfWindow;
        this.opts.onChange({ path: rel, kind: k, self });
      }, this.debounceMs),
    );
  }

  /**
   * 파일을 직접 쓴다 — 감시기가 이 쓰기를 **자기 쓰기** 로 표시하게 한다.
   * 쓰기 **전**에 호출해야 한다(chokidar 가 이벤트를 비동기로 낸다).
   */
  noteSelfWrite(path: string, at = Date.now()): void {
    this.selfWrites.set(this.relativize(path) ?? path, at);
  }

  private relativize(p: string): string | null {
    if (!p) return null;
    const root = this.opts.root;
    const abs = isAbsolute(p) ? p : `${root}${sep}${p}`;
    const rel = relative(root, abs);
    // 루트 밖은 감시 대상이 아니다 — `..` 로 시작하면 버린다.
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).join("/");
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pendingKind.clear();
    this.selfWrites.clear();
    const w = this.w;
    this.w = null;
    if (w) await w.close();
  }

  get watching(): boolean {
    return this.w !== null;
  }
}
