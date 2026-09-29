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
phase: P0            # 현재 Phase
status: in_progress   # not_started | in_progress | blocked | done
last_commit: "(P0 착수 전 — 커밋 없음)"
next_action: "P0-1 식별자 일괄 치환 (llamacli → harnesside)"
blocking: 없음
```

## ② Phase 대시보드

상태 기호: `☐` 미착수 · `◐` 진행중 · `☑` 완료(검증 통과) · `⨯` 중단

| Phase | 내용 | 상태 | 완료 검증 | 커밋 |
|---|---|---|---|---|
| **P0** | §1 복사·치환. 이식 모듈 빌드/테스트 통과 | ◐ | `npm test` 38개 파일 통과, `grep -r llamacli` 0 | — |
| P1 | llama-server 부트스트랩 + §3.2 [1]~[8] | ☐ | 웹 없이 기동, `/v1/models` 200 | — |
| P1.5 | §3.6 보안 경계 + §6.4 설정 규약 | ☐ | §10.3.1 보안 시나리오 전부 통과 | — |
| P2 | Chrome `--app` + §4.6 VRAM 예산 + **§4.7 GPU off** | ☐ | 창 뜸, 라운드 확인, 30분 무 OOM, `glRenderer==="Disabled"` | — |
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

### P0 — 복사·치환
- [x] P0-0 원본에서 소스 복사 (`src/ scripts/ bin/ docs/` + 설정 파일). `.git`·`.llamacli`·`node_modules`·`dist` 제외
- [ ] P0-1 식별자 일괄 치환: `llamacli`→`harnesside`, `LLAMACLI_*`→`HARNESSIDE_*`, `.llamacli/`→`.harnesside/`
- [ ] P0-2 `package.json` 개편 (name/bin/scripts/deps, §1.5)
- [ ] P0-3 `src/tui/*` → `src/legacy-tui/` 격리 (§1.4)
- [ ] P0-4 `npm install` (신규 의존성: ws, chokidar, monaco, vite, react-dom)
- [ ] P0-5 `npm test` 38개 파일 통과 확인 (이식 검증의 핵심 게이트)
- [ ] P0-6 `npm run typecheck` 통과
- [ ] P0-7 `grep -rni llamacli` 결과 0 확인

### P1 — llama-server 부트스트랩
- [ ] P1-1 `src/server/` 뼈대 + 부트스트랩 12단계 상태 머신 (§3.2)
- [ ] P1-2 하드웨어 탐지 확장 (실측 free VRAM)
- [ ] P1-3 llama-server 기동 + `/v1/models` 헬스체크
- [ ] P1-4 `tsconfig.server.json` 분리

## ④ 지금 바로 할 일 (재개 시 첫 번째 = 1번)

1. **P0-1 식별자 일괄 치환.** `node` 스크립트로 **토큰 단위** 치환(§1.2 주의: 정규식 `*` 를 주석에 쓰면 블록 주석이 조기 종료됨).
   대상: `src/ scripts/ package.json tsconfig.json README.md` 에서 `llamacli`→`harnesside`, `LLAMACLI_`→`HARNESSIDE_`, `.llamacli`→`.harnesside`.
   검증: `grep -rni "llamacli" src scripts package.json tsconfig.json | grep -v "원본\|fork"` 가 **0건**.
2. P0-2 `package.json` 개편.
3. P0-3 TUI 격리.
4. P0-4 `npm install`.
5. P0-5 `npm test` — **여기서 막히면 이 파일의 "열린 이슈" 에 적고 넘어가지 말 것.**

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

## ⑧ 열린 이슈 / 블로커

| # | 이슈 | 영향 | 상태 | 다음 시도 |
|---|---|---|---|---|
| — | 없음 | — | — | — |

## ⑨ 변경 이력 (커밋 로그)

| # | 커밋 | 내용 |
|---|---|---|
| — | — | 아직 커밋 없음 |
