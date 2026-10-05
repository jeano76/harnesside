# harnesside

An AI coding agent CLI that talks to a local llama.cpp backend directly and is
fully compatible with the OpenAI Chat Completions API. See
[`PROMPT.md`](./PROMPT.md) for the full design background and requirements.

> 로컬 llama.cpp를 직접 호출하며 OpenAI Chat Completions API와 호환되는 AI 코딩 에이전트
> CLI입니다. 설계 배경과 전체 요구사항은 [`PROMPT.md`](./PROMPT.md)를 참고하세요.

## Screens

**이 README 의 그림은 전부 실제로 뜨는 창을 CDP(`Page.captureScreenshot`)로 찍은 것이다.**
사람이 그린 그림은 하나도 없다. 총 **17장**이고, 각각 언제 · 무엇을 · 어떻게 찍었는지가
[사용법](#사용법) 절에 적혀 있으며 그대로 되풀이할 수 있다.

한 장으로 요약하면 이렇다.

![시작 화면](./docs/screenshots/01-start.png)

- 위쪽 헤더 — 프로젝트 · **사용 중인 모델 경로** · `부팅 12/12` · `실시간`
- 누를 수 있는 예시 프롬프트 3개, 그 아래 단축키 안내
- 맨 아래 계측바 `CPU · RAM · VRAM · CTX · DISK` — 숫자가 아니라 막대

> **직접 확인하기**: 설치한 뒤 프로젝트 디렉터리에서 `harnesside` 를 실행하고
> `node scripts/verify-window.mjs` 를 돌린다. 그림이 없어도 창 검증은 돈다
> (현재 **22/22 통과**).

## What this program is

harnesside is a single-binary terminal coding agent. It reads a prompt, streams a
reply from a local LLM, and executes the tools that reply asks for — reading
and writing files, running shell commands, diffing, and driving a browser over
CDP — looping until the model stops asking for tools. It is deliberately built
around a **local** llama.cpp server rather than a hosted API, so the entire
loop (model weights, conversation history, every file the agent reads) stays on
one machine.

Three things follow from that, and they explain most of the design:

1. **It is a long-running process, not a request/response tool.** A turn can
   take minutes of CPU-bound generation. That is why context is compacted
   automatically rather than being allowed to overflow, why work is
   checkpointed to disk between tool calls, and why a crash has to be
   recoverable on the next launch.
2. **Memory is the scarce resource, not disk.** The model file is tens of
   gigabytes and the machine is not a datacenter. Every subsystem that can
   hold memory has an explicit budget, and the failure mode to design against
   is a host that gets slow and then kills the wrong process.
3. **The UI is a fixed-size grid painted with escape sequences.** The whole
   TUI assumes it knows exactly how many terminal columns and rows it has,
   because it positions the real hardware cursor by absolute row/column. Any
   change that makes a line's real width differ from the width the layout
   budgeted for is a visual bug, not a cosmetic one.

### Request flow

```
keystroke
  └─ App.tsx (Ink)  input box, slash menu, status bar
       └─ AgentLoop.send()
            ├─ check context usage  ─── over threshold ──▶ compact()
            │                                                   │
            │                                     summarize + write checkpoint
            │                                     to .harnesside/state/, resume
            ▼                                                   │
        POST /v1/chat/completions  ──▶ llama-server ──▶ tool_calls?
            │                                                   │
            │                                     yes ─────────┘
            │                                     execute via tools/index.ts
            │                                     (read/write/edit/shell/diff/browser)
            │                                     append results to the transcript
            ▼                                     loop back with the results
        streamed text ──▶ markdown render ──▶ log pane
```

Every hop in that loop has a failure mode that has already bitten this
codebase, and each is documented at its call site and covered by a test. The
`## Implementation status` section below is the running list.

### The subsystems

| Area | Entry point | Responsibility |
|---|---|---|
| Web UI | `src/web/main.tsx` | Prompt, conversation blocks, command palette, AI CLI target (replaced the deleted Ink TUI `tui/App.tsx`) |
| Terminal capabilities | `src/setup/terminal.ts` | What this process may emit, per terminal (bootstrap progress) |
| Keybindings | `src/web/main.tsx` | Command palette shortcuts (the TUI's `tui/keybindings.ts` was deleted with the TUI) |
| Agent loop | `src/agent/loop.ts` | Turn driving, tool dispatch, context accounting |
| Compaction | `src/compaction/` | Checkpoint write/resume, history summarization |
| Self-healing | `src/hermes/` | Failure log, circuit breaker, improvement proposals |
| Backend | `src/backend/` | llama-server process management, OpenAI-compatible client |
| Tools | `src/tools/` | `read_file` / `write_file` / `edit_file` / `run_shell` / `browser_*` |
| Skills & rules | `src/skills/` | Always-on rules, lazily-loaded skills |
| Update | `src/server/updateService.ts` | GitHub Releases check, hash-verified slot swap, boot check, rollback (one path — Q-7) |
| Crash handling | `src/crashHandler.ts` | Synchronous crash log + terminal restore |

`src/setup/terminal.ts` and `src/server/updateService.ts` are
the most recent additions and the ones with the sharpest edges — see the
developer guide below before changing them.

> ## 이 프로그램이 무엇인가
>
> harnesside는 단일 바이너리 터미널 코딩 에이전트입니다. 프롬프트를 받아 로컬 LLM
> 응답을 스트리밍하고, 그 응답이 요구하는 도구(파일 읽기/쓰기, 셸 실행, diff,
> CDP 브라우저 제어)를 실행하며, 모델이 도구를 더 요구하지 않을 때까지
> 반복합니다. 호스팅 API가 아니라 **로컬 llama.cpp** 를 전제로 만들기 때문에
> 모델 가중치·대화 기록·에이전트가 읽은 모든 파일이 한 머신 안에 남습니다.
>
> 여기서 대부분의 설계가 설명됩니다.
>
> 1. **요청-응답 도구가 아니라 오래 사는 프로세스입니다.** 한 턴이 수 분의
>    CPU 바운드 생성을 걸칠 수 있습니다. 그래서 컨텍스트를 자동 압축하고,
>    도구 호출 사이마다 체크포인트를 디스크에 남기며, 다음 실행에서 복구될 수
>    있어야 합니다.
> 2. **부족한 자원은 디스크가 아니라 메모리입니다.** 모델 파일이 수십 GB이고
>    머신은 데이터센터가 아닙니다. 메모리를 잡을 수 있는 서브시스템마다 예산이
>    명시되어 있고, 설계 대상 실패 모드는 "느려진 머신이 잘못된 프로세스를
>    죽이는 것" 입니다.
> 3. **UI는 탈출문자열로 칠하는 고정 크기 격자입니다.** TUI 전체가 터미널의 열과
>    행 수를 정확히 안다고 가정합니다. 실제 커서를 절대 좌표로 이동시키기
>    때문입니다. 줄의 실제 폭이 레이아웃이 예산한 폭과 달라지는 변경은
>    장식이 아니라 버그입니다.

## 사용법

이 절은 **기능 목록이 아니라 실제 사용법**이다. 그림 17장 각각에 대해
무엇을 했고 무엇이 보였는지를 적었다. 없는 것은 **없다고 적었다**.

### 캡처 조건 (실측)

| 항목 | 값 |
|---|---|
| 날짜 | 2026-10-05 |
| 설치 | 전역 설치본 (`~/.npm-global/lib/node_modules/harnesside/dist`) |
| 모델 | `Ornith-1.5-35B-A3B-Q4_K_M.gguf` 35B A3B Q4_K_M (20.4GiB) |
| llama.cpp | **이미 떠 있던 서버를 채택** (`127.0.0.1:8080`) — 우리가 띄우지 않았다 |
| GPU | 브라우저 `off` · VRAM 85% 사용 (8GiB 카드, 여유 816MiB) |
| 창 | 1400×860 · 설정/에디터만 1400×900 |
| 검증 | `scripts/verify-window.mjs` **22/22 통과** |

`llama-server` 를 새로 띄우지 않은 이유가 화면에 그대로 적혀 있다. 8GiB 카드에서
두 개를 띄우면 즉시 OOM 한다 — 추측 아니라 실측이라서 프로그램이 스스로 멈춘다.

### 1. 창을 처음 열면

![시작 화면](./docs/screenshots/01-start.png)

- 위쪽: 프로젝트 이름 · **사용 중인 모델 경로** · `부팅 12/12` · `실시간`
- 빈 화면이 아니라 **누를 수 있는 예시 프롬프트 3개**
- 그 아래 단축키 안내 — 아이콘을 눌러도 같은 것이 열림
- 맨 아래 **계측바** `CPU · RAM · VRAM · CTX · DISK`: 숫자가 아니라 막대라
  언제 과부하인지 먼저 보인다
- 입력창 아래 `프롬프트 목표` — 지금 어디로 보내는지 항상 보인다

### 2. 슬래시 명령 — 메뉴, 스크롤, 도움말

입력창에 `/` 를 치면 이 프로그램의 명령이 후보로 뜬다.

![슬래시 메뉴](./docs/screenshots/02-slash-menu.png)

- `↑` `↓` 로 고르고 `Tab`/`Enter` 로 **완성**하고, `Esc` 로 닫는다
- 아래로 내려가면 **목록이 선택 항목을 따라간다**

![슬래시 스크롤](./docs/screenshots/03-slash-scroll.png)

계측값: 항목 14개 · 한 줄 26px · 창 240px · 전체 384px.
9칸째(선택 항목이 234~260px)로 처음 스크롤이 움직여 `scrollTop` 이 21이 되었다.
**아직 보이는 구간에서는 움직이지 않는다** — 필요한 만큼만 움직이는 것이 의도다.

`/help` 를 실행하면 전체 목록이 **역할별로 묶여** 나온다.

![도움말](./docs/screenshots/04-slash-help.png)

맨 아래 한 줄이 이 프로그램의 태도다.

```
이 창에서는 쓸 수 없는 명령 3개: /keys /copy /mouse
  — 콘솔(TUI) 전용이며 그 UI는 2026-10-04 에 삭제되었습니다.
```

조용히 없는 척 하지 않고 **몇 개와 무엇인지** 말한다.

#### 명령 전체 (웹 창에서 쓰는 14개 / 등록 17개)

| 명령 | 하는 일 |
|---|---|
| `/help` | 이 프로그램의 명령 목록 |
| `/models` | 이 PC 에서 구동 가능한 로컬 모델 목록 · 교체 |
| `/server` | 모델 제공 서버 상태 · `restart` 로 재시작(확인 후) |
| `/reset` | 현재 GPU·VRAM·RAM 에 맞는 모델/설정으로 다시 계산 |
| `/term` | 감지된 터미널과 지원 기능 상태 |
| `/cli` | AI CLI 를 tmux 탭으로 열기 · 목록 · 종료 |
| `/skills` | 불러온 스킬 목록 |
| `/rules` | 불러온 룰 목록 |
| `/improve` | 반복 실패를 분석해 룰 제안 |
| `/improve-apply` | 마지막 제안을 룰 파일로 저장 |
| `/compact` | 지금 컨텍스트 압축 실행 |
| `/queue` | 대기열 보기 |
| `/plan-clear` | 멈춘 계획 표시 초기화 |
| `/quit` | 정상종료 (**15초 안에 두 번** — 확인 없이 끝내지 않는다) |

`/keys` · `/copy` · `/mouse` 는 등록되어 있으나 웹 창에는 없습니다.
이름은 지우지 않고 **이유와 함께** 남겼다 — 없는 명령을 찾는 사용자가 생기기 때문.

`/models` · `/server` · `/reset` · `/cli` 는 **인자가 필요한 명령**이라
입력을 치면 다음 단계 후보가 이어서 나온다(`1`·`2`·`confirm`).
바꾼다는 사실은 미리보기 → `confirm` 두 번으로 나눠 진다.

### 3. 슬래시 명령의 실제 결과

명령은 **모델을 부르지 않는다.** 서버가 정본을 읽어 즉시 그린다.
그 여기가 이 프로그램의 편한 점이다.

**`/models` — 이 PC 에서 무슨 모델이 돌 수 있나**

![모델 목록](./docs/screenshots/11-models.png)

- **현재 실행 중인 모델**과 그 조건을 그대로 보여준다(포트 8080 · VRAM 6.1GiB 사용 ·
  `-ngl 999` · `--n-cpu-moe 33`)
- 목록에는 각 모델의 상태 배지가 붙는다 — 35B MoE 는 ⚠ **RAM 스터빙**, 9B 는 ✅ VRAM
- 고르면 **지금 서버를 내렸다 올리는 동작**이라서, 바꾼 뒤 무엇이 달라지는지 미리
  보여준 뒤 `confirm` 을 요구한다
- 교체는 `/models <번호>` → `confirm` 두 단계

**`/term` — 창이 스스로를 설명한다**

![터미널 상태](./docs/screenshots/12-term.png)

```
창          : 웹 브라우저 (콘솔 터미널이 아님)
브라우저    : ... Chrome/153.0.0.0 ...
화면        : 1400×860px · 배율 1 · 색 24bit
마우스      : 항상 켜짐
```

**`/skills` · `/rules` — 이 프로젝트가 무엇을 알고 있나**

![스킬](./docs/screenshots/13-skills.png)

![룰](./docs/screenshots/14-rules.png)

둘 다 `.harnesside/skills/*.md` · `.harnesside/rules/` 를 읽는다.
`.clinerules` 도 같이 본다. 파일이 없으면 **"없음"이라고 말한다** —
빈 목록을 "준비 완료"처럼 보여주지 않는다.

### 4. 설정 — 모델과 업데이트

![설정](./docs/screenshots/06-settings.png)

**모델**

- `저장 위치`와 `사용 중` 경로를 **따로** 보여준다 — 다르면 헷갈리니까
- `이미 실행 중인 서비스를 사용합니다` — **채택 경로**. 우리가 띄운 게 아닌 서버는
  **죽이지 않는다**. 부팅 로그에도 그 사실이 남는다
- HuggingFace 검색과 `순차 다운로드` 안내

**업데이트**

```
설치됨      0.1.0
빌드        20261005  08c4467  더티
설치 해시   검증 안 됨 — 전체 트리를 자기 매니페스트로 대조하지 못했습니다
설치 경로   /home/jeano/.npm-global/lib/node_modules/harnesside/dist
```

마지막이 이 프로그램의 태도다. 이 설치본은 **npm 이 설치한 것**이라
`dist/manifest.json` 이 없다. 그래서 해시를 계산할 **수단이 없고**
화면은 그대로 "검증 안 됨" 이라고 말한다. 0이나 그럴듯한 해시로 메우지 않는다.

### 5. 명령 팔레트

![명령 팔레트](./docs/screenshots/05-command-palette.png)

`Ctrl+K` 또는 `Ctrl+P`. 두 단축을 **같은 기능**에 걸었다 — "어느 쪽이 맞지" 하고
헤매지 않게. 그리고 이 시점의 팔레트 항목은 **3개뿐**이다(명령 팔레트 · 서버 로그 ·
설정). 더 적혀 있지 않은 것은 아직 없다는 뜻이다.

### 6. 서버 로그 — 부팅이 왜 그랬는지

![서버 로그](./docs/screenshots/07-log-panel.png)

`▴ 서버 로그` 를 누르면 부팅 12단계를 **원문 그대로** 보여준다.
`서버 / llama / 브라우저 / 프로세스` 로 걸러내고, 수준과 줄 수를 좁힌다.
하단에 `4줄 · 3,656자 · 상한 500,000자` — **접어도 쌓이고 있는다**는 사실을
숫자로 말한다.

### 7. 에이전트에게 일시키기

![파일 읽기](./docs/screenshots/15-tool-read.png)

한 턴이 이렇게 보인다.

- 턴 머리말: 사람이 한 일 · `파일 2 · 도구 read_file · 최신` · 소요시간
- `Thinking 356자` — 추론을 **숨기지 않되 접을 수 있게** 보여준다
- 파일 칩 `app.ts 편집 · /…/src/app.ts · TypeScript` — 경로와 언어를 함께
- `✓ 셸 실행 ls -la … /tmp/opencode/demo-project/src` · `완료` 배지
- `컨텍스트 1,732/32,768` — 도구 호출마다 숫자가 움직이는 것이 보인다
- 실행 중에는 보내기 버튼이 `대기열에 추가`로 바뀐다 — **거절하지 않고 받는다**

이어서 실제로 고친 결과.

![파일 편집 과정](./docs/screenshots/16-agent-edit.png)

이 그림에서 **35B 모델이 지운 파일을 목록에 넣었다.** 화면은 그 사실을 덮지 않고
`edit_file` 이 무엇을 썼는지 그대로 보여준다. 모델의 실수를 숨기는 화면은
도움이 되지 않는다 — **사용자가 직접 확인할 수 있어야 한다.**

셸 실행만 떼어 보면 이렇다.

![셸 실행](./docs/screenshots/10-shell-tool.png)

`원본` / `답` 으로 **모델이 본 것과 실제 출력을 따로** 열어본다.
마크다운 표도 렌더링된다.

### 8. 파일 열기와 편집

![에디터](./docs/screenshots/17-file-view.png)

도구 호출 칩의 `편집` 을 누르면 열린다. **별도 패널이 아니라 대화 위에 겹친다.**
`편집 중 · 자동 저장` · `저장됨 (버전)` · 탭에 경로와 언어 · `닫기`.

**자동 저장**이 실제로 돈다 — 입력을 멈추면 1.5초 뒤에 PUT 으로 디스크에 쓰이고
헤더가 `저장됨 (v…)` 으로 바뀐다(계측: 2.5초 안에 디스크 반영 확인).

**바깥에서 파일을 고친 경우** — 두 갈래로 갈린다. 손댄 것과 안 손댄 것의 결과가
다르기 때문이다.

- **손대지 않았다면** → 디스크를 따른다(계측: 2초 만에 반영)
- **고치는 중이라면** → **덮어쓰지 않는다.** 자동 저장이 서버의 새 버전을 보고
  409 를 받으면 **자동 덮어쓰지 않는다** 고 말하며 선택지를 내놓는다

![편집 충돌](./docs/screenshots/19-edit-conflict.png)

```
다른 곳에서 이 파일이 바뀌었습니다(서버 v1791174703731). 자동 덮어쓰지 않습니다.
[서버본문 보기] [내 편집 보기]      ← 둘 다 눈으로 확인
[내 편집 유지] [서버본문 사용] [둘 다 남기기]
```

버전 번호까지 같이 보여준다 — "누가 언제 바꿨는지"가 아니라 **지금 어느 버전이
기준인지** 를 말해 충돌을 곧바로 해결하게 한다. 두 본문을 먼저 눈으로 비교하는
버튼이 위에 있는 이유다.

> **이 절의 내용은 고치면서 계측한 것이다.** 고치기 전에는 세 가지가 틀렸다:
> 바깥 변경을 **아무것도 하지 않았다**(알림만), 자동 저장은 **한 번도 일어나지 않았다**
> (화면에는 "자동 저장" 이라고 적혀 있었다), 같은 파일의 내용 갱신이 **미저장 편집을
> 조용히 지웠다.** 셋 다 계측으로 잡힌 것이고, 각각 별도 테스트가 붙어 있다.

### 9. 프롬프트 대상 — 로컬 모델과 AI CLI

![대상 선택](./docs/screenshots/18-cli-target.png)

기본은 **이 PC 의 로컬 모델**이다. 고르면 사용자 환경에 이미 있는 AI CLI 로 보낼 수
있고, tmux 탭으로 띄워 함께 쓴다.

```
◆ Claude Code
◆ Gemini CLI — 확인 못 함
◆ Antigravity (agy)
◆ Codex (GPT) — 설치 안 됨
```

`설치 안 됨` 과 `확인 못 함` 은 **다른 상태**다. 전자는 **알고 있고 없는 것**이고,
후자는 **모르는 것**이다. 둘을 같은 말로 뭉개지 않는다.

### 10. 좁은 창

![좁은 창](./docs/screenshots/08-narrow.png)

800px 에서 가로 스크롤이 생기지 않는다(계측: `scrollWidth <= clientWidth`).
1600×1000 으로 띄우는 Chrome 창이 아니라 **창 자체가 줄어드는** 경우다.

### 11. 두 개를 동시에 띄울 때

프로젝트마다 `.harnesside/` 상태가 따로이므로 **인스턴스도 따로**다.
그리고 각 인스턴스는 **자기 CDP 포트와 자기 Chrome 프로필**을 가진다.

실측: 사용 중인 프로젝트 7317 · 이 문서를 만든 프로젝트 7318 · 새 프로젝트 7319,
CDP 는 9222 · 9223 · 9224 로 전부 분리됐다.

CDP 포트를 **이름으로 지정하지 않으면** 비어 있는 포트를 찾아 쓴다.
`HARNESSIDE_CDP_PORT` 로 지정했는데 그 포트를 이미 다른 인스턴스가 쓰고 있으면
**조용히 바꾸지 않고 멈춘다** — 엉뚱한 창을 띄우는 것보다 안 뜨는 게 낫다.

> 이 분리는 **실측으로 고친 것**이다. 고치기 전에는 두 번째 인스턴스가
> `--user-data-dir` 가 같은 Chrome 에 URL 을 넘겨서 **첫 번째 인스턴스의 브라우저에
> 새 창이 떴고**, 자기 CDP 에 붙은 것처럼 "기동 성공" 이라고 보고했다.

### 자주 하는 일 → 하는 법

| 하고 싶은 것 | 하는 법 |
|---|---|
| 파일 찾기 | "최신 변경 파일을 찾아" · "테스트를 실행하고 실패한 건만 정리해줘" |
| 코드 이해 | "src/app.ts 를 읽고 이 함수가 하는 일을 설명해줘" → 칩의 `편집` 으로 소스 보기 |
| 고치기 | "… 바꿔줘" → `edit_file` 결과를 확인 → 안 맞으면 "그 부분을 되돌려줘" |
| 실측하기 | "ls -la 실행해서 보여줘", "테스트를 돌려줘" |
| 중간에 정리 | `/compact` · 긴 일이 되면 자동 압축이 먼저 도는 중 |
| 기다리는 동안 | 보내기 버튼이 `대기열에 추가`가 됨 · `/queue` 로 순서 보기 |
| 키보드 없이 명령 찾기 | `Ctrl+K` · 슬래시는 입력창에서 `/` |

### 추론 예산이 초과되면 무슨 일이 벌어지나

본턴에서 모델이 **생각만 하다가 아무것도 안 하는** 것을 막으려고 상한이 있다.
초과하면 **이번 턴을 "생각" 에서 "직접 도구 호출" 로 전환한다.** 상한은
`.harnesside/config.yaml` 의 `agent.maxReasoningTokens` 로 정한다.

```
추론 예산 초과 → 도구 호출로 전환 (66/64·추정)
```

이 문구는 **무엇이 일어났는지 · 다음에 무엇을 할 것인지 · 이 값이 추정치라는 사실**을
함께 말한다. 예전에는 `Thinking 꺼짐 (예산 초과)` 라고 적었는데 그것은 **틀린 말**이었다 —
thinking 은 상시 동작하고, 실제로 바뀐 것은 이 턴의 행동 모드뿐이었다. 툴팁마저
"다음 턴에 다시 켜집니다" 라고 말해 라벨과 서로 모순이었다.

> 이 화면을 고치면서 **더 큰 것 두 개**가 함께 드러났다. 둘 다 **설정만 있고 배선이 없는**
> 것이었다 — 사용자가 고쳐도 아무 반응이 없고, 서버 로그는 그 손잡이를 가리킨다.
>
> 1. **`agent.maxReasoningTokens` 를 아무도 읽지 않았다.** 스키마에 "사고 토큰 상한" 으로
>    노출되어 있었고 로그도 "설정에서 올리라" 고 안내했다. 실제로는 항상 4,096이었다.
>    이제 설정에서 실제로 읽는다(범위는 정본이 한 군데서 좁힌다).
> 2. **웹이 서버의 상한을 몰랐다.** 서버가 64 로 좁혀 강제 전환해도 웹은 4,096 으로 계산해
>    화면에 아무 설명이 없었다. 이제 턴마다 서버가 정본을 알리고 웹이 따른다.

### 입력창 — 안내문 · 높이 · 히스토리

입력창은 두 가지 정보를 **안내문에 담아서** 보여준다.

```
무엇을 할까요? (Enter 로 전송 · Shift+Enter 줄바꿈 · / 로 명령 · ↑↓ 지난 프롬프트)
```

- `/ 로 명령` — 슬래시 명령이 **14개** 있는데 발견할 방법이 입력창 밖에 있었다
- `↑↓ 지난 프롬프트` — 프롬프트를 하나라도 보낸 뒤에만 붙는다 (키만 되는 기능은 알려지지 않는다)

**높이 기본값은 2줄(104px)** 이다. 줄 높이 18px(글꼴 12 × 1.5)를 실제 창에서 재서
계산했다. 줄 수로 환산하면 이렇다.

| 저장값 | 보이는 줄 |
|---|---|
| 70 (최소) | 1줄 |
| 86 | 1줄 |
| 104 (기본) | 2줄 |
| 122 | 3줄 |

> **옛 주석이 틀렸다.** 예전엔 "기본 104 = 3줄 + 패딩 16 + 하단 바 34" 라고 적혀 있었는데,
> **하단 바는 이 상자의 형제다** — 안에 있는 줄이 아니라서 3이 아니라 **2줄**이었다.
> 숫자를 적어 두고 확인하지 않은 것이 가장 오래 남는 오류다. 그래서 드래그 간격을 16px 에서
> **18px(=한 줄)** 로 맞췄다 — 예전 간격으로는 줄 단위 높이가 손잡이로 닿지 않는 값에
> 걸렸다(86±16 = 102 · 70). 기본 높이는 86(1줄)로 줄였다가 한 줄 더 넓혀 달라는 요청에
> **104(2줄)** 로 두었다.
>
> **최소값도 70 으로 올렸다.** 예전엔 48이었는데, 거기까지 줄이면 타이핑한 글자가
> **하나도 보이지 않는다**(실측 `clientHeight` 32). 입력을 못 보는 상태는 장식이 아니라 사고다.

### 단축키

| 키 | 동작 |
|---|---|
| `Enter` | 전송 · 슬래시 메뉴가 켜져 있으면 **먼저 완성** |
| `Shift+Enter` | 줄바꿈 |
| `Ctrl+K` · `Ctrl+P` | 명령 팔레트 |
| `↑` `↓` | **프롬프트 히스토리** — 지난 말을 되살린다 (아래 절) |
| `↑` `↓` (메뉴가 열렸을 때) | 슬래시 후보 이동 — **히스토리보다 우선한다** |
| `Tab` | 후보를 입력창에 완성 |
| `Esc` | 메뉴 · 팔레트 닫기 |
| `Alt+` `←` `→` `↑` `↓` | 패널 이동 |

### 프롬프트 히스토리 — `↑` `↓`

입력창에서 `↑` 를 누르면 **지난 프롬프트가 되살아난다.** `↓` 는 반대로 가고,
최신 다음에 닿으면 **브라우즈하기 전에 쓰던 반쯤 쓴 문장**이 돌아온다.

셸처럼 무조건 과거로 대는 것은 하지 않는다. **커서가 있는 줄을 먼저 본다.**

- `↑` 는 커서가 **첫 줄**일 때만 과거로 간다
- `↓` 는 커서가 **마지막**일 때만 다음으로 간다

그래서 두 줄로 쓴 프롬프트 **본문을 고치는 중에 과거가 끼어들지 않는다.**
기능을 넣으면서 편집을 망치는 일은 없다.

`/` 를 치면 슬래시 메뉴가 뜨는데, 그때 `↑` `↓` 는 **후보 이동**이다 — 더 좁고 더 급한
요구이므로 언제나 먼저다. 메뉴를 `Esc` 로 닫으면 곧바로 히스토리가 된다.

연속으로 같은 말을 두 번 보낸 것은 **한 번만** 꺼낸다. 하지만 떨어져 나온 중복은
**지우지 않는다** — "1번 · 2번 · 1번" 은 셋 다 실제로 보낸 말이다.

> 이 절의 `↑` `↓` 는 **실제 창에서 눌러서** 확인했다(키가 DOM 에 도착했음을 계측기로
> 확인하고 결과를 읽었다). 키만 보낸 척하고 성공으로 세지 않는다.

## Structure

Regenerated from the filesystem (**2026-10-05**). LOC excludes `*.test.ts`;
the test count is the number of `*.test.ts` files (**182** files, **2210** cases).

```
src/  47,161 total (non-test)
  server/     13,436  the daemon: 12-step boot, ~70 HTTP routes, WS hub,
                          terminal/PTY, approval gate, updater, tmux CLI hosting
  setup/      10,887  hardware + tuning + port planning, llama.cpp build and
                          launch, model catalogue/download/provisioning, the
                          12-step `ensureLocalStack` ladder
  web/        11,156  the React SPA served into the Chrome window: agent panel,
                          IDE frame, file editor, monitors, settings
  agent/       2,413  the turn loop: tool-call stream, retry/repeat detection,
                          plan progress, salvaging truncated tool calls
  backend/     1,421  OpenAI-compatible client + llama-server process manager
  tools/         987  read/write/edit/run_shell, diff rendering, CDP browser tools
  models/        983  HuggingFace search, hardware-fit scoring, resumable download
  session/       903  conversation blocks (canonical), session store, autosave
  compaction/    869  context summarisation, checkpoints, durable notes
  shared/        846  zero-import pure data: slash commands, CLI providers,
                          metrics formatting, symbols, search ranking, token estimate
  config/        793  settings schema, provenance (where each value came from)
  git/           506  status/diff/commit/push with redaction and conflict stop
  fs/            501  root-escaping path guards, repo-wide search and ranking
  hermes/        229  circuit breaker, failure log, rule-proposal loop
  auth/          213  bearer token, Host/Origin allowlist for the loopback server
  skills/        207  rule/skill discovery across 8 existing AI-CLI conventions
.harnesside/          per-project state (git-ignored)
  config.yaml         backend/model/compaction settings
  rules/              always-applied project rules
  skills/             trigger-based, lazily-loaded skill docs
  state/              runtime checkpoint, instance lock, server log
```

Reproduce with:

```bash
find src -name '*.ts' -o -name '*.tsx' | grep -v '\.test\.ts$' \
  | xargs wc -l | tail -1          # 47161
find src scripts -name '*.test.ts' | wc -l   # 182
```

Design rationale, the module map in prose, terminal capability detection, and
the Hermes loop: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

> ## 구조
>
> 파일시스템에서 다시 뽑았다 (**2026-10-05**). LOC 는 테스트(`*.test.ts`) 제외,
> 테스트 수는 `*.test.ts` 파일 **182개 · 케이스 2210개**다.
>
> ```
> src/  47,161 total (non-test)
>   server/     13,436  데몬: 12단계 부팅, HTTP 라우트 약 70개, WS 허브,
>                          터미널/PTY, 승인 게이트, 업데이터, tmux CLI 호스팅
>   setup/      10,887  하드웨어·튜닝·포트 계획, llama.cpp 빌드와 기동,
>                          모델 카탈로그/다운로드/프로비저닝, 12단계 ensureLocalStack
>   web/        11,156  Chrome 창에 제공되는 React SPA: 에이전트 패널, IDE 프레임,
>                          파일 편집기, 계측, 설정
>   agent/       2,413  턴 루프: 도구 호출 스트림, 재시도/반복 감지, 계획 진행,
>                          잘린 도구 호출 복구
>   backend/     1,421  OpenAI 호환 클라이언트 + llama-server 프로세스 관리
>   tools/         987  read/write/edit/run_shell, diff 렌더링, CDP 브라우저 도구
>   models/        983  허깅페이스 검색, 하드웨어 적합도 점수, 재개 가능 다운로드
>   session/       903  대화 블록(정본), 세션 저장, 자동 저장
>   compaction/    869  컨텍스트 요약, 체크포인트, 지속되는 노트
>   config/        793  설정 스키마, 각 값의 출처(provenance)
>   shared/        846  import 0개인 순수 데이터: 슬래시 명령, CLI 프로바이더,
>                          계측 포맷, 심볼, 검색 랭킹, 토큰 추정
>   git/           506  status/diff/commit/push — redact + 충돌 시 중단
>   fs/            501  루트 이탈 방지 경로 가드, 저장소 전체 검색과 랭킹
>   hermes/        229  회로차단기, 실패 로그, 룰 제안 루프
>   auth/          213  bearer 토큰, 루프백 서버의 Host/Origin 허용 목록
>   skills/        207  기존 AI CLI 컨벤션 8종에 대한 rule/skill 탐색
> .harnesside/          프로젝트별 상태 (git ignore 대상)
>   config.yaml         백엔드/모델/컴팩션 설정
>   rules/              항상 적용되는 프로젝트 규칙
>   skills/             트리거 기반 지연 로딩 skill 문서
>   state/              런타임 체크포인트, 인스턴스 락, 서버 로그
> ```
>
> 재현 명령:
>
> ```bash
> find src -name '*.ts' -o -name '*.tsx' | grep -v '\.test\.ts$' \
>   | xargs wc -l | tail -1          # 47161
> find src scripts -name '*.test.ts' | wc -l   # 182
> ```
>
> 설계 근거 · 모듈 해설 · 터미널 capability 감지 · Hermes 루프:
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Getting started

> **npm 에는 아직 게시되지 않았습니다** (2026-10-05 실측: `npm view harnesside` → `404`).
> `npm install -g harnesside` 는 **오늘 실패합니다.** 오늘 실제로 되는 경로는
> **체크아웃에서 빌드해서 전역 설치**하는 것입니다. 릴리스 자산(GitHub Releases)은
> 아래 [Release](#release) 에 있고, npm 게시는 그 뒤의 일입니다.

```bash
git clone https://github.com/jeano76/harnesside && cd harnesside
npm ci
npm run install:g        # 빌드 → 전역 설치 → **설치본 검사**
harnesside
```

`npm run install:g` 는 설치 후 아래를 확인하고 **하나라도 어긋나면 실패**합니다
(`scripts/install-global.mjs`).

- `bin` 이 심볼릭 링크로 만들어졌고 **패키지 안**을 가리키는가
- 셀프업데이트의 대상 디렉터리(`installRoot`)가 npm 전역 prefix 전체가 **아닌가**
- 설치된 `dist` 가 **방금 만든 것**과 같은가 · 빌드 신원이 실렸는가 · `--version` 이 도는가

`npm install -g .` 를 **직접 쓰면 최신 코드가 아닙니다.** 이 패키지의
`prepublishOnly` 는 `npm publish` 전용이라 로컬 폴더 전역 설치 경로에서는 돌지 않고,
**옛 `dist/` 가 그대로 전역에 남습니다** — 그 옛 코드가 `--version` 으로 정상 동작합니다.
(계측: 세 훅을 심은 실험 패키지에서 `npm install -g .` 는 **`prepare` 만** 실행 —
`npm pack` 는 `prepack`+`prepare`. `prepare` 를 붙이면 저장소 안의 `npm ci` 에서
타입 오류가 **설치 실패**로 보이므로 붙이지 않았습니다.)

On first launch `harnesside` provisions whatever is missing — llama.cpp, a model,
the ports — and says which step it is on. When it cannot do something it says
**which step, what failed, why, and what to do next** rather than opening a blank
window. `harnesside doctor` runs the same checks read-only, before anything is
changed, and reports what it could not measure as **unmeasured** rather than as
zero or false.

Per-project state follows your working directory: each project gets its own
`.harnesside/config.yaml`, `rules/` and `skills/`. The global command is only the
entry point — per-project state stays in that project.

To uninstall: `npm rm -g harnesside` (from anywhere).

### Requirements

| | 요구 | 확인 방법 |
|---|---|---|
| Node | **22 이상** (`engines`) | `node -v` |
| 브라우저 | Chrome 또는 Chromium | `google-chrome --version` |
| 터미널 | tmux | `tmux -V` |
| OS | **POSIX** (Linux·macOS) | 아래 "미측정" 참조 |
| GPU | 선택 — 없으면 CPU 로 돈다 | `harnesside doctor` 의 VRAM 여유 |
| llama.cpp · 모델 | **자동 준비** (첫 실행) | `harnesside doctor` |

- **Node 20 은 측정했고 동작하지 않습니다** — `node-pty` 가 종료 시 SIGSEGV 로 죽고,
  Node 22 전에는 전역 `WebSocket` 가 없습니다. 그래서 `engines` 를 `>=18` → `>=22` 로
  좁혔습니다.
- Chrome·Chromium 은 CDP(`9222`)로 붙습니다. 대체 렌더러는 없습니다 — 창이 뜨지 않으면
  IDE 도 뜨지 않습니다.
- **자동 준비되는 것**: llama.cpp 빌드, 모델 다운로드, 포트 계획.
  **자동 준비 안 되는 것**: Node, 브라우저, tmux.

<details>
<summary>구동환경에서 확인하지 못한 것 (측정 안 함)</summary>

- **macOS · Windows 는 미측정**입니다. CI 러너는 Linux 이고, 로컬에서도 Linux 만
  돌렸습니다. 특히 셀프업데이트의 교체가 `chmod 0o755` 를 쓰므로 **POSIX 전용**입니다
  — Windows 에서 이 경로는 동작하지 않습니다.
- GPU 실부하, 여러 동시 모델, 디스크 용량 경계, Wayland/X11 분기 같은 것은
  여기서 검증하지 않았습니다. 전체 목록은
  [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

</details>

<details>
<summary>개발용 — 체크아웃에서 직접 실행</summary>

```bash
git clone https://github.com/jeano76/harnesside && cd harnesside
npm ci
npm run dev          # 서버 :7317 + Vite :5317, 둘 다 watch
npm test             # 유닛테스트 (node:test, tsx로 구동)
npm run typecheck
npm run build        # dist/ 를 실행하려면 빌드가 먼저다
node dist/server/index.js     # 전역 설치가 실행하는 것과 같은 바이너리
```

`npm link` 도 동작하지만 문서화된 설치 경로가 아닙니다 — 체크아웃을 가리키는
심볼릭 링크로 남으므로 나중에 `git checkout` 을 하면 전역 `harnesside` 가 조용히
다른 코드를 실행하게 됩니다.

</details>

> ## 시작하기
>
> > **npm 에는 아직 게시되지 않았습니다** (2026-10-05 실측: `npm view harnesside` → `404`).
> > `npm install -g harnesside` 는 **오늘 실패합니다.** 오늘 실제로 되는 경로는
> > **체크아웃에서 빌드해서 전역 설치**하는 것입니다.
>
> ```bash
> git clone https://github.com/jeano76/harnesside && cd harnesside
> npm ci
> npm run install:g        # 빌드 → 전역 설치 → **설치본 검사**
> harnesside
> ```
>
> `npm run install:g` 는 설치 **뒤에** 다음을 확인하고 하나라도 어긋나면 **실패**합니다
> (`scripts/install-global.mjs`).
>
> - `bin` 이 심볼릭 링크로 만들어졌고 **패키지 안**을 가리키는가
> - 셀프업데이트의 대상 디렉터리(`installRoot`)가 npm 전역 prefix 전체가 **아닌가**
> - 설치된 `dist` 가 **방금 만든 것**과 같은가 · 빌드 신원이 실렸는가 · `--version` 이 도는가
>
> `npm install -g .` 를 **직접 쓰면 최신 코드가 아닙니다.** 이 패키지의
> `prepublishOnly` 는 `npm publish` 전용이라 로컬 폴더 전역 설치 경로에서는 돌지 않고,
> **옛 `dist/` 가 그대로 전역에 남습니다** — 그 옛 코드가 `--version` 으로 정상 동작합니다.
> (계측: 세 훅을 심은 실험 패키지에서 `npm install -g .` 는 **`prepare` 만** 실행 —
> `npm pack` 는 `prepack`+`prepare`. `prepare` 를 붙이면 저장소 안의 `npm ci` 에서
> 타입 오류가 **설치 실패**로 보이므로 붙이지 않았습니다.)
>
> 첫 실행에 없는 것(llama.cpp · 모델 · 포트)을 자동으로 준비하고 **어느 단계인지**를
> 말합니다. 준비할 수 없는 것은 빈 창으로 두지 않고
> **어느 단계에서 · 무엇이 · 왜 · 다음 무엇을** 말합니다.
> `harnesside doctor` 는 같은 판정을 **아무것도 바꾸지 않고** 먼저 돌려본다.
>
> 프로젝트별 상태는 **작업 디렉토리**를 따라갑니다 — 각 프로젝트가 각자의
> `.harnesside/config.yaml` · `rules/` · `skills/` 를 갖습니다. 전역 명령은 진입점일
> 뿐이고 상태는 해당 프로젝트에 남습니다.
>
> 제거: 아무 위치에서나 `npm rm -g harnesside`.
>
> ### 요구 환경
>
> | | 요구 | 확인 |
> |---|---|---|
> | Node | **22 이상** (`engines`) | `node -v` |
> | 브라우저 | Chrome 또는 Chromium | `google-chrome --version` |
> | 터미널 | tmux | `tmux -V` |
> | OS | **POSIX** (Linux·macOS) | 아래 "미측정" 참조 |
> | GPU | 선택 — 없으면 CPU 로 돈다 | `harnesside doctor` 의 VRAM 여유 |
> | llama.cpp · 모델 | **자동 준비** (첫 실행) | `harnesside doctor` |
>
> - **Node 20 은 측정했고 동작하지 않습니다** — `node-pty` 가 종료 시 SIGSEGV 로 죽고,
>   Node 22 전에는 전역 `WebSocket` 가 없습니다. 그래서 `engines` 를 `>=18` → `>=22` 로
>   좁혔습니다.
> - Chrome·Chromium 은 CDP(`9222`)로 붙습니다. 대체 렌더러는 없습니다 — 창이 뜨지 않으면
>   IDE 도 뜨지 않습니다.
> - **자동 준비되는 것**: llama.cpp 빌드, 모델 다운로드, 포트 계획.
>   **자동 준비 안 되는 것**: Node, 브라우저, tmux.
>
> <details>
> <summary>구동환경에서 확인하지 못한 것 (측정 안 함)</summary>
>
> - **macOS · Windows 는 미측정**입니다. CI 러너는 Linux 이고, 로컬에서도 Linux 만
>   돌렸습니다. 특히 셀프업데이트의 교체가 `chmod 0o755` 를 쓰므로 **POSIX 전용**입니다
>   — Windows 에서 이 경로는 동작하지 않습니다.
> - GPU 실부하, 여러 동시 모델, 디스크 용량 경계, Wayland/X11 분기 같은 것은
>   여기서 검증하지 않았습니다. 전체 목록은
>   [`docs/VERIFICATION.md`](docs/VERIFICATION.md).
>
> </details>
>
> <details>
> <summary>개발용 — 체크아웃에서 직접 실행</summary>
>
> ```bash
> git clone https://github.com/jeano76/harnesside && cd harnesside
> npm ci
> npm run dev          # 서버 :7317 + Vite :5317, 둘 다 watch
> npm test             # 유닛테스트 (node:test, tsx로 구동)
> npm run typecheck
> npm run build        # dist/ 를 실행하려면 빌드가 먼저다
> node dist/server/index.js     # 전역 설치가 실행하는 것과 같은 바이너리
> ```
>
> `npm link` 도 동작하지만 문서화된 설치 경로가 아닙니다 — 체크아웃을 가리키는
> 심볼릭 링크로 남으므로 나중에 `git checkout` 을 하면 전역 `harnesside` 가 조용히
> 다른 코드를 실행하게 됩니다.
>
> </details>

## Built-in skills

`src/skills/builtin/` ships a fixed skill set — the "senior engineer
fundamentals" PROMPT.md §4 calls for, made concrete and triggerable. There are
**9** of them: `architecture-design`, `planning`, `implementation`,
`code-review`, `whitebox-testing`, `blackbox-testing`, `static-analysis`,
`security`, `web-publisher`. Each is a normal skill file (trigger + guidance
body) in harnesside's own format, so a project can override or add to them the
same way as any other `.harnesside/skills/*.md` file.

**They are not printed by `/skills`.** That command lists the *project's*
`.harnesside/skills/*.md` — which is why a fresh project shows two entries or
none. The built-ins reach the **model** instead: their index is appended to the
system prompt ("call `load_skill` with one of these names") so the model can
discover one and fetch its body. Before that was wired, all nine were fully
built and effectively **dead code from the model's point of view** — the loader
knew they existed, nothing did.

> ## 빌트인 스킬
>
> `src/skills/builtin/`은 고정 스킬 세트를 제공한다 — PROMPT.md §4가 요구하는
> "우수 아키텍처 개발자의 기본기"를 트리거 가능한 형태로 구체화한 것. **9개**다:
> `architecture-design`, `planning`, `implementation`, `code-review`,
> `whitebox-testing`, `blackbox-testing`, `static-analysis`, `security`,
> `web-publisher`. 각각 일반 skill 파일(trigger + 본문)이며 harnesside 자체
> 포맷을 쓰므로, 프로젝트에서 다른 `.harnesside/skills/*.md` 파일과 똑같은
> 방식으로 덮어쓰거나 추가할 수 있다.
>
> **`/skills` 에는 이들이 나오지 않는다.** 그 명령은 **프로젝트의**
> `.harnesside/skills/*.md` 만 읽기 때문에, 새 프로젝트에서는 2개나 0개가 보인다.
> 빌트인은 **모델 쪽으로** 간다 — 색인이 시스템 프롬프트에 붙고
> (`load_skill` 로 불러오라면서) 모델이 본문을 가져간다. 그 전에는 9개 모두
> 로드·빌드만 되어 있고 **모델 입장에서 죽은 코드**였다.


## Release

버전은 **두 층**입니다. 릴리스 식별자는 SemVer(`package.json`), 빌드 신원은
**날짜+해시**이고, 릴리스마다 코드에 **굽혀집니다**(설치된 배포물에는 git 저장소가
없어서 커밋을 물을 수 없습니다).

```
릴리스 식별자   0.1.0              ← package.json. 정본. 업데이트 비교가 본다.
빌드 신원       2026.10.05-08c4467  ← dist/server/buildInfo.json. 화면·로그·검증이 본다.
```

의 설계 배경과 실측 근거는 **[PROMPT_RELEASE_SELFUPDATE.md](PROMPT_RELEASE_SELFUPDATE.md)**.

### 만들기

### 로컬에 전역 설치

```bash
npm run install:g        # 빌드 → 전역 설치 → **설치본 검사**
```

`npm install -g .` 를 **직접 쓰면 최신 코드가 아니다.** 이 패키지의 `prepublishOnly` 는
`npm publish` 전용이라 로컬 폴더 전역 설치 경로에서는 돌지 않으므로, **옛 `dist/` 가 그대로
전역에 남고** 그 옛 코드가 `--version` 으로 정상 동작한다. 계측: 별도 실험 패키지에 세 훅을
심어 확인했다 — `npm install -g .` 는 **`prepare` 만** 실행한다(`npm pack` 는 `prepack`+`prepare`).

`install:g` 는 전역 설치 **뒤에** 다음을 확인하고 하나라도 어긋나면 **실패**한다.

- `bin` 이 심볼릭 링크로 만들어졌는가, 그리고 **패키지 안**을 가리키는가
- `installRoot` 가 npm 전역 prefix 전체가 **아닌가**
  (전역 prefix를 가리키면 셀프업데이트가 그 폴더를 통째로 교체하려 한다 — 실측 118,347 파일)
- 설치된 `dist` 가 **방금 만든 것**과 같은가 · 빌드 신원이 실렸는가 · `--version` 이 도는가

설치된 `dist` 에는 `manifest.json` 이 **없다** — 셀프업데이트로 온 것이 아니라 npm 이 설치했으므로.
그래서 화면은 설치 해시를 "검증 안 됨" 으로 말한다. 0 이나 가짜 해시로 메우지 않는다.

---

```bash
npm run build            # tsc + vite + 웹 자산 검사 + **빌드 신원 주입**
npm run release:repro    # 배포물을 두 번 만들어 해시가 같은지 확인 (재현성)
npm run release          # release/ 에 배포물 생성 (더티 트리면 실패)
cd release && sha256sum -c SHA256SUMS
```

`release/` 에 세 가지가 나옵니다.

| 파일 | 내용 |
|---|---|
| `harnesside-dist.tar.gz` | `dist/` 트리 |
| `manifest.json` | 파일 목록 + 각 파일 sha256 + 트리 해시 + 빌드 신원 |
| `SHA256SUMS` | `sha256sum -c` 로 확인하는 텍스트 |

tar 는 **재현 가능**하게 씁니다(정렬된 순서 · mtime 0 · uid/gid 0 · gzip 타임스탬프 0).
그래야 "이 해시가 이 커밋에 대응한다"는 말이 사실입니다. GNU tar 전용 플래그에 의존하지
않고 헤더를 직접 쓰기 때문에 macOS·Windows 에서도 같은 값이 나옵니다.

### 게시

`v*` 태그를 push 하면 `.github/workflows/release.yml` 이 돕니다. 선행 게이트
(typecheck · 단위 테스트 · 정적 검사 · 커버리지 하한선 · **재현성** · **셀프업데이트
실측**)를 통과해야 배포물이 만들어지고, GitHub Releases 에 붙습니다. **분기 푸시로는
만들어지지 않습니다.**

### 업데이트가 실제로 무엇을 바꾸나

- **교체는 `dist/` 트리 전체**입니다. 진입 파일(`server/index.js`) 하나만 갈아끼우면
  나머지가 옛 버전인 채로 남아 **부팅은 성공하고 옛 로직으로 돕니다.** 그래서
  검증도 교체도 **트리 단위**로 합니다 — 해시뿐 아니라 **파일 목록**까지 대조합니다.
- **검증 전에는 어떤 파일도 덮어쓰지 않습니다.** 매니페스트 수신 → 아카이브 수신 →
  해시 대조 → 풀기 → 목록 대조, 를 전부 통과한 것만 슬롯으로 갑니다.
- **되돌릴 곳(슬롯)** 은 트리 단위로 최근 3개를 보존합니다. 슬롯과 적용할 트리는
  **경로가 다릅니다** — 같은 자리에 두면 슬롯을 만들 때 검증된 새 트리를 덮어써서
  "성공했지만 아무것도 바뀌지 않은" 상태가 됩니다(실측).
- **수동 실행만** 합니다. 부팅 시 자동 확인·자동 적용은 없습니다.
- **자동 롤백은 없습니다.** 이 서버는 자기 자신을 재시작할 수 없습니다. 부팅이
  끝나면 마커를 소비해 적용을 확인하고, 확인되지 않으면 다음 실행이
  "업데이트 미확인" 으로 알리며 슬롯 경로를 남깁니다.

### 반드시 알아야 할 두 가지

**1. 배포물에 `node_modules` 가 없습니다.** `package.json` 의 `files` 는 `dist` 뿐이라
코드는 갈아끼워지지만 의존성은 그대로입니다. 없는 의존이 있으면 새 버전은 부팅하지
못합니다. 업데이트는 이 상태를 미리 확인하고 **막습니다** — 조용히 깨뜨리지 않습니다.

**2. 해시는 코드 서명이 아닙니다.** 해시는 *바이트가 손상되지 않았다* 는 사실과,
*이 바이트가 어느 커밋·어느 시각에 만들어졌다* 는 사실을 증명합니다. **그 바이트가
신뢰할 수 있는지** 는 증명하지 못합니다. 저장소 계정이 탈취되면 공격자는 자기 코드와
맞는 해시를 다시 계산할 수 있습니다.

### 직접 확인하기

```bash
npm run verify:selfupdate
```

네트워크 0회로 전체 경로를 굴립니다: 빌드 A 설치 → B 를 받아 검증 → 적용 →
되돌리고 **바이트 단위로** A 와 같은지, 해시를 한 글자 바꾼 자산이 **아무것도
교체하지 않는지**, 네트워크가 죽었을 때 "최신" 으로 **말하지 않는지**를 봅니다.
실패하면 샌드박스를 지우지 않고 남깁니다 — 원인을 봐야 고칠 수 있습니다.


## Validation

What is actually checked, what is not, and the measured numbers — including
terminal capability detection, which used to live here:
**[docs/VERIFICATION.md](docs/VERIFICATION.md)** — including what this project
does *not* cover (no real Windows/macOS/musl, no real GPU pressure, no real
compositor). Read it before trusting any number quoted here.

Design rationale, module map and the full bug history:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** ·
**[docs/IMPLEMENTATION-HISTORY.md](docs/IMPLEMENTATION-HISTORY.md)**
