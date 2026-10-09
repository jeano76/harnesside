/** 마지막 답변이 *여러 선택지*를 나열하고 고르라고 했는지 감지한다 (순수 함수).
 *
 * 에이전트가 답한 뒤 사용자가 뭘 할지 모르는 상태를 막기 위해, 이런 응답이면
 * 입력창에 미리 "무엇을 고를까요?" 를 채운다(`main.tsx`). **감지만** 하고 —
 * 제안 문구 자체는 i18n 키가 담당하므로 여기서 상수를 만들지 않는다. 판단 기준은 느슨하게:
 *
 * 1. 번호/기호로 목록화 돼 있다 (`1) ...`, `- ...`, `(A) ...`), OR
 * 2. 고르라는 어휘가 있다 ("고르세요 / 선택하세요 / 중 하나 / choose").
 *
 * 두 조건이 있으면 강력한 신호(정확도 높음), 첫 조건만 있으면 약한 신호다. */

/** 목록 항목을 시작하는 기호 — "- 내용", "* 내용", "• 내용" (내용 없으면 마커만 있는 줄도 목록으로 본다). */
const bulletStart = /^\s*[-•*](?:\s+\S|\s*$)/;

/** "1) 내용", "2. 내용" 같은 번호 목록. */
const numberedStart = /^\s*\d+\s*[)\.](?:\s+\S|\s*$)/;

/** "(A) 내용", "[1] 내용", "A) 내용", "A. 내용" 같은 글자/괄호 목록. */
const letteredStart = /^\s*(?:\([A-Za-z0-9]+\)|\[[A-Za-z0-9]+\]|[A-Za-z0-9]\s*[)\].:])(?:\s+\S|\s*$)/;

function isListLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return bulletStart.test(t) || numberedStart.test(t) || letteredStart.test(t);
}

/** "고르다 / 선택하다 / 골라 / pick / choose" 계열 어휘. */
const chooseVerbs = /고르|선택|중 하나|either\s+.*\s+or|\b(pick(?:ing)?|choose|select)\b/i;

/** 번호 매긴 항목이 몇 개 있는지 세고, 선택 어휘가 있으면 강화한다. */
export function isMultipleChoice(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 3) return false;

  // 여러 목록 항목을 센다 — 최소 2개이면 "여러 선택지" 후보.
  let listItems = 0;
  for (const line of t.split(/\r?\n/)) {
    if (isListLine(line)) listItems++;
  }
  const hasList = listItems >= 2;

  // 번호 목록이 있으면 강력한 신호(예: "1) A\n2) B").
  if (hasList) return true;

  // 약한 신호 — 선택 어휘만 있다. 빈 응답이면 신호가 아니다.
  return chooseVerbs.test(t);
}
