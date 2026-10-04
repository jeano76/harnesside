# harnesside — 아키텍처와 설계 근거

> `README.md` 에서 분리했다 (2026-10-04 · Q-12).
>
> **무엇을 왜 이렇게 만들었는지** 를 담는다. 코드가 *무엇* 을 하는지는 코드가 말하고,
> 이 문서는 *왜 그 형태가 되었는지* 를 말한다. 발견해서 고친 실제 사고의 기록은
> [`IMPLEMENTATION-HISTORY.md`](./IMPLEMENTATION-HISTORY.md) 에 있다.

---

## Terminal capability detection

There is no portable "does this terminal support ANSI" query, and terminals do
not fail all-or-nothing anyway. `src/setup/terminal.ts` therefore reports a
capability record, and every sequence the app emits is built through it, so
anything unsupported becomes an empty string rather than a wrong byte on
screen.

| Capability | Why it is a separate question |
|---|---|
| `colorDepth` | The banner's bright-magenta SGR (`1;95m`) renders as the wrong colour on a 16-colour terminal and not at all on a true `vt100`. |
| `unicode` | Braille, `█ ░`, `✓ ✗` and box-drawing are width-bearing. On a non-UTF-8 locale they become `?` at an unpredictable width, and because this UI computes exact column positions, that desynchronises the *layout*, not just the glyph. |
| `altScreen` | **A hard precondition.** Absolute cursor addressing counts rows from the top of the active buffer, so it is only meaningful once the alt screen is up. It used to be gated on "ANSI works". |
| `mouseSgr` | DECSET 1006 does not exist on `rxvt` or the Linux console, and the legacy encoding this app's parser cannot read would make the wheel silently dead forever. |
| `synchronizedOutput` | DECSET 2026, where supported, paints a frame at a time instead of tearing. |
| `inMultiplexer` | Under tmux/screen, `TERM` is the multiplexer and mouse needs pass-through. |

**`NO_COLOR` is only half-wired, and the other half was removed on purpose.**
This module used to set `chalk.level` from the detected depth, which is what
degraded Ink's *own* colours (`<Text color="cyan">`, `dimColor`, the borders) —
without it `NO_COLOR` only suppressed the handful of sequences this code writes
itself. That call had **zero callers** once the Ink TUI was deleted (Q-2), and
`chalk` was never in `dependencies` — it resolved only as a transitive dependency
of `ink`, which is a devDependency. A packed-tarball install therefore crashed
with `Cannot find package 'chalk'` while `npm test` and `npm run dev` both
passed (Q-11). The dead import was deleted rather than promoted to a runtime
dependency.

What remains is the half this module actually owns: the escape sequences **we**
write, via `buildSequences`. If a terminal renderer is ever added back it will
need its own equivalent, and `NO_COLOR` will not work end to end until it has
one. That is a known gap, not an oversight.

Mouse reporting is **off by default**. It forced Shift-drag for text selection
on every terminal, to buy a convenience feature the keyboard now covers. `/mouse`
turns it on at runtime.

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
| Agent system prompt | `src/agent/systemPrompt.ts` | Identity, workspace root, approval gate, rule files — **and the answer-format contract** (2026-10-05) |
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


## Module map

```
src/
  backend/      llama.cpp process management + OpenAI-compatible HTTP client
  agent/        Tool-call loop (wired into compaction + self-healing)
  compaction/   Checkpoint write/resume, context summarization (PROMPT.md §2)
  hermes/       Self-healing circuit breaker, failure log, self-improvement
                proposal loop (§3)
  skills/       Lazy skill loading + always-on rule loading, reuses existing
                CLI conventions (§5); skills/builtin/ ships architecture,
                planning, implementation, review, testing, static-analysis,
                and security skills that are always loaded
  tools/        read_file / write_file / edit_file / run_shell + ANSI-colored
                diff rendering + browser_* (remote CDP control)
.harnesside/
  config.yaml   Backend/model/compaction settings
  rules/        Always-applied project rules
  skills/       Trigger-based, lazily-loaded skill docs
  state/        Runtime checkpoint (git-ignored)
```

> `src/tui/` 는 여기에 없다 — 2026-10-04 에 삭제되었다(Q-2). 이 표가 그 사실을
> 모른 채 3개월을 더 나를 수 있었던 이유가 이것이고, 그래서 지웠다.
> 되살리려면 `git log -- src/legacy-tui`.

> ## 구조
>
> ```
> src/
>   backend/      llama.cpp 프로세스 관리 + OpenAI 호환 HTTP 클라이언트
>   agent/        도구 호출 루프 (컴팩션·자가치유 연동) + 시스템 프롬프트 정본
>                 (`agent/systemPrompt.ts` — 출력 형식 규칙 포함, 2026-10-05)
>   compaction/   체크포인트 기록/재개, 컨텍스트 요약 (PROMPT.md §2)
>   hermes/       자가 치유 회로차단기, 실패 로그, 자가 개선 제안 루프 (§3)
>   skills/       skill 지연 로딩 + rule 상시 로딩, 기존 CLI 컨벤션 재사용 (§5);
>                 skills/builtin/에 아키텍처·기획·구현·리뷰·테스트·정적분석·보안
>                 스킬이 있어 프로젝트 상태와 무관하게 항상 로드됨
>   tools/        read_file / write_file / edit_file / run_shell 도구 + ANSI 컬러 diff 렌더링 + browser_* (원격 CDP 제어)
> .harnesside/
>   config.yaml   백엔드/모델/컴팩션 설정
>   rules/        항상 적용되는 프로젝트 규칙
>   skills/       트리거 기반 지연 로딩 skill 문서
>   state/        런타임 체크포인트 (git ignore 대상)
> ```

## Answer format — the material the renderer draws

The web UI has always rendered markdown properly: `Markdown.tsx` styles headings,
lists, tables and code fences (`PROMPT_UX_COMMERCIAL.md` §3.7 · §3.12 · §3.13).
On 2026-10-05 a user pasted a real answer back at us: a single blob of four
paragraphs where a 17-module directory tree was one comma-separated clause. Every
fact was correct and nobody could read it. **The renderer was fine. The material
was a wall.**

The renderer cannot fix prose — only the agent can. So the system prompt
(`src/agent/systemPrompt.ts`, 8 numbered rules) now states the contract: one idea
per paragraph, ≤120 characters, conclusion first, lists for three or more items,
tables for comparisons, code fences for paths and commands, visible truncation,
and `미측정` for anything unverified.

**A prompt rule is a request, not a guarantee** — so it ships with a measurement:
`readabilityFlags()` scores the *shape* of an answer (run-on paragraph, inline
enumeration, no structure at all), and `scripts/readability-report.ts` scores the
machine's own session history against it. Baseline on this machine
(2026-10-05, 32 sessions): **724 of 815** long assistant blocks (88.8%) tripped at
least one signal. Most of that history predates the rules, so it is a **baseline,
not a before/after measurement** — the honest after-number has to come from asking
the model again, which is not something this repository does automatically.

It also cannot claim credit it has not earned: an early live A/B attempt
(2026-10-05) asked the local model to describe the repository *without tools
wired up*, and the model emitted raw `tool_call` text that degenerated into a
repeated loop. That experiment measured tool-call degeneration, **not
readability**, and is recorded here so nobody reads it as evidence either way.

### What the A/B actually said (2026-10-05)

Same question, same machine, local model `Ornith 1.5-35B-A3B`, `temperature 0.7`,
**n = 3 per arm**, scored by `readabilityFlags()`:

| Arm | Answers with a signal | Mean longest paragraph | Worst paragraph |
|---|---:|---:|---:|
| Old prompt (no format rules) | 2/3 | **563 chars** | 1,365 chars |
| New prompt (8 format rules) | 2/3 | **202 chars** | 263 chars |

Read honestly, that is a **partial** effect: sentences got ~64% shorter, but the
*rate* at which an answer turns into a wall did not move. So the next lever is
**not** more prompt rules — it is a layer that forces structure at render time, or
one that pulls tool results into their own blocks. Which layer is not decided yet,
and this is where the next number belongs. n = 3, one model, one question: do not
generalize it.

## Reading code: colors, indent guides, diff (2026-10-05)

Asked whether the coding surface had syntax colors, indent guides and diff, the
honest answer was: **colors only where you cannot type.** The file preview, code
blocks and fenced code were colored; the **editor itself** was a plain
`<textarea>`, and there were **no indent guides at all**. All three now exist,
and two of them are the reason this section exists — the editor was not
reachable at all (see below).

| Surface | Colors | Indent guides | Note |
|---|---|---|---|
| Editor (editable) | ✅ overlay on a transparent `<textarea>` | ✅ | autosave · 409 conflict · draft restore all live here |
| File preview (read-only, in-conversation) | ✅ | ✅ | guides sit **inside** the code span |
| Code block (shell/code in conversation) | ✅ | ✅ | **command lines get no guide** — `$ npm run build` indentation is a prefix, not a block |
| Large / binary file (read-only view) | ✅ | ✅ | shares the same metrics object |
| Diff panel | — | — | **`DiffPanel` is imported but never rendered** (acknowledged in `editorReachability.test.ts`) |

**Three decisions worth knowing before changing this code:**

1. **The editor overlay is two layers with one metrics object.** A `<textarea>`
   cannot color its own text, so a transparent-text `<textarea>` sits on a
   colored `<pre>`. If the two layers disagree by a single pixel of padding, the
   colors shift one character per line. `EDITOR_TEXT_METRICS` is shared by three
   surfaces for exactly that reason, and a test counts how many layers use it —
   the invariant cannot be kept by discipline.
2. **Indent guides are positioned in `ch`, not measured.** The usual
   implementation measures the character width with a hidden span; measure before
   the font loads and the guide lands *between* characters. `1ch` is exactly one
   `"0"` in a monospace font, needs no measurement, and when the font is late it
   renders late rather than wrong. There is no measurement path to undo.
3. **Unknown languages are said out loud.** `languageFor` returns `text` and the
   UI prints `이 형식은 색칠하지 않습니다 (미지원: .rs)`. Silently plain text
   reads as a bug and sends the user hunting for one.

**The editor had no way to open it.** `EditorView`, `openFileByPath`,
`openFile` and `openTabs` all existed; nothing called any of them. So the editor
was dead UI, and both features above were invisible. It is now reachable from the
`편집` button on a file preview, and `src/web/editorReachability.test.ts` fails
if an imported component stops being reachable again — or if a new one does,
unless the reason is written down (currently: `DiffPanel`, `CommitBox`).

**Measured vs not.** The unit tests (30) verify the *computation*: column
counts, tab stops, which lines are closing, `calc(N ch)` strings, and that the
two layers read one shared object. They cannot verify that the guide lands on a
real glyph boundary — that needs a browser, and `scripts/verify-editor.mjs`
measures it (also `1ch` vs the measured character width). That script **has not
passed yet**: the session it ran against had no file block to open. Not
measured, not claimed.

## Skill / Rule — reusing existing AI CLI conventions

`src/skills/loader.ts` reuses whatever rule/skill files another AI coding CLI
has already left in the project, and only generates harnesside's own defaults
when none exist. Every source that's found gets loaded and merged — it's not
"pick one," it's "load everything present":

**Rules (always injected into the system prompt)** — all of the following are
searched, in no particular order:
- `.harnesside/rules/` (harnesside's own)
- `.clinerules` (Cline)
- `CLAUDE.md` (Claude Code)
- `GEMINI.md` (Gemini CLI)
- `.cursorrules` (Cursor)
- `.windsurfrules` (Windsurf)
- `AGENTS.md` (a convention several CLIs are converging on)
- `.github/copilot-instructions.md` (GitHub Copilot)

If none of these exist, `.harnesside/rules/00-core.md` is auto-generated as
harnesside's own default rule.

**Skills (lazily loaded on trigger match)**:
- `.harnesside/skills/*.md` (harnesside's own format, `trigger:` frontmatter)
- `.claude/skills/<name>/SKILL.md` (Claude Code's format, `name`/`description`
  frontmatter)

If neither exists, `.harnesside/skills/write-tests.md` is auto-generated as
harnesside's own default skill.

> ## Skill / Rule — 기존 AI CLI 컨벤션 재사용
>
> `src/skills/loader.ts`는 다른 AI 코딩 CLI가 이미 프로젝트에 남겨둔 rule/skill 파일이
> 있으면 그것을 그대로 쓰고, 아무것도 없을 때만 harnesside 자체 기본값을 자동 생성한다
> (모든 발견된 소스는 합쳐서 로드됨 — 하나만 쓰는 게 아니라 프로젝트에 있는 만큼 전부 반영):
>
> **Rule (항상 시스템 프롬프트에 주입)** — 다음을 순서 무관하게 전부 탐색:
> - `.harnesside/rules/` (harnesside 자체)
> - `.clinerules` (Cline)
> - `CLAUDE.md` (Claude Code)
> - `GEMINI.md` (Gemini CLI)
> - `.cursorrules` (Cursor)
> - `.windsurfrules` (Windsurf)
> - `AGENTS.md` (여러 CLI가 채택 중인 범용 컨벤션)
> - `.github/copilot-instructions.md` (GitHub Copilot)
>
> 위 중 하나도 없으면 `.harnesside/rules/00-core.md`를 harnesside 자체 기본 rule로 자동 생성한다.
>
> **Skill (트리거 매칭 시 지연 로딩)**:
> - `.harnesside/skills/*.md` (harnesside 자체 포맷, `trigger:` frontmatter)
> - `.claude/skills/<name>/SKILL.md` (Claude Code 포맷, `name`/`description` frontmatter)
>
> 둘 다 없으면 `.harnesside/skills/write-tests.md`를 자체 기본 skill로 자동 생성한다.

## Hermes self-improvement proposal loop

When the same tool fails with the same pattern 2+ times
(`src/hermes/selfImprove.ts`), the model is asked to draft a rule that would
prevent it. **It is never applied automatically** — a proposal always
requires the user to review it and approve with a separate command:

- `/improve` — analyzes the accumulated failure log and shows a proposal (no
  files are touched).
- `/improve-apply` — saves the last `/improve` proposal to
  `.harnesside/rules/hermes-proposed-<timestamp>.md`. It's always written as a
  new file, never overwriting an existing rule, so approving a bad proposal
  can't destroy prior rules.
- `/quit` — if there's an unreviewed failure log at session end, quitting
  doesn't happen immediately; the proposal is analyzed and shown first.
  Pressing `/quit` again confirms the exit (applying still requires the
  separate `/improve-apply` — quitting itself never writes a rule).

### Real-time analysis (not just on-demand)

Rather than waiting for `/improve` or session end, `AgentLoop` re-checks the
failure log immediately after every new tool/backend failure and, the first
time a pattern crosses the recurrence threshold, appends it to a running,
append-only journal — `.harnesside/state/improvement-log.md` — with an
`[auto-improve]` status line pointing at it. This is fire-and-forget
background analysis (it calls the model, so it must never block the
tool-call loop it's reacting to) and, critically, **writing to this log file
never changes agent behavior on its own** — it's a passive record, not a
rule, and not fed back into the system prompt. Turning a finding into an
actual rule still always requires the explicit `/improve` → `/improve-apply`
review flow above. Each recurring pattern (by its grouping signature, not
its growing occurrence count) is only logged once per session, so a
still-failing pattern doesn't spam the file on every subsequent occurrence.

**Deferred to after the turn, not fired mid-turn.** Asked directly to
analyze the real llama-server's own logs (`journalctl --user -u
llama-server.service`) for improvement points, and found one: this backend
only has a single inference slot (`-np 1`), and the log showed real cache
churn (`making room for prompt cache entry, removing oldest entry` — 18
evictions in an hour, ~38% of slot selections falling back to LRU instead
of reusing a cached prefix). The original implementation triggered the
improvement-check call immediately inside the tool-call loop, right after
logging a failure — meaning it could race the *same turn's own next
request* for that single slot and delay the user's response. Fixed by only
checking after the whole turn's `runUntilIdle()` loop has completed
(`hasNewFailuresThisTurn` flag, checked in `send()`/
`resumeIfCheckpointExists()`), so the background analysis call never
competes with an in-flight turn for the one available slot. Verified with
a test that tracks call ordering and asserts the improvement-check request
only ever appears after the turn's own final response.

> ## 헤르메스 자가 개선 제안 루프
>
> 동일한 도구가 같은 실패 패턴으로 2회 이상 반복되면(`src/hermes/selfImprove.ts`), 모델에게
> 이를 방지할 rule 초안(markdown)을 작성하게 한다. **절대 자동으로 적용하지 않는다** —
> 제안은 항상 사용자가 직접 확인 후 별도 명령으로 승인해야 한다:
>
> - `/improve` — 지금까지 쌓인 실패 로그를 분석해 제안을 보여준다(파일 변경 없음).
> - `/improve-apply` — 직전 `/improve` 제안을 `.harnesside/rules/hermes-proposed-<timestamp>.md`
>   로 저장한다. 기존 rule 파일을 덮어쓰지 않고 항상 새 파일로 저장되므로, 잘못된 제안을
>   승인해도 기존 rule이 파괴되지 않는다.
> - `/quit` — 세션 종료 시 미검토 실패 로그가 있으면 즉시 종료하지 않고 자동으로 제안을
>   분석해 보여준다. 확인 후 `/quit`을 한 번 더 누르면 종료된다(적용은 별도로 `/improve-apply`
>   가 필요 — 종료 자체가 rule을 쓰지는 않는다).
>
> ### 실시간 분석 (수동 트리거만이 아님)
>
> `/improve`나 세션 종료를 기다리지 않고, `AgentLoop`가 새 도구/백엔드 실패가 발생할
> 때마다 즉시 실패 로그를 다시 확인해서, 어떤 패턴이 반복 임계치를 처음 넘는 순간
> 실시간·append-only 저널인 `.harnesside/state/improvement-log.md`에 기록하고
> `[auto-improve]` 상태 메시지로 알려준다. 이건 fire-and-forget 백그라운드 분석이라
> (모델을 호출하므로 반응 대상인 도구 호출 루프를 절대 막으면 안 됨) — 중요한 건
> **이 로그 파일에 쓰는 것 자체는 에이전트 동작을 전혀 바꾸지 않는다**는 것. 순수한
> 기록일 뿐 rule이 아니고 시스템 프롬프트에도 다시 주입되지 않는다. 실제 rule로
> 만들려면 여전히 위의 `/improve` → `/improve-apply` 검토 절차가 필요하다. 각 반복
> 패턴은 (계속 늘어나는 발생 횟수가 아니라 그룹핑 시그니처 기준으로) 세션당 한 번만
> 기록되므로, 계속 실패하는 패턴이 매번 파일을 도배하지 않는다.
>
> **턴 도중이 아니라 턴이 끝난 뒤로 미룸.** 실제 llama-server 자체 로그
> (`journalctl --user -u llama-server.service`)를 직접 분석해서 개선점을 찾아달라는
> 요청을 받고 하나를 발견함: 이 백엔드는 추론 슬롯이 1개(`-np 1`)뿐인데, 로그에 실제
> 캐시 스래싱이 보임(`making room for prompt cache entry, removing oldest entry` —
> 1시간에 18번 제거, 슬롯 선택의 ~38%가 캐시된 prefix 재사용 대신 LRU로 폴백). 원래
> 구현은 실패를 로그에 남긴 직후 도구 호출 루프 안에서 곧바로 개선 체크 호출을
> 트리거했음 — 즉 **같은 턴의 다음 요청**과 그 하나뿐인 슬롯을 두고 경쟁해서 사용자
> 응답을 지연시킬 수 있었음. 턴 전체(`runUntilIdle()` 루프)가 완전히 끝난 뒤에만
> 체크하도록 수정(`hasNewFailuresThisTurn` 플래그, `send()`/
> `resumeIfCheckpointExists()`에서 확인) — 이제 백그라운드 분석 호출이 진행 중인 턴과
> 하나뿐인 슬롯을 두고 절대 경쟁하지 않음. 호출 순서를 추적해서 개선 체크 요청이 항상
> 턴의 최종 응답 이후에만 나타나는지 확인하는 테스트로 검증함.

### Compaction kept re-triggering on nearly every step, and resumed goals nested inside themselves

Reported directly, with the exact symptom from a real session: "압축을 해도
중복된 토큰이 누적되는거 같아" (even after compacting, duplicate tokens seem
to keep piling up). Root cause, confirmed against the real backend at
`n_ctx=4096`: the compacted tail's budget and the summary's `max_tokens` cap
were both flat fractions of the context window, computed with no regard for
the *fixed* per-request overhead (system prompt + tool schema), which
measured at 1,283 tokens — 31% of that window on its own. A "successful"
compaction still landed around 3,500 tokens against a 2,867-token
auto-trigger (70% of 4,096), so the very next turn compacted again — forever,
each pass re-summarizing what the last pass had just summarized.

Two smaller bugs compounded it once a session lived through more than one
compaction:

- `composeSystemMessage()` (added to replace, not append, the previous
  summary block) cut the old summary at its first blank line rather than to
  the end of the system message. Model-written summaries are routinely
  multi-paragraph, so paragraphs 2..N of every old summary survived the
  "replacement" and piled up on every pass — the actual source of the
  reported "누적" (accumulation).
- `currentGoalSummary()` took the first `role: "user"` message in
  `this.messages` as the checkpoint's goal. After one compaction, that
  message *is* the injected `[resuming after compaction] previous goal: ...`
  text, so the next checkpoint's goal wrapped the previous resume message
  inside itself, and the one after that wrapped *that* — found live in
  `.harnesside/state/checkpoint.json` as a goal field containing
  `[resuming after compaction] previous goal: [resuming after compaction]
  previous goal: ...`, several turns deep.
- Excluding the system message from the summarization slice (a prior fix, to
  stop the base prompt from being summarized into itself) had a side effect
  no one had caught: the *previous* summary lived only in that excluded
  system message, so it was never handed to the next summary request either
  — each compaction pass silently forgot everything the last one had
  condensed, rather than building on it.

Fixed all three: `AgentLoop.compact()` now measures the real fixed overhead
(the same `estimateTokens()` call used elsewhere, on the base system prompt
alone) before sizing the summary cap and kept-tail budget, so the *compacted*
conversation lands at ~75% of the trigger threshold instead of drifting past
it immediately — and warns once, explicitly, if the configured context window
is too small for that to be possible at all (telling the user to raise
llama-server's `-c`). The AgentLoop now tracks the real user-stated goal in
its own field instead of re-deriving it from `this.messages`, and
`stripResumePrefix()` unwraps any already-nested `previous goal:` text (both
for new checkpoints and for one already nested on disk). `composeSystemMessage`
now finds the summary header and treats everything from there to the end of
the string as the block being replaced, not just up to the first blank line.
And the previous summary is now passed explicitly into the next summary
request (as a synthetic leading message) and replaced by the new one, instead
of silently dropping out of the loop.

Verified two ways. First, seven new unit tests in
`src/compaction/compactor.test.ts` and `src/agent/loop.test.ts` — including
one that reproduces the exact nested-goal string pulled from a real
`checkpoint.json` and confirms it fails against the pre-fix code before
passing against the fix. Second, live: restarted the real `llama-server`
backing this at `-c 24576` (a stale-VRAM autodetect script had been landing
it at `-c 4096`, the proximate trigger for how badly this showed up) and
monitored a real, separate harnesside session end-to-end through two real
auto-threshold compactions — confirmed via the live checkpoint and the
server's own `/slots` + logs that each compaction fired only once per
threshold crossing (17,329 → 8,518 tokens on the first), never nested the
goal, and left enough headroom that the very next turn didn't immediately
re-trigger.

## Remote browser control (Chrome DevTools Protocol)

`src/tools/browser.ts` attaches to a browser the user already has running with
`--remote-debugging-port=<port>` (default `9222`, set in `.harnesside/config.yaml`
under `browser:`). It **never launches or manages a browser process itself** —
only connects to one that's already listening, over Node's built-in
`WebSocket` (no extra dependency). Four tools are exposed to the model:

- `browser_list_tabs` — list open page tabs (id/title/url).
- `browser_navigate` — navigate a tab to a URL and wait for load.
- `browser_eval` — evaluate JS in the page, returns the value.
- `browser_screenshot` — capture a PNG to `.harnesside/state/screenshots/`.

Verified end-to-end against a real headless Chrome instance: navigate,
evaluate (both string and non-string return values), and a real screenshot
that renders correctly.

> ## 브라우저 원격 제어 (Chrome DevTools Protocol)
>
> `src/tools/browser.ts`는 사용자가 이미 `--remote-debugging-port=<port>`
> (기본 `9222`, `.harnesside/config.yaml`의 `browser:`에서 설정)로 띄워둔 브라우저에
> 붙는다. **절대 브라우저 프로세스를 직접 실행하거나 관리하지 않으며**, 이미 떠 있는
> 브라우저에만 Node 내장 `WebSocket`(별도 의존성 없음)으로 연결한다. 모델에게 4개
> 도구를 노출한다:
>
> - `browser_list_tabs` — 열린 탭 목록(id/title/url) 조회
> - `browser_navigate` — 탭을 특정 URL로 이동, 로드 완료까지 대기
> - `browser_eval` — 페이지에서 JS 표현식 실행 후 값 반환
> - `browser_screenshot` — PNG 스크린샷을 `.harnesside/state/screenshots/`에 저장
>
> 실제 headless Chrome으로 end-to-end 검증 완료: navigate, eval(문자열/비문자열
> 반환값 모두), 실제로 렌더링되는 스크린샷까지 확인.

## Remote browser control (Chrome DevTools Protocol)

`src/tools/browser.ts` attaches to a browser the user already has running with
`--remote-debugging-port=<port>` (default `9222`, set in `.harnesside/config.yaml`
under `browser:`). It **never launches or manages a browser process itself** —
only connects to one that's already listening, over Node's built-in
`WebSocket` (no extra dependency). Four tools are exposed to the model:

- `browser_list_tabs` — list open page tabs (id/title/url).
- `browser_navigate` — navigate a tab to a URL and wait for load.
- `browser_eval` — evaluate JS in the page, returns the value.
- `browser_screenshot` — capture a PNG to `.harnesside/state/screenshots/`.

Verified end-to-end against a real headless Chrome instance: navigate,
evaluate (both string and non-string return values), and a real screenshot
that renders correctly.

> ## 브라우저 원격 제어 (Chrome DevTools Protocol)
>
> `src/tools/browser.ts`는 사용자가 이미 `--remote-debugging-port=<port>`
> (기본 `9222`, `.harnesside/config.yaml`의 `browser:`에서 설정)로 띄워둔 브라우저에
> 붙는다. **절대 브라우저 프로세스를 직접 실행하거나 관리하지 않으며**, 이미 떠 있는
> 브라우저에만 Node 내장 `WebSocket`(별도 의존성 없음)으로 연결한다. 모델에게 4개
> 도구를 노출한다:
>
> - `browser_list_tabs` — 열린 탭 목록(id/title/url) 조회
> - `browser_navigate` — 탭을 특정 URL로 이동, 로드 완료까지 대기
> - `browser_eval` — 페이지에서 JS 표현식 실행 후 값 반환
> - `browser_screenshot` — PNG 스크린샷을 `.harnesside/state/screenshots/`에 저장
>
> 실제 headless Chrome으로 end-to-end 검증 완료: navigate, eval(문자열/비문자열
> 반환값 모두), 실제로 렌더링되는 스크린샷까지 확인.
