/**
 * 편집기 자동 저장 (M6 · §5.1).
 *
 * 규칙은 셋이고, 셋 중 하나라도 없으면 사용자는 데이터를 잃습니다:
 *  1. **디바운스** — 타이핑마다 쓰면 디스크 I/O 가 입력을 끊는다.
 *  2. **버전 충돌은 조용히 덮어쓰지 않는다** — 서버의 `baseVersion` 이 다르면 409 와
 *     서버본문이 온다. **그 본문을 버리면 사용자는 "저장됐다" 고 believing 자기 편집을
 *     잃는다**(§3.4). 그래서 보존하고 사용자에게 선택을 준다.
 *  3. **창을 닫아도 남는다** — 닫기 직전 미저장 내용을 `localStorage` 에 남긴다.
 *
 * 판단 로직은 **순수하게** 분리한다(`planSave`):언제 저장할지·무엇을 보낼지·
 * 충돌을 어떻게 말할지를 여기서 계산하고, I/O 는 호출자가 한다. 그래야 "3초 뒤 저장"
 * 이라는 규칙이 테스트할 수 있다.
 */

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const LOCAL_DRAFT_KEY = "harnesside:dirty";

export interface Buffer {
  path: string;
  content: string;
  /** 마지막으로 서버가 준 버전. 충돌 판정의 기준. */
  baseVersion: number;
  dirtySince: number | null;
}

export type SaveDecision =
  | { action: "save"; body: { path: string; content: string; baseVersion: number } }
  | { action: "skip"; reason: string }
  | { action: "conflict"; body: { path: string; content: string; baseVersion: number }; server: { content: string; version: number } };

/**
 * 지금 저장해야 하는가.
 *
 * `now - dirtySince >= debounce` 면 저장한다. **깨끗하면 저장하지 않는다** — 안 고친
 * 파일을 PUT 하면 파일의 mtime 이 바뀌고, 그 파일은 "외부 변경됨" 알림을 만든다(§5.2).
 * 즉 저장이 **알림을 유발하는** 순간이 된다(실제로 그렇게 돌아온다).
 */
export function planSave(b: Buffer, now: number, debounceMs = AUTOSAVE_DEBOUNCE_MS): SaveDecision {
  if (b.dirtySince === null) return { action: "skip", reason: "바뀐 것이 없습니다" };
  if (now - b.dirtySince < debounceMs) return { action: "skip", reason: "아직 디바운스 중" };
  if (!b.content.length && b.baseVersion > 0) {
    // **빈 내용이 되면 저장하지 않는다** — 실수로 전부 지운 뒤 창을 닫으면
    // 파일이 빈 채로 남는다(원본이 사라진다). 그건 사용자가 명시적으로 해야 한다.
    return { action: "skip", reason: "내용을 모두 지웠습니다 — 빈 파일 저장은 명시적 저장이어야 합니다" };
  }
  return { action: "save", body: { path: b.path, content: b.content, baseVersion: b.baseVersion } };
}

/* ───────────────────────── 바깥에서 파일이 바뀐 경우 ───────────────────────── */

/**
 * 디스크의 같은 파일이 **바깥에서** 바뀌었을 때, 버퍼를 어떻게 할 것인가.
 *
 * ── 왜 이 판단이 필요한가 (실측으로 본 결함) ─────────────────────────────────
 *
 * 에디터의 버퍼는 `EditorView` 안의 ref 다. 그 ref 의 기준은 `info.content` 과
 * `info.version` 이고, `info` 가 새 값으로 오면 **버퍼를 통째로 갈아끼웠다.**
 * 즉 바깥에서 파일이 바뀌면 열린 파일이 **아무 말 없이 옛 내용으로 돌아갔다.**
 * 사용자는 "저장했는데 왜 옛 내용이네" 하고 자기 편집을 잃었다.
 *
 * 그런데 **미저장 편집이 있을 때 갱신하면 더 나쁘다** — 바깥 변경이 사용자 편집을
 * 지운다. 그래서 아무 때나 갱신하는 것도, 아무 때나 말리는 것도 답이 아니다.
 *
 * 규칙은 하나다: **사용자가 손대지 않은 버퍼만 따라간다.**
 *  - 안 고쳤으면 → 디스크를 따른다(그게 사용자가 기대하는 동작이다)
 *  - 고치는 중이면 → **보존한다.** 대신 왜 그대로인지 **말한다**
 *
 * 같은 이유로 **내용이 같으면 갱신하지 않는다** — 버전만 바뀌었을 수 있다.
 * 커서 위치와 접힌 상태를 잃을 이유가 없다.
 */
export type ExternalChangePlan =
  | { action: "adopt"; why: string }
  | { action: "keep"; why: string };

export function planExternalChange(b: Buffer, disk: { content: string; version: number }): ExternalChangePlan {
  if (b.dirtySince !== null) {
    // **미저장 편집이 있으면 절대 덮지 않는다.** 이 프로그램의 다른 곳
    // (`planSave` 의 충돌 처리) 도 같은 원칙을 따른다 — 조용히 덮어쓰지 않는다.
    return { action: "keep", why: "저장하지 않은 편집이 있어 그대로 둡니다" };
  }
  if (disk.content === b.content) {
    // 내용이 같으면 손댈 것이 없다. `mtime` 만 바뀐 경우도 여기 걸린다.
    return { action: "keep", why: "내용이 같습니다" };
  }
  return { action: "adopt", why: "저장하지 않은 편집이 없어 디스크를 따랐습니다" };
}

export interface LocalDraft {
  path: string;
  content: string;
  baseVersion: number;
  at: number;
}

/** 창을 닫기 직전에 남길 것 — **경로와 버전까지** 있어야 복원할 수 있다. */
export function saveLocalDraft(d: LocalDraft, store: Storage | null): void {
  if (!store) return;
  try {
    store.setItem(LOCAL_DRAFT_KEY, JSON.stringify(d));
  } catch {
    // 용량 초과 등 — 조용히 넘기지 않고, 호출자가 "못 남겼다" 고 말할 수 있게 한다.
  }
}

export function loadLocalDraft(store: Storage | null): LocalDraft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(LOCAL_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as LocalDraft;
    if (typeof d?.path !== "string" || typeof d?.content !== "string") return null;
    return d;
  } catch {
    return null;
  }
}

export function clearLocalDraft(store: Storage | null): void {
  try {
    store?.removeItem(LOCAL_DRAFT_KEY);
  } catch {
    /* 없음 */
  }
}

export type ConflictChoice = "keep-mine" | "take-theirs" | "both";

/**
 * 충돌 시 선택지. **"덮어쓰기" 같은 단독 버튼을 두지 않는다.**
 *
 * 선택지가 하나뿐이면 사용자는 그 버튼이 옳은 것이라 믿고 누른다. 서버본문을 보여주고
 * 나란히 둘 수 있게 해야 (§3.4) 결정을 정보로 할 수 있다.
 */
export function conflictOptions(server: { content: string; version: number }): { choice: ConflictChoice; label: string; detail: string }[] {
  return [
    { choice: "keep-mine", label: "내 편집 유지", detail: "서버본문을 덮어씁니다. 되돌리려면 저장소에서 복구해야 합니다." },
    { choice: "take-theirs", label: "서버본문 사용", detail: "내 편집을 잃습니다." },
    { choice: "both", label: "둘 다 남기기", detail: "서버본문을 먼저 두고 내 편집을 뒤에 붙입니다(수동 정리 필요)." },
  ];
}

/** 충돌 해결 — 내 편집과 서버본문을 합친 최종 텍스트. */
export function applyChoice(choice: ConflictChoice, mine: string, theirs: string): string {
  switch (choice) {
    case "keep-mine":
      return mine;
    case "take-theirs":
      return theirs;
    case "both":
      return `${theirs}\n\n${mine}`;
  }
}
