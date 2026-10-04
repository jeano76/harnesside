# harnesside — claude · gemini · codex(GPT) CLI 를 tmux 로 웹에서 그대로 쓰는 구현 프롬프트

> **문서 종류**: 구현 프롬프트 (이 문서를 그대로 에이전트에게 넘겨 구현시킨다)
> **대상 저장소**: `harnesside` (`/home/jeano/harnessCli`)
> **선행 문서**: `PROMPT.md` · `PROMPT_IDE_CLI.md` · `PROGRESS.md`
> **작성 기준일**: 2026-10-04
> **요구 번호**: `T-1` ~ `T-14` (기존 `PROMPT.md` 1~19, `PROMPT_IDE_CLI.md` `S-*` 와 겹치지 않는다)

---

## 0. 역할과 읽는 법

너는 `harnesside` 저장소에서 일하는 시니어 엔지니어다. 아래 요구를 **한 번에 하나씩**
구현하고, 요구마다 **검증한 결과**를 남긴다. 이 문서는 "무엇을 만들까" 와 "어떻게 느껴져야
하나" 와 "밟지 말아야 할 함정" 을 함께 적는다. **이유 없는 규칙은 없다** — 규칙이 불편해 보이면
이유 줄을 먼저 읽는다.

### 0.1 작업 태도 (저장소 공통 규칙, 그대로 따른다)

- **"설정했다" 와 "동작한다" 를 다른 문장으로 쓴다.** 동작은 실제로 실행해 본 것만 말한다.
- **모르는 것을 아는 것처럼 쓰지 않는다.** 측정하지 못한 것은 "미측정" 이라고 적는다.
- **조용히 실패하지 않는다.** 실패는 화면에 이유와 함께 보인다. 빈 화면·가짜 성공 금지.
- **같은 일을 두 곳에 두지 않는다.** 목록·규칙의 정본은 한 곳, 나머지는 읽기만 한다.
- **파괴적 동작은 확인 뒤에만.** 세션 종료·삭제·키 입력 주입은 사용자가 의도했음이 분명해야 한다.
- 검증 없이 "완료" 라고 쓰지 않는다. 특히 사람이 보는 화면은 **실제 브라우저에서** 확인한다.

---

## 1. 한 줄 목표

> **터미널에서 `claude` · `gemini` · `codex`(GPT) 같은 AI 코딩 CLI 를 쓰던 경험을,
> 창을 닫아도 살아 있는 `tmux` 세션 위에서, 웹 화면 안에서 똑같이 이어서 쓴다.**

"똑같이" 의 기준:

1. 터미널에서 하던 **모든 키 입력**(방향키·Ctrl 조합·Esc·Tab·붙여넣기·마우스)이 그대로 CLI 에 간다.
2. **색·TUI(전체 화면 UI)·리사이즈·한글 입력** 이 터미널과 같게 보인다.
3. **브라우저를 닫거나 새로고침하거나 서버를 재시작해도** CLI 세션이 살아 있고, 다시 열면
   **그 자리에서 이어진다** (이것이 tmux 를 쓰는 유일한 이유다).
4. 웹 밖(SSH·로컬 터미널)에서 `tmux attach` 로 **같은 세션에 붙어도** 된다.

---

## 2. 이미 있는 것 (다시 만들지 않는다)

먼저 읽고 시작한다. 새로 만드는 것은 **"PTY 를 직접 쥐는 방식" 과 "tmux 가 쥐는 방식" 사이의
이음새** 뿐이다.

| 무엇 | 어디 | 비고 |
|---|---|---|
| PTY 셸 매니저 | `src/server/terminal.ts` (`TerminalManager`) | `node-pty` 로 셸을 띄우고 `write/resize/close/shutdown` 제공 |
| 터미널 REST | `src/server/index.ts` `/api/terminal*` | `create` `input` `resize` `close` `cwd` `dirs` |
| 출력 스트림 | WS 이벤트 `terminal.data` `terminal.exit` `terminal.open` | **출력은 WS 로만** 보낸다(폴링 금지) |
| 웹 터미널 | `src/web/panels/TerminalView.tsx` | `@xterm/xterm` + fit addon, 하단 셸 영역 |
| 하단 레이아웃 | `src/web/main.tsx` `DEFAULT_BOTTOM_H` · `BODY.terminal` | 셸은 4줄 높이 기본, 드래그로 조절 |
| 인증 | `src/auth/token.ts` | 모든 `/api/*` 와 WS 는 토큰 필수 |
| 슬래시 명령 | `src/shared/slashCommands.ts` · `src/web/main.tsx` `runSlash` | 명령 목록은 이 파일이 정본 |

이 머신: `tmux 3.6`, `claude`(`~/.local/bin/claude`), `gemini`(`/snap/bin/gemini`) 가 있다.
`codex`(OpenAI GPT CLI)는 **설치 확인 안 됨(미측정)** — 없으면 "설치 안 됨" 으로 말하고 설치를
안내하되 **자동 설치하지 않는다**(T-4).

---

## 3. 핵심 설계 결정 (바꾸려면 먼저 이유를 적는다)

### D1. 웹 터미널은 tmux **클라이언트** 로 붙는다 — tmux 를 흉내 내지 않는다

- 서버는 AI CLI 를 **tmux 세션 안에서** 실행한다: `tmux new-session -d -s <이름> -c <cwd> <명령>`.
- 웹 탭 하나 = 서버가 `node-pty` 로 `tmux attach-session -t <이름>` 을 띄운 것이다.
  즉 **PTY 의 자식이 tmux 클라이언트** 이고, CLI 자체는 tmux 서버가 쥐고 있다.
- 이유: 웹 탭이 닫혀도(= `attach` 프로세스가 죽어도) **CLI 는 tmux 서버 안에서 계속 산다.**
  `TerminalManager` 가 CLI 를 직접 자식으로 쥐면 서버 재시작 때 CLI 가 같이 죽는다.
- **하지 말 것**: `tmux capture-pane` 을 폴링해서 화면을 그리는 방식. 지연이 생기고 색·커서·TUI 가
  깨진다. 반드시 PTY attach 로 **원시 바이트 스트림**을 그대로 `xterm.js` 에 흘린다.

### D2. 세션 이름은 서버가 정한다 — 사용자 입력을 그대로 쓰지 않는다

- 형식: `hs-<provider>-<짧은 id>` (예: `hs-claude-a1b2`). 접두사 `hs-` 로 **harnesside 가 만든
  세션만** 관리 대상으로 삼는다. 사용자가 직접 만든 다른 tmux 세션(`claude`, `opencode` 등)은
  **목록에 보이더라도 읽기 전용으로 두고 종료·키 주입을 하지 않는다**(T-8).
- 이름·cwd·명령은 **배열 인자로** `execFile`/`spawn` 에 넘긴다. **셸 문자열 연결 금지**
  (쉘 인젝션). 이미 있는 `shellQuote`(`terminal.ts`)가 필요한 곳에서만 쓴다.

### D3. 프로바이더는 **데이터** 다 — 코드 분기를 늘리지 않는다

`src/shared/cliProviders.ts`(새 파일, import 0개)에 목록을 둔다. 서버·웹이 이 한 곳을 읽는다.

```ts
export interface CliProvider {
  id: "claude" | "gemini" | "codex" | "shell";   // shell = 빈 tmux 셸
  label: string;                // "Claude Code" | "Gemini CLI" | "Codex (GPT)" | "Shell"
  command: string[];            // 실행 파일 + 고정 인자. 예: ["claude"]
  detect: string[];             // 설치 확인용(예: ["claude","--version"]) — 타임아웃 3초
  installHint: string;          // 없을 때 보여줄 한 줄 안내(실행하지 않는다)
  env?: Record<string,string>;  // 필요한 환경변수 이름만. 값(키)을 코드/로그에 쓰지 않는다
  resumeArgs?: string[];        // 같은 폴더의 지난 대화 이어가기 인자(있을 때만)
}
```

`claude` `gemini` `codex` 의 실제 실행 인자·재개 플래그는 **설치된 CLI 의 `--help` 로 확인해서**
채운다. 기억에 의존해 플래그를 지어내지 않는다. 확인 못 하면 비워 두고 "미확인" 으로 적는다.

### D4. 인증 정보는 웹이 만지지 않는다

- 각 CLI 는 **이미 로그인된 상태**(자기 설정 폴더의 토큰)를 쓴다. 웹은 API 키를 받지도, 저장하지도,
  로그에 남기지도 않는다.
- 처음 로그인이 필요하면 **CLI 가 스스로 띄우는 로그인 화면이 터미널 안에 그대로 보인다.**
  그게 "똑같이 쓴다" 이다. 웹에 로그인 폼을 따로 만들지 않는다.

---

## 4. 요구사항

### T-1. tmux 사용 가능 여부를 먼저 말한다

- 서버 기동 시·`GET /api/cli/status` 에서 `tmux -V` 로 설치/버전을 확인한다.
- 없으면 CLI 탭 생성은 **거절하고 이유를 말한다**: "tmux 가 없습니다 — `sudo apt install tmux`".
  **일반 PTY 로 조용히 대체하지 않는다**(재접속 보장이 깨지는데 모르는 채로 쓰게 된다).
- 최소 버전 요구는 **측정해서** 정한다(`tmux 3.x` 에서 확인). 추측으로 정하지 않는다.

### T-2. CLI 세션 생성 — `POST /api/cli/sessions`

- 요청: `{ provider, cwd?, resume?: boolean, cols?, rows? }`.
- `cwd` 는 **워크스페이스 루트 안** 이어야 한다(`/api/terminal/cwd` 와 같은 경계 규칙, 밖이면 403).
- 서버 동작: ① 설치 확인(T-4) ② `tmux new-session -d -s hs-<provider>-<id> -c <cwd> -x <cols> -y <rows> -- <command…>`
  ③ 옵션 설정(T-3) ④ 웹 탭용 attach PTY 생성 ⑤ `terminal.open` 이벤트 발행.
- 같은 `provider+cwd` 의 **살아 있는 세션이 이미 있으면 새로 만들지 않고 붙는다**(중복 세션으로
  VRAM·토큰을 두 번 쓰지 않게). 새로 만들려면 `forceNew: true`.
- 실패(명령 없음·tmux 오류)는 **HTTP 409 + 한국어 이유**. 가짜 세션을 만들지 않는다.

### T-3. tmux 옵션 — 웹에서 터미널과 똑같이 느껴지게

세션 생성 직후 **그 세션에만** 설정한다(사용자의 전역 `~/.tmux.conf` 를 건드리지 않는다).
`-f /dev/null` 처럼 사용자 설정을 통째로 무시하지 말고, 세션 스코프 `set-option` 으로 덮는다.

- `status off` — 웹 터미널 안에 tmux 하단바가 끼면 "터미널이 아니다" 로 보인다. (끄고, 상태는 웹
  UI 가 보여준다.)
- `mouse on` — 휠 스크롤·클릭이 CLI/tmux 에 전달된다. 단, **xterm.js 의 텍스트 선택·복사**와
  충돌하지 않는지 실제로 확인한다(T-7).
- `escape-time 0` (또는 10) — Esc 가 늦게 먹으면 Claude/Gemini 의 Esc 중단이 굼뜨다.
- `history-limit` 충분히(예: 50000) — 긴 출력 스크롤백.
- `default-terminal "tmux-256color"` + `terminal-overrides` 로 truecolor 전달(`COLORTERM=truecolor`).
- `set-clipboard on`(OSC52) — CLI 가 복사를 요청하면 브라우저 클립보드로 가게 한다(T-7).
- `focus-events on`, `allow-passthrough on`(지원되는 버전에서) — 일부 TUI 의 포커스/이미지 시퀀스.
- `remain-on-exit on` — CLI 가 죽어도 **마지막 화면과 종료 코드가 남는다.** (사라지면 "왜 꺼졌지" 를
  알 수 없다.) 화면에는 "종료됨 (코드 N) — 다시 시작" 버튼을 보인다.

각 옵션이 **이 tmux 버전에서 실제로 받아들여지는지** `tmux show-options -t <세션>` 으로 확인한
결과를 검증 기록에 남긴다. 버전에 따라 없는 옵션은 **조용히 무시하지 말고** 경고로 말한다.

### T-4. 설치·로그인 상태를 탭 만들기 전에 보여준다

- `GET /api/cli/providers` → `[{ id, label, installed, version?, installHint }]`.
  `installed` 는 `detect` 명령을 **3초 타임아웃**으로 실행해 판단한다(실패/타임아웃은
  "확인 못 함" 이지 "없음" 이 아니다 — 둘을 구분해서 말한다).
- 없는 CLI 의 버튼은 비활성이 아니라 **눌리되 "설치 안 됨 — `installHint`" 를 보여준다.** 자동 설치 금지.
- 로그인 여부는 CLI 마다 확인법이 달라 **추측하지 않는다.** 로그인이 안 돼 있으면 CLI 가 터미널
  안에서 스스로 안내한다.

### T-5. 입력 — 터미널과 똑같이

- 키 입력은 `xterm.js` `onData` 의 **원시 바이트**를 그대로 `POST /api/terminal/:id/input`(또는
  WS 입력 채널)로 보낸다. 웹에서 키를 해석·가공하지 않는다.
- **IME(한글) 조합**: 조합 중에는 전송하지 않고 확정된 글자만 보낸다. 조합 중 Enter 가 전송되는
  버그(`isComposing` 무시)는 이 저장소에서 이미 밟았다 — 같은 실수를 반복하지 않는다.
- **붙여넣기**: bracketed paste(`ESC[200~ … ESC[201~`)로 보낸다. 여러 줄을 붙여도 CLI 가 한 번에
  받게 한다. 크기 상한(예: 1MB)을 두고 넘으면 **잘라서 보내지 말고 거절하고 말한다.**
- 브라우저 단축키와 충돌하는 키(Ctrl+W, Ctrl+T, Ctrl+K, Ctrl+P …)는 **터미널에 포커스가 있을 때
  CLI 로 보낸다.** 단, 앱 전역 단축키(명령 팔레트 Ctrl+K)와 겹치면 **터미널 포커스 중에는
  터미널이 우선**이라는 규칙을 정하고 화면(툴팁/도움말)에 적는다.
- `Ctrl+C` 는 반드시 CLI 에 SIGINT 로 가야 한다(복사와 헷갈리지 않게: 선택이 있을 때만 복사).

### T-6. 출력·리사이즈

- 출력은 **WS `terminal.data` 로만**. 바이트를 가공하지 않는다(ANSI·OSC·DEC 모드 그대로).
- 웹 창/탭 크기가 바뀌면 `fit` → `POST /api/terminal/:id/resize` → `tmux resize-window`(또는
  attach PTY 의 `resize`). **두 크기가 어긋나면 TUI 가 깨진다** — 어긋남을 검사하는 테스트를 둔다.
- **여러 클라이언트가 한 세션에 붙을 때**(웹 탭 + 외부 `tmux attach`) 크기 정책을 정한다:
  `window-size latest`(마지막으로 활동한 클라이언트 기준)를 기본으로 하고, 이유를 주석으로 남긴다.
- **재접속 시 화면 복원**: attach 직후 tmux 가 현재 화면을 다시 그려 주므로, 웹은 **추가 스크롤백을
  끌어오지 않는다.** 단, 이어붙은 직후 화면이 깨져 보이지 않는지(커서 위치·대체 화면) 확인한다.
  스크롤백이 꼭 필요하면 `tmux capture-pane -e -p -S -N` 로 **최초 1회만** 가져오는 별도 API 를 만든다.

### T-7. 복사·붙여넣기·링크

- 마우스 드래그 선택 → 복사가 되어야 한다. tmux `mouse on` 이면 드래그가 tmux 선택이 되어 브라우저
  선택과 충돌한다. **둘 중 어느 쪽을 기본으로 할지 실제로 눌러 보고 정한다**(권장: Shift+드래그 =
  브라우저 선택, 일반 드래그 = tmux/CLI). 정한 규칙을 화면 도움말에 적는다.
- CLI 가 보낸 OSC52 복사 요청 → `navigator.clipboard.writeText`. 권한이 막히면 **막혔다고 말한다.**
- URL 은 클릭하면 새 탭으로 연다(`@xterm/addon-web-links`). **`javascript:` 등 위험한 스킴은 막는다.**
  로그인 OAuth 링크가 CLI 에서 자주 나온다 — 이 경로가 매끄러워야 한다.

### T-8. 세션 목록·재접속·종료 (수명주기)

- `GET /api/cli/sessions` → `hs-*` 세션의 `{ name, provider, cwd, createdAt, attachedClients, alive, exitCode? }`.
  서버가 **재시작된 뒤에도** `tmux list-sessions` 로 되살려 목록을 채운다(서버 메모리에만 두지 않는다).
- 웹이 새로 뜨면 **살아 있는 `hs-*` 세션을 자동으로 탭으로 복원**하거나 "이어가기" 목록으로 보여준다.
- **탭을 닫는 것 ≠ 세션을 끝내는 것.** 탭 ✕ 는 **detach 만** 한다(CLI 계속 실행). 세션 종료는 별도
  "세션 종료" 버튼이고 **확인을 받는다**(작업 중인 에이전트를 날릴 수 있다).
- 서버 종료(`shutdown`)는 기존 규칙(`terminal.shutdown`)과 **다르다**: `hs-*` 세션은 **죽이지 않는다.**
  단 `harnesside down --kill-cli` 같은 **명시적 옵션**이 있으면 정리한다. 이 차이를 종료 로그에 적는다.
- `hs-` 가 아닌 세션은 목록에 `읽기 전용` 으로만 보이고, 입력·종료 요청은 403 으로 막는다.

### T-9. UI

- 하단 셸 영역(`BODY.terminal`)의 **탭 막대**에 `＋` 메뉴: `Claude · Gemini · Codex · Shell`.
  CLI 탭은 아이콘/색으로 일반 셸 탭과 구분하고, **어떤 폴더에서 도는지(cwd)** 를 탭 툴팁에 보인다.
- CLI 는 화면이 많이 필요하다. **"확대"** 버튼(또는 더블클릭)으로 셸 영역을 일시적으로 대화 영역까지
  키우고, 다시 누르면 원래 높이로 돌아간다(하단 4줄 기본 높이 규칙은 유지 — 기본값을 바꾸지 않는다).
- 상태 표시: `실행 중 / 종료됨(코드 N) / 연결 끊김(재접속 중…)`. WS 가 끊기면 **끊겼다고 말하고**
  자동 재접속한다(재접속해도 CLI 는 그대로).
- 슬래시 명령과의 연동은 **하지 않는다**(범위 밖). 단, 프롬프트 입력창과 CLI 터미널 중 **키 입력이
  어디로 가는지 포커스가 분명히 보여야 한다**(포커스 테두리).
- 모든 문구는 한국어, 이유 없는 비활성/무반응 금지.

### T-10. 보안 (필수)

- 모든 `/api/cli/*` 와 터미널 WS 는 **기존 토큰 인증을 그대로** 탄다. 새 우회 경로를 만들지 않는다.
- **셸 인젝션 금지**: tmux·CLI 호출은 `execFile`/`spawn` 배열 인자만. 세션명은 서버가 정규식
  (`^hs-[a-z]+-[a-z0-9]{4,8}$`)으로 **검증**하고, 요청으로 받은 이름은 이 검증을 통과해야만 쓴다.
- **키 주입 API(`tmux send-keys`) 는 만들지 않는다.** 입력은 attach PTY 경로 하나뿐이다 —
  입력 경로가 둘이면 인증·감사·IME 규칙이 둘로 갈라진다.
- API 키·토큰·OAuth 코드가 **로그·에러 메시지·`ring` 로그·WS 이벤트**에 나가지 않는지 점검한다.
  터미널 출력 바이트는 로그에 **저장하지 않는다**(비밀이 섞인다). 이벤트에는 메타(세션명·크기)만.
- `cwd` 경계(워크스페이스 루트 밖 거절) 와 심볼릭 링크 우회(`realpath` 비교)를 테스트한다.
- Origin/Host 검증이 WS 에도 걸려 있는지 확인한다(DNS 리바인딩).

### T-11. 승인 게이트·에이전트와의 관계 (경계 명시)

- 외부 CLI(claude/gemini/codex)는 **harnesside 의 승인 게이트·도구 계층을 거치지 않는다.** 그 CLI 가
  파일을 고치고 명령을 실행하는 것은 **그 CLI 자신의 권한 모델** 이 다룬다. 화면에 한 줄로 밝힌다:
  "이 탭의 작업은 harnesside 승인 게이트 밖에서 실행됩니다."
- harnesside 의 파일 감시(`fsWatcher`)가 CLI 가 바꾼 파일을 **트리/미리보기에 반영**하는지 확인한다
  (같은 워크스페이스를 보므로 되어야 한다 — 안 되면 원인을 적는다).
- 동시 편집 충돌(내장 에이전트 vs 외부 CLI)은 **막지 않고 알린다**: 같은 파일을 두 쪽이 쓰면 경고 토스트.

### T-12. 관측·문서

- `GET /api/cli/status` : `{ tmux: { installed, version }, providers: [...], sessions: n }`.
- 로그(`ring`)에는 **생성/종료/오류/재접속 이벤트만** 남긴다(출력 내용 금지).
- `README.md` 에 "웹에서 AI CLI 쓰기" 절 추가: 사용법, tmux 필요, 외부에서 `tmux -L harnesside attach -t hs-…` 로
  붙는 법, 세션이 서버 종료 후에도 남는다는 사실과 **정리하는 법**.
- `PROGRESS.md` 에 이번 작업의 **검증 표**(아래 §6)를 채워 넣는다.

### T-13. 어떤 CLI 를 쓸지 고르는 슬래시 명령 — `/cli`

프롬프트 입력창에서 **슬래시로 CLI 를 고른다.** 명령 목록의 정본은 `src/shared/slashCommands.ts`
(웹 전용 `where: "web"`)이고, 프로바이더 목록의 정본은 `src/shared/cliProviders.ts` 다 — **두 곳에
같은 이름을 따로 적지 않는다**(자동완성은 `cliProviders` 를 읽는다).

| 입력 | 동작 |
|---|---|
| `/cli` | 프로바이더 목록(설치 여부·버전)과 살아 있는 `hs-*` 세션을 **대화 블록**으로 보여준다. 아무것도 만들지 않는다. |
| `/cli claude` · `/cli gemini` · `/cli codex` · `/cli shell` | 해당 CLI 탭을 연다(T-2). 같은 `provider+cwd` 세션이 살아 있으면 **새로 만들지 않고 붙는다.** |
| `/cli <provider> new` | 같은 폴더에 이미 있어도 **새 세션**을 만든다(`forceNew`). |
| `/cli <provider> resume` | 그 CLI 의 이어가기 인자(`resumeArgs`)가 확인된 경우에만. 확인 못 했으면 "이어가기 인자 미확인" 이라고 말한다. |
| `/cli kill <세션명> confirm` | `hs-*` 세션만 종료. **`confirm` 이 없으면 미리보기만**(무엇이 종료되는지 말하고 아무것도 안 한다). |

- **자동완성**: `/` → 명령 목록(기존 규칙). `/cli ` 다음 칸은 **두 번째 토큰 자동완성**으로 프로바이더
  (`claude · gemini · codex · shell`)와 서브명령(`new · resume · kill`)을 추천한다. 설치 안 된 항목은
  회색 + "설치 안 됨" 으로 표시하되 **선택은 가능**하다(눌렀을 때 설치 안내를 말한다, T-4).
- **버튼**: 슬래시 버튼 줄에 `/cli` 하나를 둔다. 누르면 입력창에 `/cli ` 가 채워지고 후보가 뜬다
  (기존 "버튼 = 입력창 채우기" 규칙 그대로).
- **결과는 대화 블록**으로 남는다(접고 펼 수 있음, 같은 인자 없는 명령을 다시 실행하면 접고 편다).
  CLI 탭 자체는 하단 셸 영역에 열린다 — 블록에는 "Claude 탭을 열었습니다 · 세션 `hs-claude-ab12` ·
  폴더 …" 한 줄과 외부에서 붙는 법(`tmux -L harnesside attach -t hs-claude-ab12`)을 적는다.
- **기본값 기억**: 마지막으로 고른 CLI 를 기억해 `/cli` 단독 실행 시 맨 위에 표시한다(저장은
  브라우저 `localStorage` 의 per-viewer 편의값이며, 없어도 동작해야 한다).
- 안 되는 입력(알 수 없는 프로바이더, 폴더 밖 cwd)은 **이유와 함께 실패 블록**으로 말한다.

### T-14. CLI 마다 다른 슬래시 명령 — 대상 전환과 동적 매핑

각 CLI(claude·gemini·codex)는 **자기만의 슬래시 명령**(`/clear` `/compact` `/chat` …)을 가진다. 터미널에
직접 치면 이미 동작하지만, 프롬프트 입력창의 `/` 추천은 harnesside 명령만 알았다. 이를 CLI 별로 바꾼다.

- **대상 선택기**: 프롬프트 바에 `<select>` 하나 — `local_model · <모델명>`(harnesside 의 로컬 모델 에이전트)과 **사용자 환경에
  설치된** CLI(`◆ Claude Code` `◆ Gemini CLI` `◆ Codex`; 미설치는 비활성 + 설치 안내)를 보인다. CLI 를 고르면 그 CLI
  탭을 **열거나(없으면 만들고) 활성화**하고, 다시 고르면 같은 탭을 재사용한다(중복 생성 없음). 슬래시 **버튼 줄**도
  대상에 따라 바뀐다: local → harnesside 명령, CLI → 그 CLI 의 자주 쓰는 명령(`quick`) + `/cli`.
- **하단 셸 창은 없다**(사용자 요구, 2026-10-04): 기본 셸을 만들지 않고 하단 높이 조절·셸 영역 명령도 없다. 터미널은 AI CLI 탭뿐이며
  로컬 대상일 때는 **마운트만 유지한 채 숨긴다**. CLI 대상일 때는 슬래시 **버튼 줄도 숨긴다**(`/` 자동완성은 유지). 새로고침 직후엔 복원된
  CLI 탭이 있어도 **로컬 대화로 시작**하고, 사람이 고르거나 연 때만 CLI 대상이 된다.
- **터미널 위치**: 대상이 CLI 이면 CLI 터미널을 **메시지 출력창 자리**(`position: fixed` 오버레이, 한 인스턴스를 옮기지
  않고 위치만 바꿔 xterm·tmux 상태를 잃지 않는다)에 크게 띄우고 **아래 셸 영역은 접는다**(모니터 줄만 남김). `대화 보기 ↔
  터미널 보기` 버튼으로 harnesside 대화 기록(`/cli` 목록·명령 결과)과 오갈 수 있고, harnesside 명령을 실행하면 자동으로
  대화 보기로 간다. local 로 돌아오면 터미널은 원래 하단 4줄 셸로 돌아온다. 터미널을 **대화 블록으로 변환하지는
  않는다**(출력 파싱은 범위 밖 — 화면 그대로가 목표).
- **대상 전환**: 활성 터미널 탭이 AI CLI 탭이면 프롬프트 입력창의 대상이 **그 CLI** 가 된다(자동). 입력창
  아래에 `harnesside | ◆ Claude Code` 전환 칩을 **항상** 보이고, 대상이 CLI 이면 위 테두리 색·placeholder·
  보내기 버튼 문구("CLI로 보내기")가 달라진다. 엉뚱한 곳으로 보내지 않게 하는 것이 목적이다.
- **전송**: 한 줄은 `텍스트 + \r`, 여러 줄은 bracketed paste. **입력 경로는 attach PTY 하나**(`/api/terminal/:id/input`)
  — `send-keys` 를 만들지 않는다. 죽은 CLI 면 보내지 않고 이유를 말한다.
- **`/cli` 는 항상 harnesside 명령**이다(대상과 무관). 그 밖의 `/…` 은 CLI 대상일 때 **그대로 CLI 로 전달**한다.
  슬래시 **버튼**은 harnesside 명령이므로 누르면 대상을 harnesside 로 돌린다(CLI 대상에서 `/quit` 이
  CLI 로 가는 사고를 막는다).
- **동적 매핑 출처 셋** — 섞였다는 사실을 화면이 말한다:
  1. **내장 명령**: CLI 가 기계가 읽게 내놓지 않는다(`--help` 는 실행 옵션만). `shared/cliProviders.ts` 의
     **버전 붙은 표**(`builtinsVersion`)다. 설치 버전과 다르거나 확인하지 못한 표(`null`)면 추천 목록 하단에
     "내장 명령 표가 오래됐거나 미확인일 수 있음" 을 보인다.
  2. **사용자 정의 명령·스킬**: CLI 가 읽는 폴더를 **스캔**(`server/cliCommands.ts`, `GET /api/cli/commands`).
     claude: `.claude/commands/**/*.md` · `~/.claude/commands` · `.claude/skills/*/SKILL.md` · `~/.claude/skills`.
     gemini: `.gemini/commands/**/*.toml` · `~/.gemini/commands`. 하위 폴더는 `:` 이름 공간. 같은 이름은 사용자
     정의가 내장을 가린다(CLI 와 같은 우선순위).
  3. **플러그인이 주는 명령**은 스캔하지 않는다(설치 구조가 CLI·버전마다 달라 추측하지 않는다) — 입력은 전달된다.
- **하지 않는 것**: `/help` 를 보내 화면을 긁어 목록을 만드는 방식(입력 경로가 둘이 되고 깨지기 쉽다).
- **표를 만드는 법**: 설치된 CLI 의 `/help` 에 **실제로 보이는 이름만** 적고, 확인한 버전을 적는다. 확인 못 한
  CLI 는 `builtinsVersion: null` 과 "문서 기준" 주석을 남긴다. 설명은 확신하는 것만(모르면 비운다).

---

## 5. 구현 순서 (각 단계 끝에 검증하고 다음으로)

1. **정찰**: `terminal.ts` 의 `create/write/resize/close/shutdown` 과 `TerminalView.tsx` 의 입력·IME·
   리사이즈 경로를 읽는다. 재사용할 것과 바꿀 것을 한 단락으로 적는다. 코드를 쓰기 전에.
2. **tmux 래퍼**(`src/server/tmux.ts`): `isInstalled/version/newSession/listSessions/hasSession/
   killSession/setOptions/resizeWindow` — 전부 `execFile` 배열 인자, 타임아웃, 한국어 오류.
   **단위 테스트는 가짜 `execFile` 주입으로**, 별도 **통합 테스트는 실제 tmux 로**(`-L <테스트소켓>`
   으로 사용자 tmux 와 분리 — 사용자의 실제 세션 `claude` `opencode` 를 절대 건드리지 않는다).
3. **프로바이더 목록**(`src/shared/cliProviders.ts`) + `detect`.
4. **세션 매니저**(`CliSessionManager`): create(중복 방지) / list(서버 재시작 복구) / attach PTY /
   detach / kill(확인) / 정리. `TerminalManager` 를 **확장하거나 감싼다** — 복사하지 않는다.
5. **라우트** `/api/cli/*` + WS 이벤트 재사용(`terminal.data/open/exit`).
6. **웹 UI**: `＋` 메뉴, 탭 구분, 확대, 상태 표시, 재접속.
7. **tmux 옵션·키·복사·링크** 튜닝(T-3, T-5, T-7) — **실제 CLI 를 띄워 눌러 보며** 조정.
8. **보안 점검**(T-10) 과 **문서**(T-12).

각 단계에서 `npx tsc --noEmit`, 관련 테스트, `npm run build:web` 를 돌린다.

---

## 6. 검증 (이 표를 채워서 `PROGRESS.md` 에 남긴다 — 못 한 칸은 "미측정")

사용자 tmux 와 분리하기 위해 **테스트는 전용 소켓(`tmux -L hs-test`)** 을 쓰고, 끝나면 그 서버만 정리한다.

| # | 시나리오 | 기대 | 측정 방법 |
|---|---|---|---|
| V1 | tmux 없는 환경(PATH 에서 제거) | 탭 생성 거절 + 설치 안내, 일반 PTY 로 대체 안 함 | 실제 실행 |
| V2 | `claude` 탭 생성 → 질문 입력 → 응답 | 색·TUI 가 터미널과 같음 | 실제 브라우저 스크린샷 |
| V3 | `gemini` 동일 | 〃 | 〃 |
| V4 | `codex` 미설치 | "설치 안 됨" + 안내, 자동 설치 안 함 | 〃 |
| V5 | 브라우저 새로고침 | 같은 세션에 이어 붙고 화면 유지 | 〃 |
| V6 | 서버 재시작(`hs-*` 세션 유지) | 재시작 후 목록 복구, CLI 안 죽음 | `tmux list-sessions` 대조 |
| V7 | 외부 터미널에서 `tmux -L harnesside attach -t hs-…` | 웹과 같은 화면, 입력 양쪽 반영 | 실제 |
| V8 | 탭 ✕ | detach 만, CLI 계속 | `tmux has-session` |
| V9 | "세션 종료" | 확인 후 종료, 확인 전엔 유지 | 실제 |
| V10 | 한글 입력(조합 중 Enter 포함) | 조합 중 전송 안 됨, 확정 글자만 | 실제 |
| V11 | 5MB 붙여넣기 | 거절 + 이유 표시 | 실제 |
| V12 | Esc 중단 반응 | 체감 지연 없음(`escape-time`) | 실제(체감은 "주관" 으로 표기) |
| V13 | 리사이즈(창·분할 크기 변경) | TUI 안 깨짐, 두 크기 일치 | 실제 + 크기 비교 테스트 |
| V14 | OAuth 링크 클릭 | 새 탭으로 열림, `javascript:` 는 차단 | 실제 |
| V15 | 세션명에 `; rm -rf` 등 | 정규식 검증에서 400, 실행 안 됨 | 단위 테스트 |
| V16 | `cwd` 에 `../..` · 심볼릭 링크 | 403 | 단위 테스트 |
| V17 | 토큰 없이 `/api/cli/*` | 401 | 실제 |
| V18 | `hs-` 아닌 세션(`claude`,`opencode`)에 입력/종료 요청 | 403, 세션 무사 | 실제(읽기 전용 확인) |
| V19 | 출력에 비밀 문자열이 있어도 | 로그·`ring` 에 안 남음 | 로그 grep |
| V20 | CLI 가 스스로 종료 | 마지막 화면 + 종료 코드 + 다시 시작 | 실제 |
| V21 | `/cli` 목록 · `/cli claude` · 자동완성 2번째 토큰 | 목록/탭 열림/후보 표시 | 실제 브라우저 |
| V23 | CLI 탭 활성 시 입력창 대상 전환 · `/` 가 그 CLI 명령 추천 · `/help` 가 CLI 로 전달 | 칩·추천·전달 | 실제 |
| V22 | `/cli kill hs-x` (confirm 없이) · `/cli kill claude confirm`(`hs-` 아님) | 미리보기만 / 거절 | 실제 |

**실제 브라우저 확인 규칙**: 서버가 띄운 Chrome(CDP)으로 확인한다. 인증 토큰은 **읽거나 출력하지
않는다**(서버가 자기 창에 URL 로 심어 준다). 토큰이 필요한 호출은 그 창 안에서 실행한다.

---

## 7. 하지 않는 것 (범위 밖 — 요청받아도 이 문서에서는 만들지 않는다)

- tmux 없이 동작하는 "에뮬레이트된 세션 유지".
- 웹에서 CLI 의 **API 키 입력/저장/관리** 화면.
- CLI 출력을 파싱해서 harnesside 의 대화 블록으로 바꾸기(그건 별도 기획 — 터미널 그대로가 목표다).
- `tmux send-keys` 로 외부에서 입력을 주입하는 API.
- 모바일 전용 UI·터치 키보드.
- 사용자의 `~/.tmux.conf` 수정, 사용자가 만든 tmux 세션 종료.

---

## 8. 알려진 함정 (이 저장소/tmux 에서 실제로 문제 되는 것)

- **tmux 가 TERM 을 덮는다**: 안쪽 `TERM` 이 `screen`/`tmux-256color` 가 되어 CLI 의 색 감지가 달라질
  수 있다. truecolor 전달 옵션을 확인하고, 안 되면 CLI 별 환경변수(`COLORTERM`)를 세션에 설정한다.
- **중첩 tmux**: 서버가 이미 tmux 안에서 돌고 있으면 `TMUX` 환경변수가 새어 들어가 `tmux attach` 가
  "sessions should be nested with care" 로 거부된다. attach PTY 의 환경에서 **`TMUX` 를 제거**하고
  `-L` 소켓 정책을 정한다(기본 소켓 vs 전용 소켓 — **외부 `tmux attach` 는 `tmux -L harnesside attach -t hs-…` — 구현에서는 **전용 소켓을 기본**으로 정했다: 사용자의 기본 tmux 서버에는 사람의 세션이 있고, `escape-time`·`focus-events`·`set-clipboard` 는 서버 전역 옵션이라 기본 소켓에서 바꾸면 그 세션들까지 바뀐다. `HARNESSIDE_TMUX_SOCKET` 로 바꿀 수 있다**).
- **서버 재시작 vs PTY**: `node-pty` attach 프로세스는 서버와 같이 죽지만 tmux 서버는 산다. 이 비대칭이
  의도다. 다시 붙을 때 **이중 attach(웹 탭 두 개가 같은 세션)** 가 되지 않게 탭 ↔ 세션 1:1 규칙을 둔다.
- **`remain-on-exit`**: 켜 두면 죽은 pane 이 남는다. 정리 정책(수동 "닫기")이 없으면 세션이 쌓인다.
- **`mouse on` 과 xterm 선택**: 위 T-7. 한쪽만 되는 상태로 두지 않는다.
- **Esc 지연**: `escape-time` 기본 500ms. 반드시 낮춘다.
- **IME 조합 중 Enter**: 이 저장소에서 이미 한 번 사고. T-5.
- **`gemini` 가 snap 설치**: snap 의 샌드박스 때문에 홈 밖 `cwd` 접근이 막힐 수 있다 — 실제로 워크스페이스
  폴더에서 띄워 확인하고, 막히면 이유를 화면에 말한다(추측하지 않는다).
- **사용자 세션 보호**: 이 머신에는 이미 `claude`·`opencode` 라는 **사용자의 tmux 세션이 떠 있다.**
  개발·테스트 중에 `tmux kill-server` 같은 명령을 **절대 쓰지 않는다.** 전용 소켓으로만 시험한다.

---

## 9. 완료 정의

- §6 표의 V1~V23 이 **실제로 실행한 결과** 로 채워져 있다(못 한 칸은 "미측정" + 이유).
- `npx tsc --noEmit` 통과, `npm test` 통과, 새 테스트(세션명 검증·cwd 경계·크기 일치·tmux 래퍼) 추가.
- 사용자의 기존 tmux 세션(`claude`, `opencode`)이 시험 전후로 **그대로** 있다 — 시험 후
  `tmux list-sessions` 로 대조해 기록한다.
- README / PROGRESS 갱신. 커밋은 **사용자가 요청할 때만** 한다.
