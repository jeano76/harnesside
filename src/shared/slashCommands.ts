/**
 * 슬래시 명령 **정본** — 웹 프롬프트가 이 목록을 쓴다.
 *
 * 왜 공유하나 (사용자 요구: 프롬프트에서 슬래시로 콘솔의 쉘 기능을 쓰고 싶다):
 *   구 Ink TUI 의 슬래시 메뉴(2026-10-04 삭제, Q-2)만 명령 목록을 갖고 있었고,
 *   웹 프롬프트에는 **아무것도 없었다.** 두 곳에 같은 목록을 두면 반드시 하나가 뒤처진다 — 이
 *   저장소가 가장 많이 기록한 실패 유형이다("같은 일을 두 곳에 두지 않는다").
 *   특히 **화면에 보이는 목록**이라 어긋나면 사용자가 없는 명령을 찾게 된다.
 *
 * 그래서 목록과 파싱 규칙을 `shared/`(import 0개)에 두고 웹이 읽기만 한다.
 * Ink·React 는 여기 없다 — 서버/웹 어느 쪽에서도 안전한 순수 데이터다.
 *
 * `where` 는 **어디서 되는지** 다. `tui` 명령을 웹에서 조용히 무시하지 않는다 —
 * 대신 이유를 말한다(조용히 실패하는 것이 명백히 실패하는 것보다 나쁘다).
 */

export interface SlashCommandDef {
  /** 명령 이름. 라벨(`/xxx`)과 반드시 같아야 한다(옛 사고: 라벨만 다르면 매칭이 안 된다). */
  key: string;
  /** 화면에 보이는 형태. */
  label: string;
  /** 한 줄 설명. */
  description: string;
  /** `tui` 는 터미널 제어라 웹 창에는 없다. */
  where: "both" | "web" | "tui";  // web = 웹에만 있다, tui = 콘솔에만 있다
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // `/help` 는 `tui` 였다가 **2026-10-04 에 `both` 로 바꿨다.** TUI 가 삭제되면서
  // (Q-2) 이 명령을 실행할 곳이 하나도 남지 않았고, 사용자가 친 뒤에는
  // "웹에서 지원하지 않는 명령입니다" 가 답이었다 — 이미 웹에 있는 사람이
  // 웹이 명령을 모른다고 들었다. 이제 웹 프롬프트에서 **이 프로그램의 명령 목록**을
  // 보여준다(`web/main.tsx` 의 `runSlash` 의 `help` 분기).
  { key: "help", label: "/help", description: "이 프로그램의 명령 목록", where: "both" },
  // `/keys` 는 **의도적으로 `tui` 로 남긴다.** 이 명령이 읽는 키바인딩 정본
  // (`keybindings.ts`)이 구 TUI와 함께 삭제됐고(2026-10-04), 웹 쪽 키바인딩 정본은
  // 아직 없다. 목록을 지어내지 않는다 — 없는 데이터를 보여주는 도움말은
  // 도움말이 아니라 거짓말이다. 웹에 키바인딩 정본이 생기면 그때 `both` 로 올린다.
  { key: "keys", label: "/keys", description: "키보드 단축키만 보기", where: "tui" },
  { key: "quit", label: "/quit", description: "정상종료 (창을 닫으면 함께 종료)", where: "both" },
  { key: "queue", label: "/queue", description: "대기열 보기", where: "both" },
  { key: "compact", label: "/compact", description: "지금 컨텍스트 압축 실행", where: "both" },
  { key: "copy", label: "/copy", description: "화면 로그 복사 — /copy 20 처럼 줄 수 지정 (드래그 선택과 같은 클립보드)", where: "tui" },
  { key: "skills", label: "/skills", description: "불러온 스킬 목록", where: "both" },
  { key: "rules", label: "/rules", description: "불러온 룰 목록", where: "both" },
  { key: "improve", label: "/improve", description: "반복 실패 분석 → 룰 제안", where: "both" },
  { key: "improve-apply", label: "/improve-apply", description: "마지막 제안을 룰 파일로 저장", where: "both" },
  { key: "plan-clear", label: "/plan-clear", description: "멈춘 계획 표시 초기화", where: "both" },
  // 터미널 제어 — 웹 창에는 감지할 터미널도 제어할 터미널도 없다.
  // 조용히 없는 척 하지 않고 **이유를 말한다**(`where: "tui"`).
  { key: "term", label: "/term", description: "감지된 터미널과 지원 기능 상태 ", where: "both" },
  { key: "mouse", label: "/mouse", description: "마우스 스크롤/클릭 켜기·끄기", where: "tui" },
  // 구 TUI(2026-10-04 삭제)의 서버 쪽 명령 — 웹 서버가 같은 내용을 실행한다(`server/slashService.ts`).
  // 콘솔(TUI)에는 핸들러가 없어서 `web` 으로 둔다.
  // tmux 위의 AI CLI 탭 — 프로바이더 목록의 정본은 `shared/cliProviders.ts`.
  { key: "cli", label: "/cli", description: "AI CLI(claude·gemini·codex)를 tmux 탭으로 열기 · 목록 · 종료", where: "web" },
  { key: "models", label: "/models", description: "이 PC에서 구동 가능한 로컬 모델 메트릭스 · 선택", where: "web" },
  { key: "server", label: "/server", description: "모델 제공 서버 상태 확인 · restart 로 재시작(확인 후)", where: "web" },
  { key: "reset", label: "/reset", description: "현재 GPU·VRAM·RAM에 맞는 모델/설정으로 다시 초기화", where: "web" },
];

export const SLASH_BY_KEY: Record<string, SlashCommandDef> = Object.fromEntries(
  SLASH_COMMANDS.map((c) => [c.key, c])
);

/**
 * 입력을 명령으로 파싱한다. **명령이 아닐 때만** `null`.
 *
 * 규칙 (TUI `filterMenuItems` 와 같은 규칙이어야 한다):
 *  - `slash` 로 시작해야 한다.
 *  - 공백 **뒤는 전부 인자**다 — `/copy 20` 의 `20` 은 명령명이 아니다.
 *  - 등록된 명령이 아니면 `null`. 경로(`/home/...`)처럼 슬래시로 시작하는
 *    평범한 문장을 명령으로 가로채지 않는다 — **모델에게 그대로 보낸다**.
 */
export function parseSlash(text: string): { key: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const firstSpace = trimmed.search(/\s/);
  const head = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase();
  const arg = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  if (!head) return null;
  const def = SLASH_BY_KEY[head];
  if (!def) return null;
  return { key: def.key, arg };
}

/**
 * 메뉴용 필터 — 첫 토큰(명령명)으로 좁힌다.
 *
 * TUI가 쓰던 규칙을 그대로 옮겼다: 인자가 붙어도(`/copy 20`) 매칭이 깨지지 않고,
 * 접두사뿐 아니라 **어디에든 포함**된 이름도 잡는다(`/apply` → `improve-apply`).
 */
export function slashMatches(input: string): SlashCommandDef[] {
  const raw = input.slice(1);
  const firstSpace = raw.search(/\s/);
  const query = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
  if (!query) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((item) => item.key.toLowerCase().includes(query));
}

/** 웹에서 실행 가능한 명령만 — 웹 매니페스트를 그릴 때 쓴다. */
export function webSlashCommands(): SlashCommandDef[] {
  return SLASH_COMMANDS.filter((c) => c.where !== "tui");
}

/**
 * `/help` 가 그리는 본문 — **순수 함수**. (2026-10-04)
 *
 * 왜 React 콜백 안이 아니라 여기 있는가: UI 안에 두면 브라우저 없이는 출력물을
 * 확인할 수 없다. 이 저장소 규칙("사람이 보는 것은 실제 브라우저로 확인한다")을
 * 지키면서도 **회귀 검사**를 하려면, 그리는 규칙이 순수 함수여야 한다.
 * 로직은 `.ts` 에 두고 `.tsx` 는 렌더만 한다 — 이 저장소의 관례.
 *
 * 목록을 여기에 다시 적지 않는다. `SLASH_COMMANDS` 가 정본이며, 여기서는
 * **읽기만** 한다(같은 일을 두 곳에 두지 않는다).
 */
const HELP_GROUPS: Array<[string, string[]]> = [
  ["대화 · 컨텍스트", ["compact", "queue", "plan-clear"]],
  ["규칙 · 스킬 · 자기개선", ["skills", "rules", "improve", "improve-apply"]],
  ["모델 · 서버", ["models", "server", "reset"]],
  ["터미널 · AI CLI", ["term", "cli"]],
  ["안내 · 종료", ["help", "quit"]],
];

/** 라벨 폭. `padEnd` 으로 이름을 맞추면 목록을 훑을 때 어느 줄에 무엇이 있는지 눈에 들어온다. */
const LABEL_W = 16;

export function renderHelpText(
  all: SlashCommandDef[] = SLASH_COMMANDS,
  web: SlashCommandDef[] = all.filter((c) => c.where !== "tui")
): string {
  const lines: string[] = [
    "harnesside 명령 — 입력창에 `/` 를 치면 자동완성됩니다. 인자가 필요하면 뒤에 공백을 두세요.",
    "",
  ];
  const placed = new Set<string>();
  for (const [title, keys] of HELP_GROUPS) {
    const rows = web.filter((c) => keys.includes(c.key));
    if (!rows.length) continue;
    for (const r of rows) placed.add(r.key);
    lines.push(`${title}`);
    // 화면에 보이는 이름을 쓴다. 사용자는 키가 아니라 `/models` 를 타이핑한다.
    for (const c of rows) lines.push(`  ${c.label.padEnd(LABEL_W)}${c.description}`);
    lines.push("");
  }
  // 그룹에 못 넣은 명령이 새로 생겨도 **사라지지 않게** 한다 — 새 명령이 조용히
  // 목록에서 빠지면 사용자는 없는 줄 찾게 되고(원인이 없다), 있는 줄을 못 찾게
  // 되면(원인이 있다) 둘 다 나쁘다. 최소 한 줄로는 반드시 보인다.
  const rest = web.filter((c) => !placed.has(c.key));
  if (rest.length) {
    lines.push("기타");
    for (const c of rest) lines.push(`  ${c.label.padEnd(LABEL_W)}${c.description}`);
    lines.push("");
  }
  // 조용히 없는 척 하지 않는다: 빠진 명령이 있으면 **몇 개와 무엇인지** 말한다.
  const tuiOnly = all.filter((c) => c.where === "tui");
  if (tuiOnly.length) {
    lines.push(
      `이 창에서는 쓸 수 없는 명령 ${tuiOnly.length}개: ${tuiOnly.map((c) => c.label).join(" ")}`,
      "  — 콘솔(TUI) 전용이며 그 UI는 2026-10-04 에 삭제되었습니다.",
    );
  }
  return lines.join("\n").trimEnd();
}
