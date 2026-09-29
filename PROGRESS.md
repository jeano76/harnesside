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
phase: P15          # 도메인 로직과 앱 셸 완료. 남은 것은 "연결" 과 "검증 자동화"
status: in_progress
last_commit: "2c2c6da dock-driven app shell + live window verification"
next_action: "P12 §4.4 창 종료 → llama 종료 (S1~S5 각각 독립 검증). 그 다음 P14 · P15 나머지 · P16 CI"
blocking: 없음
verified_this_session:
  - "npm test → 1051 pass / 0 fail (P0 525 → ... → P3 699 → P6 800 → 셸 1051)"
  - "npm run typecheck → exit 0"
  - "npm run build → exit 0 (dist/packaged-web 10개 파일)"
  - "grep -rni llamacli → 0건 · 혼합 문자(깨진 바이트/CJK) → 0건"
  - "12단계 전부 동작, 창 열림, 콘솔 에러 0"
  - "GPU: glRenderer=Disabled · opengl=disabled_off · webgl=disabled_off"
  - "verify-window.mjs 13/13 통과 (실제 창을 CDP 로 구동해 검사)"
  - "계측 실측: CPU 7.2% · RAM 12.2% · VRAM 29.2%(2363/8192 MiB) · GPU 32%/33°C/26W"
  - "llama RSS 16.4 GiB · 컨텍스트는 0% 가 아니라 null(미측정)"
  - "보안: 무토큰 /api/metrics 401 · ../../etc/passwd 403"
  - "도킹 실측: 탐색기 → 상단 도크 클릭, 본체 행이 아래로 밀리고 중앙이 921→1181px 로 넓어짐"
```

> ⚠️ **환경: llama.cpp 워치독은 모두 off (2026-09-29)**
>
> `llama-watchdog.timer` · `llama-server-monitor.timer` · `llama-server.service` ·
> `cpulimit-llama.service` 를 모두 disabled 로 두었고 `~/.local/state/llama-watchdog` 를 지웠다.
> 그래야 "기존 llama-server 를 없애고 새로 띄운다" 를 재현할 수 있다.
>
> **그래도 조심한다**: `kill` 후 곧바로 다시 뜨는 것을 실제로 겪었다. 재현 전 반드시
> `pgrep -af llama-server` 로 확인하고, **adopt 가 아니라 새로 띄우는 것이 목적** 인 경우에만
> 죽인다(§12 결정 D: 두 번째 llama-server 는 OOM 난다 — 실측 `cudaMalloc failed`,
> 1476.55 MiB 요청에 321 MiB free).

---

## ② Phase 대시보드

상태 기호: `☐` 미착수 · `◐` 로직 완료·연결 대기 · `☑` 완료(검증 통과)

| Phase | 내용 | 상태 | 완료 검증 | 커밋 |
|---|---|---|---|---|
| **P0** | §1 복사·치환 | ☑ | `npm test` 555 pass/0 fail, `grep -rni llamacli` 0건 | `8272ad4` |
| **P1** | llama-server 부트스트랩 + §3.2 [1]~[8] | ☑ | TTY 없이 12단계, adopt 실측, SIGTERM orphan 없음 | `7bae9c1` `76eb72f` |
| **P1.5** | §3.6 보안 경계 + §6.4 설정 규약 | ☑ | 무토큰 401 · Host 위조 403 · 출처/원자적 쓰기 | `0690ccc` `8c482d3` `3efd6f8` |
| **P2** | Chrome `--app` + §4.6 VRAM 예산 + **§4.7 GPU off** | ☑ | 창 렌더 · 라운드 14px · **GPU 비활성 확인** | `1393ed4` |
| **P2.5** | §3.7 데몬 모드 + §5.12 로그 패널 | ☑ | TTY 없이 12단계 · 상한 500,000자 후 최신 유지 · `up/status/logs/down` | `7158db5` |
| **P3** | WS 허브 + 레이아웃 골격 + 입력창 | ☑ | 브라우저 입력 → 서버 수신 → WS 응답 · 12/12 스텝 live | `509d0b7` |
| **P4** | §5.6 블록 + §5.11 신규 도구 | ☑ | 블록 격리 렌더(버전/50ms) · **승인 게이트가 위험 도구 실제 차단** | `509d0b7` |
| **P5** | §5.1 에디터 + §8.2 파일 열기/저장 | ☑ | 언어 판정 · 큰 파일 처리 · **충돌 409 + 서버본문** | `a1075a6` |
| **P6** | §5.2 가로 diff | ☑ | 2열 + 문자단위 강조(원문 복원 불변식) · 3개 소스 | `db73cfe` |
| **P7** | §5.5 모니터 패널 | ☑ | 1Hz 서버 계측 · 요청당 계측 0 · rAF 보간 · 버킷 리렌더 | `1629bf4` |
| **P8** | §5.4 자석 도킹 | ☑ | 5존 판정 · 자기 진화 · 키보드 대안 · **셸이 존을 실제로 따름** | `1629bf4` `2c2c6da` |
| **P9** | §8.3 워크스페이스 이동 | ◐ | 도메인 로직+테스트 완료. **HTTP 연결·UI 미연결** | `1629bf4` |
| **P10** | §5.3 Think | ◐ | 상태 머신+테스트 완료(예산 초과 전환·2회 재시도). **UI 미연결** | `1629bf4` |
| **P10.5** | §5.10 세션 영속화 | ◐ | `SessionStore`+`planRestore` 완료. **주기적 저장 배선 미들** | `1629bf4` |
| **P11** | §7 모델 관리 | ◐ | Ornith 1순위 고정 · 멀티 다운로드 · 교체+응답확인 판정. **HF 연동 미들** | `1629bf4` |
| **P12** | §4.4 창 종료 → llama 종료 | ◐ | `watchdog.ts` S1~S6 구현·테스트. **S1~S5 각각 실측 미확인** | `509d0b7` |
| **P13** | §9.1 업데이트 + §5.13 설정 + §5.13.2 추천 | ◐ | 파이프라인·슬롯·롤백·알림 로직+테스트. **네트워크 호출·화면 미연결** | `1629bf4` |
| **P14** | §9.3 GitHub 연동 | ☐ | `gitStatus`/`gitShowHead` 만 있음. clone/pull 없음 | `db73cfe` |
| **P15** | §11.1 M1~M13 | ◐ | M2·M4·M5·M7·M11·M12·M13 도메인+셸. **M1 터미널·M3 취소 버튼·M6 자동저장 UI** | `1629bf4` `2c2c6da` |
| **P16** | §10.4 E2E + 회귀 + CI | ◐ | `verify-window.mjs` 13/13 (수동). **CI 없음** | `2c2c6da` |
| **P17** | 스타일 마감 · i18n · 접근성 | ☐ | §10.5 매트릭스 | — |

> **◐ 의 뜻**: 로직과 테스트는 통과했지만 **아직 사용자에게 보이는 경로가 없다.**
> 즉 "돌면 되지만 실행하지 않는다". 이 상태로 "완료"라 쓰지 않는다(부록 C).

---

## ③ 세부 진행 (Phase 안의 작업 목록)

### 완료된 것 (요약)

| Phase | 파일 | 핵심 |
|---|---|---|
| P2.5 | `logRing.ts` `logWatcher.ts` `daemon.ts` `cli.ts` | 500,000자 링, `bufferFull`=유실, TTY 무관 |
| P3 | `wsHub.ts` `wsClient.ts` `watchdog.ts` | seq/epoch, `sinceSeq` 재현, 50ms 비콘 |
| P4 | `blocks.ts` `approval.ts` `fs/safePath.ts` | 시작순 정렬·버전은 바뀔 때만·상한은 완료된 것부터 / 무응답=거절 / `realpath` 경로 안전 |
| P5 | `editor/model.ts` | 언어 판정, 큰 파일 **잘라서 주지 않음**, 충돌은 409+서버본문 |
| P6 | `editor/diff.ts` `editor/inline.ts` `gitDiff.ts` `fsWatcher.ts` | LCS+1:1 modify, 문자 하이라이트, `-z` 파싱, 자기쓰기 무시 |
| P7 | `shared/metrics.ts` `server/metrics.ts` `MonitorPanel.tsx` | **스냅샷 델타** CPU, 중복 계측 금지, null≠0 |
| P8 | `web/layout/engine.ts` | 5존·20% 경계·자기 진화·Alt+방향 |
| P9 | `server/workspace.ts` | 트리/baseDir/rule **원자적**, rebase, 세션 유지 |
| P10 | `web/agent/think.ts` | 기본 OFF, 상한 초과 → `tool_choice:required` |
| P10.5 | `session/store.ts` | WS 재연결≠새로고침, debounce 1s, gzip |
| P11 | `models/manage.ts` | Ornith 고정, 중단/재개, **교체≠동작** |
| P12 | `server/watchdog.ts` | S1~S6 |
| P13 | `update/pipeline.ts` `update/notify.ts` `config/schema.ts` | 해시 2중, 슬롯 3개, 부팅실패 롤백, 6섹션 근거 |
| M2·M4·M5·M7 | `web/panels/review.ts` `notify.ts` `logFilter.ts` | 검토 승인/되돌리기, 오류 자동소멸 금지, 드래프트 |
| 셸 | `web/main.tsx` | 존에서 그리드 계산, 빈 상태 채움, 입력창 1개 |
| 경계 | `shared/boundary.test.ts` | **웹←→서버 import 규칙을 기계적으로** |

---

## ④ 지금 바로 할 일 (재개 시 첫 번째 = 1번)

> **도메인 로직은 대체로 끝났다. 남은 것은 "연결" 이다.**
> 로직만 있고 실행되지 않는 것은 "있는 기능" 이 아니다. 그래서 우선순위는 **사용자에게 보이는 경로** 다.

1. **P12 — §4.4 창 종료 → llama 종료 실측.** S1~S5 를 **각각 따로** 재현한다.
   - 부호 5개 + 창 X 를 **따로** 시도하고, 매번 `pgrep -af llama-server` 로 종료 확인.
   - ⚠️ 두 번째 llama-server 는 OOM 난다(§12 결정 D). **adopt 되는 상황과 강제 종료 상황을 구분**해서 잰다.
   - daemon 모드에서는 창을 닫아도 llama 가 살아 있어야 한다 — 이게 §4.4 의 핵심이다.
2. **P9/P10/P10.5/P11/P13 연결.**
   - 워크스페이스: `/api/workspace` + 확인 다이얼로그 + 컨텍스트 경계 문장 주입.
   - think: `reasoning_content` 델타를 블록으로, 스타일 스위치, 경고 문구.
   - 세션: 블록 변화 시 `SessionStore.schedule()`, WS 재연결과 새로고침 구분해서 복원.
   - 모델: HF 검색/추천/다운로드를 실제 API 로. §5.11 토큰 비용 관리 포함(브라우저 도구 4종만 1,238 토큰 실측).
   - 업데이트: GitHub Releases 조회 + 진행 단계 UI + **지금 적용** 확인 모달(롤백 불가면 차단).
3. **P14 GitHub 연동** — clone → 파일 열기 → 커밋 → pull, **충돌 시 자동병합 없이 중단**.
4. **P15 나머지** — M1 PTY 터미널(탭 복수), M3 취소/재개 버튼, M6 편집기 자동 저장.
5. **P16** — `verify-window.mjs` 를 CI 에 넣고 스크린샷 회귀 추가. `npm test` 와 함께 돌린다.
6. 각 단계마다 `npm test` + typecheck + **실측** → 커밋 → **이 파일 갱신** → 다음.

### 이 세션에서 실제로 겪은 버그 (모두 수정·재현 확인)

| # | 증상 | 근본 원인 | 교훈 |
|---|---|---|---|
| 1 | 동일 파일 2만 줄이 "2만 줄 추가" 로 보고됨 | LCS 는 O(n·m). 동일성 검사를 안 해서 가짜 추가가 나옴 | 큰 입력에서 **가장 흔한 경우는 "같다"** 다. 먼저 확인한다 |
| 2 | 한 줄 수정이 삭제 1 + 추가 1 로 부풀고 문자 강조 대상이 사라짐 | 1:1 교체를 `modify` 로 묶지 않음 | 줄 diff 의 기본 단위는 **1:1 교체** 다 |
| 3 | "del del add" 에서 삭제 하나가 사라짐 | del 묶음을 **한 줄씩** 판단해서 뒤 del 을 add 와 짝지음 | 연속 구간은 **묶음 단위** 로 판단한다 |
| 4 | modify 짝을 만들고 나면 다음 짝을 건너뜀 | 짝짓고 인덱스를 1만 증가 | 쌍 소비량을 정확히 이동한다 |
| 5 | 수정 1건이 "변경 2건" 으로 표시됨 | modify **짝 2줄** 을 줄 수로 셈 | 통계는 사람이 세는 단위로 센다(1쌍=1건) |
| 6 | 승인 게이트의 화이트리스트가 **세션을 넘어 남음** | 기본 정책 `{...DEFAULT}` 얕은 복사 → 배열 참조 공유 | 중첩 값은 **반드시 복사**한다(§6.4 와 같은 계열) |
| 7 | 승인 타임아웃이 아예 발화하지 않음 | 타이머 `unref` → 이벤트 루프가 먼저 끝남 | "진짜로 기다리는 중" 은 루프를 붙잡아야 한다 |
| 8 | 파일명 개행/따옴표에서 **엉뚱한 파일의 diff** 를 검토하게 됨 | `git status` 를 개행 파싱 | 경로가 깨지면 **조용히 틀린 것** 을 보여준다 |
| 9 | 웹 번들이 **빌드 실패** | UI 가 서버 모듈에서 `severity` 를 값 import → `node:child_process` 따라옴 | 공유 로직은 `shared/`(import 0개)에 둔다 |
| 10 | 로그 필터의 `LogEntry` 가 서버와 **모양이 달랐음** | 웹에서 같은 인터페이스를 다시 정의 | 정본은 **한 곳**(`logRing`)이다 |
| 11 | 패널이 "오른쪽 도크" 라고 적혀 있는데 **화면은 중앙** | 셸이 고정 그리드로 그리고 도킹 엔진 무시 | **라벨이 거짓말을 하는 배치가 엔진보다 나쁘다** |
| 12 | 검증 스크립트가 **이전 실행의 탭** 을 붙잡음 | 새로고침 없이 붙음 | 서버가 새로 떴으면 화면도 새로 떠야 검증된다 |
| 13 | GPU 비활성을 못 확인 | `WebGL.getParameter` 는 GPU off 일 때 **undefined** | undefined 를 "켜짐" 으로 읽으면 반대로 보고한다 |
| 14 | `SystemInfo` 가 빈 값으로 옴 | **브라우저 수준** 도메인을 **페이지** 타깃에 연결 | "값이 없음" 과 "아직 안 채워짐" 을 구분한다 |
| 15 | 입력창이 **두 개** 보임 | 조건이 "중앙 또는 에이전트 열" 이라 두 열 모두에서 렌더 | 하나는 **정확히 한 곳** 이어야 한다 |
| 16 | 패널 머리에 `editor` 라는 원문 id 노출 | 타이틀 맵에 `editor` 누락 | 내부 식별자는 UI 에 못 나온다(§5.8) |
| 17 | `src/setup/tuning.ts` 를 **덮어씀** | 이미 있는 모듈을 같은 이름으로 생성 | 기존 파일을 **먼저 확인**한다. 중복 정본이 가장 비싸다 |
| 18 | `npm run build` 가 실패 — `pack-web-assets.mjs` 없음 | 스크립트를 참조하는데 안 만들었다 | build 는 **끝까지** 돌려 본다 |
| 19 | 그 스크립트가 존재하지 않는 경로를 읽음 | `p.slice()` 로 상대경로 조립 | 상대경로는 `join` 으로 만든다 |
| 20 | 정상 코드(`/api/...`)가 비밀 검사에서 걸림 | 금지 대상이 **경로** 가 아니라 **값** 이었다 | 검사를 **위협 모델** 에 맞춘다 |
| 21 | P12 시그널 검증에서 **3개가 거짓 실패** (S2·S5 "안 죽음", S4 "죽음") | 판정을 `pgrep -f /llama-server` 로 했다 — **검증 셸 자신** 을 잡아 세 결과가 뒤집혔다(포트 8080 은 비어 있었다) | "살아 있는가" 의 판정 기준을 **리소스**(포트/HTTP)로 정한다. 프로세스 **이름** 은 위장된다 |
| 22 | 저장소에 옛 이름 빌드 산출물(`bin/llamacli-dist.tar.gz`) 추적 중 | 포크에서 넘어옴. 치환 불변식을 위반하고 빌드 산출물이라 이유가 없음 | publish 전에 **무엇이 올라가는지** 본다 |
| 23 | `doctor` 가 `/home/jeano/llama.cpp/...` 하드코딩 | 같은 탐색 규칙이 `findLlamaServer` 에 이미 있었는데 중복 구현 | 진단 도구와 부팅 경로는 **같은 규칙** 을 쓴다 |

---

## ⑤ 환경 사실 (재측정 불필요 · 2026-09-29 실측)

- GPU: **RTX 2070 SUPER 8192 MiB**. llama-server 가 7278 MiB 를 쥐었을 때 남는 게 285 MiB.
  → 그래서 **브라우저 GPU 기본 off** (결정 D1). `--disable-software-rasterizer` 는
  `--disable-gpu` 와 함께야 한다(D2, 안 그러면 SwiftShader 가 살아남는다).
- RAM 32 GiB · CPU **12코어**(부팅 로그 기준) · DISPLAY `:0` · Node v22.22.1.
- Chrome 153.0.8010.52 · 포트 8080(llama) / 7317(IDE) / 9222(CDP).
- 모델: `/media/jeano/nvme-usb/models/` — Ornith-1.5-35B-A3B-Q3_K_XL 외 Q5_K_M/Q4_K_M/IQ3_M.
- llama.cpp: `/home/jeano/llama.cpp/build-opt/bin/llama-server`.
- `/` 여유 ≈ 10.1 GiB (실측). Chrome RSS 1.54 GiB → 로그 상한 50만 자는 힙 ~1 MiB (결정 D4).

---

## ⑥ 결정 기록

- **D1** 브라우저 GPU 기본 `off` — 실측 free VRAM 285 MiB.
- **D2** `--disable-software-rasterizer` 는 `--disable-gpu` 와 함께.
- **D3** `window` 모드가 기본(요구 9). `daemon` 은 명시적 opt-in.
- **D4** 로그 상한 500,000자 / 50,000줄 / 8 KiB/줄 — 한 세션 분량.
- **D5** P2.5(데몬+로그)를 P3(WS) **직전**에 두었다 — WS 허브가 처음 생길 때 `log.append` 를
  한 줄로 붙이는 게 retrofit 보다 싸다.
- **D6** E2E 는 CI 에서. GPU off 라 렌더링이 결정적이라 실행해도 무해하다.
- **D7** `git init` 은 새로. 원본 `.git` 은 가져오지 않았다.
- **D8** **adopt, never re-spawn** — 두 번째 llama-server 는 OOM 난다(실측).
- **D9** 토큰은 **데이터**(`/api/*`)만 지킨다. 앱 셸 자산에 요구하면 백 화면.
- **D10** 검색은 로그 레벨 하한을 `debug` 로 **완화**하고 UI 에 "검색 중: debug 포함" 으로 말한다.
- **D11** `bufferFull` 은 "상한 접촉" 이 아니라 **"뭔가 실제로 유실"** 이다.
- **D12** 공유 로직은 `src/shared/`(import 0개). 서버 모듈에서 웹이 **값** 을 가져오면 Node 가 따라온다.
- **D13** 자동 설치는 env 로도 켤 수 없다(`envOverridable: false`). 스크립트에 남은 값 하나가
  IDE 를 자동 재시작시키면 실패했을 때 돌아갈 곳이 없다.
- **D14** 자동 업데이트 설치는 **기본 꺼짐**. 롤백 슬롯을 못 만들면 **시도 자체를 막는다**.
- **D15** 원격 저장소 이름 = `jeano76/harnesside`. push 전에 확인한 것:
  추적된 파일에 `state/token.json`·`.env` 없음 · 민감 파일 없음 · `grep -rni 옛이름` 0건.
  `PROMPT.md` 의 옛 이름 언급은 **상위 프로젝트 참조**라 유지(제품명 아님).

---

## ⑦ 실측 기록 (성능·환경·버그)

- CPU 사용률은 **스냅샷 델타**. 한 스냅샷의 `1-idle/total` 은 부팅 이후 평균이라
  조용한 서버가 0% 로 보이고 3초 전 버스트가 사라진다.
- 계측은 **서버 1Hz 1회**. `/api/metrics` 는 마지막 샘플만 돌려준다(요청당 계측 금지).
  `nvidia-smi` 실행만으로 100~300ms 걸린다.
- 실측 계측값: CPU 7.2% · RAM 12.2% · VRAM 29.2%(2363/8192 MiB) · GPU 32%/33°C/26W ·
  llama RSS 16.4 GiB. **컨텍스트는 null**(미측정) — 0% 가 아니다.
- 도킹 실측: 탐색기 → 상단 도크 클릭 시 본체 행이 y=35 → y=395 로 밀리고,
  중앙 열이 921 → 1181px 로 넓어진다(좌측 열이 사라지므로).
- `verify-window.mjs` 13/13: 마운트됨 · 로그 패널 상시 · WS open · GPU Disabled ·
  토큰 URL 없음 · 빈 상태 채움 · 콘솔 에러 0 · 라벨↔위치 일치 · 내부 id 미노출.

---

## ⑧ 열린 이슈 / 블로커

**없음.** 다만 다음을 반드시 기억한다:

- **P12 1차 실측에서 검증기 자신이 세 번 거짓말을 했다** (§④ 표 21 참조).

- `llama-server` 를 **새로 띄우려면** 기존 것을 죽여야 한다(포트 8080 사용 중).
  죽이면 watchdog 이 되살릴 수 있다 — 유닛은 off 였지만 **실제로 한 번 되살아난 적이 있다**.
- 창을 닫으면 llama 가 죽는다(§4.4). 살아 있는 상태로 다루려면 `--daemon`.
- 검증은 `rm -f .harnesside/state/instance.lock` 후 기동, 약 70초 대기(모델 로딩).

---

## ⑨ 변경 이력 (커밋 로그)

| 커밋 | 내용 |
|---|---|
| `0d70467` | 첫 push — `jeano76/harnesside`, 205개 파일, 민감 파일 0 |
| `2c2c6da` | 도킹 기반 앱 셸 + `verify-window.mjs` 13/13 (실측) |
| `55f7c03` | 주석 혼합 문자 수정 |
| `1629bf4` | P7~P13 + M1~M5 도메인 로직과 앱 셸 |
| `db73cfe` | P6 가로 diff(문자 강조, 3개 소스) |
| `a1075a6` | P5 에디터 도메인 + 경로 안전 파일 API |
| `dd5b620` | 주석 혼합 문자 수정 |
| `509d0b7` | P3 WS 허브 + P4 블록 + 승인 게이트 |
| `7158db5` | P2.5 로그 링(500k) + 데몬 명령 + 로그 패널 |
| `90b451c` | PROGRESS.md P2 기록 |
| `1cc00a4` | PROGRESS.md P1.5 기록 |
| `1393ed4` | P2 vite 골격 + 브라우저 플래그(GPU off) |
| `3efd6f8` | lateSteps 가 `{ result }` 받음, `/api/gpu` `/api/bootstrap` |
| `8c482d3` | §6.4 설정 계약(병합·출처·원자적 쓰기·마이그레이션) |
| `0690ccc` | P1.5 토큰 + Origin/Host 가드 |
| `76eb72f` | 데몬 엔트리포인트, `LlamaLauncher`, adopt |
| `7bae9c1` | 12단계 부팅 상태 기계, `decideGpuMode()` |
| `8272ad4` | P0 llamacli→harnesside 치환 |
| `0a31e35` | fork + PROMPT.md + PROGRESS.md |
