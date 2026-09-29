# harnesside — 구현 진행 기록 (재개용)

> **이 파일이 재개 지점이다.** 새 세션/재시작이 발생하면 **이 파일을 먼저 읽고**
> "④ 지금 바로 할 일" 의 첫 항목부터 이어서 실행한다. 다른 문서보다 **이 파일이 우선**이다.
>
> 규칙:
> 1. **작은 단위로 커밋하고, 커밋 직후 이 파일을 갱신한다.** 커밋은 `feat|fix|refactor|test|docs(scope): 요약` 형식.
> 2. 이 파일의 상태는 **실제로 확인한 것만** 적는다. 추정으로 "완료"를 쓰지 않는다(부록 C 규칙).
> 3. 막히면 "열린 이슈"에 원인과 우회로를 적고, **다음에 시도할 것**을 명시한다.
> 4. 커밋 SHA 를 적어두면 `git log`/`git show` 로 그 시점 상태를 그대로 복원할 수 있다.

---

## ① 현재 상태 (마지막 갱신: 2026-09-29)

```yaml
phase: P2.5          # 현재 Phase (P0 · P1 · P1.5 · P2 완료)
status: not_started
last_commit: "P2 커밋 (아래 ⑨ 참조)"
next_action: "P2.5 §3.7 데몬 명령계(up/down/status/logs/open) + §5.12 로그 싱글턴(logRing.ts)"
blocking: 없음
verified_this_session:
  - "npm test → 638 pass / 0 fail (P0 525 → P1 +30 → P1.5 +40 → P2 +43)"
  - "npm run typecheck → exit 0 · tsc -p tsconfig.server.json → exit 0"
  - "grep -rni llamacli → 0건 · 깨진 문자 → 0건"
  - "12단계 1~11 실제 동작 (12=P3), 데몬 TTY 없이"
  - "Chrome 창 실측: 본문 954자 · 제목 harnesside · border-radius 14px · 콘솔 에러 0"
  - "토큰이 URL 에서 제거됨: location.href = http://127.0.0.1:7317/ (token 없음)"
  - "GPU: glRenderer=Disabled · opengl=disabled_off · nvidia-smi 에 chrome 항목 없음"
  - "보안: 토큰 없는 /api/gpu → 401 · Host 위조 → 403 · 경로 탈출 내용 새지 않음"
```

> ⚠️ **환경 변경 (개발 착수 시 반드시 알아야 할 사실)**: 이 머신에는 `llama-server.service`
> (systemd user) 가 llama.cpp 를 **자동 재시작**한다. `kill` 로 멈춰도 몇 분 안에 다시 뜬다.
> harnesside 를 개발하려면 먼저 아래를 실행해 VRAM 을 비워야 한다.
> 되돌리기: `systemctl --user enable --now llama-server.service cpulimit-llama.service`
>
> ```bash
> systemctl --user disable --now llama-server.service cpulimit-llama.service
> ```
```


> ⚠️ **환경 변경 (개발 착수 시 반드시 알아야 할 사실)**: 이 머신에는 `llama-server.service`
> (systemd user) 가 llama.cpp 를 **자동 재시작**한다. `kill` 로 멈춰도 몇 분 안에 다시 뜬다.
> harnesside 를 개발하려면 먼저 아래를 실행해 VRAM 을 비워야 한다.
> 되돌리기: `systemctl --user enable --now llama-server.service cpulimit-llama.service`
>
> ```bash
> systemctl --user disable --now llama-server.service cpulimit-llama.service
> ```

## ② Phase 대시보드

상태 기호: `☐` 미착수 · `◐` 진행중 · `☑` 완료(검증 통과) · `⨯` 중단

| Phase | 내용 | 상태 | 완료 검증 | 커밋 |
|---|---|---|---|---|
| **P0** | §1 복사·치환. 이식 모듈 빌드/테스트 통과 | ☑ | `npm test` **555 pass/0 fail**, `grep -rni llamacli` **0건**, typecheck exit 0 | `8272ad4` |
| **P1** | llama-server 부트스트랩 + §3.2 [1]~[8] | ☑ | TTY 없이 12단계 통과, adopt 실측 확인, SIGTERM 종료·orphan 없음 | `7bae9c1` `76eb72f` |
| **P1.5** | §3.6 보안 경계(토큰·Origin/Host·HTTP) + §6.4 설정 규약 | ☑ | 토큰 없는 API 401 · Host 위조 403 · 0600 · 출처/원자적 쓰기 테스트 | `0690ccc` `8c482d3` `3efd6f8` |
| **P2** | Chrome `--app` + §4.6 VRAM 예산 + **§4.7 GPU off 정책** | ☑ | 창 렌더 954자 · 라운드 14px · **GPU 비활성 확인됨** · 토큰 URL 제거 | `1393ed4` |
| P2.5 | **§3.7 데몬 모드 + §5.12 로그 패널** | ☐ | TTY 없이 12단계 부팅, 상한 500,000자 후 최신 줄 유지 | — |
| P3 | WS 허브 + 레이아웃 골격 + 입력창 | ☐ | 브라우저 입력 → 서버 수신 → WS 응답 | — |
| P4 | §5.6 블록 스트림 + §5.11 신규 도구 | ☐ | 블록 격리 렌더, 승인 게이트 실제 차단 | — |
| P5 | §5.1 Monaco + §8.2 파일 열기/저장 | ☐ | 하이라이트·접기·저장 반영 | — |
| P6 | §5.2 가로 diff | ☐ | 2열 + 문자단위 강조 | — |
| P7 | §5.5 모니터 패널 | ☐ | 1초 갱신 + 프레임 예산 | — |
| P8 | §5.4 자석 도킹 | ☐ | 5존 드래그, 저장/복원, 키보드 대안 | — |
| P9 | §8.3 워크스페이스 이동 | ☐ | 트리·baseDir·rule 재로드 전부 변경 | — |
| P10 | §5.3 Think 애니메이션 | ☐ | 예산 초과 시 자동 전환 | — |
| P10.5 | §5.10 세션 영속화 | ☐ | 새로고침 후 통째로 복원 | — |
| P11 | §7 모델 관리 | ☐ | Ornith 1순위 고정 → 검색 → 다운로드 → 교체 → 재기동 | — |
| P12 | §4.4 창 종료 → llama 종료 | ☐ | S1~S6 각각 독립 검증 | — |
| P13 | §9.1 업데이트 + **§5.13 설정/업데이트 화면** + **§5.13.2 추천 알림** | ☐ | 롤백 동작, HF·llama 알림 | — |
| P14 | §9.3 GitHub 연동 | ☐ | clone→열기→커밋→pull, 충돌 시 중단 | — |
| P15 | §11.1 M1~M13 | ☐ | 각 인수 기준 통과 | — |
| P16 | §10.4 E2E + 스크린샷 회귀 + CI | ☐ | E2E 그린, 콘솔 에러 0, GPU assert 통과 | — |
| P17 | 스타일 마감 · i18n · 접근성 | ☐ | §10.5 매트릭스 전 항목 | — |

## ③ 세부 진행 (Phase 안의 작업 목록)

### P0 — 복사·치환 ☑ 완료
- [x] P0-0 원본에서 소스 복사 (`src/ scripts/ bin/ docs/` + 설정 파일). `.git`·`.llamacli`·`node_modules`·`dist` 제외
- [x] P0-1 식별자 일괄 치환 — `scripts/rename-identifiers.mjs` (**토큰 단위 파서** 사용: 문자열/줄주석/블록주석을 구분해 치환, §1.2 의 `*` 함정 회피).
      규칙 순서 `LLAMACLI_`→`Llamacli`→`llamacli` (대소문자 변형 누락 방지 — 검출이 `grep -ni` 라 함).
      자기 자신·`PROGRESS.md` 는 제외(규칙 문자열/원본 프로젝트 참조 보존). `.py` 포함.
- [x] P0-2 `package.json` 개편 — name/bin(`dist/server/index.js`)/scripts(§1.5)/의존성 재편
- [x] P0-3 `src/tui/*` + `src/index.tsx` → `src/legacy-tui/` 격리. 상대 import 경로 교정(`scripts/fix-legacy-tui-imports.mjs`).
      `tsconfig.server.json` 에서 제외. **legacy-tui 는 빌드 대상이 아니지만 테스트는 계속 돈다**(ink 를 devDependency 로 유지)
- [x] P0-4 `npm install` — 신규: `ws`(dependency 로 승격), `chokidar`, `react-dom`, `vite`, `@vitejs/plugin-react`, `concurrently`; `monaco-editor` 는 optionalDependency(§1.5 lazy load)
- [x] P0-5 `npm test` → **525 pass / 0 fail** (이식 검증 게이트 통과)
- [x] P0-6 `npm run typecheck` → exit 0 · `tsc -p tsconfig.server.json --noEmit` → exit 0
- [x] P0-7 `grep -rni llamacli src scripts package.json tsconfig.json README.md .gitignore` → **0건**

> **P0 에서 배운 것(재발 방지)**: `ink` 를 dependencies 에서 지우면 legacy-tui 테스트 20여 개가
> import 에서 죽는다. **격리는 삭제가 아니다** — devDependency 로 남겨 검증을 보존한다.
> `LlamacliConfig` 같은 대문자 변형을 놓치면 `grep -ni` 게이트가 통과해 버린다(치환 스크립트가 규칙 3줄).

### P1 — llama-server 부트스트랩 ☑ 완료
- [x] P1-1 `src/server/bootstrap.ts` 12단계 상태 머신. `STEP_NAMES` 를 **export** 하여 §3.2 와 이름/순서 일치를 테스트가 지킨다.
      단계 9~12 는 `pending: true` 로 "지났습니다"라고 말하지 않는다. 각 단계 `tookSeconds` 기록.
- [x] P1-2 하드웨어/GPU 정책 — `src/setup/gpuPolicy.ts` `decideGpuMode()`. 이식 모듈 `detectHardware()` 가 이미
      **실측 `vramFreeBytes`** 를 제공하므로 재작업 불필요(재작업하면 두 진실원이 생긴다). `off` 모드의 rationale 에 **측정 근거** 를 실어 둠.
- [x] P1-4 포트 계획 2종 — `IDE_PORT=7317` 추가, llama 포트와 **절대 겹치지 않도록**(겹치면 "런처 버그"로 오인된다)
- [x] P1-3 llama-server **스폰 + 헬스체크** — `src/server/llamaLauncher.ts`(`buildLlamaArgs()` 순수 함수 + 프로세스 수명/로그 tee/우아한 종료) + `src/server/index.ts` 엔트리포인트
- [x] P1-5 "웹 없이" 기동 확인 — TTY 없이 12단계 통과. `HARNESSIDE_MODELS_DIR=/media/jeano/nvme-usb/models` 로 실모델 사용

### P1 에서 발견한 버그 2건 (둘 다 수정·재확인 완료)

| # | 증상 | 근본 원인 | 수정 | 재발 방지 |
|---|---|---|---|---|
| 1 | 부팅이 즉시 "이미 실행 중" 으로 실패 | `index.ts` 와 `bootstrap()` 단계 1 이 **둘 다 락을 획득** → 자기 자신의 락을 남의 것으로 판단 | `BootstrapDeps.lock` 로 이미 잡은 락을 전달. 획득은 한 곳만 | 코드 주석에 사유 + 단일 획득 원칙 |
| 2 | SIGTERM 후 **orphan llama-server** 가 8081 에 남음 | `process.on('exit')` 는 비동기 종료 절차를 못 돌린다 → 자식 정리 전에 부모가 끝남 | 동기 `exit` 훅에서 자식 PID 를 **SIGKILL** + `uncaughtException` 처리 추가 | 실측으로 orphan 0 확인(사용자 원본 서버 무손상) |

> **배운 것**: 자식 프로세스를 스폰하는 프로그램은 **부모가 어떻게 죽든** 자식이 안 남는 경로가
> 하나는 있어야 한다. `detached: false` 는 SIGTERM 에는 도움 되지만 강제 종료에는 모자라다.

### P1 실측 결과 (개발 머신 — 재측정 불필요)

- 두 번째 llama-server 스폰 → **`cudaMalloc failed: out of memory`** (1476.55 MiB 요청, free 321 MiB).
  → **adopt 경로(§6.2)는 이 머신에서 선택이 아니라 필수다.** 8080 은 사용자의 서버가 점유 중이라
  플래너가 8081 로 이동시켰고, 그 8081 이 OOM 했다. "가용 포트를 찾으면 그곳에 스폰" 은 이 환경에서 틀렸다.
- llama 가 죽어도 **서버는 살아 있고** "창은 계속 뜹니다" 를 보고했다 → **degrade 원칙이 실제로 작동**.
- SIGTERM → 체크포인트 → llama 종료 → 락 해제 순서 동작, orphan 0.

## ④ 지금 바로 할 일 (재개 시 첫 번째 = 1번)

> **P2 가 끝났다. 다음은 P2.5(데몬 명령계 + §5.12 로그 패널).**
> P2.5 는 P3(WS 허브) **직전**에 두는 게 가장 싸다 — WS 허브가 처음 생길 때
> `log.append` 를 한 줄로 붙이는 것과 나중에 모든 이벤트에 로깅을 retrofit 하는 것은
> 작업량이 10배 차이 난다(§12 순서 경고 3).

1. **P2.5-1 `src/server/logRing.ts`** — NDJSON 로그 싱글턴 + 상한 링(§5.12.2).
   기본값: **500,000자 / 50,000줄 / 8 KiB 한 줄 절단**.
   검증(유닛): 상한 초과 시 **오래된 것만** 버리고 **최신 줄은 절대 안 사라짐** ·
   `sinceSeq` 재현 · 멀티바이트 문자 수 · 파싱 실패 줄 격리.
2. **P2.5-2 `src/server/logWatcher.ts`** — `llama-server`/`chrome` 자식 로그를 링으로 tee.
   지금 `index.ts` 의 `onLine` 이 곧 이 역할하므로 그 자리에 꽂는다.
3. **P2.5-3 `harnesside` 명령계** — `up` `up -d` `open` `status` `logs [-f]` `down` `doctor`(§3.7.4).
   검증: CI 에서 `up -d && status && down` 이 TTY 없이 통과(§10.3).
4. **P2.5-4 로그 패널 UI** — `src/web/panels/LogPanel.tsx`. 가상 스크롤 필수(§5.12.3).
   필터(소스 3종/레벨/검색) + "잘렸습니다" 배너 **1회만** + 자동 스크롤 토글.
5. 각 단계마다 `npm test` + typecheck → 커밋 → **이 파일 갱신** → 다음 항목.
6. P2.5 다음은 **P3(WS 허브 + 레이아웃 골격 + 입력창)**. 그때 로그 링을 WS 로 내보낸다.

### P2 에서 실제로 겪은 버그 5건 (모두 수정·재현 확인)

| # | 증상 | 근본 원인 | 교훈 |
|---|---|---|---|
| 1 | "브라우저 바이너리를 찾지 못했습니다" (설치는 되어 있음) | 기본 `exists` 가 `access()` 의 성공(`undefined`)을 **없음** 으로 읽음 | 성공/실패를 분기로 표현한다 |
| 2 | GPU 비활성 **미확인** 으로 오판 | GPU 정보가 **초기화 중에는 빈 값** — 한 번 읽고 결론 | "판정 불가" ≠ "켜져 있음". 재시도 |
| 3 | 창은 떴는데 빈 화면 | 서버가 **정적 자산을 서빙하지 않음** → `/` 404 → 앱 미실행 → 토큰도 안 지워짐 | "창이 떴다" 와 "내용이 나온다" 는 다르다 |
| 4 | (3 이어서) 토큰이 URL 에 남음 | 정적 자산에도 토큰 요구 → HTML 은 `?t=` 로 뜨지만 **그 JS 는 401** | 토큰은 **데이터**(`/api/*`)를 지킨다, 앱 셸은 아니다 |
| 5 | 없는 JS 자원이 403 | "루트 밖" 과 "파일 없음" 을 구분하지 않음 | 상태를 구분해서 표현한다 |

## ⑤ 환경 사실 (재측정 불필요 · 2026-09-29 실측)

| 항목 | 값 |
|---|---|
| 머신 | RTX 2070 SUPER **8192 MiB** / RAM 32 GiB / Linux (DISPLAY `:0`) |
| llama.cpp | `/home/jeano/llama.cpp` , 빌드: `/home/jeano/llama.cpp/build-opt/bin/llama-server` (기동 중, 7278 MiB 점유) |
| 모델 | `/media/jeano/nvme-usb/models/Ornith-1.5-35B-A3B-{Q5_K_M,Q4_K_M,Q4_K_S,Q3_K_XL,IQ3_M}.gguf` (외장 볼륨) |
| Chrome | `/usr/bin/google-chrome` **153.0.8010.52** |
| Node / npm | **v22.22.2** / 9.2.0 |
| 원본 설정 참고 | `/home/jeano/llamacli/.llamacli/config.yaml` (baseUrl 8080, model 위 경로) |
| GPU 정책 실측 | GPU off 플래그 시 VRAM **+10 MiB**, `nvidia-smi` 에 chrome 항목 없음, `glRenderer: "Disabled"` → **기본 모드 `off`** |
| 디스크 | `/` 여유 **11 GiB** (91% 사용). **모델 복사 금지** — 경로만 참조 |

## ⑥ 결정 기록

| # | 결정 | 이유 | 날짜 |
|---|---|---|---|
| D1 | **브라우저 GPU 기본값 `off`** | 카드 8192 MiB 중 llama-server 가 7278 MiB 점유(free 285 MiB). 실측 근거 §4.7.1 | 2026-09-29 |
| D2 | **`--disable-software-rasterizer` 를 `off` 세트에 반드시 포함** | 이게 없으면 GPU 를 꺼도 SwiftShader 가 살아 GPU 프로세스가 남는다(실측 대조군) | 2026-09-29 |
| D3 | **설정 불변 조건 10개 유지**(창 닫으면 llama 종료) | `daemon` 모드는 **명시적 opt-in 예외**로만 허용. 기본값은 바꾸지 않는다 | 2026-09-29 |
| D4 | **로그 상한 500,000자** | "한 세션 분량" + 프로세스 RSS 대비 무시 가능(Chrome 전체 1.54 GiB 중 1 MB 미만) | 2026-09-29 |
| D5 | **P2.5(데몬+로그)를 P3 직후에 배치** | WS 허브가 처음 생길 때 `log.append` 를 넣는 게 retrofit 보다 10배 싸다 | 2026-09-29 |
| D6 | E2E 를 **PR 에서 실행** | GPU off 로 software render → 결정적. 기존 "GPU 의존 불안정" 근거가 사라짐 | 2026-09-29 |
| D7 | 원본 `.git` 이력을 **가져오지 않고** 새로 `git init` | 원본 remote 제거 요구 + 원본은 읽기 전용 유지 | 2026-09-29 |

## ⑦ 실측 기록 (성능·환경·버그)

| 날짜 | 항목 | 측정값 | 방법 |
|---|---|---|---|
| 2026-09-29 | Chrome GPU off 시 VRAM | 7499 → 7509 MiB (**+10**) | `nvidia-smi` 기동 전후 |
| 2026-09-29 | Chrome GPU off 시 프로세스 | 16개, 총 RSS **1.54 GiB** | `pgrep`+`ps` |
| 2026-09-29 | GPU off 판정 | `glRenderer="Disabled"`, `webgl="disabled_off"` | CDP `SystemInfo.getInfo` |
| 2026-09-29 | GPU on(대조군, 헤드리스) | `ANGLE (…SwiftShader…)`, `webgl="unavailable_software"` | 동일 방법 |
| 2026-09-29 | `--disable-vulkan` | Chrome 153 바이너리에 **해당 스위치 없음** | `strings` 검색 |
| 2026-09-29 | llama-server 점유 VRAM | 7278 MiB / 8192 MiB | `nvidia-smi --query-compute-apps` |
| 2026-09-29 | **두 번째 llama-server 스폰 결과** | **`cudaMalloc failed: out of memory`** (1476.55 MiB 요청 / free 321 MiB) | 실제 스폰 후 자식 로그 |
| 2026-09-29 | adopt 경로 필요성 | OOM 이 실측되었으므로 8080 의 기존 서버를 **채택**하는 것이 필수 | 위 항목의 귀결 |
| 2026-09-29 | 데몬 부팅 (TTY 없음) | 12단계 전부 기록, 1~8 실제 동작, 9~12 `pending` | `tsx src/server/index.ts --no-browser` |
| 2026-09-29 | 포트 자동 이동 | 8080 점유(사용자 서버) → **8081 로 이동 + 사유 기록** | 단계 6 로그 |
| 2026-09-29 | SIGTERM 종료 | 체크포인트 → llama 종료 → 락 해제, **orphan 0** | `pgrep` / 로그 확인 |

## ⑧ 열린 이슈 / 블로커

| # | 이슈 | 영향 | 상태 | 다음 시도 |
|---|---|---|---|---|
| — | 없음 | — | — | — |

## ⑨ 변경 이력 (커밋 로그)

| # | 커밋 | 내용 | 검증 |
|---|---|---|---|
| 1 | `0a31e35` | `chore: fork from llamacli` + PROMPT.md 명세 + **PROGRESS.md 재개 원장** | 파일 114개 커밋 |
| 2 | `8272ad4` | `refactor!: rename llamacli → harnesside, isolate TUI as legacy-tui` | `npm test` 525/0 · typecheck 0 · grep 0 |
| 3 | `7bae9c1` | `feat(server): 12단계 부트스트랩 + GPU 정책 결정 + 2포트 계획` | `npm test` **544**/0 (+19) · typecheck 0 |
| 4 | `76eb72f` | `feat(server): 데몬 엔트리포인트 + llama 런처 + adopt 경로` | `npm test` **555**/0 · TTY 없이 12단계 · SIGTERM orphan 0 |
| 5 | `0690ccc` | `feat(auth): 토큰 + Origin/Host 가드 + 토큰 필수 HTTP 서버` | `npm test` **582**/0 · curl 401/403 실측 |
| 6 | `8c482d3` | `feat(config): §6.4 설정 계약 (병합·출처·원자적 쓰기·마이그레이션)` | `npm test` **595**/0 (+13) |
| 7 | `3efd6f8` | `fix(server): lateSteps 에 결과 전달 (단계 10 이 1~9 를 볼 수 있게)` | `/api/gpu`·`/api/bootstrap` 실측 확인 |
| 8 | `1cc00a4` | `docs: P1.5 완료 기록 · llama.cpp 정지 · P2 대기열` | — |
| 9 | `1393ed4` | `feat(web,P2): vite 골격 · GPU off 플래그 단일 출처 · Chrome 기동+검증` | `npm test` **638**/0 · 창 렌더·GPU 비활성 실측 |
