# harnesside 품질·상품화 기획서 (마스터 프롬프트)

> **문서 종류**: 구현 프롬프트 — 이 문서를 그대로 에이전트에게 넘겨 한 라운드씩 실행시킨다.
> **대상 저장소**: `harnesside` (`/home/jeano/harnessCli`)
> **선행 문서**: `PROMPT.md`(구현 명세 1~19) · `PROMPT_IDE_CLI.md`(S-1~S-12) ·
> `PROMPT_TMUX_CLI.md`(T-1~T-14) · `PROMPT_UX_COMMERCIAL.md`(UX/UI) · `PROGRESS.md`(재개 지점) · `todo.md`
> **작성 기준일**: 2026-10-04 · HEAD `1e4a0a2`
> **요구 번호**: `Q-1` ~ `Q-13` (위 문서들의 번호와 겹치지 않는다)

---

## 0. 이 문서의 주장이 한 문장

> **기능을 더하지 않는다. 무게를 뺀다.**
> 코드가 5만 줄인데 정확히 1.2만 줄이 테스트 0줄이고, 6,300줄은 배포물에 들어가지 않으며,
> 같은 기능이 두 벌로 나뉘어 있고, 문서 8,300줄 중 일부는 이미 코드가 아닌 것을 가리키지 않는다.
> **이 상태에서 "기능 추가"는 가장 비싼 선택이다.** 남은 버그의 대부분은
> "어느 사본이 진짜인가"를 아무도 모른다는 사실에서 나온다.

이 기획서는 요구를 13개로 줄였고, 그 13개는 전부 **삭제·통일·검증**이다.
새 파일을 추가하라는 요구는 **0개**다. 이게 "복잡하지 않게"의 유일한 해석이다.

---

## 1. 너에게 주는 역할과 작업 태도

너는 `harnesside` 저장소에서 일하는 시니어 엔지니어다. **기능 설계자가 아니다.**

### 1.1 이 저장소의 규칙 (변경하지 않는다)

- **"설정했다"와 "동작한다"를 다른 문장으로 쓴다.** 동작은 실제로 실행해 본 것만 말한다.
- **모르는 것을 아는 것처럼 쓰지 않는다.** 측정 못 한 것은 **"미측정"** 이라고 적는다.
- **조용히 실패하지 않는다.** 실패는 화면에 이유와 함께 보인다. 빈 화면·가짜 성공 금지.
- **같은 일을 두 곳에 두지 않는다.** 정본은 한 곳, 나머지는 읽기만 한다.
- **검사는 코드보다 먼저 의심된다.** 새 검사를 만들 때 "이 검사가 거짓말할 수 있는 경우"를 먼저 적는다.
- **사람이 보는 화면은 실제 브라우저에서 확인한다.** 유닛 통과는 "코드가 자기가 쓰인 대로 도는가"만 증명한다.
- 사용자의 원문 요구는 문서에서 지우지 않는다. 왜 그렇게 만들었는지를 코드에 남긴다.

### 1.2 이 문서만의 추가 규칙

- **삭제할 때는 "왜 지금 살아 있는 것처럼 보였는지"를 한 줄 적는다.** 나중에 다시 붙인다.
- **삭제 전에 반드시 도달 가능성부터 증명한다.** import 그래프 + 빌드 포함 여부로.
  추측으로 "아마 쓰이지 않는다"고 쓰지 않는다.
- **한 라운드 = 한 요구.** 두 요구를 같이 하면 "어느 쪽이 실패했나"를 못 말한다.
- **돌이킬 수 있는 삭제부터.** 삭제와 별도로 되돌리는 방법(1문장)을 PR 설명에 적는다.

---

## 2. 지금 실측한 상태 (2026-10-04 · 이 기획서의 근거)

아래 숫자는 **모두 이 저장소에서 명령을 실행해 낸 값**이다. 추정치는 추정치라고 적었다.

### 2.1 규모

| 항목 | 값 | 측정 방법 |
|---|---:|---|
| 비테스트 소스 LOC (`src/`, `.ts`/`.tsx`) | **49,700** | `find src -name '*.ts*' \| xargs wc -l` 전체 − 테스트 |
| 비테스트 소스 파일 | **≈154** | 동일 |
| `src/` 테스트 파일 | **132** | `find src -name '*.test.ts' \| wc -l` |
| 테스트 결과 | **1618 pass / 0 fail / 91.7s** | `npm test` |
| `npm run typecheck` | exit 0 | CI `gate` job 통과 |
| 커버리지 하한선 | 80% | `scripts/coverage-floor.mjs --min 80` (CI 게이트) |

### 2.2 무게가 이상한 지점 (이 기획서의 존재 이유)

| # | 실측 사실 | 근거 명령 |
|---|---|---|
| 1 | **`src/localstack/` = 11,969 LOC · 테스트 파일 0개 · 소비자 1개 파일 411줄** | `ls src/localstack/setup \| wc -l` · `grep -rl localstack src \| grep -v localstack` → `slashService.ts` 뿐 |
| 2 | **`src/legacy-tui/` = 5,530 LOC · 빌드에서 제외 · `bin`에서 도달 불가** | `tsconfig.server.json` 의 `exclude` 에 포함 · `ls dist/legacy-tui` → 없음 |
| 3 | **배포물에서 도달 불가한 코드 ≈ 6,292 LOC (12.7%)** | 2번 + 그것만 참조하는 `setup/bootstrap.ts` 435 · `src/config.ts` 220 · `backend/llamaServer.ts` 107 |
| 4 | **`src/legacy-tui/terminal.ts` 와 `src/localstack/tui/terminal.ts` 가 둘 다 597줄이고 차이는 주석 16줄** | `diff` → 16줄. 살아 있는 쪽은 `localstack/tui/terminal.ts` |
| 5 | **`src/backend/` 와 `src/localstack/backend/` 가 4파일 복제.** 웹 프로덕션 경로는 **약한 사본**을 쓴다 | 아래 §2.3 |
| 6 | `dist/` 에 테스트 산출물 **85개** 포함, 총 **26MB** | `find dist -name '*.test.js' \| wc -l` |
| 7 | `dist/` 는 **현재 `src/` 보다 오래됨** — `dist/server/index.js` 에 `slashService` 참조 0건, `dist/server/{slashService,tmux,cliSessions,safeOutput,cliCommands}.js` 없음, `dist/localstack/` 없음 | `grep -c slashService dist/server/index.js` → 0 |
| 8 | **`dist/packaged-web/` 는 빌드되고 검사되지만 서버가 제공하지 않는다.** 서버는 `dist/web` 을 제공 | `src/server/index.ts:513` `join(projectRoot,"dist","web")` |
| 9 | `scripts/update-bin.mjs` 는 **어떤 npm script 에도 묶여 있지 않고**, 존재하지 않는 `dist/index.js` 를 `stat` 한다 | `package.json` · `scripts/update-bin.mjs` |
| 10 | `npm run test:e2e` 가 참조하는 `scripts/e2e_check.ts` **없음** | `ls scripts/e2e_check.ts` |
| 11 | `scripts/coverage-floor.test.ts` 의 10개 테스트가 **CI에서 실행되지 않는다** (`npm test` 글이 `src/**` 만) | `package.json` 의 `test` |
| 12 | **`README.md` 가 `src/tui/` 를 23회 참조 — 그 경로는 없다** (실제 `legacy-tui/`, `localstack/tui/`) | `grep -c 'src/tui/' README.md` → 23 · `ls src/tui` → 없음 |
| 13 | `PROMPT_UX_COMMERCIAL.md` 가 `src/web/panels/SearchBlock.tsx` 를 목록에 넣었지만 **파일이 없다** | `ls src/web/panels/SearchBlock.tsx` → 없음 |
| 14 | **README 3,075줄이 TUI(종료된 제품)를 기준으로 쓰여 있다** | README `## Screens` 가 Ink 배너·`/help` 캡처 |
| 15 | `verify-signals` `verify-a11y` `verify-i18n` `verify-firstrun` `verify-shell` `verify-shutdown` **6개가 로컬 전용** (CI는 3개 job: gate·boot-smoke·window) | `.github/workflows/ci.yml` · `workflow_dispatch` 외 `schedule:` 없음 |
| 16 | 자동 업데이트 **2벌 병존** — `src/selfUpdate.ts`(tarball) / `src/server/updateService.ts`(슬롯 교체) | 파일 두 개 |
| 17 | `LICENSE` `CHANGELOG.md` `CONTRIBUTING.md` `SECURITY.md` **없음**, `package.json` 에 `files` 없음 | `ls LICENSE* CHANGELOG*` · `grep '"files"' package.json` |

### 2.3 가장 위험한 한 건 (Q-3의 근거)

`src/backend/` 와 `src/localstack/backend/` 는 복제본인데 **강한 쪽이 아니라 약한 쪽을 웹 프로덕션이 쓰고 있다.**

| 파일 | `src/backend/` (웹이 쓰는 쪽) | `src/localstack/backend/` (localstack만) |
|---|---:|---:|
| `openaiClient.ts` | 428줄 | 556줄 — `keepAlive:false` 수정(4/8→8/8 실측), `chat()` **절대 deadline**, 미완결 tool-call JSON 히스토리 제외 |
| `detect.ts` | 69줄 — `COMMON_PORTS=[8080,8081,11434]` **하드코딩** | 376줄 — `/props` 탐색, stub 거부, `waitForServer`, `verified: "llama.cpp\|other\|stub"` |
| `llamaServer.ts` | 107줄 | 348줄 — MoE `-np`, speculative decoding, `-no-kvu`, `readyTimeoutMs` |

같은 사실을 `src/setup/` ↔ `src/localstack/setup/` 에서도 반복한다.
`bootstrap.ts` 는 **23줄짜리 주석이 `harnesside` ↔ `llamacli` 한 단어만 다른** 복제다.

> **이것이 왜 위험한가**: 버그를 고칠 때 두 벌 중 하나만 고친다.
> 어느 쪽이 배포되는지는 import 그래프를 눈으로 추적해야만 알 수 있다.
> 그 눈을 못 맞추면 고치는 버그가 그대로 사용자에게 나간다.

---

## 3. Done 의 정의 (13개 요구 공통)

- [ ] 요구를 지우고 **아무도 회고하지 않는 일이 없다.** git blame 에서 "왜 없었는지"가 읽힌다.
- [ ] `npm run typecheck` · `npm test` · `npm run build` · `node scripts/ci-checks.mjs` · `node scripts/coverage-floor.mjs --min 80` **5개 전부 통과.**
- [ ] **커버리지가 내려가지 않는다.** 라운드 전후 `coverage:report` 를 붙여 붙이고, 내림차순 5개를 적는다.
- [ ] 줄어든 LOC 수를 적는다. **줄어든 수만 적는다.** 늘어난 것은 나중에 별도로 적는다.
- [ ] 사람이 보는 화면을 건드렸다면 **실제 브라우저로 확인한다** (`node scripts/verify-window.mjs`).
- [ ] 이 문서의 §8 미측정 목록에서 **한 칸이 줄었는지** 적는다. 줄지 않았으면 그거 적는다.

---

## 4. 라운드 A — 무게를 뺀다 (단순함)

> **왜 이게 "복잡하지 않게"의 본체인가**: 지금 문제는 기능 부족이 아니라 **모호함**이다.
> 어느 사본이 진짜인지, 어디가 정본인지, 배포물에 뭐가 들어가는지 알 수 없다.
> 12,000줄을 **이동·병합**해서 없애는 것이, 새 추상화 3개를 추가하는 것보다 싸고 확실하다.

### Q-1. `src/localstack/` 을 없애고 `/models`·`/server`·`/reset` 을 native로 이식한다

**무엇을**

`src/localstack/` (11,969 LOC · 테스트 0) 안에는 `llamacli` CLI가 그대로 복사되어 있다.
이름을 바꾼 것(`llamacli` → `harnesside`)이 한 벌뿐이다.

- 9,580줄 `localstack/setup/` 안에 **29개 파일**은 `src/setup/` 에 대응본이 없다
  (`stockRuntime` `modelCatalog` `modelSelect` `modelSwitch` `modelMetrics` `provision`
  `calibrate` `download` `disk` `existingModel` `checksum` `ggufMeta` `buildTarget`
  `buildEnv` `engineCommon` `hostEnv` `tarGz` `zip` `fsUtil` `downloadProgress`
  `resetDiff` `resetPreview` `serverCommand` `serverReport` `serverPolicy` `gpuReport`).
  **이것들은 살려야 한다** — 모델 다운로드·체크섬·프로비저닝의 실제 기능이다.
- 5개 파일은 대응본이 있다: `bootstrap` `tuning` `hardware` `llamaCpp` `ports`.
  이것들은 **한 벌로 합친다.**

**어떻게**

1. 먼저 `localstack/setup/` 의 29개 단독 파일을 `src/models/`·`src/setup/`·`src/server/` 로 **이동**한다.
   `localstack` 이라는 디렉토리 이름이 없어지면 끝난다.
2. 5개 중복 파일(`bootstrap` `tuning` `hardware` `llamaCpp` `ports`)은
   **강한 쪽 = `localstack/setup/` 판본**을 정본으로 삼고 `src/setup/` 을 없앤다.
   전자가 더 크고 실제 결함을 이미 고친 쪽이다(§2.3).
3. `localstack/config.ts` 의 `LlamacliConfig` 를 `src/config.ts` 로 흡수한다.
   **주의**: `src/config.ts` 는 `enableThinking: true` 를 넣고 있고 `localstack/config.ts` 는 넣지 않는다.
   기본값은 **오늘의 `src/config.ts` 를 따른다**(2026-10-04 커밋 `1c039c3` 의 의도).
   단 **`summaryDeadlineMs` `warmTriggerRatio` `warmPrefill` `llama.modelPath` MoE·speculative 항목**은
   `localstack/config.ts` 쪽에만 있으므로 **반드시** 가져온다.
4. `src/server/slashService.ts` 의 import 17개를 새 경로로 고친다.
5. `src/localstack/tui/terminal.ts`(597줄)를 `src/setup/` 로 옮기고 `legacy-tui` 사본을 지운다.
6. `src/localstack/backend/` 는 Q-3에서 처리한다. **Q-3을 먼저 끝낼 것을 권한다.**

**검증**

- `npm run typecheck` exit 0
- `npm test` **1618 pass 유지** (줄어들면 이식 중 테스트를 깬 것 — 각 1개라도 먼저 고친다)
- `grep -rn "localstack" src scripts` → **0건**
- `/api/slash/run` 으로 `/models` `/server` `/reset` 이 **각각 실제로 동작**한 로그 1줄씩
- `node scripts/verify-firstrun.mjs` 통과 (이 스크립트는 `dist/setup/firstRun.js` 를 본다 — 이식 후에도 성립해야 한다)
- **`src/localstack/` 에 테스트가 0개였다** — 이식한 코드가 0줄 커버리지인 채 나가지 않게,
  이식한 파일마다 테스트 1개 이상을 붙인다

**하지 말 것**

- localstack의 `download` / `modelSwitch` / `provision` 을 **"웹에서 필요 없다"는 이유로 버리지 않는다.**
  `/models` 슬래시 명령이 그것을 호출한다. "안 쓰는 기능"이라는 판단은 import 그래프로 증명한다.
- 디렉토리 이름을 `legacy/` `old/` 같은 것으로 **또 바꾸지 않는다.** Q-1로 끝낸다.
- 이동을 한 번에 하지 않는다. 29개 파일을 묶어서 옮기고 그 묶음마다 테스트를 돌린다.

**되돌리는 법**: 이동 전 커밋 태그를 찍는다. 되돌리기는 `git reset --hard <tag>`.

---

### Q-2. `src/legacy-tui/` 을 저장소에서 뺀다

**무엇을**

`src/legacy-tui/` (5,530 LOC, 13개 테스트 파일) 은 **Ink TUI** 구현이다.
- `tsconfig.server.json` 이 `exclude` 한다 → `dist/legacy-tui/` 가 **존재하지 않는다**.
- `package.json` 의 `bin` 이 가리키는 `dist/server/index.js` 경로에서 **도달할 수 없다.**
- 이 파일들은 `npm run typecheck` 에는 **포함된다**(`tsconfig.json` 이 전체 `src` 를 본다)
  → **타입 에러는 막고, 빌드는 안 하고, 배포는 안 하는** 코드다.

이 저장소가 TUI에서 웹 IDE로 넘어온 것이 §2.2 의 근거다(README의 TUI 캡처, §2.2 14행).

**어떻게**

1. 아래 3개 중 하나를 고르고 **문서에 이유를 적는다.**
   - **(가) 삭제한다.** 이 저장소의 제품이 웹 IDE이고, TUI는 코드가 아니다.
   - **(나) `packages/legacy-tui/` 로 옮기고 npm `workspaces` 에서 제외한다.** 되살릴 가치가 있으면.
   - **(다) `archive/legacy-tui/` 로 옮기고 CI·타입체크·커버리지에서 완전히 뺀다.**
2. **지금 어느 TUI가 살아 있는지 먼저 확정한다.** Git 히스토리에서 `legacy-tui` 가 남은 이유를
   읽고 그 결론을 문서에 적는다. 살아 있는 TUI가 있다면 Q-1·Q-2의 전제를 고쳐야 한다.
3. **스크린샷을 웹 IDE로 다시 찍는다.** `scripts/capture_screens.py`(TUI)와
   `scripts/capture-window.mjs`(웹) 중 어느 것으로 README `## Screens` 를 만드는지 명시한다.
4. `docs/screenshots/*.txt` 를 어느 쪽에서 생성하는지 정한다. **정본이 없는 스크린샷은 삭제한다.**

**검증**

- `grep -rn "legacy-tui" src scripts tsconfig*.json vite.config.ts package.json` → **0건**
- 또는: 옮겼다면 grep 결과가 **아래 4곳에만** 남는다 — `tsconfig.server.json` exclude, `coverage-floor.mjs` EXCLUDES, `rename-identifiers.mjs` SKIP, `scripts/fix-legacy-tui-imports.mjs` 의 **삭제 대상 표시**
- `npm run typecheck` exit 0 · `npm test` 1618 pass 이상
- **`npm run typecheck` 가 여전히 TUI를 보고 있지 않은지 확인한다.** 보고 있다면 이것부터 제거해야 한다.
- README `## Screens` 가 **실제 화면 캡처**다. 사람이 만든 그림이면 그 즉시 실패다.

**하지 말 것**

- `dist/legacy-tui` 가 없다는 근거로 "이건 없어도 되겠다"고 **혼자 결정하지 않는다.** 삭제/보관 중 하나를 고르고 이유를 적는다.
- TUI의 알아두면 쓸모 있는 것(터미널 capability 감지 `terminal.ts`, 선택 `selection.ts`,
  키바인딩 목록 `keybindings.ts`)은 **웹으로 옮기거나, 안 옮긴다면 그 이유를 적는다.**

**되돌리는 법**: 이 요구는 전부 파일 이동·삭제다. 태그를 찍는다.

---

### Q-3. 갈라진 두 벌을 **강한 쪽으로** 합친다

**무엇을**

§2.3 의 표. 같은 기능이 두 벌이고 **웹 프로덕션은 약한 쪽을 쓴다.**
이것은 "중복"이 아니라 **"양쪽 다 버그가 있다"** 이다.

**어떻게 (이 순서를 지킨다)**

1. `src/backend/` → `src/localstack/backend/` 판본으로 전부 교체한다.
   - `detect.ts`: `COMMON_PORTS` 하드코딩을 `setup/ports.ts` 재수출로 바꾼다.
     (주의: 이 재수출 자체가 **순환 참조 위험**이 있다. `backend` → `setup/ports` 방향만 허용하고 역방향 금지.)
   - `openaiClient.ts`: `keepAlive: false`, `chat()` 절대 deadline, 미완결 tool-call JSON 제외를 **전부** 가져온다.
   - `llamaServer.ts`: MoE / speculative / `readyTimeoutMs` 를 가져온다.
2. `src/setup/` ↔ `src/localstack/setup/` 5개 중복 파일은 Q-1에서 합친다. **여기서는 확인만 한다.**
3. `src/config.ts` ↔ `src/localstack/config.ts` 도 Q-1에서 합친다. **여기서는 확인만 한다.**
4. `src/server/blocks.ts`(145줄)와 `src/session/blocks.ts`(283줄) — 두 `BlockKind` 열거형이 공존한다.
   **삭제하지 않는다.** 역할이 다르다(WS 스트림 상태기 vs 영속 대화 기록). 대신
   `session/blocks.ts` 가 정본이고 `server/blocks.ts` 는 스트림 상태만 다룬다는 사실을
   **양쪽 파일 상단 주석에 1줄씩** 적는다. 그리고 `server/blocks.ts` 가 `src/` 내에서
   자기 테스트 외에 아무에게도 쓰이지 않는 것을 확인하고, 적힌 근거를 적는다.

**검증**

- `npm test` **1618 pass 유지.** 특히 `src/backend/openaiClient.test.ts`(534줄)·`detect.test.ts` 가
  **교체 후에도 통과**해야 한다. 통과하지 않으면 가져오는 쪽을 잘못 고른 것이다.
- **기존 `backend/` 테스트가 `localstack/backend/` 판본을 직접 못 박는지 확인한다.**
  못 박는다면 그 테스트는 약한 사본의 동작을 고정하고 있는 것이므로 **의도한 것인지 판단하고 문서에 적는다.**
- `grep -rn "from \"../backend/\|from \"./backend/" src | grep -v localstack` → **0건**
- 새로 붙은 경로에 대해 `keepAlive`·deadline·stub-거부 동작을 **직접 검증하는 테스트 1개씩** 추가한다

**하지 말 것**

- **`src/backend/` 를 지우면서 그 안의 `LlamaServerManager`(107줄)를 함께 버리지 않는다.**
  `src/backend/llamaServer.test.ts:4` 가 "이 클래스는 새 `LlamaLauncher` 로 대체됐지만
  `src/legacy-tui/` 가 아직 쓴다"라고 적어 있다. **Q-2가 먼저다.**
- 두 벌을 "정리용"이라는 이름으로 **세 번째 벌을 만들지 않는다.**

**되돌리는 법**: 태그.

---

### Q-4. 배포 산출물을 좁히고 `npm` 배포 가능하게 만든다

**무엇을**

지금 `npm install` 후 `npm run build` + `npm link` 가 유일한 설치 경로다(`README` `## Getting started`).

| # | 문제 | §2.2 근거 |
|---|---|---|
| 1 | `dist/` 에 테스트 산출물 **85개** 포함, 총 26MB | 6 |
| 2 | `dist/` 가 현재 소스보다 **오래됨** — `bin` 이 실행하는 것이 구버전 | 7 |
| 3 | `dist/packaged-web/` 를 만들면서 검사하는데 **서버는 `dist/web` 을 제공** | 8 |
| 4 | `scripts/update-bin.mjs` 가 어떤 npm script 에도 **묶여 있지 않고** 존재하지 않는 `dist/index.js` 를 `stat` | 9 |
| 5 | `files` 필드 없음 · `LICENSE` 없음 · `prepublishOnly` 없음 | 17 |
| 6 | `npm run test:e2e` → 존재하지 않는 스크립트 | 10 |
| 7 | `dist/` 가 커밋 가능해 보인다 (`.gitignore` 확인이 필요하다) | — |

**어떻게**

1. `tsconfig.server.json` 의 `exclude` 에 `**/*.test.ts` 를 추가해 테스트가 `dist/` 에 안 나오게 한다.
   **검증**: `find dist -name '*.test.js' | wc -l` → **0**
2. **문제 3을 먼저 고친다.** 서버가 `dist/packaged-web` 을 제공할지, `pack-web-assets.mjs` 를 없앨지
   **하나를 고른다.** 지금은 "만들고 검사하지만 아무도 쓰지 않는" 상태가 가장 나쁘다.
   고른 뒤 **서버가 실제로 제공하는 경로**를 부팅 스텝 9(`src/server/index.ts:513`)에 맞춘다.
3. `files`(최소 `dist`, `README.md`, `LICENSE`)와 `prepublishOnly: "npm run build"` 를 넣는다.
4. `LICENSE` 를 넣는다. **소유자는 사용자가 정한다** — 선택지만 고르지 말고 되묻는다.
5. `npm run test:e2e` 를 **실제로 있는 스크립트에** 묶거나 지운다.
   지금 후보: `scripts/verify-window.mjs` + `scripts/verify-terminal.mjs`.
6. `dist/` 가 `.gitignore` 에 있는지 확인한다. 없다면 넣는다.
7. `.ci-fake-models/` `.harnesside/state/` 처럼 커밋 금지가 필요한 경로가
   `ci-checks.mjs` 목록과 `package.json` `files` 양쪽에서 일치하는지 확인한다.

**검증**

- `find dist -name '*.test.js' | wc -l` → 0
- **`dist` 를 지우고 처음부터 다시 만든다:** `rm -rf dist && npm run build` 후
  부팅 스텝 9가 통과하고 `verify-window.mjs` 가 18/18 통과.
  (§2.2 7 — **이걸 안 하고 빌드가 통과했다고 말하면 안 된다.**)
- `npm pack --dry-run` 가 `dist/` 안의 테스트 파일을 담지 않는지 확인하고 **파일 수를 적는다.**
- `node dist/server/index.js --help` 가 `--help` 를 출력하고 exit 0

**하지 말 것**

- `dist/` 를 커밋하지 않는다. **커밋돼 있으면 이 요구에서 지운다.**
- `files` 를 넣으면서 **의존성을 빼지 않는다.** 현재 `node-pty` `ws` `chokidar` `@xterm/*` 가 런타임 필수다.

---

## 5. 라운드 B — 안 흔들린다 (안정성)

> 이미 측정 장비는 충분하다. `verify-signals` `verify-shutdown` `verify-shell` `soak-users`
> persona 검사 2종, 코버리지 하한선. **문제는 그 장비 절반이 CI에 없다**는 것뿐이다.
> 새 테스트를 쓰는 것이 아니라 **있는 검사를 게이트로 올리는** 것이 이번 라운드의 일이다.

### Q-5. 부팅 실패를 "어느 단계에서 왜"로 말한다

**무엇을**

부팅은 12단계(`src/server/bootstrap.ts` 626줄 + `index.ts` 의 `lateSteps` 9~12)로 되어 있고,
`--dry` 는 단계 이름만 찍는다. `--dry` 로 12줄을 찍는 것까지는 CI가 보장한다(`ci.yml` boot-smoke).

**어떻게**

1. `bootstrap.ts` 의 `BootstrapReport` 가 **이미 단계별 결과를 담는지 먼저 확인한다.** 담고 있으면
   **UI에 그리는 쪽만** 고친다. 새 리포트 구조를 만들지 않는다.
2. 실패 시 사용자에게 4가지를 말한다: **몇 단계에서 · 무엇이 실패했는지 · 왜(원본 로그 1줄) · 다음 행동 1개.**
   - 실패 원인이 `null` 이면 `null` 을 문장으로 바꾸지 않는다. **"확인 못 함" 이라고 쓴다.**
3. 단계 11(Chrome 기동) 실패와 단계 8(llama 헬스체크) 실패는 **사용자가 스스로 해결할 수 있는 문장으로 쓴다.**
   리눅 패키지 이름·포트 번호·이미 띄운 서버 있는지를 포함한다.
4. 부팅 단계 순서가 **CI가 이미 검증하는 것**(1..12 연속, `diff -u` 와 `seq 1 12`)과 코드 순서를
   대조한다. 두 곳(`bootstrap.ts` 1~8, `lateSteps` 9~12)이 나뉘어 있으니 **정본 한 곳에 나열한다.**

**검증**

- `--dry` 출력이 **여전히 정확히 12줄·연속** (기존 CI 그대로 통과)
- 실패를 **실제로 만들어서** 확인한다: 가짜 llama를 일부러 잘못된 포트에 띄운 뒤 `verify-firstrun.mjs` 확장,
  또는 CI에 **"llama 없는 상태로 부팅"** 시나리오를 하나 추가한다.
  (요구 5: 부팅 스모크가 **성공 경로만** 본다. 실패 경로 검사가 없다.)
- 각 실패 메시지에 **원본 로그 1줄이 실제 포함**되는지 확인한다.

**하지 말 것**

- 부팅 단계를 **더 나누지 않는다.** 12가 많다어서 늘리는 것이 아니다.
- 실패를 `console.log` 로만 남기지 않는다. **창에도 보인다.**

---

### Q-6. 로컬 전용 검사 6개를 CI 게이트로 올린다

**무엇을**

`verify-signals` `verify-a11y` `verify-i18n` `verify-firstrun` `verify-shell` `verify-shutdown` 중
**하나도 CI에서 돌지 않는다.** 그 중
- `verify-shutdown.mjs:24-26` 가 **오래된 S1~S5 이름표를 쓴다** — 같은 저장소의
  `verify-signals.mjs:24-26` 가 그 이름을 **명시적으로 틀렸다고 적어 있다.**
- `.github/workflows/ci.yml` 헤더는 "E2E는 nightly"라고 쓰면서 **`schedule:` 트리거가 없다.**

**어떻게**

1. **`schedule:` 트리거를 넣는다**(매일 새벽). 기존 job 3개는 그대로 두고 nightly job을 하나 더 단다.
   이것만으로 §2.2 15의 절반이 해결된다.
2. 6개 중 **정부는 변동(variance)이 작아서** nightly에 올릴 수 있다. 나머지는 job을 새로 만든다:
   - `verify-firstrun.mjs` → 기존 boot-smoke에 편입 (빠르고 결정적)
   - `verify-terminal.mjs` 는 이미 window job에 있다. **`verify-shell.mjs` 는 판정 기준이
     "느낌·지연은 측정 안 한다"고 스스로 적고 있다** — 지연 임계값을 정하면 올릴 수 있다.
   - `verify-signals.mjs` 는 **포트/inode 기반 판정**이라 드문 실패가 적다. 올린다.
   - `verify-a11y` `verify-i18n` 는 헤드리스 CDP에 붙인다. ** flaky하면 flaky하다고 적고 두지 않는다.**
3. `verify-shutdown.mjs` 를 `verify-signals.mjs` 에 흡수하거나 **둘 다를 이유를 적는다.**
   같은 S1~S5를 두 파일이 다르게 부르는 것은 다음 사람이 고치게 되는 부채이다.
4. **`scripts/coverage-floor.test.ts` 의 10개 테스트를 CI에 넣는다** (§2.2 11).
   커버리지 하한선을 만드는 검사기가 자기 테스트가 실행되지 않으면,
   하한선이 조용히 잘못되어도 아무도 모른다.

**검증**

- nightly가 **한 번 실제로 돌았다** — GitHub Actions run URL을 PR에 붙인다.
- flaky 검사는 3회 연속 성공을 확인하고 그 사실을 적는다. 1회 성공은 증거가 아니다.
- `scripts/coverage-floor.test.ts` 를 `npm test` 에서 실행되게 하거나 CI에서 별도 호출한다.

**하지 말 것**

- **검사를 통과시키려고 검사를 고치지 않는다.** 검사기가 코드보다 먼저 의심된다.
  고쳐야 할 때는 **그 사실을 PR에 적는다.**
- flaky한 검사를 `continue-on-error: true` 로 조용히 숨기지 않는다. **이름을 적는다.**

---

### Q-7. 자동 업데이트 경로를 1개로 만든다

**무엇을**

| # | 문제 | §2.2 근거 |
|---|---|---|
| 1 | **업데이트 메커니즘 2벌** — `src/selfUpdate.ts`(199줄, GitHub tarball, SHA-256) 와 `src/server/updateService.ts`(473줄)+`update/`(슬롯 교체, 롤백). **어느 쪽이 사용자 경로인지 문서에 없다.** | 16 |
| 2 | `scripts/update-bin.mjs` 는 tarball을 만드는 스크립트인데 **어떤 npm script 에도 묶여 있지 않다** | 9 |
| 3 | 그 스크립트가 버전 번호를 구하기 위해 `dist/index.js` 를 `stat` 한다 — **그 파일은 존재하지 않는다** (`dist/server/index.js` 가 있다) | 9 |
| 4 | `legacy-tui/banner.ts` 의 `buildVersionString` 이 만드는 버전 형태(`v<YYYYMMDD>`)와 **맞춰야 하는데** TUI는 Q-2에서 사라진다 | — |
| 5 | `bin/` 는 gitignore + 커밋 금지 대상이고, `bin/manifest.json` 을 만들어야 함 | 17 |

**어떻게**

1. **2개 중 하나를 정본으로 정한다.** 판단 근거를 3문장으로 적는다.
   (판단: 슬롯 교체 쪽이 롤백·`ApplyGuard`·알림을 이미 갖고 있고 HTTP 라우트가 있다.
   **하지만 반대쪽 근거도 적어라** — 결정을 남에게 감사받게 하려면 반대 근거를 함께 둔다.)
2. **`--version` 을 정본의 값으로 삼는다.** 지금 `harnesside --version` 이 무엇을 출력하는지
   **먼저 실행해서 확인한다** — usage에 `--keep-alive` 가 적혀 있지만 소스에 없다는 사실이
   (§6.4 등) 이미 한번 그런 일이 있었다.
3. `update-bin.mjs` 를 `build` script 에 묶거나 **삭제한다.** "manual" 로 방치된 채 경고만 낸다 = 죽은 코드.
4. 버전 문자열의 **정본 한 곳**을 정한다 (`package.json` 의 `version` 이 정본일 수도 있다).
   날짜 기반 `v20260928` 을 쓸지 시맨틱 버전을 쓸지 **결정하고 그 이유를 적는다.**

**검증**

- `harnesside --version` 과 `harnesside version`(또는 `status`의 버전 필드)이 **같은 문자열**을 출력한다.
- `npm run build` 한 번만 돌리고, `bin/manifest.json` 이 **생기거나 안 생기는 것이 문서대로**다.
- 슬롯 교체를 고른다면: 롤백이 **실제로 동작하는** 로그 1줄. 가짜 업데이트로 시도한 뒤 되돌린 기록.

**하지 말 것**

- **새 업데이트 시스템(3벌째)을 만들지 않는다.**
- 자동 업데이트가 **백그라운드로 조용히 재시작하지 않게** 한다. 사용자 발동이 있어야 한다.

---

## 6. 라운드 C — 어디서든 돈다 (호환성)

> 이 라운드가 이 기획서에서 **"호환성"**을 말하는 부분이다.
> 결론은 달성하기 어려운 대합이다. **매트릭스를 만들어 빈 칸을 "미측정"으로 남기는 것**이 목표다.

### Q-8. 문서와 코드의 드리프트를 CI 게이트로 만든다

**무엇을**

| # | 이미 확인된 드리프트 | §2.2 |
|---|---|---:|
| 1 | `README.md` 가 `src/tui/` 를 **23회** 참조 — **경로가 존재하지 않는다** | 12 |
| 2 | `PROMPT_UX_COMMERCIAL.md` 가 `src/web/panels/SearchBlock.tsx` 를 목록에 넣었지만 **파일이 없다** | 13 |
| 3 | `npm run test:e2e` → `scripts/e2e_check.ts` **없음** | 10 |
| 4 | `scripts/update-bin.mjs` 가 `dist/index.js` 를 `stat` — **없음** | 9 |
| 5 | `scripts/fixtures/coverage-report.txt` 가 **낡은 스냅샷** — `src/localstack` 없음, `loop.ts` 가 "미도달 2813행" 인데 그 파일은 지금 1,779줄 | — |
| 6 | `README.md` 3,075줄이 **종료된 제품(TUI)** 기준으로 쓰여 있다 | 14 |
| 7 | `verify-shutdown.mjs` 와 `verify-signals.mjs` 가 **같은 S1~S5를 다르게 부른다** | — |
| 8 | `USAGE` 에 `--keep-alive` 가 적혀 있지만 **소스에 없다** | — |
| 9 | `src/localstack/` **0 테스트**, `src/legacy-tui/` 는 13 테스트가 **빌드 안 되는 코드**를 검증 | 1,2 |

**어떻게**

1. **새 검사 1개**를 `scripts/` 에 만든다(기존 `ci-checks.mjs` 에 붙여도 된다 — 5번째 게이트).
   ```
   문서 8개(PROMPT*.md, README.md, PROGRESS.md, todo.md, IMPROVEMENTS.md, MIGRATION_CHECKLIST.md)에서
   `src/` 로 시작하는 백틱 경로를 전부 뽑아,
   실제 파일·디렉토리가 존재하는지 확인한다.
   하나라도 없으면 실패한다.
   ```
   **예외 목록**을 파일로 두고, 예외에 넣은 **이유를 빈 칸 없이** 적는다(빈 이유가 있으면 허용 안 함).
2. **같은 방식으로 `package.json` 의 `scripts` 를 검사한다.** 값에 적힌 파일이 없으면 실패.
3. `verify-shutdown` / `verify-signals` 의 신호 이름표를 **한 부로** 맞춘다(§Q-6 3).
4. `scripts/fixtures/coverage-report.txt` 를 **재생성**하거나 **삭제한다.**
   낡은 스냅샷을 "커버리지 증거"로 인용하는 것이 이 저장소 문서에서 가장 자주 본 사고다.
5. README를 **TUI 기준으로 다시 쓰지 않는다**(Q-12에서 한다). 지금은 경로만 즉시 고친다.

**검증**

- 검사기가 **실제로 실패한다.** 자기 정본 경로(`src/server/index.ts`)를 문서에 **한 줄 추가하면
  새 검사가 빨간불이 되어야 한다.** 이 부재를 확인하지 않은 검사는 없는 검사다.
- 이 요구가 끝나면 `grep -rn 'src/tui/' README.md` → **0**
- `npm run test:e2e` 가 실제로 실행되거나 스크립트 목록에서 사라진다.

**하지 말 것**

- **정본 파일 지문을 굳이지 않는다.** 경로 표는 자주 바뀌고, 그 표를 굳히면 이 요구가
  매 라운드 짜증이 된다. 이 예외가 몇 개인지 **문서에 적어 둔다.**
- 이미 이렇게 쓰는 저장소 규칙(`ci-checks.mjs` 의 규칙 3)을 **위배하지 않는다.**

---

### Q-9. 실행환경 매트릭스 1장 — 그리고 빈 칸은 비워둔다

**무엇을**

| 축 | 주장되어 있나 | 실제 검증 |
|---|---|---|
| 터미널 | `persona_usability_check.ts` 가 터미널을 바꿔가며 검증 | 로컬 전용 |
| Node | `engines: ">=18"` | **CI는 Node 22 하나뿐.** 18/20/24 미검증 |
| OS | README가 linux·darwin·win32를 **합성 하드웨어로** 돌렸다고 함(6,720 조합) | **README도 "실제 Windows·macOS·Wayland·musl에서 돌리지 않았다"고 적고 있다** |
| 브라우저 | `verify-window.mjs` (Chrome 헤드리스) | Chrome 고정 버전 1개 |
| GPU | 합성. **실제 VRAM 압력은 안 돌림** (README 인정) | 미측정 |
| `docs/multienv-acceptance-report.md` 에 **25개 미검증 케이스**가 남아 있음 | — | — |

> **핵심**: README가 이미 **"이 매트릭스가 하지 않는 것"** 을 정직하게 적었다
> (드라이버·커널·터미널에 대해 아무것도 말하지 않는다). 그 정직함이 이 요구의 출발점이다.
> **지우지 말고 위로 쌓아라.**

**어떻게**

1. README에 **매트릭스 1장**을 둔다. 표의 칸 값은 **3개뿐**:
   - `검증됨` — 이 저장소 CI나 로컬 스크립트가 돌린 것이 존재
   - `로컬 실행 가능` — 스크립트가 있으나 CI에 없음 (Q-6 대상)
   - `미측정` — 돌아본 적 없음
2. **빈 칸을 채우려고 가상 검사를 만들지 않는다.** 미측정 칸을 정직하게 남기는 것이 요구다.
3. **하나만 실제로 채운다.** 가장 값싸고 영향이 큰 축을 골라 그 1개만 `검증됨`으로 올린다.
   후보: **Node 20** (또는 18). 이유: 손이 거의 안 가는 대신 3배로 넓어진다.
   → `ci.yml` 에 `matrix: node: [20, 22]` 추가. **22 하나를 건드리지 않는다.**
4. OS 매트릭스는 **GitHub Actions `macos-latest` / `windows-latest`** 로 갈 수 있다.
   다만 **`node-pty` 빌드**와 **Chrome 부팅**이 걸린다. **한 축만 시도하고, 안 되면
   "CI 러너에서 안 된다"고 적고 멈춘다.** 3개 OS × 3개 job을 넣지 않는다.
5. 25개 미검증 케이스(`docs/multienv-acceptance-report.md`)는 **줄어든 것만 표시한다.**
   새로 늘어나지 않았는지도 적는다.

**검증**

- 매트릭스의 `검증됨` 칸 **하나하나에 그걸 돌린 명령·날짜·로그**가 붙는다.
  못 붙이면 그 칸은 `검증됨`이 아니라 `로컬 실행 가능`이다.
- Node 축을 올렸다면 그 job이 **한 번 실제로 성공한 run URL**이 남는다.
- README가 **"무엇을 검증하지 않는가"** 절을 여전히 갖고 있다(Q-8의 다른 문서에 이미 있음).

**하지 말 것**

- **합성 매트릭스 결과를 실측 결과처럼 쓰지 않는다.** README가 이미 규칙을 정했다
  ("168,668 figure는 다시 돌릴 수 없다 — 인용하지 않는다"). 이 규칙을 매트릭스에도 적용한다.
- 미측정 칸을 채우려고 **모킹**을 쓰지 않는다. `scripts/fake-llama-server.mjs` 는
  **부팅 경로 검증용**이지 호환성 증거가 아니다. 그 구분을 문서에 쓴다.

---

### Q-10. OpenAI 호환 API의 정본과 범위를 고정한다

**무엇을**

`localstack/backend/openaiClient.ts`(556줄) 가 강본이고 `src/backend/openaiClient.ts`(428줄)가 약본이다(Q-3).
여기에 더해:

- `.ci/rules.json` + `ci-checks.mjs` 규칙 2가 **OpenAI 비밀 키 패턴 6종**을 금지한다.
  즉 **"OpenAI 호환 API를 *호출*하는 것과 *키를 넣는 것*이 같은 저장소 규칙으로 다르게 취급된다.**
  이 비대칭을 문서에 적어야 한다.
- 원격·프록시 경유(`baseUrl`)를 **쓰는 곳과 안 쓰는 곳**이 갈라 있다.
- 스트리밍(`data:` / `[DONE]`), 오류 형태(HTTP 코드 → 메시지), 토큰 계수(`/tokenize` vs `/props`),
  절대 deadline — 4개가 정본에 따라 **다르게 동작한다.**

**어떻게**

1. Q-3으로 한 벌을 정본으로 만든다. **이 요구의 80%는 Q-3이 끝나면 자동으로 끝난다.**
2. **지원 범위를 문서로 적는다.** 표 4행:
   | 항목 | 지원 | 근거 |
   |---|---|---|
   | 로컬 `llama-server` `/v1/chat/completions` 스트리밍 | `검증됨` | `openaiClient.test.ts` 534줄 |
   | `/tokenize` | `측정 필요` | 41ms 실측이 **저장소에 없음**(2026-09-23 메모) |
   | `/props` 컨텍스트 크기 | `측정 필요` | — |
   | 원격 `baseUrl` (프록시·클라우드) | **`미측정` / `미지원` 중 하나를 명시** | — |
3. **`baseUrl` 을 미정인 상태로 두지 않는다.** 지원하면 테스트 1개, 지원 안 하면
   **에러 메시지가 "지원하지 않습니다"라고 말하게 한다.** 조용히 무시하면 안 된다.
4. 스킴 표준에서 벗어나는 behavior(무미결 tool-call, keepAlive)에는 **코드 주석으로 사유**를 남긴다.

**검증**

- `src/backend/openaiClient.test.ts` 가 정본 경로를 검증하는지 (Q-3에서 판정)
- `baseUrl` 을 정한 쪽이면 **그 근거가 되는 테스트 1개**가 있다
- 읽기 전용 3상태(§Q-11의 규칙을 이 요청에도 적용): 실패하면 HTTP 코드와 원본 응답 앞 200자를 남긴다.

**하지 말 것**

- "OpenAI 호환"이라는 말을 **마크트링 문구로 쓰지 않는다.** 위 표에 없는 것은 지원이라고 말하지 않는다.
- secret 규칙을 이 요구를 이유로 약화시키지 않는다. **`.ci/rules.json` 은 손대지 않는다.**

---

## 7. 라운드 D — 팔 수 있는 상품이 된다 (상품성)

> 상품성은 "화면이 예쁜 것"이 아니다. 이 문서 기준 **상품성 = 새 사람이 60초 안에
> 첫 대화를 하고, 무슨 일이 일어나고 있음을 설명할 수 있고, 안 되면 어디가 잘못됐는지 즉시 안다.**

### Q-11. 설치 경로를 1개로 줄인다

**무엇을**

`README ## Getting started` 는 지금 이 3개다:

```
npm install && npm run dev     ← 개발자용
npm run build && npm link      ← 지금 유일한 전역 설치법
node dist/server/index.js      ← bin이 가리키는 곳 (README에 없음)
```

`README` 안에는 **영문·한글 두 벌이 같은 내용을 중복**해서 담고 있다.

**어떻게**

1. **1개를 정한다.** 후보: `npm i -g harnesside` / `npx harnesside` / `npm link`.
   판단 근거를 2문장으로 적는다. (판단: Q-4에서 `files` 와 `prepublishOnly` 를 넣는 전제라면
   **`npm i -g`** 가 유일하게 자연스럽다. **반대 근거도 적어라** — npm registry에 못 올리는 구조면 이건 못 한다.)
2. **개발자용(`npm run dev`)은 남기되** 사용자용과 **섹션을 분리**한다.
3. README의 **영문·한글 중복을 하나로** 줄인다. 두 벌이 서로 다른 내용을 담기 시작했기 때문에
   어느 쪽이 맞는지 확인하지 않는 사람이 나온다.
4. **첫 실행에 60초 안에 필요한 것만** 위로 올린다. 그 아래에 있는 것은 아래로 내린다.

**검증**

- **깨끗한 상태에서** 한 번만: `git clone` → 문서에 적힌 설치 명령 3줄 복사 → 실행.
  **남의 컴퓨터가 아니라 새 디렉터리에서** 해본다.
- 부팅 12단계가 끝나고 창이 뜨기까지 **실측 시간**을 적는다. 기대치로 적지 않는다.
- 첫 화면에 "무엇을 하는 프로그램인지" 한 문장과 **눌러 볼 수 있는 예시**가 보인다
  (`PROMPT_UX_COMMERCIAL.md` §3.1이 이미 요구했다 — 여기서는 **설치 경로가 그 화면까지 이어지는가**만 본다).

**하지 말 것**

- 설치 스크립트(`postinstall`)로 뭘 깔지 않는다. `node-pty` 는 빌드해야 하고,
  그 전제를 README에 **정직하게** 적는다.
- `npm link` 를 "권장"으로 두면서 `npm i -g` 도 적어두지 않는다. **하나만 적는다.**

---

### Q-12. README 3,075줄을 3문서로 나눈다

**무엇을**

`README.md` 는 지금 3,075줄이고 섹션이 17개다.
그중 `## Screens`(1~147줄)는 **삭제된 제품(TUI)** 의 캡처이고,
`## Implementation status`(740~2832줄 — **2,000줄**) 는 상태 문서(`PROGRESS.md` `todo.md`)와 역할이 겹친다.
`## Skill / Rule`(2833~) · `## Hermes`(2886~) · `## CDP`(3044~) 는 각각 기능 문서다.

**어떻게**

1. **3개로 나눈다.**
   - `README.md` — **60초 시작 + 5분 둘러보기.** 지금의 **10%** 컷. 스크린샷은 **웹 IDE의 실물 캡처**.
   - `docs/VERIFICATION.md` — 지금의 검증 섹션들(터미널 감지 · 매트릭스 · persona 100 · TUI 시뮬레이션 · 테스트).
     **"무엇을 검증하지 않는가" 절을 이 문서의 첫 문단으로 옮긴다.**
   - `docs/ARCHITECTURE.md` — 구조 · 블록 규칙 · 스킬/룰 · Hermes · CDP.
2. **`## Implementation status` 2,000줄은 지운다.** 상태는 `PROGRESS.md` `todo.md` 가 정본이다.
   세 문서가 **같은 상태를 각각 말하지 않게** 한다. (Q-8의 검사 대상이 된다)
3. **각 문서에 "이 문서가 언제 마지막으로 실측했는가"**를 적는다.
   `PROMPT_IDE_CLI.md` 와 `todo.md` 가 이미 이 규칙을 쓰고 있다 — **끝에 적힌 날짜가 지는 게 아니라면 그게 이 요구의 실패다.**

**검증**

- 새 사람이 README만 읽고 실행할 수 있다 → **로컬의 새 디렉터리에서 1회 시험.**
- 세 문서에 **같은 사실이 다른 내용으로** 적힌 곳이 없다 (Q-8 검사로 확인 가능).
- **삭제한 줄 수를 적는다.** README는 줄어들어야 한다.

**하지 말 것**

- 검증 섹션을 **지우지 않는다.** "오래되어 보일까봐"가 아니라 **담을 곳을 옮기는 것**이다.
  지워진 검증은 돌아오지 않는다.
- Screenshot을 새로 **손으로 그리지 않는다.** 저장소의 스캐너(`capture-window.mjs`)로 찍는다.

---

### Q-13. `harnesside doctor` 를 "뭐가 틀렸는지" 한 명령으로 만든다

**무엇을**

`harnesside doctor`(및 `doctor --install`)가 이미 있다(`src/server/cli.ts`).
현재 확인하는 것: llama 서버 상태 · `chrome --version` · `nvidia-smi` 여유 VRAM.
그리고 **이것만**.

**어떻게**

`doctor` 가 **판정만 하고 아무것도 고치지 않는 상태**를 유지한 채, 아래를 **판정** 항목에 추가한다.
`doctor` 는 **읽기 전용**이어야 한다 — 이건 설계 규칙이 아니라 **사용자가 어느 위험을 감수하고 부르는 명령인가**다.

| 항목 | 근거/판정 | 하지 말 것 |
|---|---|---|
| **Node 버전이 `engines` 를 만족하는가** | major/minor 를 나란히 **둘 다** 출력 | 현재는 CI가 Node 22 하나만 본다(Q-9) |
| **터미널 capability** (`colorDepth` `unicode` `altScreen` `mouseSgr` `syncOutput`) | `src/localstack/tui/terminal.ts`(Q-1에서 이동) 의 `getCapabilities` 를 **재사용** | 새로 쓰지 않는다 — `README ## Terminal capability detection` 에 이미 표가 있다 |
| **감지된 단말 → 알려지지 않은 단말일 때** | 알려진 목록 / 미지원 / **판단 불가** 3가지를 구분 | 미판정을 `false` 로 쓰지 않는다 |
| **포트 상태** (7317 웹 / llama / 9222 CDP) | 각 포트: 비어 있음 / 우리가 씀 / **다른 프로그램이 씀** | 이 셋을 구분하지 않으면 §Q-4의 stale-dist 문제가 사용자에게 "모르겠다"로 보인다 |
| **`dist/` 가 `src/` 보다 오래되었는가** | `dist/` newest mtime vs `src/` newest mtime | **지금 실제로 그 상태다**(§2.2 7) — 이 한 줄이 지금 가장 값싸다 |
| **설정 파일** (`.harnesside/config.yaml` 존재 · 스키마 버전 · 비밀값 존재 여부 **값은 절대 출력 안 함**) | `src/config/contract.ts` 의 provenance 를 재사용 | 비밀을 출력하지 않는다 — `ci-checks.mjs` 규칙 2의 이유 |
| **모델 파일** (경로 존재 · 크기 · GGUF 매직) | `src/models/ggufMeta` 재사용 | — |

**검증**

- **`doctor` 가 아무것도 바꾸지 않음을 검증한다.** 부팅 전·후 파일시스템과 포트를 비교한다.
  (`doctor` 가 고치는 순간 이 요구는 실패다)
- **모르는 것은 `미확인` 으로 출력한다.** 0이나 `false` 로 채우지 않는다.
  (이 저장소 규칙이며, 게이지의 `null ≠ 0` 원칙과 같다)
- `harnesside doctor` 출력에 **사용자가 다음에 할 수 있는 행동**이 1개 이상 있다.

**하지 말 것**

- `doctor --install` 의 기존 동작(llama.cpp 빌드)을 **변경하지 않는다.**
  설치는 별개의 위험이므로 §3.6 승인 규칙의 대상이다.
- `doctor` 가 **`--fix` 를 자동으로 제안하고 실행하지 않는다.** 고치는 것은 `doctor --install` 뿐이다.

---

## 8. 하지 말아야 할 것 (13개 요구 공통 경계)

| 금지 | 이유 |
|---|---|
| **탐색기 패널 부활** | 2026-10-01 사용자 삭제 결정. 검색 결과는 대화 안 블록으로(`PROMPT_IDE_CLI.md` §7.3) |
| **레이아웃 엔진 교체** | 도킹·고정 경계·창 검사가 검증됐다. 패널 안쪽만 고친다 |
| **리본 메뉴** | 키보드 사용자에게 최악. 명령은 팔레트로 |
| **모르는 명령을 `safe` 로 통과** | `unknown` 은 **물어야 한다**. 게이트가 뚫리는 쪽이 그쪽이다 |
| **실측 안 한 것을 "동작한다"고 쓰기** | 이 저장소에서 검사기가 가장 많이 거짓말한 대상이다 |
| **새 추상화 레이어** | 이 기획서는 **삭제·통일·검증** 13개다. "레이어 추가"는 답이 아니다 |
| **`.ci/rules.json` 손대기** | secret·금지어 규칙은 손댈 이유가 이 기획서에 없다 |
| **`engineS` 를 올려서 버리기** | `engines: ">=18"` 를 좁혀서(예: `>=20`) **CI도 함께 좁히면** 그게 정보다. 아니면 건드리지 않는다 |
| **커버리지 하한선을 낮추기** | 코드를 지워 하한선을 달성하지 않는다. **하한선은 80에서 건드리지 않는다** |
| **`dist/` 를 커밋** | 커밋돼 있으면 지운다 |
| **문서 8개를 또 늘리기** | 이번에 Q-8·Q-12로 줄인다. 새 문서를 만들지 않는다 |
| **"단순하게"를 "잘못 단순하게"로 읽기** | 짧아도 **틀리면** 안 된다. 검증 없는 삭제는 요구가 아니다 |

---

## 9. 미측정 목록 (이 기획서가 판정하려고 하는 것)

> `todo.md` 규칙: **미측정 목록을 지우면 아무도 하지 않게 된다.** 조용한 실패가 가장 나쁘다.
> 이 기획서를 시작할 때 이 표를 **복사해서** 각 라운드 뒤에 갱신한다.

| # | 항목 | 2026-10-04 기준 | 관련 요구 |
|---|---|---|---|
| 1 | 실제 macOS 에서 부팅한다 | **미측정** | Q-9 |
| 2 | 실제 Windows 에서 부팅한다 | **미측정** | Q-9 |
| 3 | Node 18 / 20 / 24 에서 도는다 | **미측정** (CI는 22만) | Q-9 |
| 4 | Wayland 에서 창이 뜬다 | **미측정** | Q-9 |
| 5 | macOS 에서 한글 입력이 안 깨진다 | **미측정** | Q-9 |
| 6 | 원격 `baseUrl` 로 실제 스트리밍이 된다 | **미판정 — 미지원인지 미측정인지가 안 정해졌다** | Q-10 |
| 7 | `/tokenize` 지연이 실측 값이다 | **미측정** (2026-09-23 메모에 "41ms" 있으나 재현 못 함) | Q-10 |
| 8 | 원격 모델로 전체 흐름이 돈다 | **미측정** | Q-10 |
| 9 | 새 사람이 60초 안에 첫 대화를 한다 | **미측정** | Q-11 |
| 10 | `dist/` 를 지우고 처음부터 빌드하면 부팅한다 | **미측정** (§2.2 7 — 지금 dist 는 오래됨) | Q-4 |
| 11 | `npm pack` 산출물로 전역 설치된다 | **미측정** | Q-4 |
| 12 | 실패 경로 부팅(llama 없음)이 사용자에게 설명된다 | **미측정** (CI는 성공 경로만) | Q-5 |
| 13 | nightly CI 가 한 번이라도 실제로 돌았다 | **미측정** (`schedule:` 트리거 없음) | Q-6 |
| 14 | `verify-a11y` / `verify-i18n` 가 CI에서 3회 연속 통과 | **미측정** | Q-6 |
| 15 | 슬롯 교체 후 롤백이 실제로 된다 | **미측정** | Q-7 |
| 16 | 다중 환경 미검증 25개 케이스가 줄었다 | **미측정** (`docs/multienv-acceptance-report.md`) | Q-9 |
| 17 | 커버리지 하한선이 여전히 80이다 | **검증됨** (CI `gate` job) | Q-4 |

---

## 10. 라운드 운영 규칙

### 10.1 순서 (이 순서로만)

```
1. Q-2  (legacy-tui 제거 · 5,530줄 · 제일 쉬움 · Q-3의 전제)
2. Q-3  (backend 두 벌 → 강한 쪽 · 이식 전에 틀을 잡는다)
3. Q-1  (localstack 제거 · 11,969줄 · 가장 크다 · 그래서 뒤에)
4. Q-4  (dist 좁히기 + 배포 가능하게)      ← Q-1~Q-3 이 끝나야 산출물이 정리된다
5. Q-8  (문서-코드 드리프트 CI 게이트)      ← Q-1~Q-4 의 재발을 막는다
6. Q-5 → Q-6 → Q-7  (안정성 3건)
7. Q-9 → Q-10  (호환성 2건)
8. Q-11 → Q-12 → Q-13  (상품성 3건)        ← 1~7의 결과물을 설명해야 정확하다
```

**왜 이 순서인가**: 앞 라운드가 지면 산출물이 즉시 뒤지른다.
Q-1~Q-3 은 삭제·이동이라 이후 라운드의 실측 대상 자체를 바꾸고,
Q-4 는 그 정리를 배포 경로까지 닫고, Q-8 은 되돌아가는 것을 막는다.
**Q-9 를 Q-1 앞에 놓으면 지워진 코드에 대한 측정 결과를 쓰게 된다.**

### 10.2 한 라운드의 완료 조건

1. 요구 번호 하나만 고른다. 나머지 요구에 손대지 않는다(문서 고침 제외).
2. 라운드 전 상태를 **숫자로** 적는다(LOC · 테스트 수 · 커버리지 · `dist` 크기 · 파일 수).
3. 구현한다.
4. **5개 게이트 전부 통과** — `typecheck` `test` `build` `ci-checks` `coverage-floor --min 80`
5. 라운드 후 상태를 **같은 지표로** 적는다. **줄어든 숫자만 밑줄로.**
6. §9 미측정 표에서 **한 칸 줄었는지** 적는다.
7. **되돌리는 법** 한 줄을 PR에 적는다.

### 10.3 라운드 종료 시 갱신할 문서

`PROGRESS.md`(이 라운드의 근거·결과) · `todo.md`(남은 것) ·
`docs/VERIFICATION.md`(Q-12 이후) · `.ci/rules.json`(**결과적으로 금지어가 늘었을 때만**)

### 10.4 이 문서에 대한 자기 점검 (라운드마다 답한다)

- [ ] 내가 지운 코드는 **역시 도달 불가**함을 import 그래프 + 빌드 설정으로 **증명**했나?
- [ ] 내 삭제 때문에 **커버리지가 내려가지** 않았는가? 내려갔다면 무엇을 되돌릴 것인가?
- [ ] 내가 고친 버그가 **두 벌 중 어느 벌**에 고쳐졌나? **양쪽 다 필요한가?**
- [ ] 내가 추가한 줄이 **내가 지운 줄보다 많지** 않은가?
- [ ] 이 요구를 끝내고 **사용자가 무엇이 달라졌는지를 한 문장으로** 말할 수 있는가?
- [ ] 그 한 문장에 **검증 시각·방법**을 붙일 수 있는가?
