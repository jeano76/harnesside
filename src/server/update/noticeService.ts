/**
 * 추천 알림 서비스 — M13 배선 (§5.13.2).
 *
 * 판단 로직(`notify.ts` — detect/silence)은 있었으나 **라우트도 UI 도 없어**
 * "돌면 되지만 실행하지 않는다" 상태였다(◐). 이 서비스가 그 연결이다:
 * 판단 결과를 들고 있고, silence 만 디스크에 남긴다.
 *
 * - silence = 영구 ("다시 보지 않기") → state 파일에 저장, 재시작 후에도 유지
 * - dismiss = 이번 세션만 숨김 → 메모리, 재시작하면 다시 보인다
 * - 둘을 섞으면 "읽음 처리했는데 재시작하니 다시 뜬다" 또는 그 반대가 된다
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  newWatchState,
  scanModels,
  detectNewModels,
  parseModelName,
  type WatchState,
  type RecommendationNotice,
} from "./notify.js";

export interface NoticeRefreshResult {
  scanned: number;
  added: number;
  notices: RecommendationNotice[];
}

export class NoticeService {
  private watch: WatchState = newWatchState();
  private active = new Map<string, RecommendationNotice>();
  private dismissed = new Set<string>();

  constructor(private readonly stateFile: string) {}

  /** silence 키 불러오기. 없으면 빈 채로 시작 (실패가 아니다). */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf8");
    } catch {
      return;
    }
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        for (const k of arr) if (typeof k === "string") this.watch.silenced.add(k);
      }
    } catch {
      // 깨진 파일은 버리고 새로 시작 — 깨진 silence 때문에 알림이 영원히
      // 안 뜨는 것보다 낫다. 단 조용히는 아니다: 호출부가 로그를 남긴다.
      throw Object.assign(new Error(`알림 무시 목록이 깨졌습니다: ${this.stateFile}`), { corrupt: true });
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify([...this.watch.silenced].sort(), null, 2), "utf8");
  }

  /**
   * 모델 디렉터리 한 번 훑기. 새 파일이면 알림을 만든다.
   * currentModelPath 가 없으면 계열 판정이 안 되므로 훑지 않고 빈 결과를 준다 —
   * "모델을 모른다" 를 "새 모델 없음" 으로 말하지 않는다.
   */
  async refreshModels(
    dir: string,
    list: (p: string) => Promise<string[]>,
    currentModelPath: string | null
  ): Promise<NoticeRefreshResult> {
    if (!currentModelPath) return { scanned: 0, added: 0, notices: this.list() };
    const cands = await scanModels(dir, list);
    const cur = parseModelName(currentModelPath);
    const fresh = detectNewModels(this.watch, cands, { family: cur.family, quant: cur.quant });
    for (const n of fresh) {
      if (!this.active.has(n.id)) this.active.set(n.id, n);
    }
    // 사라진 파일의 알림은 내린다 — 없는 것을 계속 권하면 거짓말이다.
    const alive = new Set(cands.map((c) => `model:${c.file}:${c.fingerprint}`));
    for (const id of [...this.active.keys()]) {
      if (id.startsWith("model:") && !alive.has(id)) this.active.delete(id);
    }
    return { scanned: cands.length, added: fresh.length, notices: this.list() };
  }

  /** 보이는 목록 — silenced 는 detect 단계에서 이미 빠지고, dismissed 는 여기서 뺀다. */
  list(): RecommendationNotice[] {
    return [...this.active.values()]
      .filter((n) => !this.dismissed.has(n.id))
      .sort((a, b) => b.at - a.at);
  }

  /** 이번 세션만 숨김. 없으면 false (404 로 알린다). */
  dismiss(id: string): boolean {
    if (!this.active.has(id)) return false;
    this.dismissed.add(id);
    return true;
  }

  /** 영구 무시. 없으면 false (404 로 알린다). */
  async silence(id: string): Promise<boolean> {
    const n = this.active.get(id);
    if (!n) return false;
    this.watch.silenced.add(n.silenceKey);
    this.active.delete(id);
    this.dismissed.delete(id);
    await this.save();
    return true;
  }
}
