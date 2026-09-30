/**
 * 대화 블록 모음 (§5.4) — **웹과 서버가 같은 규칙** 으로 만든다.
 *
 * 왜 `shared/` 가 아니라 `session/` 이냐: 이건 UI 상태가 아니라 **기록** 이다. 세션
 * 영속화가 서버에서 일어나므로 서버도 같은 블록을 만들어야 하고, 두 곳에서 각각 만들면
 * "화면에 보이는 것" 과 "저장되는 것" 이 어긋난다 — 복원했을 때 다른 내용이 나오면
 * 사용자는 데이터를 잃었다고 생각한다.
 *
 * 그래서 **React 를 여기 두지 않는다.** `web/panels/AgentPanel.tsx` 는 이 모듈을
 * 그려 줄 뿐이고, 판단은 전부 여기 있다(§④ 표 10: 정본은 한 곳).
 */

export interface AgentBlock {
  id: string;
  /**
   * `user` 는 사람이 보낸 말. 이것이 **묶음(turn)의 시작**이다(2026-10-01).
   *
   * 왜 블록 종류로 구분하나: 묶음을 **만들어내려면 "사람이 뭘 물었나" 가 알아야
   * 한다. `turnId` 를 직접 다는 방법도 있지만 그러면 "이 블록이 새 묶음의 첫 블록인가" 를
   * 계산하는 규칙이 **저장·복원 양쪽에** 생기고, 둘이 어긋나면 대화의 경계가 사라진다.
   * `user` 를 한 종류로 넣으면 "이 블록부터가 한 묶음" 이 **정본**이 된다.
   */
  kind: "user" | "reasoning" | "text" | "status" | "tool" | "error" | "view";
  text: string;
  /**
   * `kind === "view"` 일 때 무엇을 여는지. **대화 안에 블록으로** 열린다 —
   * 2026-10-01 요구: "각 메뉴 선택시 대화창 처럼 출력화면 안에 블럭화 하여 내용을
   * 보여준다". 별도 패널이 없어진 이유는 이것이다.
   */
  view?: {
    what: "settings" | "diff" | "file" | "dirs";
    /** `file` 일 때 경로. 나머지는 무시. */
    path?: string;
  };
  /**
   * 도구 호출.
   *
   * `args` 를 **버리지 않는다** (2026-10-01 실측: 서버는 이미 보내고 있었는데
   * 이 타입이 버려서 화면에는 "도구: edit_file" 한 줄만 남았다). 그 한 줄로는
   * *무엇이* 바뀌었는지 알 수 없다. 그래서 파일 경로와 인자를 여기서 살린다 —
   * 에이전트 출력 안에 **에디터·diff·셸** 을 그리기 위한 재료다.
   */
  tool?: {
    name: string;
    done?: boolean;
    /** 파일 경로 후보. 도구마다 키 이름이 다르므로 여러 흔적을 남긴다. */
    path?: string;
    /** 도구 인자 원본. 알 수 없는 모양이어도 버리지 않는다(추측 금지). */
    args?: Record<string, unknown>;
  };
  at: number;
}

/**
 * 사람이 **눈으로 연** 것을 대화 안에 블록으로 넣는다 (2026-10-01).
 *
 * 왜 이것이 `applyEvent` 의 반대쪽에 붙나: `agent.*` 이벤트는 **에이전트가 한 일**이고
 * 이것은 **사람이 한 일**이다. 둘을 같은 배열에 두는 이유는 **순서**가 중요해서다 —
 * "이 파일을 봤다" 와 "그래서 이렇게 고쳤다" 의 관계가 스크롤 순서로 남아야 한다.
 * 서로 다른 목록에 두면 그 관계가 사라지고, 화면이 두 개의 독립된 기록처럼 보인다.
 *
 * `kind` 는 그대로 두고 `view` 만 채운다. 그러면 **화면은 하나** — 도구 결과든
 * 설정 창이든 같은 자리에 쌓이고, 스크롤 한 번으로 전부 이어진다.
 */
export function openView(
  blocks: AgentBlock[],
  view: NonNullable<AgentBlock["view"]>,
  at: number
): AgentBlock[] {
  // **같은 것을 두 번 열면 하나로 합친다.** 두 번 열면 화면에 같은 설정이 두 번
  // 쌓이고, 사용자는 "설정을 두 번 열었나" 하고 화면을 더듬는다.
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "view" && last.view?.what === view.what && last.view?.path === view.path) {
    return blocks;
  }
  return [...blocks, { id: `view-${at}-${blocks.length}`, kind: "view", text: "", view, at }];
}

/**
 * 대화 **묶음(turn)** — 한 번의 물음과 그것에 대한 모든 것(2026-10-01).
 *
 * 요구: "프롬프트 입력의 출력창은 마치 메신저 대화창 처럼 동작이 되는거야 답변은
 * 하나의 묶음인거고 파일을 여는것, DIFF 해주는거, 쉘을 구동하거나 도구를 구동하는 것
 * 모두 하나의 대화 덩어리처럼 보여주고"
 *
 * 즉 묶음의 경계는 **사람이 보낸 말** 이다. 그 뒤에 오는 사고·답변·도구·파일 열람이
 * 전부 그 묶음에 속한다. 이것을 화면에서 계산하지 않고 **정본 함수** 로 둔다 —
 * 화면·세션 저장이 같은 규칙을 써야 대화가 저녁마다 다르게 나뉘지 않는다.
 */
export interface Turn {
  /** 사람이 보낸 말. 묶음의 제목이 된다. */
  prompt: string;
  at: number;
  blocks: AgentBlock[];
  /** 화면이 이 묶음에 **지금까지 한 일**을 한 줄로 요약한다. */
  summary: string;
}

/** 묶음의 요약 — "무엇을 했나" 를 접었을 때 보이는 한 줄. 개수가 아니라 사실. */
export function summarizeTurn(blocks: AgentBlock[]): string {
  const files = new Set<string>();
  const tools = new Set<string>();
  let shell = 0;
  for (const b of blocks) {
    if (b.kind === "tool") {
      const name = b.tool?.name ?? "";
      const p = toolPath(b.tool?.args);
      if (p) files.add(p);
      if (toolCommand(b.tool?.args) || /shell|exec/i.test(name)) shell++;
      else if (name) tools.add(name);
    } else if (b.kind === "view" && b.view?.what === "file" && b.view.path) {
      files.add(b.view.path);
    }
  }
  const parts: string[] = [];
  if (files.size) parts.push(`파일 ${files.size}`);
  if (tools.size) parts.push(`도구 ${[...tools].slice(0, 3).join(", ")}${tools.size > 3 ? ` 외 ${tools.size - 3}` : ""}`);
  if (shell) parts.push(`셸 ${shell}`);
  return parts.length ? parts.join(" · ") : "답변만";
}

/**
 * 블록 배열 → 묶음 배열. **`user` 블록이 경계**다.
 *
 * `user` 앞의 블록(복원된 세션의 잔여 등)은 **자기 묶음**이 된다. 버리지 않는다 —
 * 세션 복원에서 이 부분을 잃으면 사용자는 "내 대화가 잘렸다" 고 읽는다(§5.10).
 */
export function groupTurns(blocks: AgentBlock[]): Turn[] {
  const out: Turn[] = [];
  let current: AgentBlock[] = [];
  let prompt = "";
  let at = blocks[0]?.at ?? 0;

  const flush = () => {
    if (!current.length) return;
    out.push({ prompt, at, blocks: current, summary: summarizeTurn(current) });
    current = [];
  };

  for (const b of blocks) {
    if (b.kind === "user") {
      flush();
      prompt = b.text;
      at = b.at;
      current = [b];
      continue;
    }
    if (!current.length) {
      // **묶음 시작 전의 블록** — 세션 복원 시 남을 수 있다. 버리지 않고 묶는다.
      prompt = "";
      at = b.at;
    }
    current.push(b);
  }
  flush();
  return out;
}

/** 인자에서 **파일 경로** 를 찾는다.
 *
 * 도구마다 키 이름이 다르다(`path` / `file` / `file_path` / `target`). 그래도
 * **추측해서 키를 만들지는 않는다** — 있는 키만 본다. 없는 경로에 링크를 그리면
 * 404 인 파일을 열었다고 believing—that is worse than showing nothing.
 */
export function toolPath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ["path", "file", "file_path", "filePath", "target", "absolute_path"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * 서버가 보내는 `args` 는 **문자열** 이다 — OpenAI 규격에서 도구 인자가 JSON 텍스트로
 * 오기 때문이다. 화면이 쓰려면 **객체** 여야 하므로 여기서 연다.
 *
 * **안 되면 undefined 로 둔다.** 추측으로 빈 객체·부분 객체를 만들면 "인자가 있다" 고
 * 말하면서 화면은 아무것도 못 그린다 — 경로도 명령도 없는 블록이 그럴 때 생긴다.
 */
export function normalizeTool(t: { name: string; done?: boolean; args?: unknown; ok?: boolean } | undefined): AgentBlock["tool"] | undefined {
  if (!t) return undefined;
  const out: NonNullable<AgentBlock["tool"]> = { name: t.name };
  if (typeof t.done === "boolean") out.done = t.done;
  if (typeof t.args === "string") {
    try {
      const parsed = JSON.parse(t.args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.args = parsed as Record<string, unknown>;
        const p = toolPath(out.args);
        if (p) out.path = p;
      }
    } catch {
      // 파싱 실패 — **모른다.** 경로를 지어내지 않는다(존재하지 않는 파일을 열면
      // 사용자는 그 파일이 없는 것으로 알고, 실제로는 우리가 틀린 것).
    }
  } else if (t.args && typeof t.args === "object" && !Array.isArray(t.args)) {
    out.args = t.args as Record<string, unknown>;
    const p = toolPath(out.args);
    if (p) out.path = p;
  }
  return out;
}

/** 인자에서 **셸 명령** 을 찾는다. */
export function toolCommand(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ["command", "cmd", "script"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** 블록 하나의 인라인 상한. 넘으면 **뒤만** 남긴다(사용자가 본 마지막이 중요). */
export const MAX_BLOCK_CHARS = 4000;
/** 같은 종류를 합치는 시간 창. 이 안에 온 델타는 한 블록으로 본다. */
export const MERGE_WINDOW_MS = 2500;

/**
 * 델타를 누적하되, 지나치게 긴 블록을 만들지 않는다.
 *
 * **합치는 대상은 '스트림' 뿐이다.** `text` 와 `reasoning` 은 토큰이 쪼개져 와도
 * 하나의 말이므로 이어 붙여야 한다. `status` · `tool` · `error` 는 **각각 독립된
 * 사건** 이다 — 이들을 합치면 "컨텍스트 984/32768모델이 응답 중입니다모델이 사고
 * 델타를 보냈지만…" 처럼 한 줄로 뭉개져 읽을 수 없다(실측).
 * "같은 종류니까 합친다" 는 판단이 사건을 잃는 방법이다.
 */
export function appendToBlock(
  blocks: AgentBlock[],
  kind: AgentBlock["kind"],
  text: string,
  at: number,
  tool?: AgentBlock["tool"]
): AgentBlock[] {
  const last = blocks[blocks.length - 1];
  const streamable = kind === "text" || kind === "reasoning";
  const sameTool = kind !== "tool" || (!!last && last.tool?.name === tool?.name);
  if (streamable && last && last.kind === kind && sameTool && at - last.at < MERGE_WINDOW_MS) {
    return [
      ...blocks.slice(0, -1),
      {
        ...last,
        text: (last.text + text).slice(-MAX_BLOCK_CHARS),
        // **도구 인자도 합친다.** 호출 때 인자, 끝날 때 결과가 따로 오는데
        // 인자를 버리면 **끝난 블록에 경로가 없어** 에디터가 안 열린다.
        tool: tool ? { ...(last.tool ?? { name: tool.name }), ...tool } : last.tool,
      },
    ];
  }
  return [...blocks, { id: `${kind}-${at}-${blocks.length}`, kind, text: text.slice(0, MAX_BLOCK_CHARS), tool, at }];
}

/**
 * 서버 이벤트를 블록으로 바꾼다. **한 곳에서만** — 분기마다 따로 처리하면
 * 순서가 뒤집히고(상태 문구가 답변 뒤에 붙는다) 되돌리기 어렵다.
 */
export function applyEvent(
  blocks: AgentBlock[],
  e: { type: string; text?: string; tool?: AgentBlock["tool"]; at?: number }
): AgentBlock[] {
  const at = e.at ?? Date.now();
  switch (e.type) {
    case "agent.reasoning":
      return appendToBlock(blocks, "reasoning", e.text ?? "", at);
    case "agent.delta":
      return appendToBlock(blocks, "text", e.text ?? "", at);
    case "agent.status":
      return appendToBlock(blocks, "status", e.text ?? "", at);
    case "agent.user":
      return appendToBlock(blocks, "user", e.text ?? "", at);
    case "agent.tool":
      return appendToBlock(blocks, "tool", e.text ?? "", at, normalizeTool(e.tool));
    case "agent.error":
      return appendToBlock(blocks, "error", e.text ?? "", at);
    case "agent.diff":
      return appendToBlock(blocks, "text", `[${e.text ?? "diff"}] 변경됨`, at);
    default:
      return blocks;
  }
}

/** 사람이 읽는 한 줄 — 목록·로그·세션 이름에 쓴다. */
export function blockLabel(b: AgentBlock): string {
  switch (b.kind) {
    case "user":
      return b.text.slice(0, 60) || "(빈 입력)";
    case "reasoning":
      return `사고 ${b.text.length.toLocaleString("ko-KR")}자`;
    case "text":
      return b.text.slice(0, 60) || "(빈 답변)";
    case "status":
      return b.text;
    case "tool":
      return `도구 ${b.tool?.name ?? "?"}`;
    case "view":
      // 사람이 연 블록의 이름. **무엇을 열었는지** 말해야 세션 목록에서 찾을 수 있다.
      return b.view?.what === "settings"
        ? "설정"
        : b.view?.what === "diff"
          ? "변경 검토"
          : b.view?.what === "file"
            ? `파일 ${b.view.path ?? ""}`
            : "디렉터리";
    case "error":
      return `오류: ${b.text.slice(0, 60)}`;
  }
}
