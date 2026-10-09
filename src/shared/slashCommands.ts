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
  /** 한 줄 설명의 카탈로그 키(`web/i18n/ko.ts`의 `slash.desc.*`).
   *
   * 한국어 본문은 카탈로그에 하나만 둔다(M9). 여기에 직접 적으면 두 벌이 되고
   * 어느 쪽이 진짜인지 아무도 모른다(저장소 규칙 4 — 묶음4b에서 옮김).
   * 그리는 쪽은 `renderHelpText`의 `tr` 로 풀어서 쓴다. */
  descriptionKey: string;
  /** `tui` 는 터미널 제어라 웹 창에는 없다. */
  where: "both" | "web" | "tui";  // web = 웹에만 있다, tui = 콘솔에만 있다
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // `/help` 는 `tui` 였다가 **2026-10-04 에 `both` 로 바꿨다.** TUI 가 삭제되면서
  // (Q-2) 이 명령을 실행할 곳이 하나도 남지 않았고, 사용자가 친 뒤에는
  // "웹에서 지원하지 않는 명령입니다" 가 답이었다 — 이미 웹에 있는 사람이
  // 웹이 명령을 모른다고 들었다. 이제 웹 프롬프트에서 **이 프로그램의 명령 목록**을
  // 보여준다(`web/main.tsx` 의 `runSlash` 의 `help` 분기).
  { key: "help", label: "/help", descriptionKey: "slash.desc.help", where: "both" },
  // `/keys` 는 **의도적으로 `tui` 로 남긴다.** 이 명령이 읽는 키바인딩 정본
  // (`keybindings.ts`)이 구 TUI와 함께 삭제됐고(2026-10-04), 웹 쪽 키바인딩 정본은
  // 아직 없다. 목록을 지어내지 않는다 — 없는 데이터를 보여주는 도움말은
  // 도움말이 아니라 거짓말이다. 웹에 키바인딩 정본이 생기면 그때 `both` 로 올린다.
  { key: "keys", label: "/keys", descriptionKey: "slash.desc.keys", where: "tui" },
  { key: "quit", label: "/quit", descriptionKey: "slash.desc.quit", where: "both" },
  { key: "queue", label: "/queue", descriptionKey: "slash.desc.queue", where: "both" },
  { key: "compact", label: "/compact", descriptionKey: "slash.desc.compact", where: "both" },
  { key: "copy", label: "/copy", descriptionKey: "slash.desc.copy", where: "tui" },
  { key: "skills", label: "/skills", descriptionKey: "slash.desc.skills", where: "both" },
  { key: "rules", label: "/rules", descriptionKey: "slash.desc.rules", where: "both" },
  { key: "improve", label: "/improve", descriptionKey: "slash.desc.improve", where: "both" },
  { key: "improve-apply", label: "/improve-apply", descriptionKey: "slash.desc.improve-apply", where: "both" },
  { key: "plan-clear", label: "/plan-clear", descriptionKey: "slash.desc.plan-clear", where: "both" },
  // 터미널 제어 — 웹 창에는 감지할 터미널도 제어할 터미널도 없다.
  // 조용히 없는 척 하지 않고 **이유를 말한다**(`where: "tui"`).
  { key: "term", label: "/term", descriptionKey: "slash.desc.term", where: "both" },
  { key: "mouse", label: "/mouse", descriptionKey: "slash.desc.mouse", where: "tui" },
  // 구 TUI(2026-10-04 삭제)의 서버 쪽 명령 — 웹 서버가 같은 내용을 실행한다(`server/slashService.ts`).
  // 콘솔(TUI)에는 핸들러가 없어서 `web` 으로 둔다.
  // tmux 위의 AI CLI 탭 — 프로바이더 목록의 정본은 `shared/cliProviders.ts`.
  { key: "cli", label: "/cli", descriptionKey: "slash.desc.cli", where: "web" },
  { key: "models", label: "/models", descriptionKey: "slash.desc.models", where: "web" },
  { key: "server", label: "/server", descriptionKey: "slash.desc.server", where: "web" },
  { key: "reset", label: "/reset", descriptionKey: "slash.desc.reset", where: "web" },
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
const HELP_GROUPS: Array<[titleKey: string, keys: string[]]> = [
  ["slash.help.group.dialog", ["compact", "queue", "plan-clear"]],
  ["slash.help.group.skills", ["skills", "rules", "improve", "improve-apply"]],
  ["slash.help.group.models", ["models", "server", "reset"]],
  ["slash.help.group.cli", ["term", "cli"]],
  ["slash.help.group.meta", ["help", "quit"]],
];

/** 라벨 폭. `padEnd` 으로 이름을 맞추면 목록을 훑을 때 어느 줄에 무엇이 있는지 눈에 들어온다. */
const LABEL_W = 16;

export function renderHelpText(
  all: SlashCommandDef[] = SLASH_COMMANDS,
  web: SlashCommandDef[] = all.filter((c) => c.where !== "tui"),
  tr: (key: string) => string = (key) => key,
): string {
  const lines: string[] = [
    tr("slash.help.intro"),
    "",
  ];
  const placed = new Set<string>();
  for (const [titleKey, keys] of HELP_GROUPS) {
    const rows = web.filter((c) => keys.includes(c.key));
    if (!rows.length) continue;
    for (const r of rows) placed.add(r.key);
    lines.push(tr(titleKey));
    // 화면에 보이는 이름을 쓴다. 사용자는 키가 아니라 `/models` 를 타이핑한다.
    for (const c of rows) lines.push(`  ${c.label.padEnd(LABEL_W)}${tr(c.descriptionKey)}`);
    lines.push("");
  }
  // 그룹에 못 넣은 명령이 새로 생겨도 **사라지지 않게** 한다 — 새 명령이 조용히
  // 목록에서 빠지면 사용자는 없는 줄 찾게 되고(원인이 없다), 있는 줄을 못 찾게
  // 되면(원인이 있다) 둘 다 나쁘다. 최소 한 줄로는 반드시 보인다.
  const rest = web.filter((c) => !placed.has(c.key));
  if (rest.length) {
    lines.push(tr("slash.help.other"));
    for (const c of rest) lines.push(`  ${c.label.padEnd(LABEL_W)}${tr(c.descriptionKey)}`);
    lines.push("");
  }
  // 조용히 없는 척 하지 않는다: 빠진 명령이 있으면 **몇 개와 무엇인지** 말한다.
  const tuiOnly = all.filter((c) => c.where === "tui");
  if (tuiOnly.length) {
    lines.push(
      tr("slash.help.tuiOnly").replace("{{count}}", String(tuiOnly.length)).replace("{{labels}}", tuiOnly.map((c) => c.label).join(" ")),
      tr("slash.help.tuiNote"),
    );
  }
  return lines.join("\n").trimEnd();
}
