# harnesside — 검증 (무엇을 실제로 확인했고, 무엇을 확인하지 않았는가)

> 이 문서는 `README.md` 에서 분리했다 (2026-10-04 · Q-12). **검증 결과를 지우는 것은
> 아니고 옮긴 것이다.** 숫자를 인용하기 전에 이 문서를 먼저 읽을 것.
>
> 이 저장소의 규칙: **"설정했다" 와 "동작한다" 를 다른 문장으로 쓴다.** 검증 시각·방법이
> 없는 숫자는 통과로 쓰지 않는다. 확인 못한 것은 **"미측정"** 이라고 적는다.

**한 문장 요약**: 결정·렌더링 로직은 잘 덮여 있고, **OS 계층과 하드웨어 계층은 전혀
덮여 있지 않다.** "13,713 checks, all passing" 을 "어디서든 동작한다" 고 읽으면
잘못 읽은 것이다.

---

## Validation — what is actually checked, and what is not

Three harnesses, one per axis, plus the unit suite. Run all of them:

```bash
npm test                                              # 2083 unit tests (2026-10-05)
npx tsx scripts/persona_usability_check.ts           # terminal identity
npx tsx scripts/project_persona_check.ts             # project shape
npx tsx scripts/tui_simulation_check.ts              # terminal capability + interaction
```

| Axis | Harness | Checks | Status |
|---|---|---:|---|
| Unit / regression | `npm test` | **2,083** | pass — `2083 pass / 0 fail`, 2026-10-05. (The `525` this table used to quote was stale by ~4x; a number with no date is a claim, not a measurement.) |
| Terminal identity (100 personas) | `persona_usability_check.ts` | **5,877** | 0 violations |
| Project shape (100 real directories) | `project_persona_check.ts` | **7,237** | 0 violations |
| Terminal capability + TUI interaction | `tui_simulation_check.ts` | **599** | 0 violations |
| Hardware matrix (one-off sweep) | *(not committed — see below)* | 168,668 | 0 violations |

The four sections below each cover one axis. Every bug they found is in the
unit suite now, and each was verified by **reverting the fix and requiring the
new tests to fail** — a regression test that passes with its own fix reverted is
asserting nothing, and one of these did exactly that before it was caught.

### Packaged install (2026-10-04 · Q-11)

> **이 절의 `0.1.0` 은 2026-10-04 에 잰 값이다.** 릴리스 식별자는 그 뒤
> `0.2.0` 으로 올렸고(2026-10-05 · `/server calibrate`), 위 표의 숫자는 **고치지
> 않았다.** 측정 기록의 날짜를 지우면 그 기록이 무엇을 말하던지가 사라진다.
> 최신 배포물의 확인은 `release/SHA256SUMS` 와 `harnesside --version` 이 정본이다.

`npm pack` → install the tarball into a clean prefix → run it from an unrelated
directory. Not `npm link`, which would have hidden the failure below.

| Step | Result |
|---|---|
| `npm pack --dry-run` | **121 files · 733 kB** (2.3 MB unpacked) — no test files, no `src/` |
| `npm install -g --prefix <clean> harnesside-0.1.0.tgz` | 39 packages, 6 s |
| `harnesside --version` | `0.1.0` |
| `harnesside --help` | full usage |
| `harnesside status` | `실행 중이 아님` + log paths, exit 0 |
| `harnesside doctor` | read-only: server stopped · llama-server up on 8080 · Chrome 153 · VRAM 820 MiB free |
| `harnesside --dry` | all **12** boot steps listed, no side effects |

**This found a real bug, which is the reason the table exists.** The first run of
exactly this sequence died with `Cannot find package 'chalk'`. `chalk` was
imported by `src/setup/terminal.ts` but was never in `dependencies` — it was
reachable only as a transitive dependency of `ink`, which is itself a
devDependency. Since the Ink TUI was deleted (Q-2) the function that used it
(`applyColorDepth`) had **zero callers**, so the import was dead weight that
only a real install could expose: `npm run dev` and `npm test` both worked,
because the dev tree has `ink`.

Fixed by deleting the dead import and recording *why* in the function's doc
comment, rather than by promoting `chalk` to a runtime dependency. A package
that only ever ran from a checkout should be installable from its tarball; the
way to find out is to install the tarball.

### Runtime matrix (2026-10-04 · Q-9)

One table, three values only. **`검증됨`** = a command in this repo ran it and the run is cited ·
**`로컬 실행 가능`** = a script exists but no cited run on that axis · **`미측정`** = never run.
Synthetic sweeps (the 6,720-combination matrix above) are **not** evidence here — they exercise
branches, not machines. `scripts/fake-llama-server.mjs` proves the **boot path**, not model or
server compatibility.

| Axis | Value | State | Evidence (command · date · result) |
|---|---|---|---|
| Node | 22 | `검증됨` | CI `gate` (`node-version: "22"`) · local `npm test` 2026-10-04 → 1985 pass / 0 fail |
| Node | 20 | `검증됨` — **does not work** | 2026-10-04, fresh `npm ci` under Node 20.20.2 in a separate worktree: `npm test` 1984 pass / **6 fail** — every process that loads `node-pty` dies with **SIGSEGV on exit** (`terminal*.test.ts`, `tmux.test.ts`; `node dist/server/index.js --version` exits 139), and the browser tools fail with `WebSocket is not defined` (no global `WebSocket` before Node 22). → `engines` narrowed from `>=18` to **`>=22`** |
| Node | 18 · 24 | `미측정` | Node 24 was tried with modules built under Node 20 (aborted on exit) — not a fair run, so not counted |
| OS | Linux x64 (Ubuntu) | `검증됨` | CI runners `ubuntu-latest` · this machine (Linux 7.0, x64) |
| OS | macOS · Windows · musl | `미측정` | no runner tried; `node-pty` build and Chrome boot are the expected blockers |
| Display | Wayland | `미측정` | the Chrome window opens on this Wayland session, but no check targets Wayland-specific behaviour (OSC 52, clipboard) |
| Browser | Chrome (headless, one pinned version) | `검증됨` | CI `window` job: `verify-window.mjs` · local 2026-10-04 22/22 ×3 |
| Browser | Chromium / other versions | `미측정` | — |
| GPU | real VRAM pressure (8 GB card, 35B MoE) | `미측정` | synthetic VRAM only |
| Terminal identities (100 personas) | — | `로컬 실행 가능` | `npx tsx scripts/persona_usability_check.ts` (not in CI, no cited run this round) |

Acceptance TCs in `docs/multienv-acceptance-report.md`: **13 unverified + 5 partial**, unchanged this round
(0 reduced, 0 added). (The quality plan quoted "25"; the report's own tally is 13 + 5.)

### OpenAI-compatibility scope (2026-10-04 · Q-10)

"OpenAI Chat Completions API와 호환된다" is a claim, so here is exactly which
endpoints were measured and which were not. Values are `검증됨` / `측정함` /
`미지원` — never an unqualified "compatible".

| Surface | State | Evidence (command · date · result) |
|---|---|---|
| Local `llama-server` `/v1/chat/completions`, streaming | `검증됨` | `src/backend/openaiClient.test.ts` (534 lines) · the SSE reassembly, client-side `max_tokens` cap, idle guard and partial-tool-call salvage are all pinned there |
| `/tokenize` | `측정함` — 1,440 chars → **562 tokens**; 20 calls **p50 1.5 ms · p90 3.3 ms · max 55.9 ms** | read-only requests against this machine's llama-server on 8080, 2026-10-04 |
| `/props` (`n_ctx`) | `측정함` — **1 ms**, `n_ctx` = **98,304** | same run; `getContextSize()` reads `/config` then falls back to `/props` (`src/backend/openaiClient.ts`) |
| Remote `baseUrl` (proxy · cloud · another LAN host) | **미지원** | the web server's agent always requests `127.0.0.1:<planned llama port>`. A remote address in `config.yaml` was **read by nothing** — the user got local answers while believing otherwise. Streaming, error shape, token accounting and auth were never measured, so there is no basis for calling it supported. Now it says so at boot: `src/server/baseUrlPolicy.ts` + `index.ts` emit `[warn] … 원격 OpenAI 호환 서버는 지원하지 않습니다` |

**The asymmetry worth naming.** It is fine to *call* an OpenAI-compatible
endpoint — that is the whole point of the local backend. It is not fine to
*store a key in this repository*, and `.ci/rules.json` enforces that with six
secret patterns (GitHub PAT/OAuth, OpenAI, HuggingFace, AWS, private key). So
"talk to OpenAI" and "put an OpenAI key here" are different acts with different
rules, and only one of them is checked. Keeping the remote path unsupported is
what makes that asymmetry cost nothing.

**Error bodies are not truncated to 200 characters, on purpose.** A requirement
suggested clipping the upstream response at 200 chars for display. The agent
loop pattern-matches the response body to tell *why* a request failed — a
context-window overflow reads differently from a bad request — so clipping the
body breaks the classification, and the loop retries a non-retryable failure
instead of reporting it. The UI already clips to 300 chars **at render time**,
which is the layer that owns that decision. Left unchanged, deliberately.

### `harnesside doctor` (2026-10-04 · Q-13)

`doctor` is a **read-only** command, and that is a property of the command rather
than a promise in its help text: it is measured, not asserted. The check runs the
real `doctor` process against a throwaway project and throwaway `HOME`, snapshots
every file path **with mtime and size** plus the set of listening ports, and
compares before/after.

| Property | How it was checked | Result |
|---|---|---|
| Changes nothing on disk | real process · snapshot of project tree + `~/.harnesside`, path + mtime + size | **identical** before/after |
| Opens and closes no port | `ss -ltnH` (or `netstat -an`) set compared before/after | **identical** |
| Reports every required axis | output scanned for all 9 labels (Node · terminal capability ×5 · terminal identity · 3 ports · dist freshness · config · model file) | all present |
| Says what to do next | non-empty "next actions" section | present; failure/warn/unknown in that order |
| Never prints a secret value | `apiKey: <value>` planted in `config.yaml`, output scanned | value **0 times**, the *name* printed |
| Unknowns stay unknown | output contains `미확인 N건 — 0 이나 false 가 아닙니다` | present in the real run |

Two suites back it: `src/server/doctorChecks.test.ts` (**23**, pure verdicts) and
`src/server/doctorChecks.readonly.test.ts` (**4**, spawns the real command).

The read-only test was itself **falsified**: making `doctor` write one file into the
project turned all four of those checks red, and printing the raw config text
turned the secret check red. A check that cannot fail is not a check.

**The bug this found.** `doctor` reported the web server it had launched itself as
"held by another program". The attribution matched on the install path
(`/harnesside/i`) and this repository's directory is `harnessCli`. A user who
believed that sentence would try to kill their own server. Now the server entry
point (`dist/server/index.js`) also counts as ours, and the **recorded instance
pid** outranks any command-line guess. The reproduction is a unit test — reverting
the pattern makes it fail again.

**One measured exclusion.** `google-chrome --version`, which `doctor` shells out
to, writes `~/.local/share/applications/mimeapps.list` when `HOME` has no GLib
cache yet (2026-10-04, measured). That is the inspected process's side effect, not
harnesside writing something, so the read-only comparison covers the project tree
and `~/.harnesside` — stated in the test rather than left as a mystery.

**What `doctor` cannot tell you** — a design limit, not a missing feature:

| Unknown | Why |
|---|---|
| The **browser's** terminal/OSC capability | the UI is drawn by Chrome; `doctor` measures *its own* process env, and says so |
| Real GPU pressure | it reads free VRAM; it does not load a model |
| Port attribution on macOS/Windows | relies on `ss`/`netstat`/`wmic`; where those are absent the answer is `unknown`, never "free" |
| Whether `dist` matches the *commit* | mtime comparison only — a fresh checkout makes both trees equally "newest" |

### Code surface — colors, indent guides, editor reachability (2026-10-05)

| Property | How it was checked | Result |
|---|---|---|
| Overlay preserves the source line-by-line | `colorOverlay.test.ts` — CRLF normalization, trailing blank lines, tokens rejoined | identical, incl. empty/whitespace lines |
| **Highlighted code loses no characters** | `highlight.test.ts` + the case that broke it (a 14,290-char minified CSS line lost 12,800) | fixed and pinned; reverting the fix fails 2 tests |
| Guides land on the right columns | `indentGuides.test.ts` — 17 checks incl. tab stops, closing lines, `ch` strings | pass |
| **The editor is reachable** | `editorReachability.test.ts` — import must reach a render; a guard and a state write must exist | pass; mutation-proven (4 ways) |
| Colors are **transparent + a color layer exists** | one test binds both — either alone means an empty editor | pass |
| Two layers share one metrics object | the test counts the layers that use `EDITOR_TEXT_METRICS` (3) | pass |
| **The guide lands on a real glyph boundary** | `scripts/verify-editor.mjs` (browser, CDP) | **not measured** — see below |

**Two bugs this round found, both by measuring instead of reading:**
a minified single line silently lost 12,800 characters (an iteration guard was
allowed to truncate content), and the editor had no way to open it at all.

**Not measured (and why).** `verify-editor.mjs` needs a file block in the
session to click `편집` on. The session it ran against had none, and this round
did not send a prompt into the user's conversation to create one — an earlier
attempt did exactly that by sending keystrokes, which is why the script now opens
its own tab, closes it afterwards, and clicks buttons instead of typing. So:
**the alignment of the color layer with the textarea, and `1ch` against the real
character width, are unmeasured.** Run `node scripts/verify-editor.mjs` in a
session where a file was opened.

### What this does not cover

Stated plainly, because a validation section that only lists passes is not
useful:

- **No real Windows, macOS, or musl machine.** `platform: "win32"` and
  `darwin` exercise the *branch*, not the OS. Windows path separators, `\r\n`
  line endings, conhost behaviour, Apple unified memory and a musl libc are
  untested. The bugs most likely to hide there are exactly the ones the
  document set this work came from warned about.
- **No real GPU pressure.** Synthetic VRAM figures prove the arithmetic; they
  do not prove an 8 GB card survives a 35B MoE load.
- **No real mouse or compositor.** Selection and edge-scroll arithmetic is
  verified; frame pacing, and whether *your* Wayland compositor refuses OSC 52,
  are not. The harness asserts the app behaves correctly whenever refusal
  happens, which is the half the app owns.
- **13 of 47 acceptance TCs remain unverified**, mostly those needing a live
  backend, a live `laya-serve`, or a real build. Per-TC results:
  [`docs/multienv-acceptance-report.md`](docs/multienv-acceptance-report.md).

The honest summary: the **decision and rendering logic** is now well covered,
and the **OS and hardware layers are not covered at all**. Anyone reading
"13,713 checks, all passing" as "this works everywhere" is reading it wrong.

## Usability validation across 100 personas

`scripts/persona_usability_check.ts` runs **5,877 assertions across 100
distinct usage configurations** — 3 platforms, 10 terminal families, 5 locales,
6 terminal sizes and 4 colour modes, crossed so every value of every axis is
exercised.

It is worth being precise about what this is and is not. It is **not** 100
simulated humans; nobody can emulate perception or taste, and a script claiming
to is worse than useless. What it is: 100 concretely-specified configurations
checked against the invariants that users actually reported, each of which is
mechanically verifiable and each of which this app has genuinely broken:

1. the fixed-height layout must not overflow the terminal
2. no rendered line may exceed the terminal width, in display columns
3. nothing may be emitted that the terminal cannot render
4. every interaction must be reachable without a mouse
5. every interaction must be discoverable from `/help`
6. the gate must never be the reason a request goes unanswered

```bash
npx tsx scripts/persona_usability_check.ts [--verbose]
```

### What it found

The first run failed **47 assertions across 3 invariants**, and two were real
product bugs rather than harness noise:

- **The status bar overflowed.** `statusBarFieldWidth`'s `Math.max(8, …)` floor
  overrode its own arithmetic, so at 40 columns the row came out **41 columns
  wide** and wrapped. 17 personas hit it. The root cause was structural: the
  width math and the render each decided the layout *independently*, so nothing
  ever checked the sum. Fixed by making `statusBarChrome()` the single source of
  truth both read, dropping the gauge and then the decorative divider before the
  row can overflow. The irreducible 8-column minimum is now a declared constant
  rather than a hidden floor.
- **A gate status line printed on every turn while the gate was off**, pushing
  the real reply out of view. Caught in a real pty capture of the disabled
  default, where it was the only non-blank line on screen.
- A third finding was in the harness itself: it checked the border style against
  *colour* when the correct contract is *glyph coverage* (a 16-colour terminal
  draws box-drawing perfectly well). Worth recording, because "the test was
  wrong" is a real outcome and the temptation is to quietly fix the test.

## Hardware / environment matrix validation

`scripts/persona_usability_check.ts` (above) varies the **terminal**. This section
is about the other axis: the **machine**. The sweep behind this was run once as
a throwaway harness over

```
CPU (1·2·4·8·12·16·32·64) × RAM (2–256 GiB)
  × GPU (none / 4·8·12·24·80 GiB, plus a card reporting 0 MiB free)
  × platform (linux·darwin·win32) × model size (0·1·4·20·70 GiB)
```

= **6,720 environment combinations, 168,668 invariant checks, 1,442 violations
before the fix, 0 after.**

Being precise about what survives in the repo: the one-off harness was **not
committed** — the 168,668 figure is what that throwaway run reported, and you
cannot re-run it from a clean checkout. What *is* committed is
`src/setup/tuning.test.ts` (11 tests), which pins every invariant the sweep
found broken, plus the cross-product spot-checks. The sweep's value was finding
the three bugs below; the tests are what stop them coming back. Quoting a check
count that no longer has anything to reproduce it would be the same mistake this
README criticises elsewhere.

The invariants are the ones whose violation the user discovers hours later:
threads never exceed the core count, context stays in a range llama.cpp's KV
allocator handles, `-b`/`-ub` stay powers of two, no derived flag is ever `NaN`
or negative, and no GPU means `-ngl 0` while a GPU always wins over the CPU.

### What it found

Three real bugs, all of which the previous 590 tests passed straight through —
because each one is invisible on the machine they were written on.

- **Threads exceeded the core count on 1–3 core machines** (`tuning.ts`). The GPU
  branch used a `Math.max(2, …)` floor, so a 1-core box was launched with
  `-t 2 -tb 2`. The dev box has 12 cores, where `max(2, 6)` lands on a legal
  value *by accident* — 1,440 of the 6,720 combinations were wrong and none of
  them could be seen from here. Now clamped with `Math.min(cpuCount, …)`; the
  known-good 12-core result (`threads=6`, the value in the hand-tuned config
  below) is unchanged, and a test pins it.

- **Recursive and forced deletes were classified "cheap"** (`gate.ts`). The
  `bulk delete` rail required a delete verb *and* a separate bulk word, so the
  `-r`/`-f` flag did not count as the qualifier. `rm -rf /home/jeano` and
  `rm -rf /*` were caught — the first by the path pattern, the second by a literal
  `*` — while `rm -rf /`, `rm -rf ~` and `rm -fr node_modules` passed through and
  could be downgraded to a system1 turn. Whether a destructive command was held
  depended on which characters sat next to it.

- **Korean verb conjugations were not matched** (`gate.ts`). The rail listed
  `지우`, but Korean changes the stem vowel `우 → 워` before a vowel-ending
  suffix, so the imperative anyone actually types — `지워줘` — does **not**
  contain `지우` as a prefix. `모든 파일을 지워줘` ("delete all the files") was
  judged cheap while the identical `전부 삭제해줘` was held. `제거` and `재귀`
  were absent from the list entirely.

All three are now covered by regression tests, and the benign side is guarded
too: 39 ordinary requests (English and Korean) must stay unflagged, because a
rail that fires on everything is the same as having no rail.

### What this does *not* cover

Being explicit, because a matrix like this is easy to over-claim. It exercises
the **decision functions** against synthetic hardware. It does not run on real
Windows, macOS, Wayland or musl, and it does not put a real 8 GB card under
real VRAM pressure. A green matrix means the *arithmetic* is sound; it says
nothing about the driver, the kernel, or the terminal.

For the per-TC results, what was actually executed, and the 25 test cases that
remain **unverified** for lack of the hardware, see
[`docs/multienv-acceptance-report.md`](docs/multienv-acceptance-report.md).

## Project validation — 100 developers, 100 projects

The harness above varies the **terminal**. `scripts/project_persona_check.ts`
varies the axis next to it: the **project the developer opened**.

```bash
npx tsx scripts/project_persona_check.ts [--verbose]
```

Being precise about what this is: not 100 simulated humans, and not 100
simulated machines. A "developer" here is a concrete, reproducible project state
— a directory layout, a path shape, a config state, a locale, a disk
condition. Nothing about it is fictional. The value is the coverage matrix, not
a story about a person.

What makes it different from the synthetic sweep above is that **every persona
gets a real directory on disk and the real `ensureLocalStack` runs against it.**
Only the network and the hardware probe are stubbed — the two things a test
must not depend on. So this covers what pure-function tests structurally
cannot: a project directory called `my project 28`, or `프로젝트-5`, or
`proj-7-🚀`, or one whose `.harnesside/config.yaml` is three bytes of garbage, or
a read-only checkout, or a model file sitting inside the repo.

- **10 project kinds** — empty, git repo, dirty git repo, monorepo, already
  bootstrapped, corrupt config, truncated config, read-only, model-in-project,
  deeply nested
- **8 path shapes** — ascii, spaces, Korean, emoji, many dots, very long,
  a name that *looks* like `C:\Users\dev\project`, and a symlink (where the
  path you type and the path on disk differ)
- **5 locales**, **5 disk conditions**

**7,237 checks across 100 real project directories.**

### What it found

Two real bugs, in the same shape, one layer apart:

- **`ensureLocalStack` threw on an unwritable project.** `writeConfig` was the
  one call in the whole function not wrapped in the error-catching `step()`
  helper, so `mkdir .harnesside` failing with `EACCES` rejected the entire
  bootstrap — directly contradicting this module's own contract that a
  bootstrap "degrades instead of failing". A read-only mount, a checkout owned
  by someone else, or a container running as a non-owner all reach it.

- **`loadConfig` had the identical defect, and it was worse.** The same
  unguarded `mkdir` + `writeFile`, inside the `catch` block that handles a
  *missing* config. Since that path runs on **every launch**, a read-only
  project could not start `harnesside` at all. It now starts with in-memory
  defaults and says so honestly, instead of showing a stack trace.

Both are now regression-tested — and the tests were themselves wrong at first:
the read-only probe created `.harnesside` as a side effect, so on a system where
the directory was *not* actually read-only the test passed without exercising
anything. Reverting the fixes and watching the tests fail is the only reason
that got caught.

## TUI / terminal simulation

The two harnesses above vary the terminal's *identity* and the project's
*shape*. `scripts/tui_simulation_check.ts` covers the third axis: **what the
terminal can actually do, and what happens when the user interacts with it.**

```bash
npx tsx scripts/tui_simulation_check.ts [--verbose]
```

- **12 terminal configurations**, each with a **ground-truth capability
  table** — not a guess, but what that terminal genuinely does: xterm at 256
  and truecolor, `vt100`, `dumb`, a CI pipe with no tty at all, `NO_COLOR`,
  a `C`-locale non-UTF-8 terminal, Windows Terminal, bare conhost, macOS
  Terminal, and tmux.
- **5 sizes, 20×10 through 200×50** — the layout must hold at the 40×16 the
  docs name and at a 20×10 that is genuinely too small for a 15-item popup.
- **A real pty** (`script -qec`) for the cases only a terminal can answer:
  background restore on exit, cursor restoration, and line width as bytes
  actually reach the wire.
- **Clipboard routes** — a terminal that accepts OSC 52, one that refuses it
  (Wayland, several multiplexers), and a payload too large to send.
- **Korean and emoji width** at every size, plus paste-chip detection driven
  by a keystroke timeline.

**599 checks.**

### What it found

- **Monochrome terminals were being sent colour.** `detectColorDepth` fell
  through to a 16-colour default for unknown TERMs, and `vt100` was in that
  unknown set — so `48;2;0;0;0m` and `95m` went to a terminal that renders
  them as stray characters. The code's own comment warns about "guessing up";
  this was a guess up in the direction nothing noticed, because every common
  TERM does have colour. Now matched by exact name, with the safe fallback
  preserved for terminals this code has never heard of.

- **`altScreen` was derived from `ansi`, and they are different capabilities.**
  `vt100` predates the alternate screen, and — more importantly — **tmux and
  GNU screen disable `alternate-screen` by default**, because switching buffers
  is precisely what destroys scrollback. Their inner `TERM` is still
  `screen-256color`, so both the ANSI and the colour checks pass and *nothing
  else would have caught it*. The app was telling tmux sessions to enter an
  alternate buffer nobody asked for. It now answers "no" when unsure, because
  rendering inline is recoverable and switching a session's buffer is not.

- **The slash menu could render taller than the thing it overlays.** At 20×10
  the log area is 5 rows, the `MIN_ROWS` floor produced 4 items, and the box
  needed 6 — clipping its own bottom border. Clamped to the container now.

### What the simulation got wrong, and why that matters

The first run reported 17 failures. **Nine were my expectations being wrong**,
and several would have caused damage if "fixed":

- Asserting that `selectionText` strips ANSI would have "fixed" code that is
  already correct — both real call sites (`App.tsx:1354`, `index.tsx:1136`)
  wrap it in `stripAnsiForCopy`.
- Asserting a reset sequence on a non-ANSI terminal would have written escapes
  into a dumb pipe.
- Asserting SGR `0m` on exit would have "fixed" the app to wipe the user's
  *foreground* colour too; the real restore is SGR `49`.
- Asserting the paste detector on a whole typed string tested an input the app
  never receives — typing produces one `useInput` chunk per keystroke.

Each was checked against the real call site, contract, and unit before being
reclassified. Recording this because a simulation harness that reports its own
bugs as product bugs is worse than no harness.

## Testing

Every module with real logic (not just glue/IO) has a `*.test.ts` next to it,
run with `npm test` (Node's built-in `node:test` + `node:assert`, executed
via `tsx` — no test framework dependency needed). Currently covered:
`tools/diff.ts`, `tools/browser.ts` (target-selection/error paths, via a fake
HTTP server — full CDP round-trips were verified manually against real
headless Chrome, see below), `hermes/selfHeal.ts`, `hermes/selfImprove.ts`
(with a fake `ModelBackend`), `compaction/compactor.ts`,
`compaction/checkpoint.ts`, and `skills/loader.ts`. The agent loop and TUI are
integration-level (tool-call loop, streaming, slash commands) and were
verified by scripting real keystrokes through a pty against a real running
llama-server — see the git history for those sessions — rather than unit
tests, since mocking Ink's terminal rendering buys little over driving the
real thing.

> ## 테스트
>
> 실질적인 로직이 있는 모듈에는 (glue/IO 코드 제외) 전부 옆에 `*.test.ts`가 있고
> `npm test`로 실행된다(Node 내장 `node:test` + `node:assert`, `tsx`로 구동 —
> 별도 테스트 프레임워크 의존성 없음). 현재 커버리지: `tools/diff.ts`,
> `tools/browser.ts`(타겟 선택/에러 경로는 fake HTTP 서버로 — 실제 CDP 왕복은
> 실제 headless Chrome으로 수동 검증, 아래 참고), `hermes/selfHeal.ts`,
> `hermes/selfImprove.ts`(fake `ModelBackend` 사용), `compaction/compactor.ts`,
> `compaction/checkpoint.ts`, `skills/loader.ts`,
> `setup/tuning.ts`(코어 수 · VRAM · OS에 따른 플래그 결정 불변식),
> `tui/terminal.ts` + `tui/SlashMenu.tsx`(터미널 능력 감지 · 팝업 높이),
> `setup/bootstrap.ts` + `config.ts`(쓰기 불가 프로젝트에서의 점진적 저하).
> 현재 **525개 테스트 전부 통과**.
> 에이전트 루프와 TUI는
> 통합 테스트 성격(도구 호출 루프, 스트리밍, 슬래시 명령)이라 실제 llama-server를
> 대상으로 pty로 실제 키 입력을 흘려보내며 검증했다(git 히스토리 참고) — Ink 터미널
> 렌더링을 모킹하는 것보다 실제로 구동해보는 쪽이 더 실질적이라고 판단.
