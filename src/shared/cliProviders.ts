/**
 * 웹에서 tmux 로 쓰는 AI 코딩 CLI **정본 목록** — 서버(`server/cliSessions.ts`)·웹 자동완성이
 * 같은 목록을 읽는다. 순수 데이터(import 0개).
 *
 * 인자·재개 플래그는 **설치된 CLI 의 `--help` 로 확인한 것만** 적는다(2026-10-04 실측:
 * claude 2.1.289 `--continue` · gemini 0.60.0 `--resume latest`). `codex` 는 이 머신에
 * 설치돼 있지 않아 재개 인자를 **확인하지 못했다** — 비워 둔다(지어내지 않는다).
 *
 * 로그인·API 키는 웹이 만지지 않는다. 각 CLI 가 자기 설정으로 인증하고, 필요하면 터미널 안에서
 * 스스로 안내한다(`PROMPT_TMUX_CLI.md` D4).
 */

export type CliProviderId = "claude" | "gemini" | "agy" | "codex" | "shell";

export interface CliBuiltinCommand {
  /** 슬래시 없이(`help`). 하위 이름은 `:` 로(`plugin:list`). */
  name: string;
  /** 확신하는 것만 적는다. 모르면 비운다(지어내지 않는다). */
  description?: string;
}

export interface CliProvider {
  id: CliProviderId;
  label: string;
  /** 실행 파일 + 고정 인자. `shell` 은 빈 배열 = tmux 기본 셸. */
  command: string[];
  /** 설치 확인 명령(3초 타임아웃). 빈 배열이면 확인 대상이 아니다. */
  detect: string[];
  installHint: string;
  /** 같은 폴더의 지난 대화를 이어가는 **추가 인자**. 확인 못 했으면 없다. */
  resumeArgs?: string[];
  /**
   * 내장 슬래시 명령. CLI 는 이 목록을 기계가 읽게 내놓지 않는다(`--help` 는 실행 옵션만 준다) —
   * 그래서 **버전을 붙인 표**다. `builtinsVersion` 은 이 표를 **실제로 확인한** CLI 버전이고,
   * 설치된 버전과 다르면 화면이 "오래됐을 수 있음" 이라고 말한다. `null` 이면 확인하지 못한 표다.
   */
  builtins?: CliBuiltinCommand[];
  builtinsVersion?: string | null;
  /** 슬래시 버튼 줄에 올릴 **자주 쓰는** 명령 이름(내장 표 안의 것만). */
  quick?: string[];
  /**
   * YOLO(승인 요청을 모두 자동 허용) 로 띄우는 **시작 인자** — 설치된 CLI 의 `--help` 로 확인한 것만:
   * claude `--dangerously-skip-permissions`, gemini `--yolo`. 없으면(codex: 미설치·미확인) YOLO 를 지원하지 않는다.
   * 이 모드는 **세션을 그 인자로 시작할 때만** 켜진다(실행 중인 세션을 바꾸지 못한다).
   */
  yoloArgs?: string[];
  /** 사용자 정의 명령·스킬이 사는 곳(홈 기준 `~/`, 아니면 작업 폴더 기준). 서버가 스캔한다. */
  customDirs?: { dir: string; kind: "md" | "toml" | "skill"; label: string }[];
}

export const CLI_PROVIDERS: CliProvider[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: ["claude"],
    detect: ["claude", "--version"],
    installHint: "npm i -g @anthropic-ai/claude-code (설치는 직접 하세요)",
    resumeArgs: ["--continue"],
    yoloArgs: ["--dangerously-skip-permissions"],
    // 2026-10-04 claude 2.1.289 의 `/help` → Commands 탭에서 **실제로 보이는 것**만 골랐다.
    builtinsVersion: "2.1.289",
    quick: ["help", "clear", "compact", "model", "resume", "context", "status", "memory", "mcp", "config"],
    builtins: [
      { name: "help", description: "도움말" },
      { name: "clear", description: "대화 비우기" },
      { name: "compact", description: "대화 요약으로 컨텍스트 줄이기" },
      { name: "config", description: "설정" },
      { name: "context", description: "컨텍스트 사용량 보기" },
      { name: "model", description: "모델 바꾸기" },
      { name: "init", description: "CLAUDE.md 만들기" },
      { name: "memory", description: "메모리 파일 편집" },
      { name: "mcp", description: "MCP 서버 관리" },
      { name: "resume", description: "지난 대화 이어가기" },
      { name: "rewind", description: "이전 시점으로 되돌리기" },
      { name: "rename", description: "대화 이름 바꾸기" },
      { name: "permissions", description: "도구 권한 관리" },
      { name: "hooks", description: "훅 설정" },
      { name: "status", description: "상태 보기" },
      { name: "doctor", description: "설치 진단" },
      { name: "login", description: "로그인" },
      { name: "logout", description: "로그아웃" },
      { name: "plan", description: "계획 모드" },
      { name: "diff", description: "변경 보기" },
      { name: "copy", description: "마지막 응답 복사" },
      { name: "export", description: "대화 내보내기" },
      { name: "add-dir", description: "작업 폴더 추가" },
      { name: "skills" },
      { name: "plugin" },
      { name: "theme" },
      { name: "usage" },
      { name: "cd" },
      { name: "chrome" },
      { name: "effort" },
      { name: "fast" },
      { name: "fork" },
      { name: "ide" },
      { name: "feedback" },
      { name: "release-notes" },
      { name: "terminal-setup" },
      { name: "statusline" },
      { name: "tasks" },
      { name: "exit", description: "종료" },
    ],
    customDirs: [
      { dir: ".claude/commands", kind: "md", label: "프로젝트 명령" },
      { dir: "~/.claude/commands", kind: "md", label: "사용자 명령" },
      { dir: ".claude/skills", kind: "skill", label: "프로젝트 스킬" },
      { dir: "~/.claude/skills", kind: "skill", label: "사용자 스킬" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: ["gemini"],
    detect: ["gemini", "--version"],
    installHint: "npm i -g @google/gemini-cli (설치는 직접 하세요)",
    resumeArgs: ["--resume", "latest"],
    yoloArgs: ["--yolo"],
    // **확인하지 못한 표다**(builtinsVersion=null): 이 머신의 gemini 0.60.0 은 로그인 화면에서 막혀
    // (`This client is no longer supported…`) `/help` 를 읽지 못했다. 공개 문서에 있는 이름만 적었다.
    builtinsVersion: null,
    quick: ["help", "clear", "chat", "compress", "memory", "tools", "stats", "mcp", "settings"],
    builtins: [
      { name: "help", description: "도움말" },
      { name: "clear", description: "화면 비우기" },
      { name: "chat", description: "대화 저장·불러오기" },
      { name: "memory", description: "메모리(GEMINI.md) 관리" },
      { name: "mcp", description: "MCP 서버 보기" },
      { name: "tools", description: "사용 가능한 도구 보기" },
      { name: "stats", description: "사용량 통계" },
      { name: "theme", description: "테마 바꾸기" },
      { name: "auth", description: "인증 방식 바꾸기" },
      { name: "editor", description: "편집기 선택" },
      { name: "copy", description: "마지막 출력 복사" },
      { name: "compress", description: "대화 요약으로 컨텍스트 줄이기" },
      { name: "restore", description: "변경 되돌리기" },
      { name: "settings", description: "설정" },
      { name: "directory", description: "작업 폴더 관리" },
      { name: "extensions", description: "확장 보기" },
      { name: "init", description: "GEMINI.md 만들기" },
      { name: "about", description: "버전 정보" },
      { name: "bug", description: "버그 신고" },
      { name: "vim", description: "vim 모드" },
      { name: "quit", description: "종료" },
    ],
    customDirs: [
      { dir: ".gemini/commands", kind: "toml", label: "프로젝트 명령" },
      { dir: "~/.gemini/commands", kind: "toml", label: "사용자 명령" },
    ],
  },
  {
    id: "agy",
    label: "Antigravity (agy)",
    command: ["agy"],
    detect: ["agy", "--version"],
    installHint: "Antigravity CLI(agy) — 설치는 직접 하세요 (gemini CLI 개인 로그인이 막힌 경우의 대체)",
    resumeArgs: ["--continue"],
    yoloArgs: ["--dangerously-skip-permissions"],
    // 2026-10-04 agy 1.2.9: `agy --help` 로 `--continue`·`--dangerously-skip-permissions` 확인, 실행 후 `/` 메뉴에서
    // **실제로 보인** 이름·설명만 적었다(번들 스킬 `/agy-customizations` 등은 제외).
    builtinsVersion: "1.2.9",
    quick: ["help", "clear", "model", "resume", "context", "config", "mcp", "usage", "plan"],
    builtins: [
      { name: "add-dir", description: "작업 폴더 추가" },
      { name: "agents", description: "사용 가능한 사용자 에이전트 목록" },
      { name: "artifact", description: "아티팩트 보기·검토" },
      { name: "btw", description: "진행 중인 작업을 끊지 않고 곁질문" },
      { name: "changelog", description: "릴리스 노트" },
      { name: "clear", description: "대화 비우고 새로 시작" },
      { name: "codesearch", description: "작업 공간 코드 검색 (/codesearch <질의>)" },
      { name: "config", description: "설정 패널" },
      { name: "context", description: "컨텍스트 사용량 보기" },
      { name: "copy", description: "마지막 응답 복사" },
      { name: "credits", description: "남은 크레딧" },
      { name: "diff", description: "커밋 안 된 변경·턴별 diff" },
      { name: "effort", description: "추론 강도 설정" },
      { name: "exit", description: "종료" },
      { name: "feedback", description: "피드백 보내기" },
      { name: "fork", description: "현재 대화에서 분기" },
      { name: "help", description: "명령·단축키 도움말" },
      { name: "hooks", description: "훅 설정" },
      { name: "keybindings", description: "단축키 설정" },
      { name: "logout", description: "로그아웃" },
      { name: "mcp", description: "MCP 서버 관리" },
      { name: "model", description: "모델 설정 / 다른 모델로 한 번 실행" },
      { name: "open", description: "파일 열기·수정한 파일 보기" },
      { name: "permissions", description: "도구 권한 관리" },
      { name: "remote-control", description: "원격 제어" },
      { name: "rename", description: "대화 이름 바꾸기" },
      { name: "resume", description: "지난 대화 이어가기" },
      { name: "rewind", description: "이전 메시지로 되돌리기" },
      { name: "skills", description: "스킬 목록" },
      { name: "statusline", description: "상태줄 켜기/끄기" },
      { name: "tasks", description: "백그라운드 작업 보기" },
      { name: "title", description: "터미널 창 제목 켜기/끄기" },
      { name: "usage", description: "모델 사용량(쿼터)" },
      { name: "voice", description: "음성으로 프롬프트 입력" },
      { name: "goal", description: "목표가 끝날 때까지 실행" },
      { name: "schedule", description: "반복·예약 실행" },
      { name: "browser", description: "웹 작업용 브라우저 에이전트" },
      { name: "plan", description: "실행 전에 계획 세우기" },
    ],
  },
  {
    id: "codex",
    label: "Codex (GPT)",
    command: ["codex"],
    detect: ["codex", "--version"],
    installHint: "npm i -g @openai/codex (설치는 직접 하세요)",
    // 설치돼 있지 않아 내장 명령도 사용자 명령 위치도 **확인하지 못했다** — 비워 둔다(지어내지 않는다).
    builtinsVersion: null,
  },
  { id: "shell", label: "Shell (tmux)", command: [], detect: [], installHint: "" },
];

export const CLI_PROVIDER_BY_ID: Record<string, CliProvider> = Object.fromEntries(CLI_PROVIDERS.map((p) => [p.id, p]));

/** `/cli` 의 서브명령 — 자동완성이 읽는다. */
export const CLI_SUBCOMMANDS = ["new", "resume", "kill"] as const;

/** harnesside 가 만든 tmux 세션만 관리 대상이다. 이 접두사가 그 표식이다. */
export const CLI_SESSION_PREFIX = "hs-";
/** 서버가 만든 세션명만 통과한다 — 요청으로 받은 이름은 이 검사를 거쳐야 쓴다. */
export const CLI_SESSION_NAME = /^hs-[a-z]+-[a-z0-9]{4,8}$/;

/**
 * YOLO 세션은 이름 끝에 `y` 가 붙는다(`hs-claude-ab12cdy`). 일반 id 는 16진 6자라 `y` 가 있을 수 없어
 * 이름만으로 구분된다 — 서버 재시작 뒤 tmux 목록에서도 모드를 되살릴 수 있다.
 */
export function isYoloSessionName(name: string): boolean {
  const seg = name.split("-")[2] ?? "";
  return seg.length >= 7 && seg[6] === "y";
}
