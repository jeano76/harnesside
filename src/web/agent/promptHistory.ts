/**
 * 프롬프트 입력창 히스토리 — `↑` `↓` 로 지난 프롬프트를 다시 꺼낸다.
 *
 * ── 왜 순수 함수로 분리하나 (이 저장소 관례) ─────────────────────────────────
 *
 * 화면 안에서 다 판단하면 브라우저 없이 검증할 수 없다. 규칙을 `.ts` 에 두고
 * `.tsx` 는 렌더만 한다 — 그래서 "몇 번째로 과거인지" 같은 상태 계산이
 * 테스트 가능해진다.
 *
 * ── 셸을 흉내 내지 않는다 ────────────────────────────────────────────────────
 *
 * readline 처럼 `↑` 를 무조건 과거에 대는 것은 하지 않는다. 그러면 두 줄로
 * 쓴 프롬프트 안에서 커서를 한 줄 위로 못 옮긴다 — 본문을 고치는 중인데 과거가
 * 끼어들면 그건 기능이 아니라 버그다.
 *
 * 그래서 **커서가 있는 줄을 먼저 본다.**
 *  - `↑` 는 커서가 **첫 줄**일 때만 과거로 간다
 *  - `↓` 는 커서가 **마지막**일 때만 미래로 간다(가장 최신 다음)
 *
 * 그래도 기본 동작(커서 이동)은 그대로 살아 있다.
 *
 * ── 슬래시 메뉴와 겹치지 않는다 ──────────────────────────────────────────────
 *
 * `/` 를 치면 메뉴가 뜨고 `↑` `↓` 는 **후보 이동**이 된다. 그건 더 좁고 더
 * 급한 요구이므로 **메뉴가 먼저**다. 여기서는 그 경우가 닫혔을 때의 동작만
 * 책임진다.
 */

/** 브라우즈 상태. `index === items.length` 이면 브라우즈가 끝나 있고(즉 새 입력), 그보다 작으면 과거를 보고 있다. */
export interface PromptHistoryState {
  /** 과거 프롬프트. **오래된 것 → 최신** 순. */
  items: string[];
  /** 지금 보고 있는 위치. `items.length` 는 "최신 다음"(새 입력). */
  index: number;
  /** 브라우즈를 시작하기 **전에** 입력창에 있던 글. 되돌아오면 복원한다. */
  stash: string;
}

export function historyState(items: string[]): PromptHistoryState {
  return { items, index: items.length, stash: "" };
}

/**
 * 대화에서 지난 프롬프트를 꺼낸다.
 *
 * - 앞뒤 공백만 있는 것은 버린다(빈 줄을 `↑` 로 꺼내는 것은UX 결함이다)
 * - **연속 중복**은 하나로 합친다 — 같은 말을 두 번 연속 보낸 건 한 번만 꺼낸다
 * - 연속이 아닌 중복은 **지우지 않는다.** "1번, 2번, 1번" 은 셋 다 실제로 보낸
 *   말이므로 셋 다 남긴다(단순 `Set` 으로 만들면 셋 중 하나가 사라진다).
 */
export function buildHistory(prompts: string[]): string[] {
  const out: string[] = [];
  for (const raw of prompts) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    if (out.length > 0 && out[out.length - 1] === t) continue;
    out.push(t);
  }
  return out;
}

/** 커서 위치가 몇 번째 줄인지. 개행 개수를 센다. */
export function caretLine(text: string, caret: number): number {
  const upTo = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  let line = 0;
  for (const ch of upTo) if (ch === "\n") line++;
  return line;
}

/** `↑` 를 과거로 써도 되는가 — 커서가 첫 줄이어야 한다. */
export function shouldRecallUp(text: string, caret: number): boolean {
  return caretLine(text, caret) === 0;
}

/** `↓` 를 미래로 써도 되는가 — 커서가 마지막이어야 한다(가장 최신 다음). */
export function shouldRecallDown(text: string, caret: number): boolean {
  return caret >= text.length;
}

export type Recall = { next: PromptHistoryState; text: string } | null;

/** 한 칸 과거로. 더 없으면 `null` — 커서를 움직이지 않는다. */
export function recallUp(st: PromptHistoryState, current: string): Recall {
  if (st.items.length === 0) return null;
  if (st.index === st.items.length) return { next: { ...st, index: st.index - 1, stash: current }, text: st.items[st.index - 1] };
  if (st.index === 0) return null;
  return { next: { ...st, index: st.index - 1 }, text: st.items[st.index - 1] };
}

/**
 * 한 칸 미래로. **최신 다음(새 입력)까지 가면 stash 를 되살린다** — 브라우즈를 시작하기 전에
 * 쓰던 반쯤 쓴 문장을 잃어버리면 "확인하려고 눌렀다 지워졌다" 가 된다.
 */
export function recallDown(st: PromptHistoryState): Recall {
  if (st.index >= st.items.length) return null;
  const next = st.index + 1;
  return { next: { ...st, index: next }, text: next >= st.items.length ? st.stash : st.items[next] };
}

/** **글을 고치면 브라우즈를 그만둔다.** 그래야 다음 `↑` 가 최신부터 다시 시작한다. */
export function cancelBrowse(st: PromptHistoryState): PromptHistoryState {
  if (st.index === st.items.length) return st;
  return { ...st, index: st.items.length, stash: "" };
}