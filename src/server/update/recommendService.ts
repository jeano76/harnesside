/**
 * 추천 알림 배선 (M13 · §5.13.2).
 *
 * 이 모듈의 판단은 이미 완성돼 있었다: 적합도, 노이즈 규칙, 무시(silence) 키, 백그라운드
 * 체크 정책까지. **하지만 아무것도 불러 오지 않았다** — 라우트도 없고, UI 도 없고,
 * 감시 스케줄도 없었다. 2026-09-30 실측: `grep -rn "notify" src/server/index.ts` 의
 * 결과는 0건.
 *
 * 그러므로 이 파일이 하는 일은 세 가지다:
 *  1. **판정에 데이터를 공급한다** — 모델 디렉터리와 실행 중 바이너리, 현재 계열.
 *  2. **스케줄한다** — 유휴 시 · 1시간에 한 번 · 오프라인 조용 통과 · 429 는 기다린다.
 *  3. **결과를 사용자에게 보낸다** — 배너가 필요한 것(`needsBanner`)은 배너로.
 *
 * ── 가장 조용히 위험한 지점 ──────────────────────────────────────────────────
 * **판정이 화면에 안 나타나면 알림 기능은 없는 것** 이다. 그래서 알림을 **버리지 않고**
 * `notices` 에 남겨 두며, 확인 API 로 언제든 다시 볼 수 있게 한다. 무시(silence)도
 * 서버 상태이므로 창을 닫아도 재발하지 않는다 — "무시 후 재발 없음" 은 요구 조건이다.
 */

import { stat, readdir } from "node:fs/promises";
import {
  detectLlama,
  detectNewModels,
  newCheckState,
  newWatchState,
  onOffline,
  onOnline,
  onRateLimited,
  parseModelName,
  scanModels,
  shouldCheck,
  silence,
  sortNotices,
  DEFAULT_CHECK,
  type CheckPolicy,
  type CheckState,
  type RecommendationNotice,
  type WatchState,
} from "./notify.js";

export interface RecommendationServiceDeps {
  modelsDir: string;
  /** 현재 쓰 중인 llama-server 바이너리. 없으면(설치 안 됨) llama 감시는 건너뛴다. */
  llamaBinPath?: string | null;
  /** 지금 실행 중인 llama-server 의 실제 플래그. 비어 있으면 판정을 하지 않는다. */
  runningFlags?: () => string[];
  /** 설정이 기대하는 플래그. 다르면 "튜닝이 무효화되었다" 고 알린다. */
  expectedFlags?: () => string[];
  /** 유휴 판정 — 에이전트 턴이 도는 중이거나 단어가 입력 중이면 false. */
  isIdle?: () => boolean;
  /** 오프라인 판정. 기본은 `navigator` 를 보지 않는다 — 서버라 모른다. */
  isOffline?: () => boolean;
  log?: (line: string) => void;
  now?: () => number;
  /** 주기적 재검사. 기본 30분. */
  intervalMs?: number;
  /** 백그라운드 체크 정책(유휴 시 · 최소 간격 · 429 백오프). 기본은 `DEFAULT_CHECK`. */
  policy?: CheckPolicy;
  /** 현재 실행 중 llama-server 의 플래그를 **실제로** 읽는다(없으면 빈 배열). */
  readRunningFlags?: () => string[];
  fetchImpl?: typeof fetch;
}

export interface RecommendationService {
  /** 확인 — **판정만**. 네트워크를 쓰지 않는다(로컬 파일만 본다). */
  check(now?: number): Promise<RecommendationNotice[]>;
  /** 지금까지 알린 것. 무시한 것도 **목록으로** 남는다(§5.10: 개수가 아니라 목록). */
  list(): RecommendationNotice[];
  /** 이 항목 무시. 같은 것은 재발하지 않는다. */
  silenceByKey(silenceKey: string): boolean;
  /** 무시한 목록. 지워져야 할 때의 근거로 남긴다. */
  silenced(): string[];
  /** 현재 모델의 계열·양자화. 사용자가 고르면 바꿔야 한다. */
  setCurrent(file: string | null): void;
  /** 주기 검사 시작. 중복 호출해도 한 번만 돈다. */
  start(): void;
  stop(): void;
  /**
   * **사용자가 명시적으로** 요청한 즉시 검사.
   *
   * 최소 간격을 건너뛴다 — 간격은 "배경이 과하게 돌지 않게" 하는 것이지 사용자의
   * 요청을 막으려는 것이 아니다. 이 구분이 없으면 방금 검사했는데도 "너무 이릅니다" 로
   * 조용해져, 사용자는 버튼을 눌렀는데 아무 일이 없었다고 읽는다(§5.13.2 와 반대).
   */
  checkNow(): Promise<RecommendationNotice[]>;
  /** 마지막으로 조용히 넘긴 이유 — 배너가 아니라 로그 한 줄. */
  lastQuietReason(): string | null;
}

export function createRecommendationService(deps: RecommendationServiceDeps): RecommendationService {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const watch: WatchState = newWatchState();
  // 이름이 겹치지 않게 한다 — `check`(함수) 와 `check`(상태) 둘 다 쓰는 게 자연스럽지만
  // 같은 스코프에서 둘 다 선언하면 **나중에 고치는 사람이 잘못된 쪽을 고친다.**
  const checkState: CheckState = newCheckState();
  const notices: RecommendationNotice[] = [];
  let current: { family: string; quant: string | null } | { family: string; quant: string | null } = { family: "", quant: null };
  let timer: NodeJS.Timeout | null = null;
  let quietReason: string | null = null;
  /** 첫 조회는 **무조건** 돌린다 — `minIntervalMs` 이 "방금 안 했다" 를 막으면
   * 시작 직후에 아무것도 안 본다. 한 번 본 뒤부터 간격을 지킨다. */
  let firstDone = false;
  const policy: CheckPolicy = deps.policy ?? DEFAULT_CHECK;

  setCurrentFromDisk(deps.modelsDir, current);

  function setCurrentFromDisk(dir: string, into: { family: string; quant: string | null }): void {
    // 설정의 경로를 여기서는 모른다. 디렉터리에서 가장 큰 것을 현재로 본다 —
    // 부팅 단계가 이미 `chooseModel` 로 같은 결정을 내렸으므로 **모순되지 않게**.
    void readdir(dir)
      .catch(() => [] as string[])
      .then((names) => {
        const ggufs = names.filter((n) => n.toLowerCase().endsWith(".gguf"));
        if (!ggufs.length) return;
        ggufs.sort();
        const picked = ggufs[ggufs.length - 1];
        const p = parseModelName(picked);
        into.family = p.family;
        into.quant = p.quant;
      });
  }

  async function doCheck(): Promise<RecommendationNotice[]> {
    const candidates = await scanModels(deps.modelsDir, (p) => readdir(p));
    const found = detectNewModels(watch, candidates, current, now());

    const bin = deps.llamaBinPath;
    if (bin) {
      const st = await stat(bin).catch(() => null);
      if (st?.isFile()) {
        found.push(
          ...detectLlama(
            watch,
            {
              binaryMtimeMs: st.mtimeMs,
              binarySize: st.size,
              flags: deps.runningFlags?.() ?? [],
              expectedFlags: deps.expectedFlags?.() ?? [],
            },
            now(),
          ),
        );
      }
    }

    if (found.length) {
      // **중복으로 쌓지 않는다.** 같은 silenceKey 가 이미 있으면 갱신하지 않는다 —
      // 창을 여러 번 열면 목록이 몇 배로 불어나고, 그건 "알림" 이 아니라 노이즈다.
      for (const n of sortNotices(found)) {
        if (notices.some((x) => x.silenceKey === n.silenceKey)) continue;
        notices.push(n);
        log(`[recommend] ${n.severity}: ${n.title}`);
      }
      // 목록이 무한정 쌓이지 않게 — 배너로 승격된 것만 남긴다.
      if (notices.length > 50) notices.splice(0, notices.length - 50);
    }
    return sortNotices(found);
  }

  async function check(at = now()): Promise<RecommendationNotice[]> {
    const state: CheckState = { ...checkState, idle: deps.isIdle?.() ?? true, offline: deps.isOffline?.() ?? false };
    // **오프라인과 유휴는 첫 조회에서도 지킨다.** 예전에는 `firstDone` 하나로 둘 다를
    // 건너뛰었는데, 그것은 "창을 열자마자 유저를 배너로 때리는" 경로였다. 시작 직후에
    // 네트워크가 없는데 "새 모델" 이 보이면 사용자는 오류를 찾으러 온다(§5.13.2).
    //
    // **간격만** 첫 조회에서 면제한다. 이게 없으면 부팅하자마자 `lastCheckAt = 0` 이라
    // "방금 검사했다" 고 판단해 **시작 직후에 아무것도 안 보인다**(테스트가 이걸 잡았다 —
    // 가짜 시계가 0 근처에서 시작하니까).
    if (state.offline) {
      quietReason = "offline";
      return [];
    }
    // `idleOnly` 는 **정책** 이다 — `isIdle` 를 주지 않았으면 정책이 무시된다(기본값 true).
    // 조용한 판정을 통과시키는 게 아니라, 정책이 켜져 있을 때만 물어본다.
    if (policy.idleOnly && !state.idle) {
      quietReason = "busy";
      return [];
    }
    if (firstDone) {
      // **같은 시계를 쓴다.** `shouldCheck` 는 세 번째 인자가 없으면 `Date.now()` 를 쓴다.
      // 즉 여기서 시각을 안 넘기면 서비스의 시계와 판정의 시계가 갈라진다 — 실제론
      // 우연히 같지만, 주입된 시계(테스트·가짜 시계)에서는 **간격 판정이 영영 안 걸린다.**
      const d = shouldCheck(state, policy, at);
      if (!d.run) {
        quietReason = d.quiet ?? "unknown";
        return [];
      }
    }
    checkState.lastCheckAt = at;
    checkState.offline = state.offline;
    checkState.idle = state.idle;
    firstDone = true;
    quietReason = null;
    return doCheck();
  }

  return {
    async check(at?: number) {
      return check(at);
    },
    list() {
      return sortNotices(notices);
    },
    silenceByKey(silenceKey) {
      const found = notices.find((n) => n.silenceKey === silenceKey);
      if (!found) return false;
      silence(watch, found);
      // 목록에서는 사라지되 **기억은 남는다**(재발하지 않음).
      const i = notices.indexOf(found);
      if (i >= 0) notices.splice(i, 1);
      return true;
    },
    silenced() {
      return [...watch.silenced];
    },
    setCurrent(file) {
      if (!file) {
        current = { family: "", quant: null };
        return;
      }
      const p = parseModelName(file);
      current = { family: p.family, quant: p.quant };
    },
    start() {
      // **중복 호출해도 한 번만.** 두 타이머가 같은 검사를 두 번 하면 같은 알림이
      // 두 번 나오는데, `seen` 지문은 그것을 막지 못한다(같은 시점의 같은 파일).
      if (timer) return;
      const tick = async () => {
        try {
          await check();
        } catch (e) {
          // **배경 실패는 배너가 아니다.** 사용자가 오류를 고치러 오게 만든다.
          log(`[recommend] 검사 실패(조용히): ${e instanceof Error ? e.message : String(e)}`);
        }
      };
      void tick();
      timer = setInterval(() => void tick(), deps.intervalMs ?? 30 * 60_000);
      // **이 타이머는 "진짜로 기다리는 중"** — 이벤트 루프를 붙잡아야 주기가 실제로 돈다.
      // `unref` 하면 프로세스가 나갈 때까지 한 번도 안 돈다(§④ 표 7 과 같은 부류).
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async checkNow() {
      // 간격만 건너뛴다. `shouldCheck` 에 정책 대신 `minIntervalMs: 0` 을 주면
      // **유휴·오프라인은 그대로 지켜진다**(§5.13.2 의 조용 통과는 그대로여야 한다).
      const saved = policy.minIntervalMs;
      policy.minIntervalMs = 0;
      try {
        return await check();
      } finally {
        policy.minIntervalMs = saved;
      }
    },
    lastQuietReason() {
      return quietReason;
    },
  };
}

/**
 * 오프라인/429 를 반영한다. **실패를 배너로 만들지 않는다** — 배너는 "사용자가
 * 뭔가 해야 한다" 는 뜻이고, 429 는 아무것도 하지 않으면 되는 상황이다.
 */
/** 오프라인 상태 전이 — 판단 정본을 한 곳에 둔다. */
export function applyOffline(state: CheckState, offline: boolean): CheckState {
  return offline ? onOffline(state) : onOnline(state);
}

/** 429 — 기다린다. 재시도 루프에 넣지 않는다. */
export function applyRateLimit(state: CheckState, at: number): CheckState {
  return onRateLimited(state, at);
}

