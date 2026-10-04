/**
 * 에이전트 **시스템 프롬프트** (2026-10-05 · 가독성).
 *
 * ── 왜 이 파일이 따로 있는가 ────────────────────────────────────────────────
 * 프롬프트를 `server/index.ts` 안에 두면 두 가지가 불가능해진다: 브라우저나
 * 서버를 띄우지 않고 **내용을 검사**할 수 없고, "이 문장이 어떤 규칙을 담고
 * 있는지" 를 한 곳에 적을 수 없다. 이 저장소 관례대로 규칙은 `.ts` 에 있고
 * 렌더(출력)는 호출하는 쪽에 둔다.
 *
 * ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
 * 시스템 프롬프트가 네 줄뿐이었고, 그중 **출력 형식에 관한 단 한 줄도 없었다.**
 * 그래서 모델은 배운 대로 — 앞 문장에 쉼표로 이어 붙인 긴 문단으로 — 답했다.
 * 2026-10-05 사용자가 실제outputs를 붙여 complaint한 것이 그것이다:
 * "저장소 구조를 설명하겠습니다." 뒤에 쉼표만 늘어진 600자짜리 문단,
 * `src/` 아래 모듈 17개가 괄호 안에 쉼표로 나열된 한 줄, `.ci/` 와 `.gitignore`
 * 가 뒤섞인 마지막 문장. **정보는 전부 맞았고 아무도 못 읽었다.**
 *
 * 화면 쪽은 이미 준비돼 있었다: `Markdown.tsx` 는 표·제목·목록·코드펜스를
 * 스타일 있게 그린다(`PROMPT_UX_COMMERCIAL.md` §3.7·§3.12·§3.13). 즉 문제는
 * **렌더러가 아니라 재료**였다. 재료가 벽으로 들어오면 어떤 렌더러도 못 살린다.
 *
 * ── 이 규칙이 거짓말할 수 있는 경우 ─────────────────────────────────────────
 *  1. **프롬프트 규칙은 강제가 아니다.** 모델이 어길 수 있다. 그래서 규칙만으로
 *     충분하다고 말하지 않고, 실제로 답의 모양을 **측정**할 수 있는 순수 함수를
 *     함께 둔다(`readabilityFlags`) — 규칙이 지켜지지 않는다면 그 사실이
 *     보인다(조용히 통과시키지 않는다).
 *  2. 규칙이 늘면 답이 변형 규칙에 쓰인다. 그래서 **8줄로 고정**하고, 새 규칙을
 *     넣을 때는 하나를 빼는 것을 요구한다(`MAX` 근거는 테스트가 지킨다).
 *  3. 짧게 쓰라는 규칙과 근거를 다 쓰라는 규칙은 충돌한다. 이 모듈은
 *     **요약 → 근거** 순서를 정해 충돌을 해소한다: 결론은 1줄, 근거만 길게.
 */

/**
 * 출력 형식 규칙. **순서 = 우선순위.** 각 항목에 `id` 가 있는 이유는
 * 테스트가 "몇 번째 줄" 이 아니라 **어느 규칙이 사라졌는지** 말하게 하기 위해서다.
 *
 * 왜 8줄인가: 이건 화면이다. 브라우저 한 열에 들어가는 분량만 쓴다. 더 쓰면
 * 모델이 규칙을 지키는 대신 규칙을 요약하는 데 문장을 쓴다(실측된 패턴).
 */
export interface AnswerFormatRule {
  id: string;
  text: string;
}

export const ANSWER_FORMAT_RULES: readonly AnswerFormatRule[] = [
  {
    id: "one-idea-per-paragraph",
    text: "한 문단 = 한 생각. 문단은 3줄(약 120자)을 넘지 않는다. 넘으면 목록으로 나눈다.",
  },
  {
    id: "conclusion-first",
    text: "첫 줄에 결론(무엇을 했는지 · 무엇이 문제인지)을 한 문장으로 쓴다. 근거는 그다음.",
  },
  {
    id: "list-for-three-or-more",
    text: "나열할 것이 3개 이상이면 `-` 목록, 순서가 있으면 `1.` 목록을 쓴다. 쉼표로 이어 붙이지 않는다.",
  },
  {
    id: "table-for-comparison",
    text: "전후·옵션·파일 비교는 표(`| --- |`)로 쓴다. 표가 부적절하면 목록.",
  },
  {
    id: "code-fences-for-identifiers",
    text: "경로·명령·식별자는 백틱. 여러 줄이면 언어 표기한 코드펜스.",
  },
  {
    id: "headings-not-brackets",
    text: "항목이 여러 갈래로 나뉘면 `##` 제목을 쓰고, 본문 끝에 대괄호 목록을 덧붙이지 않는다.",
  },
  {
    id: "truncation-is-visible",
    text: "길어지면 잘라내고 상위 항목만 쓰고 '… 외 N건' 처럼 **잘랐음을 드러낸다**. 조용히 없애지 않는다.",
  },
  {
    id: "unmeasured-stays-unmeasured",
    text: "확인하지 않은 것은 '미측정'이라고 쓴다. 확인 못 한 것을 단정형으로 쓰지 않는다.",
  },
] as const;

/** 한 항목이 이 창에서 읽히기에 너무 긴가? — 문단 기준 상한(≈120자, 3줄). */
export const PARAGRAPH_CHAR_LIMIT = 120;

/** 문장이 이어지는 것을 끊는 기호. 규칙이 지켜지지 않는 가장 흔한 형태. */
const RUNON_SEPARATORS = [", ", "、", ", 그리고 ", ", 또한 ", ", 그리고"];

/**
 * "항목" 으로 셀 토큰 — 경로와 파일명.
 *
 * 왜 백틱이 아니라 **모양**으로 세는가: 실제로 나온 신고문에서 파일명은
 * `README.md(약 200KB)` 처럼 **백틱 없이** 나열돼 있었다(모델이 백틱을 안 썼다).
 * 백틱만 세면 가장 흔한 형태를 못 잡는다. 반대로 모양을 세면 규칙을 지킨
 * 백틱 목록까지 함께 세게 되므로 — **한 줄에서 5개 이상**일 때만 신호로 바꾼다.
 * 목록 한 줄에 항목 하나는 정상이다.
 */
const ITEM_TOKEN = /(?:[\w.-]+\/)+[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yaml|yml|css|html)\b/g;

/** 문제 인라인 코드·펜스 안의 쉼표 연속은 **의도된 것**일 수 있으므로 세지 않는다. */
function maskCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * 답의 가독성을 **측정**한다 — 규칙을 강제하는 게 아니라, 안 지켜졌을 때
 * **보이게** 하는 것이다(저장소 규칙 "조용히 실패하지 않는다").
 *
 * 왜 이것이 프롬프트 규칙과 짝이 맞는가: 규칙은 "말해" 라는 요청이고, 요청은
 * 지킬 수 없다. 이 함수는 요청이 깨졌을 때의 **증거**다. 화면이 이 값을 쓰든
 * 쓰지 않든, 지금은 **검사 전용**이다 — 새 화면 요소를 만들기 전에는
 * "개선됐다" 고 말할 근거가 없다.
 */
export interface ReadabilityFlag {
  rule: string;
  /** 사람이 읽을 한 줄. 문제가 뭔지 · 무엇을 하면 되는지. */
  message: string;
  /** 몇 개나. "1개" 와 "17개" 는 다른 문제다. */
  count: number;
}

/**
 * 잘 읽히지 않는 답의 **형태만** 센다. 내용의 옳고 그름은 보지 않는다 —
 * 그건 판정할 수 없다. 여기서 "문제" 라고 부르는 것은 **모양**이다:
 *
 *  - `runon-paragraph` : 상한을 넘는 문단이 하나라도 있다.
 *  - `inline-enumeration` : 한 문장에 항목 5개 이상이 쉼표로 이어져 있다.
 *    (브라우저를 줄 때 `src/a`, `src/b`, … 를 나열하는 것이 대표적 — 사용자는
 *     그 목록을 스캔해야만 구조를 알 수 있다)
 *  - `no-structure` : 400자 이상인데 제목·목록·표·펜스가 하나도 없다.
 *
 * 세 개 모두 **형태**만 본다. 짧은 평문 답은 정상이다 — 문제가 아니다.
 */
export function readabilityFlags(text: string): ReadabilityFlag[] {
  const flags: ReadabilityFlag[] = [];
  const masked = maskCode(text ?? "");

  // 1) 상한을 넘는 문단 — 빈 줄 기준.
  const longParas = masked
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^[-*+]\s+.*$/gm, "").trim()) // 목록은 문단이 아니다
    .filter((p) => p.length > 0 && p.length > PARAGRAPH_CHAR_LIMIT && !/^[-*+>#|\d]/.test(p));
  if (longParas.length) {
    flags.push({
      rule: "runon-paragraph",
      count: longParas.length,
      message: `문단 ${longParas.length}개가 ${PARAGRAPH_CHAR_LIMIT}자를 넘습니다 — 한 문단 한 생각으로 나누거나 목록으로 바꾸십시오`,
    });
  }

  // 2) 한 줄에 항목 5개 이상이 쉼표로 이어 붙인 형태 — 경로·파일명 **모양**으로 센다.
  const enumLines = masked.split("\n").filter((line) => {
    const items = line.match(ITEM_TOKEN) ?? [];
    return items.length >= 5 && RUNON_SEPARATORS.some((sep) => line.includes(sep));
  });
  if (enumLines.length) {
    flags.push({
      rule: "inline-enumeration",
      count: enumLines.length,
      message: `${enumLines.length}줄이 항목 5개 이상을 한 문장에 이어 붙였습니다 — 목록이나 표로 바꾸십시오`,
    });
  }

  // 3) 길긴 한데 구조가 전혀 없다.
  const hasStructure = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|\|)/m.test(masked) || /```/.test(masked);
  const length = masked.replace(/\s+/g, "").length;
  if (length >= 400 && !hasStructure) {
    flags.push({
      rule: "no-structure",
      count: 1,
      message: `${length}자인데 제목·목록·표·코드펜스가 하나도 없습니다 — 구조를 만드십시오`,
    });
  }
  return flags;
}

/** 시스템 프롬프트에 들어갈 **출력 형식 블록**. 순서는 규칙 순서와 같다. */
export function answerFormatSection(): string {
  return [
    "출력 형식 (이 창은 브라우저 한 열이다 — 긴 문단 벽은 읽히지 않는다):",
    ...ANSWER_FORMAT_RULES.map((r, i) => `${i + 1}. ${r.text}`),
  ].join("\n");
}

/** 시스템 프롬프트 조각. 순서: 정체 → 루트 → 게이트 → 규칙 파일 → 출력 형식. */
export interface SystemPromptInput {
  /** 현재 작업 루트. 상대경로 기준을 말하는 근거가 이것이다. */
  workspaceRoot: string;
  /** 적용 중인 규칙 파일 경로. **없으면 빈 배열** — 없다고 말해야 한다(아래). */
  ruleFiles: string[];
  /** 지시를 덧씌울 내용(도시락 등). 빈 문자열이면 조각을 붙이지 않는다. */
  extra?: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts = [
    "당신은 로컬 코딩 에이전트입니다. 파일은 현재 워크스페이스 루트 기준 상대경로로 다룹니다.",
    `현재 작업 루트: ${input.workspaceRoot}`,
    "파괴적인 도구(삭제·덮어쓰기·셸)는 승인 게이트를 거칩니다. 승인 없이는 실행되지 않습니다.",
  ];
  const rules = input.ruleFiles ?? [];
  if (rules.length === 0) {
    // **없다고 말한다.** 조용히 비면 "규칙이 적용됐다" 고 오해한다.
    parts.push("이 폴더에는 규칙 파일(CLAUDE.md 등)이 없습니다.");
  } else {
    parts.push(`규칙 파일 ${rules.length}개가 적용 중입니다: ${rules.join(", ")}`);
  }
  parts.push(answerFormatSection());
  if (input.extra) parts.push(input.extra);
  return parts.join("\n");
}
