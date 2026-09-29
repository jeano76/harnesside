# harnesside — llama.cpp 기반 웹 IDE 코딩 에이전트 구현 프롬프트

> 이 문서는 **구현을 지시하기 위한 명세서**입니다. `harnesside` 는 기존 `llamacli`
> 를 원본 복사(fork)하여 만든 **별도의 신규 프로젝트**이며, TUI 터미널 에이전트를
> **CDP로 띄운 브라우저 위의 웹 IDE**로 재구성하는 것이 핵심입니다.
> 각 섹션은 별도 이슈/작업 단위로 분리해 진행할 수 있고, §12 구현 순서를 따릅니다.

---

## 목차

| § | 내용 | 원본 요구 |
|---|---|---|
| 0 | 목표와 성공 기준 | — |
| 1 | 기존 llamacli 파생 규칙 | 1 |
| 2 | 전체 아키텍처 | 2 |
| 3 | 서버 계층 요구사항 (보안 경계 · 로그 파이프라인 · 데몬 모드 포함) | 2, 7, 9 |
| 4 | 브라우저 실행 · 스플리시 윈도우 (**GPU 정책 · VRAM 예산** 포함) | 2, 8, 9 |
| 5 | 웹 IDE 화면 요구사항 (**서버 로그 패널 · 설정/업데이트 화면** 포함) | 3, 4, 6, 7, 11, 14, 17 |
| 6 | llama.cpp 라이프사이클 · 튜닝 · 설정 규약 | 9, 10 |
| 7 | 모델 관리 (HuggingFace) — **Ornith 계열 1순위 고정** | 5 |
| 8 | 파일 탐색기 · 워크스페이스 | 12, 13 |
| 9 | 업데이트 · GitHub 연동 | 14, 15, 16 |
| 10 | 테스트 · 검증 전략 | 18 |
| 11 | 추가 권장 기능 | 19 |
| 12 | 구현 순서 (Phase) | — |
| 13 | 수용 기준 체크리스트 | — |
| 부록 A | 포트 · 프로세스 수명 요약 | — |
| 부록 B | 용어 | — |
| 부록 C | 이 문서 자체의 유지보수 규칙 | — |

> **2차 개정에서 보충한 것** (초판에 없던 항목):
> **§3.6 보안 경계**(토큰 인증·Origin/Host 검증·도구 승인 게이트),
> **§4.6 GPU/VRAM 예산 분리**(모델과 브라우저의 같은 카드 경쟁),
> **§5.10 대화·세션 영속화**, **§5.11 신규 도구 목록 + 스키마 토큰 비용 관리**,
> **§6.4 설정·데이터 디렉터리 규약**, **§10.3.1 보안 테스트**, **§10.6 CI·커버리지**.
>
> **3차 개정에서 보충한 것** (브라우저 GPU 정책):
> **§4.7 브라우저 GPU 정책** — llama-server 가 GPU 를 쓰면 브라우저의 GPU 를 끈다.
> 최적 플래그 세트(실측 근거 포함)·대신 치르는 비용·무효 플래그 목록·확인 방법.
> **§3.2 부트스트랩 12단계**(GPU 정책/실측 VRAM 결정 단계 신설), **§4.1 실행 플래그 정합화**,
> **§5.5/§5.9 소프트웨어 렌더 예산**, **§10.2 `browserFlags` 테스트**, **§10.5 GPU 모드 매트릭스**.
>
> **4차 개정에서 보충한 것** (데몬 + 상시 디버그 창):
> **§3.7 데몬 실행 모드** — 서버는 TTY 없는 데몬이다. `window` 기본 / `daemon` opt-in.
> **§5.12 프로세스 디버그 로그 패널** — 서버·llama-server·자식 프로세스 로그가
> 브라우저 한 패널에 **상시** 스트리밍되고, **최대 보관 문자 수는 500,000자**(설정 가능)로 한정한다.
> **§2.3 로그 프로토콜 보강**, **§3.3 로그 API 3종**, **§3.5 로그 파이프라인**,
> **§4.4 수명 분리**(daemon 모드 예외 명시).

> **번호 누락 안내**: 원본 요구사항에서 14번 다음 16번으로 15번이 빠져 있습니다.
> 본 문서는 §9.2 에 **"15번(추가 권장) — 설정 내보내기/가져오기 및 진단 리포트"** 를
> 보완 항목으로 명시했습니다. 별도 지시가 있으면 해당 위치에 교체하십시오.

---

## 0. 목표와 성공 기준

### 0.1 한 줄 목표

> **로컬 llama.cpp 를 두뇌로 쓰고, CDP로 띄운 하나의 브라우저 창을 두뇌의 화면(IDE)으로
> 쓰는 로컬 코딩 에이전트.** 모델 가중치·대화 기록·소스·도구 실행 전부 1대의 머신 안에 있다.

### 0.2 반드시 지켜질 불변 조건 (Non-negotiables)

1. **모델은 로컬 llama.cpp 다.** 호스팅 API는 선택 사항(설정으로 전환 가능)에 불과하며,
   기본값은 언제나 로컬이다.
2. **llama.cpp 는 웹 페이지보다 먼저 기동한다.** 웹 화면이 떴는데 모델이 없는 상태는
   허용하지 않는다(§6.1).
3. **브라우저가 닫히면 llama.cpp 도 함께 멈춘다.** (§4.4) — 사용자가 창을 닫은다는 것은
   "작업을 끝냈다"는 신호다.
4. **llama-server 는 반드시 사용자 소유 사양에 맞춰 조정한다.** 고정 상수 금지.
   GPU 우선, VRAM 예산 기반, 근거 문자열(rationale) 동봉 (§6.3).
5. **기본 추천 모델은 Ornith 계열이다.** 실측 튜닝의 기준 모델이며, 점수와 무관하게
   1순위로 고정된다(§7.2).
6. **원본 llamacli의 검증된 기능을 잃지 않는다.** 컴팩션·체크포인트 자동 재개,
   자가치유 회로차단기, skill/rule 로딩, diff 표시, 자체 업데이트 해시 검증은
   **그대로 이식한다**(§1.3).
7. **모든 로직에는 테스트가 있다.** 새 모듈 추가 = 테스트 추가.(§10)
8. **모델 VRAM과 브라우저 VRAM은 같은 카드에서 경쟁한다.** 둘이 동시에 터지면
   둘 다 죽는다. 예산을 분리한다(§4.6).
9. **모델이 GPU 를 쓰면 브라우저는 GPU 를 끈다.** 기본값은 `browser.gpuMode: off`(§4.7).
   가속을 유지하려고 카드 한 자루를 양쪽에 나눠 쓰는 전략은 **실측에서 성립하지 않았다**
   (카드 8 GiB 중 free 285 MiB 상태). 공짜가 아니므로 **대신 치르는 비용까지 §4.7.4 에 명시**한다.
10. **서버는 TTY 없이 돈다.** 터미널이 붙어 있어도 없어도 같은 코드로 기동한다(§3.7).
    서버 상태를 보는 유일한 창은 **브라우저의 §5.12 디버그 로그 패널**이며, 그 패널은
    **상시** 스트리밍되고 보관 문자 수에 상한이 있다(기본 500,000자).

### 0.3 성공 판정 (Acceptance)

- `npm run build && node dist/server/index.js` 한 번 실행으로 브라우저 창이 뜨고,
  그 창 안에 채팅·편집기·파일트리·모니터 패널이 있는 IDE가 로드된다.
- 창을 닫으면 5초 이내에 llama-server 프로세스가 사라진다(설정값으로 조정 가능).
- 창을 닫았다가 다시 열면 이전 체크포인트에서 작업이 자동 재개된다.
- **`nohup harnesside up -d > /dev/null 2>&1` 로도** 부팅이 끝까지 진행된다(TTY 없음, §3.7).
  이 상태에서 창을 열면 **서버 로그가 한 패널에 상시 흐르고**(§5.12), 상한 500,000자를 넘으면
  **가장 최근 줄은 절대 사라지지 않는다**.
- **브라우저 GPU 가 실제로 꺼져 있음이 확인된다**(§4.7.5): `nvidia-smi` 에 chrome 항목이 없고,
  CDP `SystemInfo.getInfo` 의 `glRenderer` 가 `Disabled`.
- `npm test`, `npm run typecheck` 통과. 헤드리스 E2E 통과.

---

## 1. 기존 llamacli 파생 규칙 (요구 1)

### 1.1 프로젝트 생성

```bash
# 원본을 읽기 전용 참조로 두고, 새 위치에 독립 복사본을 만든다.
cp -a /home/jeano/llamacli /home/jeano/harnessCli
cd /home/jeano/harnessCli

# 1) 원본 커밋 이력은 새 저장소로 가져오되, 원본 remote 는 제거한다.
rm -rf .git && git init -q && git add -A && git commit -q -m "chore: fork from llamacli"
```

- **원본 `/home/jeano/llamacli` 은 절대 수정하지 않는다.** 읽기 전용 기준 구현(role model)으로
  취급하고, 차이가 생기면 항상 원본에 물어본다.
- `node_modules/`, `dist/`, `.llamacli/state/`, `__pycache__/`, `.pytest_cache/` 는 복사 후 제거.

### 1.2 식별자 일괄 치환 (이름 변경)

| 대상 | 기존 | 신규 |
|---|---|---|
| npm 패키지명 | `llamacli` | `harnesside` |
| bin 명령 | `llamacli` | `harnesside` |
| 설정 디렉터리 | `.llamacli/` | `.harnesside/` |
| 상태 디렉터리 | `.llamacli/state/` | `.harnesside/state/` |
| 환경변수 접두사 | `LLAMACLI_*` | `HARNESSIDE_*` |
| 프로세스 가드 파일 | 인스턴스 가드 | 동일 (`.harnesside/instance.json`) |
| 시스템 프롬프트 자기소개 | "You are llamacli…" | "You are harnesside…" |
| GitHub raw URL | `jeano76/llamacli` | `jeano76/harnesside` (가정) |

치환 후 반드시 아래를 확인한다.

```bash
grep -rni "llamacli" src scripts package.json tsconfig.json README.md | grep -v "원본\|fork\|harnessacli"
```

> **주의(원본에서 실제로 겪은 함정)**: 주석 안의 `buildX` 같은 문자열을 glob(`*`)으로
> 쓰면 블록 주석이 조기 종료해 "의미 없는 파싱 에러 벽"이 된다. 대량 치환 스크립트는
> `node`로 작성해 주석을 **파싱해서** 토큰 단위로 치환하거나, 정규식에서 `*`를 피한다.

### 1.3 이식 대상 모듈 (그대로 가져간다)

아래는 이미 실기 검증되어 있고, TUI 의존성이 없는 **순수 로직**이다. 웹 IDE로 갈아탄 뒤에도
**그대로 유지**한다. 기능을 "개선하다가" 잃는 것이 이 프로젝트의 최대 위험이다.

| 모듈 | 역할 | 웹 이식 시 주의 |
|---|---|---|
| `src/backend/openaiClient.ts` | OpenAI 호환 클라이언트(SSE 스트리밍, tool_calls) | 그대로. 유일한 모델 통신 계층 |
| `src/backend/detect.ts` | 실행 중 서버 탐지 | 그대로 |
| `src/agent/loop.ts` | 턴 구동, 도구 디스패치, 컨텍스트 계수 | UI 콜백을 WebSocket 이벤트로 교체 |
| `src/compaction/*` | 체크포인트 기록/재개, 요약 | 그대로 (웹 화면에도 동일 반영) |
| `src/hermes/*` | 자로차단기, 실패 로그, 자가개선 제안 | 그대로 |
| `src/skills/loader.ts` | rule 상시 로드 + skill 지연 로드 | 그대로 |
| `src/tools/diff.ts` | LCS 라인 diff | **가로 비교 렌더용 데이터로도 재사용** |
| `src/tools/index.ts` | 도구 정의 + 실행 | 목록 확장 (§5.6) |
| `src/tools/browser.ts` | CDP 세션 | **확장하여 앱용 CDP 컨트롤러로 승격** (§4) |
| `src/setup/hardware.ts` | 하드웨어 탐지(nvidia-smi 파싱 포함) | 그대로 + 모니터링용으로 재사용 |
| `src/setup/tuning.ts` | 하드웨어→llama-server 플래그 튜닝 | 그대로 + UI 노출 (§6.3) |
| `src/setup/ports.ts` | 포트 계획 | **2개 포트로 확장** (§부록 A) |
| `src/setup/llamaCpp.ts` | llama-server 탐색/빌드 | 그대로 |
| `src/selfUpdate.ts` | 해시검증 자체 업데이트 | 그대로 + GitHub Releases (§9.1) |
| `src/agent/harness.ts` | 진행없음 감지, 편집 후 검증 명령 | 그대로 |
| `src/crashHandler.ts` | 크래시 로그 + 터미널 복구 | **웹에서는 창 복구 + 로그 패널로 대체** |
| `src/skills/builtin/*.md` | 8종 내장 스킬 | 그대로 |
| `src/instanceGuard.ts` | 중복 인스턴스 방지 | 그대로 + 웹 서버 락 파일 |

### 1.4 제거/대체 대상 (TUI 전용)

| 모듈 | 처리 |
|---|---|
| `src/tui/*` (Ink) | **삭제하지 말고 `src/legacy-tui/`로 격리 보관.** 나중에 터미널 폴백이 필요할 수 있음 |
| `src/tui/terminal.ts` 등 | 웹용으로 불필요. 단 `keybindings.ts`의 단축키 목록을 웹 키매핑 표의 원본으로 재활용 |

- **`legacy-tui/` 는 어떤 경우에도 서버 코드에서 import 하지 않는다**(§3.7).
  데몬 기동에는 TTY 가 없으므로 `setRawMode` 를 호출하는 코드가 경로에 남아 있기만 해도
  기동이 깨진다. 차후 터미널 폴백을 붙일 때도 **별도 엔트리포인트로 격리**한다.

### 1.5 패키지 구성

```jsonc
{
  "name": "harnesside",
  "bin": { "harnesside": "./dist/server/index.js" },
  "scripts": {
    "build:server": "tsc -p tsconfig.server.json",
    "build:web":    "vite build",     // → dist/web/
    "build":        "npm run build:server && npm run build:web && node scripts/pack-web-assets.mjs",
    "dev":          "concurrently \"tsx watch src/server/index.ts\" \"vite\"",
    "start":        "node dist/server/index.js",
    "test":         "tsx --test \"src/**/*.test.ts\"",
    "test:e2e":     "tsx scripts/e2e_check.ts",
    "typecheck":    "tsc --noEmit"
  }
}
```

**새로 추가하는 의존성** (기존 의존성은 유지):

| 패키지 | 용도 | 근거 |
|---|---|---|
| `monaco-editor` | 코드 편집기(하이라이트/인덴트/접기/가로 diff/미니맵) | VS Code 코어. 요구 3의 편집 요구를 개별 라이브러리 조합으로 재현하지 않아도 됨 |
| `ws` | WebSocket (제약 없음) | **현재 devDependency → dependency 로 이동** (프로덕션에서 필요) |
| `vite` + `@vitejs/plugin-react` | 프론트 번들 | devDependency |
| `react`, `react-dom` | UI | **현재 react 는 devDependency → dependency 로 이동** |
| `chokidar` | 파일 변경 감시 | 워크스페이스 외부 편집 반영 |
| `systeminformation` *(선택)* | CPU/GPU/디스크 계측 대체 | `nvidia-smi` 직접 파싱이 더 정확하므로 **기본은 직접 파싱** |

> `monaco-editor` 는 무겁다(번들 ~5MB). 구형 GPU/저사양 대비 **lazy load** 하며,
> 편집기 미사용 패널에서는 로드하지 않는다. 대체 PoC로 `@codemirror/*` 를 남겨두되
> 기본은 Monaco 로 간다(가로 diff 편집기와 접기가 이미 갖춰져 있고, 직접 만들면
> 품질이 떨어진다).

---

## 2. 전체 아키텍처 (요구 2)

### 2.1 개요

```
┌──────────────────────────────────────────────────────────────────────┐
│                       사용자 데스크톱 (1대의 PC)                        │
│                                                                       │
│  ┌──────────────────── harnesside 서버 (Node) ──────────────────────┐  │
│  │  부트스트랩 (12단계, §3.2 · TTY 없는 데몬)                       │  │
│  │   1) 인스턴스 가드 (flock)                                      │  │
│  │   2) 하드웨어 탐지 (nvidia-smi / /proc)                          │  │
│  │   3) llama-server 탐색 → 없으면 빌드                            │  │
│  │   4) ★ 모델 결정 (Ornith 1순위)                                 │  │
│  │   5) ★ 브라우저 GPU 정책 + 실측 VRAM (§4.7)                     │  │
│  │   6) 포트 계획 (llama 8080, IDE 7317)                            │  │
│  │   7) ★ llama-server 기동 (튜닝 플래그, 5의 예산 반영)            │  │
│  │   8) ★ 헬스체크 대기 (/v1/models)                                │  │
│  │   9) 웹 자산 확인 → 10) HTTP/WS 기동                             │  │
│  │  11) ★ Chrome 기동 (--app=, GPU off, --remote-debugging-port)   │  │
│  │  12) 루프 유지                                                   │  │
│  │  HTTP + WebSocket 서버 (127.0.0.1:7317)                          │  │
│  │  에이전트 루프 / 컴팩션 / 헤르메스 / 스킬 / 도구                  │  │
│  │  로그 파이프라인 → §5.12 하단 패널(상시, 상한 500,000자)          │  │
│  └───────────┬──────────────────────────────────┬──────────────────┘  │
│              │ OpenAI 호환 HTTP (8080)          │ WS (7317)         │
│      ┌───────▼────────────┐          ┌──────────▼──────────────────┐ │
│      │  llama-server      │          │  웹 IDE (Chrome --app 창)    │ │
│      │  (자식 프로세스)    │          │  ├ 좌: 파일트리              │ │
│      └────────────────────┘          │  ├ 중앙: Monaco 편집기       │ │
│                                      │  ├ 우: 채팅/에이전트 스트림   │ │
│                                      │  └ 하: 시스템 모니터 패널     │ │
│                                      │    + 서버 로그 패널(상시)     │ │
│                                      └──────────┬──────────────────┘ │
│                                                 │ CDP(9222) 양방향    │
│                                          ┌──────▼──────────────────┐ │
│                                          │ 서버 CDP 컨트롤러        │ │
│                                          │ 창 위치/크기, 탭, 스크린샷│ │
│                                          │ GPU 모드 검증(§4.7.5)   │ │
│                                          └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

> **다이어그램이 실제 배치와 다른 곳** — §2.1 은 구성이고, 실제 화면은 §5.0(레이아웃),
> §5.12(로그 패널), §5.13(설정 화면)이 진실원이다. 그려지지 않은 것이 구현되지 않았다는
> 뜻은 아니지만, **다이어그램을 갱신하지 않고 화면만 바꾸면 문서가 거짓말을 한다.**

### 2.2 프로세스 구조 규칙

- **harnesside 서버가 부모**, `llama-server`와 `chrome`이 **자식**이다.
- 자식 프로세스는 `detached: false`로 스폰하여 부모 종료 시 함께 정리한다.
- 그래도 이중 안전장치를 둔다: (a) 자식 exit 리스너, (b) 웹 클라이언트 하트비트 타임아웃.
- 부모가 죽은 채 자식이 살아남으면 다음 실행의 인스턴스 가드가 이를 감지해 정리한다.

### 2.3 통신 프로토콜 (WebSocket)

단일 WS 연결. 서버 → 클라이언트 이벤트는 모두 `type` 필드를 가진 JSON.

| `type` | 방향 | 페이로드 | 용도 |
|---|---|---|---|
| `hello` | S→C | `{serverVersion, llama:{port,model}, hw}` | 연결 초기화 |
| `agent.state` | S→C | `{busy, phase, toolName?, elapsedMs}` | 스피너/상태 표시 |
| `agent.reasoning.delta` | S→C | `{turnId, text}` | **Think 애니메이션 + 사고 과정 스트리밍** |
| `agent.text.delta` | S→C | `{turnId, text}` | 최종 답변 스트리밍 |
| `agent.tool.call` | S→C | `{turnId, callId, name, args, argsPreview}` | 도구 호출 시작 |
| `agent.tool.result` | S→C | `{turnId, callId, ok, summary, blockId, version}` | **블록 단위 갱신** |
| `agent.block.delta` | S→C | `{blockId, version, patch}` | **증분 갱신(전체 재렌더 금지)** |
| `agent.turn.end` | S→C | `{turnId, ok, usage}` | 턴 종료 |
| `agent.plan` | S→C | `{plan:[{id,title,status}]}` | 플랜 패널 갱신 |
| `compaction` | S→C | `{before,after,droppedTokens,summary}` | 컴팩션 알림 + 상세 폴드 |
| `checkpoint` | S→C | `{exists, goal, steps, pendingToolCall}` | 체크포인트 표시/복구 안내 |
| `fs.tree` | S→C | `{root, entries:[...]}` | 파일트리 (§8) |
| `fs.file` | S→C | `{path, content, language, version, dirty}` | 편집기 콘텐츠 |
| `fs.changed` | S→C | `{path, kind}` | 외부 변경 알림 |
| `sys.metrics` | S→C | `{cpu, ram, vram, gpu, disk, context, tokensPerSec}` | **1Hz 모니터 패널** (§5.5) |
| `model.progress` | S→C | `{id, received, total, speed, etaSec, state}` | 모델 다운로드 진행률 |
| `log.append` | S→C | `{seq, ts, level, scope, source, message, data?}` | **상시 디버그 패널 (§5.12)**. `scope`=모듈, `source`=`server`/`llama`/`chrome`/`proc`, `seq`=단조 증가 |
| `log.status` | S→C | `{seq, bufferedChars, droppedChars, droppedLines, bufferFull, level}` | 링 버퍼 상태/상한 도달 통지 |
| `toast` | S→C | `{level, title, body}` | 알림 |

클라이언트 → 서버 명령:

| `type` | 페이로드 |
|---|---|
| `ping` | `{ts}` (하트비트, 기본 2초 간격) |
| `prompt.send` | `{text, attachments?}` |
| `prompt.cancel` | `{}` (현재 턴 중단) |
| `fs.navigate` | `{path}` |
| `fs.open` | `{path}` |
| `fs.save` | `{path, content, baseVersion}` |
| `model.apply` | `{modelId, ggufUrl, sha256}` |
| `settings.patch` | `{path, value}` |
| `git.action` | `{repo, action, ...}` |
| `log.query` | `{scope?, level?, sinceSeq?, limit?}` → `log.append` 다발 + `log.status` |
| `log.setLevel` | `{level: "debug"\|"info"\|"warn"\|"error"}` (런타임 로그 레벨) |
| `log.clear` | `{scope?}` (디스크 회전본은 보존, 메모리 링만) |
| `update.state` | `{state, from, to, error?}` — 업데이트 상태 머신 (§5.13.1) |
| `update.progress` | `{jobId, received, total, speed, phase}` — `download`/`verify` 단계 |
| `notice.push` | `{id, kind, title, body, actions[], ts}` — **추천 알림**(§5.13.2). `kind` = `model`/`llama`/`harnesside`/`warn` |

- `log.append` 는 **스트리밍 경로**이고 `log.query` 는 **조회 경로**다. 두 경로는 같은
  링 버퍼를 읽는다(§5.12.2). WS 재접속 시 `sinceSeq` 로 이어받는다(§3.5 재생 규칙과 동일).
- `seq` 는 **프로세스 수명 단위로 단조 증가**한다. 재시작 후에는 새 프로세스이므로
  클라이언트가 `epoch`(기동 시각) 을 함께 받아 이전 `seq` 와 구분한다.

### 2.4 "전용 화면" 원칙

기존 llamacli는 터미널이라는 **부드러운 제약** 아래에서 출력했다. 웹 IDE로 오면 그 제약이
사라지므로, 대신 **자기 규율**을 만든다:

- 모델의 원시 출력은 **화면 전체를 재렌더하지 않는다.** 블록 단위·증분 갱신만 한다(요구 7).
- 원격 지연이 있는 컨테이너(VS Code Remote, NAS 마운트)에서 이 선택이 결정적으로 중요하다.
  3만 줄 파일을 열 때 전체 재렌더는 수 초 프리즈를 만든다.

---

## 3. 서버 계층 요구사항 (요구 2, 7, 9)

### 3.1 모듈 구조

```
src/
  server/
    index.ts          부트스트랩 오케스트레이션 (§3.2 의 12단계)
    httpServer.ts     정적 서빙 + REST (/api/*)
    wsHub.ts          WebSocket 허브, 이벤트 발행/구독, 하트비트
    browserFlags.ts   Chrome 실행 플래그 **단일 생성기** (GPU 정책 포함, §4.7)
    browserLauncher.ts Chrome --app 창 실행 및 수명 관리
    cdpController.ts  CDP 세션(탭/창 위치/스크린샷/페이지 재로딩)
    metrics.ts        1Hz 시스템 계측 샘플러 (§5.5)
    logRing.ts        NDJSON 로그 파이프라인 + 상한 링 버퍼 (§5.12.2)
    logWatcher.ts     회전 로그 tail → WS 발행, `sinceSeq` 재생 (§5.12.4)
    daemon.ts         TTY 무존재 기동, flock 인스턴스 가드, `up/down/status/logs` (§3.7)
    lifecycle.ts      자식 프로세스 감시, 우아한 종료, 크래시 복구
  agent/              (이식) loop, harness, gitCheckpoint, textSanitize …
  backend/            (이식) openaiClient, llamaServer, detect
  compaction/         (이식) checkpoint, compactor, notes
  hermes/             (이식) selfHeal, selfImprove
  skills/             (이식) loader + builtin/*.md
  setup/              (이식) hardware, tuning, ports, llamaCpp, bootstrap
  tools/              (확장) index, diff, browser, + 신규 도구(§5.11)
  models/             (신규) recommend, hfSearch, hfDownload, modelManager, ggufMeta
  fs/                 (신규) tree, watcher, safePath, sizeLimit
  git/                (신규) githubApi, gitOps, sync
  auth/               (신규) token, originGuard — §3.6 보안 경계
  update/             (확장) selfUpdate + releaseCheck
  web/                (신규) React 웹 IDE (§5)
    panels/           ActivityBar, FileTree, EditorPane, ChatPane,
                      SystemMonitor, PlanPanel, LogPanel, SettingsDialog, ModelManager
    dock/             자석 도킹 레이아웃 엔진 (§5.4)
    components/       Block, Foldable, DiffView, ThinkIndicator, Splitter, Toasts …
    hooks/            useWs, useMetrics, useFs, useHotkeys …
  legacy-tui/         (격리) 기존 Ink TUI
```

### 3.2 부트스트랩 시퀀스 (`src/server/index.ts`)

원본 `src/setup/bootstrap.ts` 의 "사용자 개입 없이 진행" 원칙을 그대로 계승하되,
**순서가 다르고 그 순서가 곧 요구사항 9다.**

```
[1] instanceGuard   flock 로 이미 실행 중이면 새 프로세스를 띄우지 않고
                    기존 창 앞으로 가져오기(bring to front). §3.7.2
[2] 하드웨어 탐지    detectHardware() — CPU 코어수, RAM, GPU/VRAM, nvidia-smi
[3] llama-server 탐색 findLlamaServer() — 없으면 buildLlamaCpp() (최장 40분)
[4] 모델 결정        ① config.llama.modelPath 에 적힌 .gguf
                    ② 없으면 로컬 스캔 → §7.2 우선순위 계열(Ornith) 최우선 매칭
                    ③ 그것도 없으면 §7.2 의 양자화 표로 VRAM 에 맞는 Ornith 양자화 결정
                    (다운로드는 §7.4. 이 단계는 절대 사용자에게 묻지 않는다)
[5] ★ 브라우저 GPU 정책  decideGpuMode() — §4.7. 여기서 nvidia-smi 로
                    free VRAM 을 **실측**하고, 그 값으로 브라우저 예산과
                    llama 예산을 확정한다(페이퍼 사양 8192MiB 를 믿지 않는다)
[6] 포트 계획        llama=8080(선점되면 다음 후보), ide=7317(고정/충돌 시 +1)
[7] ★ llama-server 기동   튜닝 플래그로 spawn (§6.3, [5] 의 예산 반영)
[8] ★ 헬스체크 대기  /v1/models 가 200 을 줄 때까지 (기본 120초, 실패 시 UI에 오류 후 계속)
[9] 웹 자산 준비     dist/web 없으면 에러 메시지(설치 가이드) 후 종료
[10] ★ HTTP/WS 서버 기동
[11] ★ Chrome 기동  --app=http://127.0.0.1:7317  (§4.1, GPU 정책 반영)
[12] 루프 유지        SIGINT/SIGTERM/자식종료/하트비트만료 감시
```

- **[8]이 실패해도 [10]~[11]은 진행한다.** 모델이 죽은 IDE 화면은 "모델 연결 실패" 배너와
  재시도 버튼을 보여줄 수 있어야지, 창 자체가 안 뜨면 안 된다. (원본 bootstrap 의
  "fail 대신 degrade" 원칙과 동일)
- **[5]는 순서가 바뀌면 안 된다.** GPU 정책은 [7] 의 VRAM 예산 계산에 직결되고,
  VRAM 예산은 [7] 의 튜닝 플래그에 직결된다. 순서를 뒤집으면 모델이 이미 로드된 뒤에
  브라우저 예산을 빼게 되어 튜닝이 무효화된다.
- 각 단계는 `BootstrapStep{name, ok, detail, tookSeconds}` 로 기록해 **부팅 로그 화면**에
  순차적으로 표시한다(각 항목 접기 가능). 이 부팅 로그는 전부 §5.12 로그 파이프라인을
  지나므로, 서버가 데몬이어도 창에서 그대로 보인다.

### 3.3 REST API (`/api/*`)

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/api/health` | `{ok, llamaUp, uptimeSec, version}` |
| GET | `/api/hardware` | 탐지된 하드웨어 원본 |
| GET | `/api/tuning` | §6.3 추천 플래그 + rationale |
| GET | `/api/config` / PATCH | 설정 읽기/쓰기 (화이트리스트 키만) |
| GET | `/api/models` | 로컬 설치된 .gguf 목록 |
| GET | `/api/models/search?q=&fit=` | HuggingFace 검색 + 적합도 (§7.3). **Ornith 계열은 항상 별도 1순위** (§7.2) |
| POST | `/api/models/download` | 멀티 연결 다운로드 시작 → jobId |
| GET | `/api/models/download/:jobId` | 진행 상태 |
| DELETE | `/api/models/:id` | 모델 삭제(디스크 정리) |
| POST | `/api/models/apply` | 모델 교체 + llama-server 재시작 |
| GET | `/api/fs/tree?path=` | 디렉토리 목록 |
| GET | `/api/fs/file?path=` | 파일 내용(크기 제한 있음) |
| PUT | `/api/fs/file` | 저장(동시편집 충돌 감지) |
| GET | `/api/workspace` | 현재 워크스페이스 루트 + 언어 감지 + git 상태 |
| POST | `/api/workspace` | **워크스페이스 루트 변경** (요구 13) |
| GET | `/api/system/readme` | GitHub README 실시간 (§9.1) |
| GET | `/api/system/version` | 로컬/원격 버전, 커밋, 빌드 시각 |
| GET | `/api/github/repos` | 사용자/Org 저장소 목록 |
| POST | `/api/github/sync` | clone/pull/push (§9.3) |
| GET | `/api/metrics` | 1회 샘플(WS 구독이 주 경로) |
| GET | `/api/logs?scope=&level=&sinceSeq=&limit=` | 로그 조회 (§5.12). 링 버퍼 기준, 상한 동시 적용 |
| POST | `/api/logs/clear` | 메모리 링 비우기(디스크 파일은 보존) |
| GET | `/api/gpu` | 현재 GPU 정책·모드·예약 MiB·rationale (§4.7) |
| GET | `/api/update/check` | 원격 버전 조회 (§5.13.1) |
| POST | `/api/update/download` | 업데이트 바이너리+웹 자산 내려받기 → jobId |
| GET | `/api/update/progress` | 진행률·속도·검증 결과 |
| POST | `/api/update/apply` | 적용(승인 필수, §3.6) → 체크포인트 후 재기동 |
| POST | `/api/update/rollback` | 보존된 이전 버전으로 되돌리기(승인 필수) |
| GET | `/api/update/history` | 설치/되돌린 이력 |
| GET | `/api/notices` | 알림 목록(모델·llama·harnesside, §5.13.2) |
| POST | `/api/notices/:id/dismiss` | 읽음 처리(재발 방지 아님) |
| POST | `/api/notices/:id/silence` | 해당 항목의 재발을 영구 차단 |
| GET | `/api/watch/repos` · POST | 구독 중인 HF 저장소 목록 |
| POST | `/api/lifecycle/shutdown` | 창 종료 신호 없이 서버를 정리(데몬 종료) |
| POST | `/api/diagnostics/export` | 진단 리포트(§9.2) |

### 3.4 경로 안전 (보안 필수)

에이전트가 웹 UI를 통해 임의 파일을 읽고 쓸 수 있으므로 **경로 검증이 없으면 곧
원격 파일 읽기 취약점**이다. `src/fs/safePath.ts`:

- 모든 경로는 `fs.realpath`로 resolve 후 **워크스페이스 루트 안에 있는지** 확인.
  루트 탈출(`..`, 심볼릭 링크, `/`)은 거부하고 사유를 반환.
- 심볼릭 링크는 기본 **미해석(deny)**. `fs.allowSymlinks` 설정으로 예외 허용.
- 파일 크기 상한 기본 2 MiB(설정 가능), 초과 시 오류 대신 **앞부분 + 줄바꿈 경계 절단 +
  "더 읽으려면 start_line" 안내**를 반환(원본 `read_file` 도구와 동일한 UX).
- 바이너리 감지(NUL 바이트) 시 거부하고 확장자/크기만 반환.
- `PUT /api/fs/file`은 `baseVersion` 불일치 시 **409 + 서버측 최신본**을 반환(무음 덮어쓰기 금지).
- DELETE 계열 엔드포인트는 **없다.** 삭제는 도구(에이전트 승인 필요) 또는 CLI로만 한다.

### 3.5 동시성 · 안정성

- 파일 저장/디렉토리 조회는 **요청별 직렬화 큐**를 두어 같은 경로 race를 막는다.
  (원본 `loop.ts` 의 `taskChain` 직렬화 문제와 동일한 계열)
- WS 연결이 끊겨도 에이전트는 계속 돈다. 재연결 시 `hello` + **최근 이벤트 재생**
  (마지막 500개 링버퍼, `sinceSeq` 지원)으로 화면이 복원된다.
- 서버 로그는 stderr가 아니라 `.harnesside/state/server.log` 로 회전 기록.

### 3.5.1 로그 파이프라인 (상시 디버그 패널의 급유, §5.12)

- **단일 싱글턴 로거** `src/server/logRing.ts` 하나에서만 쓴다. 모듈마다 `console.log` 를
  직접 호출하지 않는다(§3.6 시크릿 마스킹과 같은 이유로 — 분산 처리하면 누락된다).
  - 각 로그는 **NDJSON 한 줄**: `{ts, level, scope, source, message, data?}`.
    NDJSON 이므로 사람이 `jq` 로도 읽을 수 있고, 회전·재개·`tail -F` 호환이 된다.
  - `source` 는 4종: `server` / `llama` / `chrome` / `proc`(자식 도구 실행).
- **쓰기 경로 3개가 한 줄로 합류한다**:
  1. 서버 내부 로그 (직접 호출)
  2. `llama-server` stdout/stderr → 줄 단위 tee → `source: "llama"`
  3. `run_shell`/`start_process` 출력 → `source: "proc"`
  llama-server 로그는 **요구 9 디버깅의 최우선 대상**이다(모델이 죽는 원인은 거의 항상
  이 줄들이다). 1 줄 단위 파싱 실패는 **조용히 버리지 말고 원문 1 줄을 `raw` 로 남긴다**.
- **상한은 3중**(§5.12.2): 문자(`logging.maxChars`) · 줄(`logging.maxLines`) ·
  회전 파일 바이트(`logging.maxBytes`). 초과 시 **가장 오래된 것부터 버린다**(ring).
  - 서버는 **디스크 로그를 무한히 쌓지 않는다.** 부팅이 무한정 재시작하는 버그가 있으면
    디스크가 먼저 찬다(원본 `crashHandler` 가 겪은 사고).
- **레벨 기본값은 `info`.** `debug` 는 사용자가 명시적으로 올릴 때만.
  - 실측 교훈: `debug` 를 켜면 에이전트 루프의 토큰 덤프와 도구 인자 전체가 매 턴 기록되어
    **디스크 I/O 가 토큰 생성보다 느려진다.** 그래서 `debug` 는 "모듈 단위"로 켠다
    (`debug: ["agent.loop", "tools.exec"]`).
- 로그에는 **절대 시크릿을 넣지 않는다**(§3.6). 인자 전체 대신 `argv` 는 민감 옵션을
  마스킹한 요약만, 파일 내용은 첫 줄 + 바이트 수만 기록한다.

### 3.6 보안 경계 (원본에 없었으나 웹에서는 필수)

> **이유**: §3.3 의 API 는 **임의 파일을 읽고 쓴다.** CLI 라면 실행 주체가 곧 사용자라
> 문제가 없지만, 웹 서버는 **같은 머신의 어떤 웹페이지도 호출할 수 있다.** 사용자가 다른
> 탭에서 아무 페이지를 열었을 뿐인데 그 페이지가 `http://127.0.0.1:7317/api/fs/file?path=~/.ssh/id_rsa`
> 를 `fetch` 하는 것만으로 시크릿이 새어나간다. **127.0.0.1 에만 바인드하는 것으로는
> 막히지 않는다 — 브라우저의 CORS 우회, `<img>`/`fetch` no-cors, WebSocket은 CORS가 없다.**
> 이건 이론적 위험이 아니라 이 프로그램이 매일 하는 일과 맞닿는다.

- **세션 토큰 인증 (필수, 예외 없음)**
  - 부팅 시 `crypto.randomBytes(32)` 로 토큰 생성 → `state/token.json`(`0600`)에 기록.
  - Chrome 실행 URL 에 붙인다: `--app=http://127.0.0.1:7317/?t=<token>`.
  - 모든 `/api/*` 와 WebSocket 업그레이드는 `Authorization: Bearer <token>` 또는 쿼리로 검증.
  - 페이지 첫 렌더 후 **URL 에서 토큰을 제거**하고 (`history.replaceState`) 세션스토리지에 보관.
    주소창에 토큰이 남으면 스크린샷·복사·셸 히스토리에 새어 나간다.
  - 검증 실패는 401/403 + 사유 로그. **토큰이 없으면 API 를 아예 열지 않는다.**
- **Origin / Referer 검증 (WebSocket 포함)**
  - WebSocket 은 CORS 규칙이 적용되지 않으므로, `Origin` 헤더가
    `http://127.0.0.1:<idePort>` 인지만 확인한다. 불일치면 핸드셰이크 거절.
  - `Host` 헤더도 검증한다 (DNS rebinding 방어 — `evil.com` 이 `127.0.0.1` 로
    해석되게 만들면 `Host: evil.com` 으로 도달한다).
- **CORS**: `Access-Control-Allow-Origin` 를 **전혀 보내지 않는다**(허용 출처 화이트리스트 없음).
  `credentials: include` 요청은 서버가 거부한다.
- **CSP 헤더**: `default-src 'self'` + `connect-src 'self' ws://127.0.0.1:*`.
  `unsafe-inline`/`unsafe-eval` 은 Monaco 워커 때문에 필요할 수 있으므로 불가피하면
  **허용하되 그 사실을 문서화**한다( Monaco 미사용 페이지에서는 제거 ).
- **HTML 이스케이프**: 파일명·경로·도구 인자를 DOM에 넣을 때 전부 이스케이프한다.
  **사용자 파일명이 곧 innerHTML 이 되는 경로가 없어야 한다.**
- **시크릿 마스킹**: 진단 리포트·설정 내보내기·서버 로그 어디에도
  PAT/API 키/토큰이 평문으로 남지 않는다. 마스킹은 **한 함수로만** 하고 그 외 경로에서
  직접 처리하지 않는다(원본 `IMPROVEMENTS.md` P4-1 "보안 경계가 선언만 있고 강제가 없다" 의 교훈).
- **도구 실행 승인 게이트 (웹에서 새로 생기는 요구)**
  - 원본 CLI 는 헤드리스라 모든 도구 호출이 곧 사용자 행위로 성립했다. 웹 IDE 는
    **창이 사용자의 다른 작업 중**일 수 있으므로, 파괴적·부수효과 도구는
    **기본적으로 확인을 거친다.**
  - 승인 대상: `run_shell` (기본값 승인 필요, 화이트리스트 명령은 자동), 파일 삭제,
    `git push`, `git checkout --force`, 패키지 설치, 설정 변경 중 위험 항목.
  - 승인 UI 는 **현재 대기 중인 도구 호출을 보여주는 차단형 모달** + "이 세션에서 허용"
    (일회성) / "항상 허용"(화이트리스트 등록) 선택.
  - **타임아웃 후 거절**로 기본 처리한다(무응답이 승인보다 안전).
  - 승인 대기열은 서버에 쌓이며, 에이전트 루프는 그 지점에서 **블로킹**(스트리밍 중
    막힌 것처럼 보이지 않도록 UI에 명확히 "승인 대기 중" 상태를 표시).
- **에이전트가 스스로 승인하도록 두지 않는다.** 승인 큐는 서버가 소유하며,
  모델에게는 "승인 대기 중"이라는 상태만 전달된다.
- **승인은 항상 사람이 하는 행위로 남는다.**
  - 승인 요청은 **창이 있는 세션에서만** 유효하다. 데몬 모드(§3.7)에서 창이 닫힌 상태로
    도구가 승인을 기다리면 **무한 대기가 된다.** 창이 닫히면 대기 중인 승인 요청은
    즉시 거절로 전환하고 에이전트에 사유를 넘긴다("창이 닫혀 승인이 불가능합니다").
  - `request_approval` 도구(§5.11)로 모델이 승인 요청을 **만들 수는 있어도 승인할 수는 없다.**
    모델이 재요청을 반복하면(같은 도구 3회 연속) 그 사실 자체를 텍스트로 돌려주고 진행을 계속한다.
  - 승인이 댄 **사유는 로그에 남긴다**(`scope: "approval"`, 시크릿 마스킹 적용) — 나중에
    "왜 파일이 안 지워졌지" 물었을 때 유일한 답이다.

### 3.7 데몬 실행 모드 (4차 개정) — 서버는 화면이 없다

> **요구**: "CLI 서버 프로그램은 화면이 없는 데몬 프로세서다."
> 즉 터미널 UI 를 붙이지 않은 서버 프로세스로 기동하고, 그 상태를 **브라우저의 한 패널**
> (§5.12)에서 상시 본다. TUI 의 흔적은 `legacy-tui/` 에 격리되어 있고(§1.4),
> 서버 엔트리포인트에서 **어떤 것도 TTY 를 필요로 하지 않는다.**

#### 3.7.1 TTY 비의존이 최소 조건

- **금지 / 필수 표의 두 축이 곧 이 절의 전체다.**

  | 금지 | 이유 |
  |---|---|
  | `process.stdin` raw 모드, 키보드 입력 대기 | TTY 없으면 예외. 데몬 기동이 깨진다 |
  | 화면 출력(커서 이동, 프로그레스 바, 박스 그리딩) | `nohup.out`·journal·리다이렉트에서 지저분해진다. 파일에 **NDJSON 한 줄씩만** |
  | 색상/진행 표시용 ANSI, 화면 클리어 | 위와 같다. 파일 로그는 기계가 읽어야 한다 |
  | `TUI` 를 서버 모듈이 import | §1.4 |

  | 필수 | 이유 |
  |---|---|
  | `process.stdout` 이 아닌 **파일 append 로만 기록** | 파이프로 묶였을 때 EPIPE 로 죽지 않는다(§3.5.1) |
  | 모든 상태 변경을 **이벤트로**publish | 창이 없어도 `harnesside logs` 로 보인다 |
  | 종료 신호 처리를 **단일 경로**로 | `up -d` / systemd / SIGINT 어느 쪽이든 같은 `shutdown()` (§4.4) |
  | 부팅 실패도 **로그로 남기고 종료 코드 0이 아닌 값** | 데몬은 사람이 보지 않는다. 실패가 조용히 사라지면 안 된다 |

#### 3.7.2 두 가지 실행 모드 — 요구 9 의 기본은 그대로 둔다

- **두 가지 실행 모드** — 요구 9(창을 닫으면 llama.cpp 도 멈춘다)를 **기본으로 유지**한다.
  데몬 모드는 **명시적 선택**이고, 그 선택의 대가도 화면에 분명히 적는다.

  | 모드 | 명령 | 창 닫으면 | llama-server | 기본 |
  |---|---|---|---|---|
  | **`window`** (기본) | `harnesside` | 종료 | 함께 종료 | ✅ 요구 9 |
  | **`daemon`** | `harnesside up -d` | **서버는 계속 살아 있다** | 계속 살아 있다 | 명시적 opt-in |

  - `daemon` 은 **"IDE 창을 닫아도 백그라운드 에이전트가 계속 일한다"** 는 요구다.
    따라서 요구 9(창 수명 = 작업 수명)의 **의도적 예외**로, 기본값이 아니다.
    예외인 만큼 §13 체크리스트에 "daemon 모드에서 창을 닫으면 S1~S5 중 무엇이 발동하는지"
    를 명시적으로 적는다(§4.4).
  - `daemon` 에서 창을 다시 열고 싶으면 `harnesside open`(또는 `up` 중복 실행)이
    **기존 서버에 붙어 새 창만 띄운다**(§3.2 [1]).
  - `daemon` 은 **유휴 종료 정책**을 함께 갖는다: 마지막 창이 닫힌 뒤
    `daemon.idleShutdownSec`(기본 0=무제한, 사용자가 지정) 지나면 종료. 기본값이 0인 이유는
    "데몬을 켰는데 조용히 사라졌다"는 최악의 UX 때문이다.
  - `daemon` 모드에서 llama-server 는 브라우저 VRAM 정책(§4.7)과 무관하게 계속 살아 있다.
    **창이 없으면 브라우저 VRAM 예약도 0 이 된다** — 튜닝을 다시 돌릴 필요가 없다.

#### 3.7.3 단일 인스턴스 보장 (데몬 필수)

- **단일 인스턴스 보장(데몬 필수)**: TTY 존재 여부가 아니라 **잠금 파일**로 판정한다.
  - `state/instance.lock` 에 flock + PID + 포트 + `startedAt` 기록.
  - 이미 잠겨 있으면 새 인스턴스를 띄우지 않고 "이미 실행 중(PID n, llama p, IDE p)" 을
    출력하고 종료한다. 기존 인스턴스를 죽이고 시작하는 `--force` 는 **기본 제공하지 않는다**
    (락 파일이 조용히 정리되지 않은 경우 데이터 유실 위험).
  - 서버가 죽었는데 락이 남은 경우(비정상 종료)만 **고아 락으로 판단해 정리**하고
    로그에 그 사실을 남긴다.
#### 3.7.4 `harnesside` 명령 표면 (설정 화면과 1:1)

- **명령 표면**:

  | 명령 | 동작 | 사용자 가시 출력 |
  |---|---|---|
  | `harnesside` / `up` | 부트스트랩 + 창 열기(기본) | 부팅 12단계 로그(§3.2) |
  | `harnesside up -d` | 데몬 기동(창 없음) | PID·포트·로그 파일 경로 |
  | `harnesside open` | 실행 중 서버에 창만 추가 | 창 유무·기존 세션 |
  | `harnesside status` | **JSON 1줄** 출력(프로세스·포트·llama 상태·모델·백그라운드 프로세스) | 사람이 읽는 요약 + `--json` |
  | `harnesside logs [-f]` | 디버그 로그 tail(§5.12 와 같은 링/파일) | `llama` 소스 강조 옵션 |
  | `harnesside down` | §4.4 우아한 종료 | 종료 사유·체크포인트 경로 |
  | `harnesside doctor` | 환경 진단(§9.2 리포트와 같은 내용, 터미널 출력) | 실패 항목만 굵게 |

  - 모든 명령은 **TTY 유무와 무관하게 같은 결과**를 낸다(출력 포맷만 TTY 있으면 색상).
    CI 에서 `harnesside up -d && harnesside status && harnesside down` 을 돌려야 한다(§10.3).
  - `status` / `logs` 는 **읽기 전용**이며 데몬이 없어도 동작한다(로그 파일만 읽는다).

---

## 4. 브라우저 실행 · 스플리시 윈도우 (요구 2, 8, 9)

### 4.1 Chrome 실행 플래그

**플래그는 `src/server/browserFlags.ts` 한 곳에서 만든다.** §4.1·§4.2·§4.6·§4.7 이
모두 같은 배열을 쓴다. 플래그 문자열이 여러 곳에 흩어지면 서로 모순되는 설정이 남는다
(초기안에서 실제로 `--disable-features` 가 두 군데에서 다르게 지정되어 있었다).

```bash
# launchFlags() 가 생성하는 배열(구성 모드에 따라 일부가 달라진다, §4.7)
google-chrome \
  --app="http://127.0.0.1:7317/?t=<token>" \   # 주소창·탭바 없는 "앱 모드"(요구 8) + §3.6 토큰
  --user-data-dir=$HOME/.harnesside/chrome-profile \  # 우리 프로필만(§4.1 하단)
  --remote-debugging-port=9222 \               # 서버가 이 세션에 붙는다
  --remote-allow-origins=http://127.0.0.1:7317 \# CDP WebSocket Origin 검증 통과(§3.6)
  --no-first-run --no-default-browser-check \
  --disable-features=Translate,MediaRouter,InterestFeedContentSuggestions,CalculateNativeWinOcclusion \
  --disable-component-update --disable-domain-reliability \
  --disable-sync --disable-background-networking \
  --disable-breakpad --disable-crash-reporter \  # crashpad 는 §4.4 신호로 쓴다(--disable-breakpad 아님)
  --password-store=basic --use-mock-keychain \   # 첫 실행에 비밀번호 저장 프롬프트가 뜨지 않게
  --disable-dev-shm-usage \                     # /dev/shm 작은 컨테이너/좁은 시스템에서 크래시 방지
  --disk-cache-size=268435456 \                 # 256 MiB 디스크 캐시 상한
  --js-flags=--max-old-space-size=2048 \        # 탭 JS 힙 상한(§4.7.4 Monaco 예산과 함께 결정)
  --window-size=1600,1000 --window-position=0,0 \
  --force-device-scale-factor=<dpi> \           # HiDPI 보정(§5.9)
  about:blank
```

- `--app=` 이 **요구 8의 "상단/하단 브라우저 메뉴가 없다"** 를 충족하는 핵심이다.
  주소창·탭바·북마크바·확장 아이콘이 전부 사라진다.
- **`--disable-features` 는 빈 값이라도 반드시 한 번만 지정한다.** 같은 스위치를 여러 번 주면
  브라우저가 **마지막 것만** 적용한다(Chromium 의 `CommandLine` 은 중복 키를 덮어쓴다).
  `Translate,MediaRouter` 처럼 두 군데에서 따로 지정하면 **앞의 것이 조용히 사라진다.**
  → `buildFeatures()` 한 함수가 전체 목록을 모아 한 번만 붙인다(§4.7.3, 유닛 테스트 대상).
- **`--remote-allow-origins` 를 생략하면 안 된다.** §3.6 이 WebSocket Origin 검증을 하므로,
  CDP 소켓은 기본 거절된다. 정확한 값은 `http://127.0.0.1:<idePort>` 이며,
  **와일드카드(`*`)는 절대 쓰지 않는다.**
- **토큰은 URL 쿼리로만 전달**하고 첫 렌더 후 제거한다(§3.6). CDP 소켓에는 토큰을 싣지 않는다 —
  `/json/version` 이 보이면 토큰이 노출되므로 **인증은 WS 헤더(쿠키) 대신 프로세스 소유권으로 한다.**
  (같은 계정 안의 다른 프로세스가 CDP 포트에 붙는 시도는 §3.6 의 Host/Origin 검사로 막는다)
- 브라우저 바이너리 탐지 순서: `CHROME_BIN` → `google-chrome` → `chromium` →
  `chromium-browser` → `google-chrome-stable` → Playwright/Puppeteer 번들 크로미움.
  **없으면** (a) 설치 안내를 띄우고 **데몬만** 계속 기동한다(브라우저 없이도 §3.7 `status`/
  `logs`/API 는 동작), (b) 자동 silent install 은 하지 않는다. 설치 경로는 사용자에게 알린다.
- **사용자 프로필을 공유하지 않는다.** 전용 `--user-data-dir`를 쓴다(사용자 세션 오염 방지).
- **플래그는 배열로 `spawn` 한다**(쉼 문자열 조립 금지, §9.3 원칙). 사용자 입력(경로·포트)이
  플래그에 들어가므로 `execFile`/`spawn` 배열 인자를 쓴다.
- **`--no-sandbox` 는 절대 넣지 않는다**(§3.6 의 보안 경계가 통째로 무의미가 된다).
  컨테이너에서 샌드박스가 막히는 환경은 별도 설정(`env.chromeExtraArgs`)으로 **사용자가
  명시적으로** 추가하되, 그 사실을 부팅 로그와 설정 화면에 남긴다.

### 4.2 라운드 모서리 (요구 8)

- 페이지 루트: `html, body { background: transparent; }` + `border-radius: 14px; overflow: hidden;`
  그리고 앱 셸(`#app-shell`)이 `border-radius` + `overflow:hidden` + 1px 보더.
- **선택(권장)**: OS 창 자체를 라운드로 만들려면 데스크톱 환경 설정에 의존한다
  (GNOME/KDE는 앱 창 라운딩을 지원). 앱 내부 라운드는 **항상** 동작하므로
  창이 직사각형이어도 안쪽 모서리가 둥글게 보인다. 양쪽 다 만족시키려면 문서화 +
  "이 데스크톱은 앱 창 라운딩 설정이 필요합니다" 1회 안내.
- 라운드 영역 바깥에 1~2px 여백을 두어, 창 모서리를 가리지 않게 한다.
  (여백 0이면 둥근 모서리가 창 경계에서 잘려 보인다)

### 4.3 CDP 컨트롤러 (`src/server/cdpController.ts`)

기존 `src/tools/browser.ts` 의 세션 관리(타임아웃 강제, 이벤트 waiter, 요청 ID 매핑)를
**공용 모듈로 승격**한다. 앱용으로 다음을 추가:

| 기능 | CDP 메서드 | 용도 |
|---|---|---|
| 탭 목록 | `GET /json/list` | 현재 창 추적 |
| 창 위치/크기 | `Browser.getWindowForTarget` + `Browser.setWindowBounds` | 마지막 위치 복원, 자석 스냅에 맞춰 실제 창 크기 조정 |
| 창 최소화/최대화 복원 | `Browser.setWindowBounds` `windowState` | 트레이/최소화 대응 |
| 페이지 로드 대기 | `Page.lifecycleEvent` / `Page.loadEventFired` | 부팅 완료 정확 판정 |
| 스크린샷 | `Page.captureScreenshot` | README/로그 첨부, 검증 스크립트 |
| **창 종료 감지** | `Target.detachedFromTarget` + `Target.targetCrashed` | **요구 9의 핵심 신호** |
| **페이지.evaluate** | `Runtime.evaluate` | 안티패턴 회피용 헬스체크, 부팅 상태 조회 |
| **키보드/마우스 주입** | `Input.dispatchKeyEvent` 등 | 자동화 테스트(§10.4) 전용 |

- **CDP는 "선택적 강화"이다.** CDP 연결이 실패해도 앱은 정상 동작해야 한다
  (창 종료 감지는 §4.4의 하트비트 경로가 대신 받는다).

### 4.4 창 종료 → llama.cpp 종료 (요구 9) — 다중 신호

단일 신호에 의존하지 않는다. 각 신호는 서로 다른 실패를 잡는다.

| # | 신호 | 감지 방식 | 잡는 실패 |
|---|---|---|---|
| S1 | Chrome 프로세스 exit | `child.on('exit')` | 정상 종료 |
| S2 | CDP target detached | `Target.detachedFromTarget` | CDP 붙어있을 때 정확한 신호 |
| S3 | 웹 클라이언트 하트비트 만료 | 마지막 `ping` 후 N초(기본 15초) 경과 | CDP 없이 닫힘/강제 종료/크래시 |
| S4 | CDP 연결 자체 소실 | `ws.on('close')` + 재연결 시도 2회 실패 | 프로필 잠김 등 |
| S5 | 사용자가 콘솔에서 종료 | SIGINT/SIGTERM | 명시적 종료 |
| S6 | **데몬이 고아가 됨** | 자식 전부 exit + WS 클라이언트 0 | 서버만 살아 있고 창·모델이 사라진 상태 |

- **S3 판정 전에 반드시 두 가지를 확인한다.** (a) 진행 중 백그라운드 프로세스가 있는가,
  (b) `daemon.idleShutdownSec` 이 설정돼 있는가. 둘 중 하나라도 있으면 S3 를 **유예**하고
  로그에 사유를 남긴다. 그렇지 않으면 큰 파일을 여는 중인데 서버가 죽는 일이 생긴다.
- **`daemon` 모드(§3.7)에서는 S1~S3 이 종료 신호가 아니다.** 서버는 계속 살아 있어야 한다.
  요구 9(창을 닫으면 llama 도 멈춘다)는 **`window` 모드가 기본**이므로 그대로 지켜지고,
  예외는 명시적 opt-in 뿐이다.

종료 절차 (`shutdown(reason)`):

```
1. 진행 중 턴 중단 (cancel) — 파일이 반쯤 쓰인 상태로 두지 않는다
2. 체크포인트 강제 기록 (항상)  → 다음 실행에서 재개 가능
3. llama-server에 SIGTERM → 5초 대기 → 그래도 있으면 SIGKILL
4. Chrome SIGTERM → 3초 대기 → SIGKILL (SIGKILL 전에 탭을 CDP로 닫아 세션 파일 손상 방지)
5. 상태 파일에 종료 사유/시각 기록
6. 로그 flush 후 exit(0)
```

- **우유부단 모드**: `--keep-alive` 플래그 또는 설정 `lifecycle.keepServerOnClose`로
  S3/S1만 무시하고 콘솔에서 Ctrl+C로만 종료 가능하게 한다. 기본은 꺼짐.
  (`daemon` 모드가 켜져 있으면 이 모드는 불필요하다 — 둘 다 켜지 않는다)
- **데몬 종료는 같은 `shutdown()` 을 다른 사유로 부른다**: `harnesside down` /
  `POST /api/lifecycle/shutdown` 은 위 절차를 그대로 실행하되 사유를 `user` 로 기록하고,
  다른 창에서 곧바로 붙을 수 있도록 **세션은 유지**한다.
- 재시작 횟수 제한: 30분 안에 5회 이상 재시작되면 크래시 루프로 판단해 자동 재기동을 멈춘다
  (원본 `selfImprove`/`ProgressTracker` 와 같은 계열의 자기보호 철학).

### 4.5 CDP를 통한 입출력 (요구 2)

- **입력**: 사용자의 키/마우스는 브라우저가 직접 처리한다. 서버를 경유하지 않는다.
- **출력**: 서버 → WS → DOM. CDP `Runtime.evaluate` 로 DOM을 직접 조작하지 않는다.
  (직접 조작은 리액트 상태와 이중 진실원이 된다 — 원본에서 TUI 직접 조작이 버그를
  만든 전례가 있다.)
- CDP는 **창 제어·스크린샷·테스트 주입**에만 쓴다. 데이터 경로는 WS 단일.

### 4.6 GPU · VRAM 예산 분리 (이 프로젝트에서 가장 현실적인 죽음 원인)

> **배경 (실측)**: 개발 대상 머신은 RTX 2070 SUPER **8 GiB** + 32 GiB RAM 이다.
> `src/setup/tuning.ts` 의 주석이 이미 기록했듯, 35B-A3B 는 여기서
> **"GPU VRAM 7.4GB/8GB 거의 독점"** 상태로 상주한다. 그런데 이 프로젝트는 여기에
> **Chrome + Monaco(번들 5MB) + WebGL 컴포지터**를 추가로 띄운다.
> 즉 **설계상 같은 8GiB 카드를 두 프로그램이 공유한다.** 이 문서를 처음 쓴 구조로는
> "모델 로드 성공 → 브라우저 열림 → 브라우저가 GPU 텍스처 잡음 → CUDA OOM → 모델 죽음"
> 이라는 순서가 그대로 일어난다. llama-server 가 먼저 죽기 때문에
> 사용자는 "IDE가 열리면 모델이 죽는다"로 느끼고 원인을 모른다.

- **차단 순서**: §6.3 의 튜닝은 llama-server **단독 실행 기준**으로 계산된다.
  브라우저까지 함께 있는 이 구조에서는 그 계산을 다시 해야 한다.
  ```
  가용 VRAM
    − 브라우저 예산 (§4.7 의 GPU 모드에 따라 달라짐)   ← 여기가 빠져 있었다
    = llama-server 예산 → §6.3 입력
  ```
- **브라우저 VRAM 예산 (기본값, `browser.vramBudgetMiB`)**:

  | GPU VRAM | GPU 모드 `off` (기본) | GPU 모드 `budgeted` | 근거 |
  |---|---|---|---|
  | ≤ 6 GiB | **0** | 1200 MiB | 모델 로드가 우선. IDE는 느려도 되게 |
  | 6~10 GiB | **0** | 700 MiB | 8 GiB 카드 |
  | 10~16 GiB | **0** | 400 MiB | 여유 있음 |
  | > 16 GiB | **0** | 250 MiB | |

  - **`off` 모드에서 브라우저 예산이 0 인 것은 실측 근거가 있다**(§4.7.1).
    GPU 프로세스 자체는 여전히 뜨지만 VRAM 은 10 MiB 남짓만 먹는다.
    예산 700 MiB 를 그대로 차감하면 **모델이 필요도 없는 700 MiB 를 빼앗기게 된다.**
  - **`budgeted` 는 `auto` 판정에서만, 그리고 여유가 1.5 GiB 이상일 때만**(§4.7.2).
    사용자가 명시적으로 고를 수 있지만 기본은 아니다.
- **예시 계산 (이 개발 머신)**: 8192 - 1024(기존 데스크톱 컴포지터 예약) - 0(브라우저) = **7168 MiB**.
  → `Q4_K_M`(21.9GB) 은 `--n-cpu-moe` 로 expert 층을 CPU 에 내려야 하며,
  `contextSize` 는 표의 8192 → 그 이하로 낮아질 수 있다. **이 결과가 §6.3 의 rationale 에
  "브라우저 GPU 를 꺼서 N MiB 을 확보했다 / 브라우저가 함께 실행되므로 M MiB 을 제외했다"는
  항목으로 노출**되어야 한다 — 사용자가 컨텍스트가 왜 줄었는지 설명받지 못하면 버그로 본다.
  (GPU off 의 실질적 이득은 여기다: `budgeted` 대비 **약 700 MiB 를 모델에 돌려준다.**
   그 700 MiB 가 "브라우저가 느려지는 대가"의 정확한 크기다.)
- **런타임 감시와 자동 퇴행**
  - `sys.metrics` 로 VRAM 사용률을 계속 본다. **90% 초과가 지속되면**:
    1. `contextSize` 를 1단계 낮추고 llama-server 를 재시작(모델 가중치는 유지).
    2. 그래도 안 되면 브라우저의 무거운 패널(미니맵 · 대형 diff · 로그 패널 자동 스크롤)을 끈다.
  - **GPU 모드는 런타임에 바꾸지 않는다.** 편집 중에 컨텍스트를 바꾸면 진행 중 작업의
    상태가 꼬인다. **경고만 표시하고 사용자가 결정**하게 한다(§4.7.2).
- **부팅 순서**: [5] 에서 `nvidia-smi` 로 실제 free VRAM 을 **실측**하고,
  그 값으로 브라우저 예산과 llama 예산을 확정한다(페이퍼 사양 8192MiB 를 믿지 않는다).
- **검증**: 8 GiB 카드 머신에서 "llama-server + 브라우저 동시 기동 후 30분 연속
  CUDA OOM 없음"을 확인한다. 이 항목은 10분 확인이 아니라 **장시간 확인**이다.
  여기에 더해 **브라우저를 띄운 상태로 30분 연속 토큰이 끊기지 않는지**도 함께 본다(§4.7.4).

### 4.7 브라우저 GPU 정책 — CDP 로 창을 부를 때 GPU 는 끈다 (3차 개정)

> **결정**: §4.6 의 초기안("가속은 유지하고 예산만 줄인다")은 **실측에서 기각되었다.**
> llama-server 가 GPU 를 쓰는 순간 **브라우저의 GPU 를 끈다.** 예외를 만들려면
> 사용자가 명시적으로 모드를 골라야 한다. 아래는 추정치가 아니라 측정값이다.

#### 4.7.1 실측 근거 (2026-09-29 · 개발 머신 · Chrome 153.0.8010.52)

| 항목 | 측정값 | 의미 |
|---|---|---|
| 카드 | RTX 2070 SUPER, 8192 MiB | §4.6 의 전제와 동일 |
| 기동 직후 VRAM | used 7499 / **free 285 MiB** | llama-server 가 이미 7278 MiB 를 먹고 있다 |
| Chrome **GPU 켜고** 기동 | **측정하지 않음** | 여유 285 MiB 에서 컴포지터 버퍼를 얻는 순간 OOM 이 뻔하다. **예측 가능한 실패는 시도하지 않는다** |
| Chrome **GPU 끄고** 기동(6초) | used 7499 → 7509 (**+10 MiB**) | 브라우저의 VRAM 점유는 사실상 0 |
| `nvidia-smi --query-compute-apps` | **chrome 항목 없음** | GPU 컨텍스트 자체가 없다 |
| CDP `SystemInfo.getInfo` | `glRenderer: "Disabled"`, `featureStatus.webgl: "disabled_off"` | **확정 판정 수단**(§4.7.5) |
| 대조군(플래그 없음) | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`, `webgl: "unavailable_software"` | **상태가 다르다** — 즉 플래그가 실제로 효과가 있다 |

- free 285 MiB 라는 것은 **"모델이 이미 올라간 상태"** 다. 브라우저는 그 위에 컴포지터
  버퍼·셰이더 캐시를 요구한다. 여기서 "가속 유지"는 **모델을 죽이거나 창을 죽이는 선택지**다.
- **헤드리스 E2E 브라우저는 원래 GPU 없이 돈다**(SwiftShader). `off` 모드는
  테스트 환경의 기본 동작과 **같다** — 개발/테스트와 실사용이 갈라지지 않는다.

#### 4.7.2 GPU 모드 3단계 (`browser.gpuMode`)

| 모드 | 조건 | GPU | 기본 | 비고 |
|---|---|---|---|---|
| **`off`** | 모델이 GPU 를 씀. 실측 free − 모델 예상 점유 < 1.5 GiB | **전부 끔** | ✅ **기본값** | §4.6 표의 예산 0 |
| `budgeted` | 모델이 GPU 를 쓰고 여유가 ≥ **1.5 GiB** | 켬 + 예산 플래그만 | 자동 판정 가능 | 12~24 GiB 카드 |
| `full` | 모델이 CPU 전용(`-ngl 0`) 또는 GPU 없는 머신 | 켜고 그대로 | 자동 | CPU 모델은 GPU 를 먹지 않는다 |

- **판정은 `decideGpuMode(hw, tuning)` 한 함수에만 있다.** 다른 곳에서 분기하지 않는다.
  ```
  1) 설정이 명시하면 그 값 (사용자 우선)
  2) 모델이 GPU 를 쓰지 않으면 'full'
  3) 실측 free − 모델 예상 점유 ≥ 1.5 GiB 면 'budgeted'
  4) 그 외(가장 흔함) 'off'
  ```
- **모드 변경은 다음 기동에 적용된다.** Chrome 플래그는 프로세스 시작 인자라 실행 중
  바꿀 수 없다. 설정 화면은 **"다시 시작하면 적용됩니다"** 배너를 띄우고,
  지금 재시작할지 선택하게 한다. **적용되지 않은 변경을 "적용됨"으로 표시하지 않는다.**
- **모드와 근거는 항상 보인다**(`/api/gpu`, 설정 화면, 로그 패널 이벤트).
  "왜 내 화면이 느린데"라는 질문에 답할 수 있어야 한다.
- 모드 판정 결과는 `state/browser-gpu.json` 에 기록하고 다음 실행에 **사용자에게 다시 묻는다**
  (조용히 재판정하지 않는다 — 환경이 바뀌었을 수 있다).

#### 4.7.3 `off` 모드의 정확한 플래그 (최적 세트)

`browserFlags.ts` 가 **모드에 따라 같은 배열을 재사용**한다. 서로 다른 곳에서 플래그를
따로 붙이면 모드가 서로를 무력화한다 — 초기안에서 실제로 그랬다.

```bash
# ── GPU 전면 차단 (off 모드의 핵심) ───────────────────────────────
--disable-gpu                        # 하드웨어 GPU 경로의 총 스위치. VRAM 점유 0
--disable-gpu-compositing            # GPU 컴포지팅 차단(CPU Skia 로 대체)
--disable-gpu-rasterization         # GPU 래스터라이저 차단
--disable-software-rasterizer        # SwiftShader 등 소프트웨어 GPU 배제
                                      # ← 이게 없으면 GPU 없이도 software GL 이 살아난다
--disable-accelerated-2d-canvas      # 캔버스 2D GPU 경로 차단(모니터 패널이 캔버스 사용)
--disable-accelerated-video-decode   # 하드웨어 디코더 미사용(VA-API 점유 방지)
--disable-features=Vulkan,VaapiVideoDecoder,AcceleratedVideoDecodeLinuxGL,DefaultANGLEVulkan
# ── 프로세스 · 메모리 ─────────────────────────────────────────────
--renderer-process-limit=1           # 렌더러 상한
--js-flags=--max-old-space-size=2048 # 탭 JS 힙 상한(§4.7.4 와 함께 결정)
```

| 플래그 | 왜 이 조합인가 |
|---|---|
| `--disable-gpu` | 하드웨어 GPU 경로의 총 스위치. 이것 하나로 텍스처·셰이더·컴포지터 버퍼가 사라진다 |
| `--disable-software-rasterizer` | **가장 빠뜨리기 쉬운 항목.** 이것이 없으면 GPU 를 꺼도 SwiftShader 가 올라와 GPU 프로세스가 살아난다. 두 플래그의 **차이**가 실측 표의 `Disabled` vs `ANGLE (SwiftShader)` 다 |
| `--disable-gpu-compositing` / `--disable-gpu-rasterization` | 드라이버에 따라 남는 경로를 막는다. `--disable-gpu` 단독보다 **명시적으로 함께** 넣어야 재현성이 있다 |
| `--disable-accelerated-2d-canvas` | §5.5 모니터 패널은 Canvas 2D 다. GPU 경로가 남으면 **여기만 조용히 GPU 를 건드린다** |
| `--disable-accelerated-video-decode` | VA-API 도 카드의 VRAM 을 점유한다. 스크린샷·영상 미리보기에서 모델 VRAM 을 깎는다 |
| `--disable-features=Vulkan,…` | **Vulkan 은 스위치가 아니라 feature 다.** `--disable-vulkan` 은 **존재하지 않는 플래그**라 조용히 무시되어 "설정한 것처럼 보이지만 효과가 없는" 상태가 된다. `Vulkan`·`VaapiVideoDecoder`·`AcceleratedVideoDecodeLinuxGL`·`DefaultANGLEVulkan` 는 각각 다른 경로(ANGLE / 디코더 / ANGLE 백엔드)를 막는다 |
| `--renderer-process-limit=1` | 렌더러 수를 낮춰 **시스템 RAM** 절약. VRAM 은 이미 0 이다 |

- **플래그 합성 규칙 (초기안의 실제 버그)**
  - `--disable-features` 는 **항상 한 번만** 준다. Chromium 의 `CommandLine` 은 같은 키를
    **덮어쓴다**(§4.1). 두 번 주면 앞의 것이 사라진다.
  - `off` 의 feature 목록은 **기본 목록에 병합**한다. Vulkan 항목만 따로 주고
    `Translate,MediaRouter` 를 다른 곳에서 주면 **절반만 꺼진 상태**가 된다.
    `buildFeatures(mode)` 한 함수에서 합친다.
  - **같은 플래그를 두 번 넣지 않는다.** `launchFlags()` 가 자체 검증하고 위반하면
    **부팅을 중단하고 로그에 남긴다.** 조용히 틀린 설정으로 뜨면 안 된다.
- **절대 넣지 않는 플래그**

  | 금지 | 이유 |
  |---|---|
  | `--no-sandbox` | §3.6 보안 경계 전체가 무효화된다. 컨테이너 예외는 `chromeExtraArgs` 로 명시적으로만 |
  | `--disable-web-security` | CORS 검사 제거. §3.6 과 정면 충돌 |
  | `--allow-running-insecure-content` | 로컬 http 위에 실드컨텐츠를 허용하면 Origin/토큰 방어가 구멍 난다 |
  | `--single-process` | 크래시 지옥. 원인 추적이 불가능해진다 |
  | `--use-gl=swiftshader` | **"GPU 없는 브라우저"로 오해하기 쉬운 함정.** 소프트웨어 GL 을 **켜는** 플래그라 GPU 프로세스가 살아난다. 끄는 것은 `--disable-software-rasterizer` 다 |

#### 4.7.4 대신 치르는 비용 — 이게 "최적"의 나머지 절반이다

GPU 를 끄는 것은 공짜가 아니다. **VRAM 절약분을 시스템 RAM 과 CPU 픽셀로 지불한다.**
같은 창을 GPU off 로 띄웠을 때의 실측(2026-09-29, 개발 머신).

| 비용 항목 | 실측값 | 대응 |
|---|---|---|
| 프로세스 총 RSS | **약 1.54 GiB** (브라우저 270 MB · GPU 프로세스 184 MB · 렌더러 4개 105~172 MB · 유틸리티 4개 52~124 MB) | `--renderer-process-limit=1` + Monaco 워커 1개 + 로그 상한(§5.12.2) |
| Chrome 프로세스 수 | **16개** (브라우저 1 · GPU 1 · 렌더러 4 · zygote 3 · 유틸리티 4 · 기타) | 앱 모드는 탭이 하나이므로 렌더러가 여러 개인 것은 정상. **GPU 프로세스는 제거되지 않고 남는다** |
| GPU 프로세스 RSS | 184 MB (GPU 를 쓸 때와 큰 차이가 없다) | 절약되는 것은 **VRAM** 이다. RAM 은 그대로 든다 — 이 구분을 문서와 UI에 **둘 다** 적는다 |
| 스크롤 · 애니메이션 | 소프트웨어 래스터 = CPU 픽셀 작업 | §5.9 모션 예산 축소 · `will-change` 남용 금지 · blur/그라디언트 최소화 |
| 시각 품질 | 색수차/안티앨리어싱 저하 가능 | `--force-color-profile=srgb` + 시스템 스케일 유지로 선명도 확보(§5.9) |
| WebGL | **사용 불가** | 이 프로젝트는 WebGL 을 쓰지 않는다(Monaco·미니맵·게이지 = DOM/Canvas 2D). **WebGL 로 무언가를 그리기 시작하면 `off` 모드에서 깨진다** → 금지(§5.5) |
| 병목 이동 | GPU 가 아니라 **CPU 코어** 가 경쟁한다 | llama-server 스레드 수(§6.3)와 브라우저 렌더 비용을 함께 본다. 여유는 코어 수에만 있다 |

- **이 비용을 사용자에게 숨기지 않는다.** 설정 → 브라우저 화면에
  `GPU: 꺼짐 — 모델 VRAM 약 700 MiB 확보 / 편집기 스크롤이 느려질 수 있음` 을 표시한다.
- **느려진다고 말하려면 먼저 재야 한다.** 5만 줄 스크롤 프레임 예산을 §10.4 성능 예산에
  넣고 `off` / `full` 두 모드에서 각각 측정해 기록한다. 추정으로 단정하지 않는다.

#### 4.7.5 검증 (설정한 것과 실제로 된 것의 차이를 잡는다)

플래그를 넣었다고 GPU 가 꺼진 게 아니다. **드라이버가 무시할 수 있다.** 4중으로 확인한다.

| # | 확인 | 방법 | 통과 기준 |
|---|---|---|---|
| 1 | **CDP** | `SystemInfo.getInfo` → `gpu.auxAttributes.glRenderer` | `=== "Disabled"` |
| 2 | 기능 상태 | 같은 응답의 `gpu.featureStatus.webgl` | `=== "disabled_off"` |
| 3 | OS | `nvidia-smi --query-compute-apps=pid,used_memory` | **chrome 항목이 없어야 함** |
| 4 | **대조군** | 같은 머신에서 `full` 로 잠깐 띄워 비교 | `glRenderer !== "Disabled"` — 대조가 없으면 검증이 아니다 |

- 검증 실패 시(플래그를 넣었는데 `glRenderer` 가 `Disabled` 가 아님):
  1. 로그에 `GPU 비활성 확인 실패 — 현재 드라이버/플래그 조합` 을 남긴다.
  2. 사용자에게 **`budgeted` 로 바꾸는 선택지**와 "이 조합은 검증되지 않았습니다"를 보여준다.
  3. **조용히 넘어가지 않는다.** "설정됨"과 "동작함"을 같은 표시로 하지 않는다(§13).
- GPU 모드 변경은 **이벤트로 로그 패널에 남긴다**(누가 · 언제 · 무엇으로 · 근거).
  모드가 바뀌면 재검증한다.

### 4.8 에이전트의 브라우저 도구에도 같은 정책을 적용한다

§5.11 의 `browser_*` 도구는 **별도의 브라우저 세션**을 쓴다. 여기까지 규칙이 적용되지
않으면 "창 하나"가 아니라 "창 + 도구 브라우저"가 같은 카드를 **더** 쓴다.

- `browser.*` 세션에도 **동일한 GPU 모드**를 적용한다(기본 `off`, 헤드리스).
- **동시에 두 개 이상 띄우지 않는다.** 병렬 브라우저 호출은 **직렬 큐**로 돌리고,
  사용 중이면 "브라우저 사용 중"으로 대기시켜 그 사실을 블록에 표시한다.
- 스크린샷(`Page.captureScreenshot`)은 `off` 모드에서도 **정상 동작한다**
  (GPU 렌더가 없으면 소프트웨어 렌더 결과를 캡처할 뿐). E2E 스크린샷 회귀(§10.4)가
  이 경로의 실측 증거가 된다.
- 도구 브라우저는 **사용이 끝나면 즉시 종료**한다. 남겨두면 VRAM/RAM 이 새는 자리다.

---

## 5. 웹 IDE 화면 요구사항 (요구 3, 4, 6, 7, 11, 17)

### 5.0 레이아웃 개요

```
┌──┬──────────────────┬────────────────────────────────────┬──────────────┐
│A │  파일 트리        │  중앙: Monaco Editor (탭)          │  우: Chat     │
│c │  (또는 Search)    │                                    │  ────────────│
│t │                  │  ┌ 탭바 ──────────────────────┐    │  에이전트 스트림│
│i │  📁 프로젝트      │  │ main.ts  diff:foo.ts  ⚙    │    │  ▸ Think …   │
│v │   ▾ src           │  └────────────────────────────┘    │  ▸ tool: read │
│i │     main.ts       │                                    │  ▸ diff 블록  │
│t │     diff.ts       ├────────────────────────────────────┤  ▸ run: test  │
│y │                   │  패널 영역(도킹 가능)               │              │
│Bar│                  │[터미널][문제][출력][모니터][서버로그] │  ────────────│
│  │                  │  ┌ 시스템 모니터 (애니메이션) ──┐   │  입력창       │
│  │                  │  │ CPU ▓▓▓░ 42%  RAM ▓░ 61%... │   │  ▸ 전송      │
└──────────────────────────────────────────────────────────────────────┘
```

- 모든 패널은 **도킹 가능**하며, 레이아웃은 `.harnesside/layout.json` 에 저장·복원된다.
- 최소 폭 강제: 트리 200px, 채팅 320px, 중앙 480px. 전체 창이 1100px 미만이면
  트리/채팅이 오버레이드로 전환(좁은 화면에서 3열은 쓸모가 없다).
- **하단 패널 5개**: 터미널 · 문제 · 출력 · 시스템 모니터 · **서버 로그(§5.12)**.
  기본 선택은 **서버 로그** — 서버가 데몬이라(§3.7) 이 패널이 유일한 상태 창이고,
  부팅 단계부터 마지막까지 끊기지 않는다. 탭은 접을 수 있으나 **닫으면 안 된다**
  (닫으면 "멈췄다/없어졌다"로 오해된다).

### 5.1 코드 출력 · 에디터 (요구 3)

- **Monaco** 를 사용한다. 개별 하이라이터를 조합하지 않는 이유: 접기(folding), 인덴트 규칙,
  가로 나란한 diff 뷰, 미니맵, 브래킷 매칭, 다중 커서, 검색/치환을 직접 만들면
  "IDE처럼"의 수준에 도달하지 못한다.
- 언어: 파일 확장자 기반 자동 감지 + 수동 강제(우측 하단 상태바 클릭).
  기본 포함: ts/js/tsx/jsx/json/md/yaml/sh/py/rs/go/java/c/cpp/h/html/css/sql/shell/gguf-metadata.
- **그룹핑과 접기/펼침 (요구 3)**: 아래 3단계로 통일한다.
  1. **에디터 접기**: Monaco 기본 folding + `foldingStrategy: 'indentation'` +
     커서 주변 자동 펼침(`unfoldOnSelection`).
  2. **블록 접기**: 에이전트 출력·도구 결과·로그 등 모든 스트림 항목을
     `<FoldableBlock>` 컴포넌트로 통일. 접힘 상태는 `id` 기준 `Set`으로 관리되어
     **재렌더에도 유지**된다(전역 상태로 승격).
  3. **중첩 접기**: 블록 안에 블록이 있을 수 있음(예: 턴 > 도구 > diff).
     재귀 지원, 접힌 블록은 1줄 요약 + 건수/바이트 수만 표시.
- 접힘 요약 라벨 규칙:
  - reasoning → `▸ 사고 과정 · 1,240자`
  - tool 호출 → `▸ read_file src/a.ts · 1,204자`
  - diff → `▸ diff src/a.ts · +12 −3`
  - 컴팩션 → `▸ 컴팩션 · 18,204 → 6,021 토큰`
- 접기 상태는 `.harnesside/state/ui-state.json` 에 세션 간 유지.

### 5.2 가로 diff (요구 3 — "세로가 아닌 가로 비교")

- Monaco `DiffEditor` 를 **기본 가로(side-by-side) 모드**로 연다.
  - 좌: 이전 내용(원본/HEAD), 우: 새 내용(버퍼).
  - 줄 전체에 `lineNumbers` + 변경 라인 강조 + 문자 단위 인라인 차이.
  - `renderSideBySide: true` 가 기본값. 한 화면에 좁을 때만 자동으로 인라인 모드 폴백
    (폭 < 900px) — **사용자 설정을 우선**한다.
- diff 소스 3종을 구분한다:
  | 종류 | 좌측 | 우측 | 트리거 |
  |---|---|---|---|
  | 파일 변경 | 디스크 내용 | 편집기 버퍼 | `chokidar` 감지 / 저장 충돌 |
  | Git 변경 | HEAD | 워킹트리 | Git 패널에서 파일 선택 |
  | 도구 diff | `read_file` 이전 | `write_file` 이후 | `agent.tool.result` |
- `src/tools/diff.ts` 의 LCS 결과를 **통계(추가/삭제 라인 수, 변경 hunks)** 로 재사용한다.
  렌더링은 Monaco에 맡기고, 우리 코드는 "무엇이 왜 바뀌었는가"의 메타만 제공한다.
- 두 열이 들어가지 않는 좁은 폭에서는 "확장" 버튼으로 **전체 화면 diff 모드** 진입(단축키 `Ctrl+Alt+D`).

### 5.3 Think 애니메이션 (요구 6)

- 모델이 `reasoning_content` 델타를 내보내면, **답변 텍스트보다 앞에** thinking 블록이 열린다.
- 블록 머리 표시:
  - **기본 애니메이션**: 3개의 파동 도트(`● ● ●`)이 순차적으로 스케일/투명도 변화(1.2s 주기).
  - **대안(설정 `think.style`)**: `pulse`(원형 맥동) / `orbit`(회전 위성) /
    `shimmer`(텍스트 흘러감) / `bar`(계속 늘어나는 진행 바).
  - `prefers-reduced-motion: reduce` 이면 **애니메이션 정지**하고 텍스트만 표시.
- 동시에 표시되는 정보(다크 글씨로, 과하지 않게):
  - 경과 시간(1초 단위)
  - 누적 사고 토큰 수
  - 현재 추론 속도(tok/s)
- **중요 (원본 실측에서 확인된 함정)**: 원본 `config.ts` 는 thinking을 기본 OFF로 두었다.
  이유는 실측 — 420토큰 예산에서 thinking을 켜면 **사고에 예산을 전부 써서 tool_call이
  하나도 나오지 않았다.** UI를 만들면서 이 사실을 잊으면 "생각만 하다가 아무것도 안 하는"
  버그를 그대로 재현한다.
  - 기본값은 **`enableThinking: false` 유지**하되, UI에서 켤 때 **경고를 함께 표시**한다:
    "이 모델은 thinking을 켜면 max_tokens를 사고에 모두 사용해 도구 호출이 누락될 수
     있습니다. 필요하면 reasoning_budget 상한을 함께 지정하십시오."
  - 켰을 때 **사고 토큰 예산 상한**(`think.maxReasoningTokens`, 기본 1024)을 강제하고,
    초과하면 자동으로 thinking을 끄고 **강제 도구 호출 모드**로 전환한다.
    구현은 OpenAI 호환 `tool_choice: "required"` 로 표현된다(llama-server 가 지원).
    - **전환이 실제로 일어나는지 테스트한다**: 사고 토큰만 가득 찬 응답을 모킹해 넣고,
      다음 요청의 `tool_choice` 가 `"required"` 인지, 모델이 도구를 안 고르면
      **2회 재시도 후 명확한 오류로 끝내는지** 확인한다(무한 재시도는 금물).

### 5.4 자석(Magnet) 윈도우 도킹 (요구 4)

요구 4의 "가운데/오른쪽/왼쪽/상/하" 분리 운영을 **도킹 레이아웃 엔진**으로 구현한다.

**드롭 존** (드래그 중 하이라이트됨):

| 존 | 위치 | 결과 |
|---|---|---|
| 좌 | 좌측 20% | 왼쪽 도크 (트리가 새 창/패널로 이동) |
| 우 | 우측 20% | 오른쪽 도크 |
| 상 | 상단 20% | 상단 도크 (탭 바 영역 아래) |
| 하 | 하단 20% | 하단 도크 (패널 영역) |
| 중앙 | 그 외 | 플로팅 팝오버 (독립 창) |

- **자기 진화하는 자석**: 어떤 패널을 N회 자석 배치하면 그 자리에 대한 **드롭 존이
  우선순위를 가진다**(개별 오버라이드 설정으로 해제 가능). 자주 쓰는 배치를 손에 익도록.
- **분리 운영(Detach)**: 드래그 중 패널 헤더에 `⤢` 스냅 포인트가 뜨고, 여기에 놓으면
  패널이 **독립 팝오버 창**으로 분리된다. 다른 패널 위에 뜬 오버레이가 아니라
  별도 좌표·별도 상태·뒤로 보낼 수 있는 실제 분리 창.
- **제어 포인트**:
  - `드래그 중 자석 존 하이라이트(0.9s ease) + 미세 진동/스케일 1.02`
  - `스냅 확정 시 180ms spring 애니메이션`
  - `분리/복귀 시 220ms 크로스페이드`
- **레이아웃 영속화**: 드롭/분리/크기 변경마다 `.harnesside/layout.json`에 디바운스 저장(300ms).
  다음 실행 시 복원. 창 크기가 복원된 창보다 좁으면 비율 기반으로 클램프.
- **접근성**: 드래그만으로 못 하는 경우를 위해 `Alt+방향키`로 포커스된 패널을
  해당 방향으로 이동시키는 키바인딩을 반드시 제공한다(§5.8).
- 실제 **OS 레벨 창 분리**가 필요하면(선택 기능, `docking.nativeWindows: true`):
  `window.open()`으로 새 창을 열고 CDP `Browser.setWindowBounds`로 위치를 동기화하며,
  두 창 사이 상태는 `BroadcastChannel`로 공유한다. **기본값은 꺼짐**(복잡도 대비 이득이 낮다).

### 5.5 시스템 모니터 패널 (요구 11)

- **계측 항목**: CPU 전체/코어별, RAM(used/available/swap), VRAM(used/total),
  GPU(사용률·온도·전력·클럭, nvidia-smi), 디스크(용량·I/O), **컨텍스트 사용량**, 토큰 속도.
- **수집 주기**: 서버 1초 샘플 → `sys.metrics` WS 브로드캐스트. **서버는 절대
  요청당 계측하지 않는다**(계측 자체가 부하가 된다).
- **표시 형태** (모두 애니메이션):
  | 형태 | 설명 |
  |---|---|
  | **도넛/링 게이지** | CPU·RAM·VRAM·컨텍스트. 0→N%로 그려지며 수치도 함께 카운트업 |
  | **스파크라인** | 최근 60초 추이(120샘플 링버퍼) |
  | **바** | 디스크, GPU 온도/전력 |
  | **코어 히트맵** | 코어 0~N 개별 사용률 격자 |
- **애니메이션 규칙 (성능 필수)**:
  - 값은 `requestAnimationFrame` + **easing 보간**(150~250ms)으로 움직인다.
    1초에 1번 값이 바뀌는데 250ms 보간을 건너뛰면 눈이 거슬린다.
  - **DOM 위젯을 1Hz로 재생성하지 않는다.** SVG/Canvas는 ref로 직접 갱신하거나,
    리액트는 값의 **버킷**이 바뀔 때만 리렌더(예: 0.1% 단위)한다.
  - 패널이 접히거나 탭이 비활성(`visibilityState: hidden`)이면 갱신을 **중단**한다.
  - `prefers-reduced-motion` 시 보간 없이 즉시 반영.
- 임계치 색상: <70% 정상, 70~90% 주의, >90% 경고(색만 바꾸고 점멸시키지 않는다 —
  깜빡임은 접근성/눈부심 문제).
- **컨텍스트 게이지와 컴팩션 연동**: 80% 초과 시 게이지 옆에 "컴팩션 임박" 표시,
  자동 컴팩션이 돌면 애니메이션으로 게이지가 줄어드는 연출.

### 5.6 에이전트 스트림 · 블록 (요구 7)

- 모든 에이전트 출력은 **블록** 단위로 관리한다.

```ts
interface Block {
  id: string;            // 안정 ID (같은 도구 재호출 시 버전 증가)
  kind: "user" | "reasoning" | "text" | "tool" | "diff" | "run"
      | "plan" | "note" | "compaction" | "error" | "log";
  title: string;
  status: "pending" | "running" | "ok" | "error" | "aborted";
  version: number;       // 갱신마다 증가 — UI는 version이 바뀔 때만 리렌더
  createdAt: number;
  updatedAt: number;
  collapsed: boolean;
  content: unknown;      // 종류별
}
```

- **병렬 처리 표시**: 서버는 도구 호출을 **동시에 여러 개** 실행할 수 있어야 하고
  (요구 7 "병렬"), 각 실행은 **자기 블록**에서 **독립적으로** 갱신된다.
  - 블록은 **완료 순서가 아니라 시작 순서**로 정렬(안정 정렬) — 위치가 튀지 않는다.
  - 각 블록은 `useMemo`/`React.memo`로 격리되어, A가 갱신될 때 B는 리렌더되지 않는다.
  - 스트리밍 텍스트는 **문자 단위 DOM 갱신이 아니라 50ms 버퍼 + rAF 커밋**으로
    (초당 20회 리렌더 상한).
  - 실행 중인 블록에는 스피너, 완료 후에는 소요시간/결과 요약.
- **부분 갱신 계약**: 서버는 `agent.block.delta` 로 **_patch_** 를 보낸다
  (`{blockId, version, ops:[{type:"appendText", text} | {type:"setStatus", ...}]}`).
  클라이언트는 **전체 블록 재전송을 받지 않는다**. 대용량 `run_shell` 출력이
  10MB에 이르더라도 네트워크와 리렌더는 마지막 N줄만 건드린다.
  - 각 블록은 **가상 스크롤**(또는 출력 상한 2,000줄 + "전체 보기" 확장)한다.
  - 도구 출력이 2,000줄을 넘으면 **원본은 서버가 보관**하고 UI는 앞/뒤만 보여준다.
- **자동 스크롤**: 사용자가 끝까지 스크롤해 있으면만 따라간다. 위로 스크롤한 순간
  자동 추적을 멈추고 "새 출력 ↓" 버튼을 띄운다(붙잡고 있으면 놓치는 일이 없어야 한다).

### 5.7 채팅 입력 · 명령

- 하단 고정 입력창. 멀티라인(`Shift+Enter`), 붙여넣기 대용량 처리(칩 표시),
  히스토리(`↑/↓`), 자동 저장 드래프트.
- 슬래시 명령 팔레트: 원본 `src/tui/SlashMenu.tsx` 의 항목 목록을 **웹 명령 팔레트로
  이전**한다(한 벌의 정의를 양쪽이 공유하도록 `src/commands/registry.ts` 로 추출 권장).
  - 명령은 `{id, title, category, shortcut, run(ctx)}` 형태.
  - `Ctrl+Shift+P` 커맨드 팔레트, `/` 슬래시 메뉴(입력창 안에서 자동완성).
  - **명령 팔레트에 반드시 포함** (화면 밖에 있는 기능은 없는 기능이다):
    `/update` 업데이트 확인·적용, `/rollback` 이전 버전으로, `/version` 버전 정보,
    `/logs` 로그 패널 열기, `/gpu` GPU 모드 확인, `/watch` 구독 저장소 관리,
    `/daemon` 데몬 상태 확인.
- 입력창 우측에 현재 **모델 이름**과 **컨텍스트 게이지 미니**를 표시.

### 5.8 키바인딩

`src/commands/registry.ts` 가 단일 정본. `Ctrl/⌘` = `mod`.

| 키 | 동작 |
|---|---|
| `mod+Enter` | 전송 / `mod+Shift+Enter` 전송+개행 |
| `mod+P` | 파일 빠른 열기(fuzzy) |
| `mod+Shift+P` | 커맨드 팔레트 |
| `mod+Shift+F` | 워크스페이스 전체 검색 |
| `mod+B` | 사이드바 토글 |
| `mod+\`` | 하단 패널(터미널/모니터/로그) 토글 |
| `mod+K` | 채팅/편집기 포커스 전환 |
| `mod+W` | 탭 닫기 |
| `mod+Alt+←/→` | 탭 이동 |
| `mod+Alt+D` | 전체 화면 diff |
| `Alt+←/→/↑/↓` | **포커스 패널을 해당 방향 도크으로 이동** (드래그 대안, §5.4) |
| `mod+,` | 설정 화면 (§5.13) |
| `mod+Shift+U` | **업데이트 확인** (§5.13.1) — 메뉴 탐색 없이 곧바로 |
| `mod+Shift+L` | 서버 로그 패널 포커스 (§5.12) |
| `mod+Shift+N` | 알림 목록 열기 (§5.13.2) |
| `Esc` | 현재 턴 중단 / 팝업 닫기 |
| `F8` | 포커스 패널 접기/펼치기 |

- 모든 단축키는 설정에서 재바인딩 가능하며, `?` 키로 단축키 목록을 IDE 안에서 본다
  (원본 `/help` 의 웹 버전).

### 5.9 스타일 (요구 17 — "개발자 IDE 형태")

- **테마**: 기본은 VS Code 계열 다크 테마(`#1e1e1e` 계열) + 밝은 테마 제공.
  Monaco 테마와 앱 셸 테마를 **같은 토큰 집합**으로 정의해 한 곳에서 바꾼다.
  (`src/web/theme/tokens.ts`)
- 폰트: `ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, monospace`, 13px, `line-height: 1.5`.
  **한글 렌더링**: `-apple-system, 'Noto Sans KR', 'Malgun Gothic', sans-serif` 폴백.
  동아시아 너비 때문에 줄 정렬이 깨지지 않는지 전 화면에서 확인한다(원본 TUI가
  East Asian Width 문제를 실제로 겪었다).
- **색상 규약**:
  - 성공/추가 `#3fb950`, 삭제/에러 `#f85149`, 경고 `#d29922`, 정보 `#58a6ff`,
    사고(think) `#a371f7`, 도구 `#79c0ff`.
  - 색상만으로 의미를 전달하지 않는다(색맹 대응): 삭제 줄에는 `−`, 추가 줄에는 `+`,
    에러에는 아이콘 + 텍스트 라벨 병행.
- **밀도**: IDE는 정보 밀도가 핵심이다. 여백을 넓히지 않는다. 행 높이 1.5, 패널 패딩
  8~12px, 구분선 1px `#30363d`.
- **모션**: 전체적으로 짧고(120~220ms) `cubic-bezier(.2,.8,.2,1)`. 과한 바운스/기울임 금지.
  패널 전개, 게이지 보간, 접기, 자석 스냅만 애니메이션.
- **GPU off 모드에서 지켜야 할 렌더 예산** (§4.7.4 의 비용을 UI 규칙으로 번역):
  - `backdrop-filter`, `filter: blur()`, `box-shadow` 의 큰 blur, 넓은 면의 그라디언트는 **금지**.
    소프트웨어 래스터에서 프레임 예산을 가장 많이 먹는 것이 이것들이다.
  - `will-change` 를 남발하지 않는다. **애니메이션 중인 요소에만** 붙이고 종료 시 제거.
  - 텍스트 그림자·서브픽셀 안티앨리어싱에 의존한 효과를 피한다.
  - 그림자 대신 **1px 보더**를 쓴다(§5.9 밀도 규칙과도 일치).
  - 텍스트 그림자·서브픽셀 안티앨리어싱 의존 효과가 적은 팔레트를 쓴다.
  - 애니메이션 프레임 예산: 패널 드래그 60fps(§10.4), 그 외는 **30fps 로 충분하다고 간주**한다.
    이 선택을 사용자에게 "성능 모드"로 노출할지 여부는 §11 판단 사항.

### 5.10 대화 · 세션 영속화 (창이 아니라 "세션"이 단위다)

- CLI 는 프로세스 = 세션이었다. 웹에서는 **프로세스는 오래 살고 탭은 닫혔다 다시 열린다.**
  이 차이를 명시적으로 다뤄야 안 된다.
- **저장 대상**: 메시지(역순), 도구 호출·결과, plan, note, 컴팩션 이력, 블록 접힘 상태.
  `.harnesside/state/sessions/<sessionId>.json` 에 **디바운스 저장**(1초).
- **복구 시점 3곳**:
  1. 페이지 새로고침(F5 / 창 재시작) → 마지막 저장된 세션 자동 로드
  2. 탭을 닫았다가 서버가 살아 있는 동안 재접속 → 동일 세션 이어가기
  3. 서버 재시작 → `.harnesside/state/` 의 체크포인트 + 마지막 세션으로 복원
- **WS 재연결**과 구분: WS 재연결은 **메모리 상태**를 유지하므로 세션을 재적재하지 않는다.
  페이지 새로고침만 디스크에서 읽는다. 이 둘을 섞으면 스트리밍 도중 화면이 통째로 바뀐다.
- **세션 목록 UI**: 과거 세션 열람·이어하기·삭제·이름 붙이기. 워크스페이스별로 분류.
- **대용량 세션 보호**: 세션 파일이 수십 MB가 되면 gzip 으로 압축하고,
  도구 결과는 앞/뒤 요약만 남기고 전문은 별도 파일로 분리(§5.6 과 동일 원칙).
- **취소 후 재개**: 중단한 턴의 부분 응답도 블록 단위로 남긴다.
  새로고침해도 "어디까지 했는지"가 사라지지 않아야 한다.

### 5.11 신규/확장 도구 목록 (요구 2·7·12)

기존 11종(`read_file`/`write_file`/`append_file`/`edit_file`/`run_shell`/`note`/
`update_plan`/`load_skill`/`browser_*` 4종)에 추가한다. **각 도구는
§3.6 의 승인 게이트 정책과 §2.3 의 블록 이벤트를 함께 구현한다.**

| 도구 | 용도 | 승인 | 비고 |
|---|---|---|---|
| `list_dir` | 디렉토리 1단계 목록 | 자동 | `fs/tree.ts` 재사용, 깊이 1 고정 |
| `search_files` | glob/정규식 파일·내용 검색 | 자동 | 결과 상한(기본 200) 명시, 대형 저장소 보호 |
| `move_file` / `copy_file` | 이동·복사 | 자동 | 목적지가 루트 밖이면 거부(§3.4) |
| `delete_file` | 삭제 | **승인 필수** | 휴지통 경유(`.harnesside/trash/`), 즉시 삭제가 아님 |
| `create_dir` | 디렉토리 생성 | 자동 | `write_file` 의 상위 생성으로도 충분하나 명시적으로 제공 |
| `start_process` | **백그라운드 프로세스** (요구 7) | **승인 필수** | 블록 ID 반환, 취소 가능, 종료/재출력 지원 |
| `read_process_output` | 백그라운드 프로세스 출력을 한 줄씩 | 자동 | 긴 출력을 오프셋으로 이어 읽기 |
| `stop_process` | 백그라운드 프로세스 종료 | **승인 필수** | |
| `apply_patch` | 멀티 파일 단일 패치 적용 | 자동 | 하나의 논리적 변경을 원자적으로. 중간 실패 시 전체 롤백 |
| `git_status` / `git_diff` | 변경 조회 | 자동 | §5.2 가로 diff 로 시각화 |
| `git_commit` | 커밋 | **승인 필수** | 메시지 미리보기 후 확정 |
| `request_approval` | 모델이 승인을 요청 | — | 승인 게이트 UI 호출(§3.6) |

- **도구 스키마 토큰 비용 관리**: 원본 실측에서 **브라우저 도구 4종의 스키마만으로
  1,238 토큰(16,384 윈도우의 7.6%)** 이 매 요청마다 발생했다. 이 프로젝트는 도구가
  20종이 넘으므로:
  - **기본 비활성** 도구 그룹을 두고(예: `git_*`, `start_process`, MCP),
    `browser.*`/`git.*`/`process.*`/`index.*` 네 개의 on/off 스위치를 설정에 노출한다.
  - **`activeToolDefs()` 하나만 진실원으로** 쓴다. 토큰 추정과 실제 전송이
    다른 리스트를 쓰면 실측이 19%씩 어긋난다(원본에서 실제로 겪은 사례).
  - 활성 도구 스키마 비용을 **상태바에 상시 표시**한다(사용자가 비용을 보고 결정하게).
- **스키마 자체도 압축한다**: 설명이 긴 도구는 예시를 줄이고, 자주 안 쓰는 도구는
  매개변수 설명을 한 줄로. 설명 길이 × 호출 빈도의 합을 기준으로 다듬는다.

### 5.12 서버 로그 패널 — 프로그램 디버깅 창 (요구: 상시 출력)

> **요구**: "브라우저의 하나의 패널에서 프로그램 디버깅 창의 출력이 상시 된다."
> 서버가 데몬이라(§3.7) 터미널에 붙어 있을 사용자가 없다. **이 패널이 곧 터미널이다.**
> 요구 11(모니터)이 "수치"를 보여준다면, 이 패널은 **원인과 내부를** 보여준다.

#### 5.12.1 소스 — 무엇이 이 패널에 들어오는가

- **위치**: 하단 패널 영역의 **"서버 로그" 탭**(§5.0). 기본 선택 탭이며 닫을 수 없다.
- **볼 수 있는 것 3가지** (표시 형식은 다르지만 같은 패널):
  1. **서버 로그** — 부팅 12단계(§3.2), WS 이벤트 수신, 도구 디스패치, 컴팩션,
     세션 저장, 에이전트 루프 내부 결정. 기본 레벨 `info`.
  2. **`llama-server` 로그** — 자식 프로세스 stdout/stderr 을 **줄 단위로 tee**.
     **모델이 죽는 원인의 99%는 여기에 있다.** 전용 필터와 "에러만" 토글을 둔다.
  3. **브라우저 로그** — CDP 연결/해제, 창 위치 변경, GPU 모드 판정 결과(§4.7.5),
     렌더러 크래시. Chrome 은 `--enable-logging=stderr` 로 자식 프로세스에 붙인다.
  - `run_shell` / `start_process` 출력은 **각 도구 블록(§5.6)에 이미 있으므로 중복 출력하지
    않는다.** 같은 내용을 두 곳에 찍으면 사용자가 어느 쪽을 믿어야 할지 모른다.
#### 5.12.2 상시 출력과 최대 보관 길이

- **상시 출력(핵심 요구)의 구현 조건**:
  - **WS 는 끊기지 않는다.** 로그 전송은 **별도 연결이 아니라 기존 WS** 를 쓴다
    (추가 소켓은 창이 늘 때마다 생기고 사라진다). 백프레셔 5초 + 지수 백오프.
  - **버퍼링 금지.** 서버는 줄을 모았다가 보내지 않고 **즉시 flush** 한다.
    화면이 멈춘 것처럼 보이는 원인이 "로그를 모으는 중"이면 안 된다.
  - **창이 닫혔다 열려도 이어진다.** `epoch + sinceSeq` 로 재접속 시 이어받는다(§2.3).
    새로고침해도 로그 흐름이 끊기지 않는 것이 눈에 보여야 한다.
- **상한 — "일반적인 크기"를 명시한다** (요구사항에서 지정):

  | 항목 | 기본값 | 키 | 근거 |
  |---|---|---|---|
  | **메모리 링 문자 수** | **500,000자** (약 50만 자) | `logging.maxChars` | 화면에 보일 "한 세션 분량". 5,000줄 × 평균 100자. §5.6 의 블록 출력 상한(2,000줄)과 같은 규모감 |
  | 메모리 링 줄 수 | 50,000줄 | `logging.maxLines` | 초장문 로그가 상한을 장악하지 못하게 하는 2차 안전장치 |
  | WS 1회 전송 묶음 | 64 KiB | — | 500ms 버퍼 + 64 KiB 단위로 묶어 보낸다(레이지 패킷 방지) |
  | 디스크 로그 | **5 MiB × 5 회전 = 25 MiB 상한** | `logging.maxFileBytes`, `logging.maxFiles` | 무제한 디스크 로그는 결국 디스크를 채운다(부팅 실패의 2위 원인) |
  | llama-server 로그 | 5 MiB × 3, **오류는 무조건 보존** | — | 회전으로 지워져도 에러 라인은 별도 `errors.ndjson` 에 누적 |
  | **기본 표시 레벨** | `info` (`warn` 이상만) | `logging.level` | `debug` 는 매우 시끄럽다. **기본값을 `warn` 으로 두지 않는다** — 디버깅 창이 비어 있으면 쓸모없다 |

  - **값을 정한 근거를 문서로 남기는 것이 요구다.** 50만 자는 "충분히 크고, 우연히
    1 GB 를 먹지 않는" 값이다. 사용자는 `logging.maxChars` 로 조정할 수 있고,
    **현재 값과 그 출처(기본값/설정/환경변수)는 §6.4 규칙대로 표시**한다.
  - 상한에 닿으면 UI 에 **`이전 N줄이 잘렸습니다 · 전체 보기`** 배너를 **한 번만** 띄운다.
    사용자가 "로그가 멈췄다"고 오해하지 않게 하는 것이 목적이다.
#### 5.12.3 필터 · 조작

- **필터 · 조작** (탐색이 목적인 창이다):
  - 소스 필터(서버 / llama / 브라우저), 레벨 필터(`error` 배지 + 클릭 → 해당 레벨만),
    전문 검색(대소문자 무시, 하이라이트), **자동 스크롤 토글**(끄면 새 줄 카운트 배지).
  - `Ctrl+F` 로 패널 안 검색, `Esc` 로 해제. **행 클릭 → 관련 로그로 점프**가 아니라
    **행 복사 + 해당 `scope` 만 필터** — "이 모듈에서만 본다"가 실제로 쓸모 있다.
  - 우클릭: `오류만` `다음 오류로` `clipboard 복사` `파일로 내보내기(.ndjson)`.
  - **붙여넣기로 필터 상자**를 열고 있다(복사해서 바로 탐색).
#### 5.12.4 성능 규칙 (소프트웨어 렌더 비용을 고려)

- **성능 규칙**:
  - **가상 스크롤 필수.** 50,000줄 DOM 을 그대로 두면 `off` 모드에서 프레임이 죽는다.
    **보이는 + 위아래 20줄만** 렌더한다.
  - 새 줄은 **50ms 버퍼 + rAF 커밋**(§5.6 규칙 재사용). 초당 20회 리렌더 상한.
  - `log.append` 를 받을 때 **패널 전체 리렌더를 하지 않는다.** `React.memo` 된 행
    컴포넌트에 `seq` 만 비교해 내려간다.
  - `log.status`(§2.3)로 **버퍼 상태를 헤더에 표시**: 현재 보관 문자 수 / 잘린 총량.
#### 5.12.5 활용

- **사용자가 직접 만든 출력도 같은 창으로 보낸다**: 진단 리포트(§9.2)에 "최근 로그
  2,000줄"을 포함하고, 버그 신고 시 **이 패널의 현재 화면을 캡처**하는 버튼을 둔다.
  로그 패널의 존재 이유가 바로 이것이다.

### 5.13 설정 메뉴 — 셀프 업데이트와 버전 관리 (요구 14, 19)

> **요구**: "설정 메뉴에서 셀프 업데이트 및 버전 관리 기능을 제공한다."
> 요구 14(업데이트)를 **설정 화면 안에** 완성된 기능으로 넣는다. CLI 명령만 있고
> 화면에 없는 기능은 "없는 기능"이다 — 이 프로그램의 유일한 화면이 설정 창이기 때문이다.

- **`mod+,` → 설정 대화상자가 아니라 화면이 된다** (다크 테마, 좌측 내비게이션 + 우측 내용).
  1인 사용자의 로컬 앱이므로 "설정 창"보다 "설정 화면"이 맞고, 전체 레이아웃 안에서
  도킹·분리도 가능해야 한다(§5.4).

| 섹션 | 내용 | 근거 |
|---|---|---|
| **모델** | 포트(§7.6) · 현재 모델 · Ornith 추천/양자화(§7.2) · 교체/재기동 | 요구 5 |
| **브라우저** | **GPU 모드 + 검증 결과**(§4.7) · 창 크기/위치 · 라운드 모서리 · 추가 플래그 · 프로필 경로 | §4.1·§4.7 |
| **에이전트** | thinking 정책(§5.3) · 도구 스키마 비용(§5.11) · 승인 게이트 화이트리스트(§3.6) | 요구 6·7 |
| **로그** | 레벨 · **보관 상한(문자/줄/회전)**(§5.12.2) · 소스 필터 기본값 · 진단 리포트 내보내기(§9.2) | §5.12 |
| **업데이트 · 버전** | **아래 §5.13.1** | 요구 14 |
| **고급** | 설정 내보내기/가져오기(§9.2) · 워크스페이스 기본값 · Chrome 추가 플래그 · 위험 초기화 | §6.4 |

- **모든 설정 항목은 3가지를 같이 보여준다**: 현재 값 · **그 값의 출처**(기본값 / 이 프로젝트 /
  환경변수) · **왜 이 값인가**(rationale). 요구 10 의 근거 표시 원칙을 UI 전체에 확장한다(§6.4).

#### 5.13.1 업데이트 · 버전 관리 화면

- **버전 블록(항상 표시)**
  | 항목 | 표시 | 갱신 |
  |---|---|---|
  | 현재 버전 | `harnesside 1.4.2` (설치 경로, 커밋 SHA 7자리, 빌드 시각) | 기동 시 1회 |
  | 업데이트 채널 | `stable` / `beta` / `nightly` (기본 `stable`) | 즉시 |
  | 최신 버전 | `1.4.3 (2026-09-28)` / "최신" | 수동 + 자동(§아래) |
  | **업데이트 상태** | `확인 중` `최신` `신규 있음` `다운로드 중 42%` `검증 중` `적용 대기` `적용됨` `실패` | 실시간 |
  | 체크섬 | `sha256 ab12…` (짧은 해시, 전체는 복사 가능) | 상시 |

- **버튼과 동작** (기다리지 않게: 각 행에 `지금 실행`을 둔다)
  | 버튼 | 동작 | 실패 시 |
  |---|---|---|
  | **업데이트 확인** | GitHub Releases 조회 → 비교 | 네트워크 불가 시 "오프라인 — 마지막 확인 시각" 유지 (§11.2 O12) |
  | **다운로드만** | 바이너리+웹 자산 내려받기(진행률·속도·취소) | **파일을 덮어쓰지 않는다** — 검증 전에는 임시 경로 |
  | **검증** | **해시 2중 검증**(원본 `selfUpdate.ts` 설계) + 서명(있을 때만) | **불일치 → 적용 금지 + 삭제** (원본 원칙 유지) |
  | **지금 적용(재시작)** | 현재 턴 취소 → 체크포인트 저장 → 교체 → **데몬 재기동** → 창 자동 재연결 | 실패 시 **기존 버전으로 자동 롤백** |
  | **이 버전으로 되돌리기** | 최근 3개 버전 슬롯에서 선택(아래) | 파일 부재 시 "설치 파일 없음 — 다시 다운로드" |
  | **채널 변경** | stable/beta/nightly | beta 는 " development build — 불안정" 경고 문구와 함께 |

- **"지금 적용"이 가장 위험한 버튼이다.** 실패하면 사용자는 IDE 를 못 쓴다.
  따라서 적용 전 **반드시** 다음을 한 화면에 모은다(확인 모달):
  - 진행 중 턴/백그라운드 프로세스 목록 → **취소하거나 기다리거나**
  - 저장되지 않은 편집 탭 수 → **저장하거나 버리기**
  - 롤백 가능 여부(아래) · 예상 소요 시간(실측 파일 크기 기준)
  - **창을 닫으면 llama-server 도 종료된다**(§4.4) — 데몬 모드라면 유지됨
  - "취소" 는 언제나 즉시 가능해야 한다. 롤백이 불가능한 업데이트는 **시도 자체를 막는다.**

- **롤백을 실제로 가능하게 만든다**(선언만 하지 않는다):
  - 업데이트 전 **현재 바이너리·웹 자산을 `~/.harnesside/versions/<현재버전>/` 로 복사 보존**한다.
  - **최근 3개 버전만** 유지(디스크 정리). 그 이상은 필요 없다 — 오래된 것은 다시 받으면 된다.
  - 적용 후 첫 부팅이 **정해진 시간(예: 90초) 안에 `hello` 를 보내지 못하면**
    자동 롤백한다(설정: `update.rollbackOnFailedBoot`, 기본 켬).
    **이 자동 롤백이 없으면 업데이트는 "설치 성공 = 성공" 이라는 잘못된 성공 기준을 갖는다.**
  - 롤백 사실은 로그 패널(§5.12) `scope: "update"` 에 남고, 부팅 배너로 알린다.

- **업데이트 결과의 신뢰성 표시** (§4.7.5 와 같은 원칙):
  - `설정됨` 과 `동작함` 을 구분한다. **다운로드 완료 ≠ 적용 완료 ≠ 정상 부팅.**
  - 각 단계를 **따로** 표시하고, 실패한 단계에서 사유를 사람이 읽을 문장으로 (§11.3).

- **자동 업데이트**
  | 항목 | 기본 | 규칙 |
  |---|---|---|
  | `update.autoCheck` | 켬(하루 1회) | 네트워크가 없을 때 조용히 넘어간다. 실패를 재시도 루프에 넣지 않는다 |
  | `update.autoInstall` | **꺼짐** | 자동 설치는 **기본 금지**. 켜면 "설치 후 자동 재시작"까지 물어야 한다 |
  | `update.checkOnStart` | **꺼짐** | 부팅 속도를 헤_FLAG로 지탱하지 않는다. 첫 부팅 3초는 사용자 눈에 가장 민감하다 |
  | 알림 | 배너(조용한 토스트 아님) | "새 버전 있음 — 지금 설치할까요?" |
  | 네트워크 안 됨 | 표시만 | 기능이 꺼져 보이지 않게 "오프라인" 배지를 상태바에 상시 (§11.2 O12) |

  - **잠금 파일(§3.7.2)을 업데이트가 깨지 않게 한다**: 업데이트는 이미 떠 있는 인스턴스가
    **없을 때만** 파일을 교체한다. 떄 있으면 "harnesside 가 실행 중이라 업데이트할 수 없습니다"
    (+ `harnesside down` 안내). **실행 중인 자기 자신을 덮어쓰는 일은 없다.**

- **버전 관리는 업데이트 이외의 것을 다룬다**:
  - **연결 진단**: Node/Chrome/llama-server/모델/GPU 모드(§4.7) 버전과 호환성 표시.
    예: "Chrome 106 미만은 GPU off 검증 불가 — 업데이트 권장"처럼 **판정 + 권장**으로 잇는다.
  - **변경 이력**: 릴리스 노트 탭(GitHub) + **로컬 설치 이력**(무엇을 언제 설치/되돌렸는지).
  - **호환성 경고**: 설정 스키마 버전 불일치(§6.4), 미지원 OS/브라우저, 구버전 llama-server.
  - **버전 정보 복사**: 진단 리포트에 자동 포함(§9.2). 버그 신고의 첫 질문이 항상 이것이다.
  - **개발 모드 표시**: `HARNESSIDE_NO_UPDATE=1` 이거나 dev 서버로 붙어 있으면
    설정 화면 상단에 **"개발 모드 — 업데이트 비활성"** 배지를 **항상** 보여준다.
    사용자가 몇 시간을 낭비하지 않게 하는 것이 목적이다.

#### 5.13.2 추천 알림 (HuggingFace 모델 · llama.cpp 프로그램) — 요구 14 확장

> **요구**: "신규 로컬 LLM 모델이 허깅페이스에 업데이트되면 추천 알림을 준다.
> 물론 llama.cpp 프로그램도 업데이트 추천 알림을 제공한다."
> 즉 **두 갈래**다 — 프로그램(llama-server)과 **모델(가중치)**.
> §5.13.1 이 "버전에 뭐가 있나" 를 보여준다면, 이 절은 "**바뀌었는데 아직 모른다**" 를 막는다.

**두 알림은 성격이 다르다. 한 화면에 두되 규칙을 다르게 준다.**

| 대상 | 무엇이 바뀌는가 | 기본 |
|---|---|---|
| **모델 (HuggingFace)** | 새 양자화 / 새 GGUF 파일 / 계열의 파생 모델 | **켜짐**(1일 1회) |
| **llama-server** | 실행 중 binary 의 버전 | **켜짐**(1일 1회) |
| **harnesside 자체** | 릴리스 (§5.13.1) | 꺼짐 |

**5.13.2.1 모델 알림 (HuggingFace)**

- **추적 대상 3가지** (사용자가 정한다. 전부 추적하면 알림이 폭탄이 된다):
  1. **설치된 모델의 원본 저장소** — 예: `Ornith-1.5-35B-A3B-GGUF` 의 새 파일/새 양자화.
     **가장 가치 높다** — 사용자가 이미 쓰던 계열이 개선되는 경우.
  2. **관심 계열** — §7.2 의 `models.prioritySeries`(기본 `["ornith-1.5-35b-a3b"]`) 의 파생 저장소.
  3. **직접 구독한 저장소** — 설정에서 추가/삭제.
- **비교 기준은 "파일"이다.** 커밋 해시 하나로 판정하지 않는다.
  - `GET /api/models/{repo}` → `siblings[].rfilename` + `lastModified`.
  - **추적 스냅샷**을 `state/watch/<sha1(repo)>.json` 에 저장하고
    **파일 목록 + 크기 + LFS oid** 를 비교한다. 새 `.gguf` 가 보이면 그것이 알림 대상.
  - **커밋 해시만 바뀌고 파일이 같으면 알리지 않는다.** 메타 편집 한 줄에 울리는 알림은
    사용자가 3일 만에 모든 알림을 끈다.
- **알림 내용(한 줄 요약 + 근거)**:
  ```
  🆕 Ornith-1.5-35B-A3B-GGUF 에 새 양자화
     + Q5_K_M (5.2 GB) · 2026-09-28 등록 · 이 PC 예상 VRAM 24.1 GiB (비추천)
     [확인] [이 양자화 다운로드] [무시]
  ```
  - **적합도 판정을 같이 보여준다**(§7.3 점수식). 8 GiB 카드에 24 GiB 모델을
    "새 모델이 나왔습니다" 만으로 알리면 무의미하다.
    → **적합하지 않으면 권장하지 않는다.** 알림은 하되 "이 PC 에서는 비추천" 을 명시한다.
- **알림이 오기만 하지 않게 막는다(노이즈 규칙)**:
  - 동일 저장소 **1일 1회**, 전체는 **하루 최대 3건**으로 묶는다(그 이상은 요약 배지 하나).
  - **이미 설치된 것과 같은 크기·해시는 알리지 않는다.**
  - "무시" 하면 **저장소+파일이 영구 무시 목록**에 들어간다(§5.12 필터와 같은 "silence" 문법).
  - **조용히 쌓인다**: 배지 → 클릭 → 목록. 창을 끌어다 놓지 않는다(§11.3).
  - 최초 실행 시 **과거 소식을 한꺼번에 뿌리지 않는다.** 구독 시점 이후분만 알린다.
- **반드시 누르지는 않는다**: "다운로드"는 §5.11·§7.5 경로를 따라가며 파일 교체와
  llama 재기동까지 승인을 거친다(§3.6).

**5.13.2.2 llama-server 업데이트 알림**

- **비교 대상은 "지금 돌아가는 binary" 다** — 저장소의 최신 tag 가 아니라.
  - 현재 버전: `llama-server --version` 출력을 **부팅 시 1회** 캡처해
    `state/llama-build.json` 에 저장한다. (빌드 경로·컴파일 플래그도 함께)
  - 원격: `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`.
    (§1.2 의 remote 제거 규칙은 **우리 저장소**에 대한 것이고, 업스트림은 그대로 `ggml-org/llama.cpp` 다)
  - `bNNNN`(빌드 번호) 또는 `tag` 를 비교해 앞섬/뒤섬을 판정한다.
- **알림 규칙**(모델과 다른 이유가 있다):
  | 상황 | 알림 |
  |---|---|
  | 새 릴리스 있고 현재 빌드가 그보다 이전 | **권장**(1일 1회) |
  | 현재 빌드가 최신 | 없음 |
  | 파싱 실패 / 네트워크 불가 | **알림 없음.** 마지막 확인 시각만 기록 |
  | `buildLlamaCpp()` 로 로컬 빌드한 경우 | "새 binary" 가 아니라 **"소스 빌드 마이그레이션 필요"** 로 표시 |
- **알림 내용**:
  ```
  ⬆ llama.cpp 새 빌드 b6xxx (2026-09-27)
     현재: b5xxx (2026-08-30) · 릴리스 노트 보기
     [릴리스 노트] [지금 업데이트]
  ```
  - 릴리스 노트는 **제목과 두드러지는 변경 몇 줄로 요약**한다. 전체는 원문 패널(§9.1 과 공유).
  - **`지금 업데이트`** 는 §5.13.1 의 파이프라인을 재사용한다. **컴파일이 필요하면
    "약 20~40분"** 을 먼저 알린다 — §3.2 [3] 이 최장 40분이라는 실측을 그대로 인용.
  - **업데이트 중 모델이 죽으면 작업이 잃힌다**: 업데이트 전에 **체크포인트 저장 + 진행 중 턴
    취소/유예 안내**를 거친다(§4.4 절차 재사용).
- **무엇이 안전한지 구분한다** — 이건 사용자가 판단해야 한다:
  - **단일 바이너리 교체**: 안전. 기본 경로.
  - **소스 리빌드**: 안전하지만 오래 걸리고 **기존 튜닝 플래그(§6.3)를 다시 적용**해야 한다.
    재빌드 후 **GPU 모드(§4.7.5) 판정을 다시 하고** 결과를 사용자에게 알린다.
    재빌드로 튜닝이 조용히 초기화되면 사용자는 "왜 느려졌지" 하며 원인을 모른다.
  - **"설정 안 바꾸고 업데이트"를 기본값으로 낸다.** 기존 튜닝·설정을 보존한 채 교체하고,
    바뀐 것이 있으면 "무엇이 달라졌는지" 를 rationale 로 보여준다.

**5.13.2.3 알림의 도착 경로와 UX**

- **백그라운드 체크는 유휴 시에 돈다.** 부팅 직후가 아니다(첫 렌더를 방해하지 않는다).
  - 타이밍: 부팅 60초 후 1회 → 이후 **6시간 간격** + 설정 화면 진입 시 1회(캐시 5분).
  - **네트워크가 없으면 조용히 넘어간다**(§11.2 O12 오프라인 배지와 연동).
  - **레이트리밋을 지키는 것이 우선이다**: 429 를 받으면 그 백오프(최소 1시간)를 지키고,
    실패를 재시도 루프에 넣지 않는다(§7.3 의 실측 근거).
  - `update.checkNetwork: 'never'` 면 **CPU/네트워크를 전혀 쓰지 않는다.**
- **알림 채널 3개**(한 이벤트가 두 곳에 중복으로 뜨지 않게):
  | 채널 | 쓰임 | 기본 |
  |---|---|---|
  | 배지 + 클릭 | 모델·llama 알림 | 항상 |
  | 배너 | harnesside 릴리스 | 기본 |
  | 데스크톱 알림 | **창이 백그라운드일 때만** | §11.2 O7, 꺼짐 |
- **클릭 시 도착**: 모델 알림 → 설정 → 모델 → 해당 저장소 상세(§7.3) /
  llama 알림 → 설정 → 업데이트·버전 → 릴리스 노트.
  **읽음/지우기/무시** 3가지를 제공한다. "무시"는 재발을 막고 "지우기"는 기록만 지운다.
- **로그 패널과 섞지 않는다**: §5.12 는 **진단용(원본 로그)**, 알림은 **사용자 액션용**이다.
  한 탭에 섞으면 "안내"와 "오류"가 뒤섞여 읽기 어려워진다.
- **기본값 요약(설정 화면에 그대로 노출)**: 모델 알림 ON·1일 1회, llama 알림 ON·1일 1회,
  harnesside 자동 설치 OFF, 알림 한도 3건/일, 데스크톱 알림 OFF.

- **API 보강** (§3.3): `GET /api/update/check` · `POST /api/update/download` ·
  `GET /api/update/progress` · `POST /api/update/apply` · `POST /api/update/rollback` ·
  `GET /api/update/history` · `GET /api/notices` · `POST /api/notices/:id/dismiss` ·
  `POST /api/notices/:id/silence` · `POST /api/watch/repos` ·
  WS 이벤트 `update.state`, `update.progress`, `notice.push` (§2.3).
- **승인 게이트 연동**(§3.6): 업데이트 적용·되돌리기는 `run_shell` 과 같은 **승인 필수**다.
  서버가 자기 자신을 바꾸는 행위이므로 사용자가 모르게 일어날 수 없어야 한다.
- **대체 경로**: 업데이트가 실패했을 때 "수동 설치 가이드"(내려받고 교체하는 3단계)를
  §5.12 로그 패널에 자동 띄운다. 실패를 "안 되네"로 끝내지 않는다.

---

## 6. llama.cpp 라이프사이클 · 튜닝 (요구 9, 10)

### 6.1 기동 순서 규칙 (요구 9)

> **"서버 프로그램이 구동이 되면 웹 페이지가 뜨기 전에 llama.cpp 가 구동을 하게 되는거야"**

- 부트스트랩 [4]~[8]이 [11]보다 **반드시 먼저** 완료된다.
- llama-server 헬스체크(`GET /v1/models`)가 200을 반환한 뒤에야 Chrome을 띄운다.
- 실패 시: 창은 **열되**, 화면 전면에 `모델 서버 연결 실패` 배너 + 원인 + `재시도` 버튼.
  빈 화면이나 무한 로딩 화면은 절대 금지.

### 6.2 기동 후 확인 항목

- 포트 충돌: 설정 포트가 다른 프로세스(`llama-server` 아님)에 점유 중이면 → 다음 후보 포트
  탐색 후 **llama-server와 클라이언트 설정 포트를 같은 값으로 동시에 갱신**
  (원본 `ports.ts` 가 지적한 "서로 다른 사실로 남는 포트" 문제의 재발 방지).
- 이미 정상인 llama-server 가 떠 있으면(원본 bootstrap의 "adopt" 원칙) **새로 띄우지 않는다** —
  특히 VRAM 8GB 환경에서 두 번째 서버를 띄우면 즉시 OOM한다. 이 원칙은 그대로 계승.
- 로그 라인(최대 500줄)을 `.harnesside/state/llama-server.log` 에 기록하고,
  모델 교체 실패 시 원인 추적용으로 UI에 "모델 서버 로그" 탭을 제공한다.

### 6.3 하드웨어 기반 자동 튜닝 (요구 10)

기존 `src/setup/tuning.ts` 의 `tuneForHardware(hw, {modelBytes})` 를 그대로 사용하고,
**결과를 UI에 노출**한다. 핵심 원칙(원본에 이미 있음, 새 프로젝트에서 지켜야 함):

- **"사용자에게 묻지 않는다."** 모든 값은 측정값에서 도출되고, 결정은 로그에 남는다.
- **다중 코어 + NVIDIA GPU → GPU 우선.** 고정 `-ngl 0`은 금지.
- 값마다 `rationale`(한국어 근거 문자열)을 함께 반환 → 설정 화면에 그대로 표시.
  사용자는 "왜 이 값인가"를 문서를 읽지 않고 바로 알 수 있어야 한다.

계산되는 값과 근거(원본 로직 유지):

| 플래그 | 결정 규칙 |
|---|---|
| `-ngl` | GPU 있으면 `999`(전체), 없으면 `0` |
| `-c` | 가용 VRAM 예산 기준 테이블: ≥20GiB→32768, ≥10→24576, ≥6→16384, ≥3→8192, 그 외→4096 |
| `--cache-type-k/v` | 예산 ≥3GiB → `q8_0`, 그 외 → `q4_0` |
| `-t` / `-tb` | GPU 있음: 코어의 절반(최소 2, 코어 수 이하) / 코어-1 |
| `-b` / `-ub` | `2048` / 예산 ≥6GiB→`512` else `256` |
| `--n-cpu-moe` | VRAM 부족분에서 산출, 최대 모델의 60%까지만 |
| `--flash-attn` | on |
| `--parallel` | `1` (에이전트는 세션 1개. 늘리면 KV 캐시만 낭비) |

> **원본에서 실제로 잡힌 버그를 반드시 피할 것**: GPU 분기의 `Math.max(2, ...)` 하한이
> 1코어 머신에서 `-t 2`(=코어 수 초과)를 만들어냈다. 12코어 개발 머신에서는 우연히
> 합법적인 값이 되어 숨겨졌다. **코어 수 스윕 테스트(1/2/3코어)** 를 반드시 포함한다.

추가로 이번 프로젝트에서 추가할 것:

- **`-c`와 클라이언트 임계치 정합성 보장.** 원본에서 실제로 겪은 사고 —
  설정의 컨텍스트가 서버보다 작거나(또는 그 반대) 컴팩션이 매 턴 발동하는 무한 루프.
  - 기동 직후 `GET /props`(llama.cpp)로 **실제 컨텍스트 크기를 읽어** 클라이언트
    임계치를 그 값에 맞춰 재계산한다. 설정 파일 값이 아니라 **서버 진실**을 따른다.
  - 두 값이 어긋나면 부팅 로그에 경고로 표시한다.
- VRAM 예산은 `nvidia-smi` **실측 free 값** 기준(페이퍼 사양 8192MiB만 믿지 않는다).
  데스크톱 컴포지터가 150~300MiB를 점유한다(원본 실측).
- 튜닝 결과를 `.harnesside/state/tuning.json` 에 기록, 설정 화면에 "자동 결정됨" 배지 + 수동 조정 지원
  (수동 조정하면 `tuning.manual: true` 가 되고 자동 갱신을 중단).
- **브라우저 VRAM 예약을 먼저 차감한다** (§4.6). 이 계산이 빠지면 8 GiB 카드에서
  모델과 브라우저가 서로를 죽인다. 차감 사실은 `rationale` 에 반드시 남긴다.

### 6.4 설정 · 데이터 디렉터리 규약 (문서에 없던 것을 명시)

경로가 섞이면 나중에 반드시 사고가 난다. **세 계층**을 명확히 나눈다.

| 계층 | 경로 | 내용 | git |
|---|---|---|---|
| **전역(머신)** | `~/.harnesside/` | 바이너리, 크롬 프로필, 로그, 세션, 자격증명, 포트 상태, 레이아웃 기본값 | 절대 커밋 금지 |
| **프로젝트** | `<workspace>/.harnesside/` | `config.yaml`, `rules/`, `skills/` | `rules/`·`skills/` 만 커밋 |
| **런타임(비영속)** | `<workspace>/.harnesside/state/` | 체크포인트, 임시, 다운로드 `.part` | 커밋 금지 |

- **모델 파일은 프로젝트 디렉터리에 두지 않는다.** 20 GB 파일이 git 에 나타나면
  언젠가 커밋된다(원본 `bootstrap.ts` 가 이미 같은 이유로 `~/models` 를 쓴다).
  기본 `~/.harnesside/models/` , 이 문서의 개발 환경처럼 외장 볼륨을 쓰는 경우
  `HARNESSIDE_MODELS_DIR` 로 지정.
- **설정 병합 규칙(명확해야 한다)**: 전역 기본 ← 프로젝트 overrides ← 환경변수.
  우선순위가 한 곳에서만 정의되고, **설정 화면에는 어느 값이 어디서 왔는지 표시**한다
  ("기본값" / "이 프로젝트에서 재정의" / "환경변수 HARNESSIDE_XXX"). 이 표시가 없으면
  사용자는 왜 값이 안 바뀌는지 알 수 없다.
- **설정 스키마 버전**: `config.yaml` 에 `schemaVersion`. 새 버전은 **마이그레이션
  훅**을 가지며, 구 버전을 읽으면 자동 변환 후 백업 파일을 남긴다.
  알 수 없는 키는 **버리지 않고 보존**한다(앞으로 추가될 키를 사용자가 날리지 않도록).
  (원본 `config.ts` 의 중첩 객체 병합 버그 — 부분 병합이 누락 필드를 통째로 날린 사례)
- **설정 쓰기는 원자적**: 임시 파일 → fsync → rename. 전원 차단으로 설정이 깨져
  부팅이 불가능해지는 경로를 막는다.
- **비밀 값은 설정 파일에 두지 않는다.** PAT 등만 `~/.harnesside/credentials.json`(0600).
- **`.gitignore` 템플릿 제공**: 새 프로젝트 생성 시 `.harnesside/state/` 가 자동으로
  제외되도록 제안한다.
- **시크릿 스캔**: CI 에서 커밋된 설정 파일에 토큰 패턴이 있는지 검사한다(§10.6).

---

## 7. 모델 관리 · HuggingFace (요구 5)

### 7.1 요구 재정의

> "설정 메뉴를 통해서 로컬 llama.cpp 의 포트와 허깅페이스를 통한 pc 에 적합한 모델을 조회하여
> 나열시켜주고 다운로드(멀티 다운로드 가속) 와 llama.cpp 모델 교체를 하고 llama.cpp 재구동"

즉 설정 화면에서 다음이 **원자적으로** 가능해야 한다: 포트 확인/변경 · 모델 검색 · 적합 모델
추천 · 다운로드 · 교체 · llama.cpp 재구동.

### 7.2 추천 1순위 — Ornith 계열 (전용 규칙, 점수 계산과 독립)

> **요청 사항**: "추천 모델은 Ornith 를 우선순위로 추천해줘"

- **기본 추천 모델은 `Ornith-1.5-35B-A3B` 계열로 고정한다.** 이 프로젝트의 튜닝·컴팩션
  임계치·Thinking 정책·도구 스키마 예산은 **모두 이 모델을 기준으로 실측 튜닝되어 있다.**
  다른 모델을 주추천으로 내세우면 그 실측값들이 맞지 않아 성능·안정성이 동시에 떨어진다.
- **하드웨어 적응형 양자화 선택** (같은 계열에서 VRAM에 맞는 양자화를 고른다):

  | 가용 VRAM | 추천 양자화 | 파일 크기(실측 기준) | 비고 |
  |---|---|---|---|
  | ≥ 26 GiB | `Q5_K_M` | 25.3 GB | 품질 최대, 24GB 카드에서는 불가 |
  | ≥ 22 GiB | `Q4_K_M` | 21.9 GB | **기본값.** 8GB 카드에서 MoE 부분 오프로드로 구동됨 |
  | ≥ 18 GiB | `Q4_K_S` | 20.4 GB | VRAM 부족분을 늘려야 할 때 |
  | ≥ 17 GiB | `Q3_K_XL` | 17.8 GB | |
  | ≥ 16 GiB | `IQ3_M` | 17.4 GB | 양자화 손실이 눈에 띄기 시작하는 구간 |

  - 위 수치는 `/media/jeano/nvme-usb/models/` 의 실제 파일 크기다. 문서와 실제 파일이
    어긋나면 **문서를 고친다** — 하드코딩된 크기가 곧 튜닝 계산의 입력이 된다.
  - VRAM이 8GiB 이하로 내려가면(예: RTX 2070 SUPER) 35B-A3B가 `--n-cpu-moe` 로
    구동될 뿐이고 속도가 크게 떨어진다. 이 경우에도 **1순위는 Ornith를 유지하되**
    "대안(경량 모델) 보기"를 두 번째 탭으로 분리해 제안만 한다. 자동 교체하지 않는다.
- **추천 UI 표현**:
  - 목록 최상단에 `★ 기본 추천` 배지와 함께 고정 배치한다(점수와 무관하게).
  - 그 아래에 점수순으로 나머지를 나열한다.
  - Ornith가 **로컬에 이미 있으면** 다운로드 없이 "사용 중 / 적용"만 즉시 보여준다.
    (네트워크 없이 완결되어야 첫 부팅이 막히지 않는다)
- **검색·점수 계산에서 Ornith를 찾아야만 한다**:
  - HF 검색 결과의 모델 `id`에 `ornith` 포함 여부를 **최우선** 매칭한다.
  - `Ornith-1.5-35B-A3B` 계열은 tool-calling을 실제로 지원한다(원본에서 실기 검증 완료:
    `/v1/chat/completions` 스트리밍 + `tool_calls` 파싱). 따라서 §7.4 점수식의
    `tool_calling +8` 을 **항상 획득**하며, 이 계열은 그 자체로 상위권이다.
- **우회 경로(우선순위를 못 지키는 경우)**: 네트워크 불가, 로컬에 파일 없음,
  HuggingFace 계정/레이트리밋으로 계열 미노출, 디스크 부족 — 이때는 점수순 추천으로
  자연스럽게 폴백하되 **"Ornith 계열을 찾지 못했습니다"** 를 명시한다.
  조용히 다른 모델을 1순위로 올리는 것은 금지.
- **설정으로 재정의 가능**: `models.prioritySeries: ["ornith-1.5-35b-a3b"]`
  처럼 다른 계열을 추가·삭제할 수 있게 데이터로 둔다(하드코딩 금지).
  단 **기본 배열에는 Ornith가 포함**되어야 한다.
- **검증**: `src/models/recommend.ts` 유닛 테스트에서 아래를 반드시 확인할 것.
  - 로컬에 `Ornith-1.5-35B-A3B-Q4_K_M.gguf` 만 있을 때 → 추천 1순위가 그 파일(점수 무관).
  - 로컬에 다른 모델만 있고 Ornith 미설치 → 1순위 제안 + "다운로드" 버튼(자동 받지는 않음).
  - VRAM 8GiB 가상 머신 → 양자화 표가 `Q4_K_M` 보다 큰 것을 고르지 않을 것.
  - Ornith 계열이 검색 결과에 아예 없음 → 폴백 + 사유 문구 노출.

### 7.3 HuggingFace 검색 + PC 적합 모델 추천

- **검색 API**: `https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=50`
  (+ `?search=`, `?author=`)
- **GGUF 검증**: `gguf` 태그 + 파일 확장자 `.gguf` + (가능하면) `gguf` 메타의
  `general.architecture` / `parameter_count` / `quantization_version` 파싱.
  (이미 받아둔 `.gguf` 헤더를 읽는 `src/models/ggufMeta.ts` 로 로컬 파일도 동일 처리)
- **적합도 점수(0~100)** — 우선순위 계열(§7.2)이 아닌 나머지에 대한 정렬 기준:
  ```
  score = 100
        - min(60, |예상VRAM부족분GiB| * 12)        // 너무 크면 강하게 감점
        - min(25, |예상RAM부족분GiB| * 5)
        + (tool_calling 지원 ? 8 : 0)              // chat template에 <tool_call>이 있을 때만
        + (thinking 지원 ? 4 : 0)
        + min(10, log10(downloads) * 1.2)          // 인기도
        - (license 비허가 ? 50 : 0)                // llama.cpp 계 모델은 대체로 허용
  ```
  - 예상 VRAM = `가중치 크기 + 0.3GiB × (contextK/1024)` (Q8 KV 기준),
    부족분은 MoE가 아니면 0(못 들어감), MoE면 `--n-cpu-moe` 로 흡수 가능.
  - **추천 목록은 상위 5개만** 제시하고, 각각 "이 PC에서 예상 토큰 속도"를
    실측/경험 기반 추정치로 함께 보여준다(과신하지 않도록 `≈`와 근거를 명시).
  - §7.2 의 Ornith 계열은 이 5개 슬롯에 **서로 경쟁시키지 않는다.** 항상 별도 고정 배너로.
- 표시 항목: 이름, 양자화(Q4_K_M 등), 크기, 적합 점수, 툴콜링/생각 지원, 라이선스,
  다운로드 수, `적용` 버튼, `★ 기본 추천` 배지(§7.2 계열일 때만).

### 7.4 멀티 다운로드 가속

- **HTTP Range 요청 병렬 다운로드**: 파일 크기를 먼저 `HEAD`(LFS redirect 확인) 로 알아내고,
  크기를 **N조각**으로 나눠 동시 다운로드. `connections` 기본값:
  ```
  N = 8, 대역폭 제한·서버 Range 미지원 시 자동 감소(1까지)
  ```
  - Range 미지원(HTTP 200으로 전체 반환) 감지 시 **단일 연결로 강등**하고 계속 진행.
  - 각 조각을 `.part/<jobId>/<idx>` 로 쓰고, 완료된 조각은 **재시작 시 건너뛴다**.
  - 동시 다운로드 중 **429/5xx** 는 지수 백오프(+지터) 후 재시도, 3회 연속 실패 시 그 조각만
    독립 재시도 큐로 이동(전체 다운로드가 멈추지 않는다).
- **속도/ETA 표시**: 3초 이동평균 속도, 남은 시간, 진행률 바, 일시정지/재개/취소 버튼.
  일시정지 시 진행 상태를 서버가 **디스크에 스냅샷**(조각별 바이트 오프셋)해 재개 정확도를 보장.
- **완료 검증**: HuggingFace LFS 메타의 sha256(`?blobs=true`)과 **다시 읽어 계산한 해시 비교**.
  불일치면 재다운로드 1회, 그 다음 실패면 **삭제 후 오류**(부분 파일을 정상으로 표시하지 않는다).
- **기존 파일 재사용**: 대상 경로에 해시까지 동일한 완전 파일이 있으면 다운로드 생략.
  (원본에서 실제로 겪은 사고 — 20GB 모델이 "동일 모델" 판정 실패로 통째로 재다운로드됨)
  판정 기준은 **파일명만이 아니라 바이트 크기 + 해시**.
- **디스크 사전 확인**: 필요한 여유 공간 < 파일 크기 + 1GiB 이면 다운로드를 시작하지 않고
  사유를 안내. (`/home/jeano/models` 에 `.part` 21GB 가 남아 있는 실제 상황을 고려)
- `.part` 잔여물 정리: 7일 이상 갱신되지 않은 `.part` 디렉터리는 목록에 "중단됨"으로
  표시하고 삭제 버튼 제공(자동 삭제는 하지 않음).

### 7.5 모델 교체 + llama.cpp 재구동

교체는 **원자적 트랜잭션**이어야 한다(요구 5의 "교체와 재구동"):

```
1. 대상 gguf 경로 검증 (존재, 헤더 파싱 가능, 로컬 해시 대조)
2. llama-server 사전 백업: 현재 실행 명령줄을 state에 기록 (되돌리기용)
3. 기존 모델에 실행 중이면 → 종료 확인 (모델 파일이 잠기지 않도록)
4. config.llama.modelPath 갱신 + atomic rename 으로 기록
5. llama-server 재기동 (동일 포트, §6.3 튜닝 재계산 — 모델 크기가 달라지므로 gpuLayers/cpuMoeLayers/contextSize가 바뀐다)
6. 헬스체크 /v1/models → 새 모델명이 돌아오는지 확인
   (llama.cpp 는 기동 시 로드한 모델명을 /v1/models 로 돌려준다 — 이것이 교체 성공의 증거)
7. 실패 시 2의 백업으로 되돌리고, 이전 모델로 재기동
8. 브라우저에 model.changed 이벤트 → 상태바·입력창·모니터 패널 갱신
```

- 재기동 중에는 UI에 **명시적 오버레이**("모델 교체 중…")를 띄우고, 진행 중인 턴이 있으면
  **취소 후 재개** 여부를 묻는다(무음 중단 금지).
- 교체 후 첫 요청은 **연결 확인용 핑 1회**를 자동 수행해 "모델이 응답함"을 사용자에게
  알려준 뒤에 완료로 판정.

### 7.6 포트 관리 (요구 5의 "로컬 llama.cpp 의 포트")

- 설정 화면에 현재 llama-server 포트를 실시간 표시(실제 바인딩 값).
- 편집 가능(1024~65535, 사용 중이면 경고 + 후보 제시).
- 변경 시 llama-server 재기동 필요 배너 + 원클릭 적용.
- 8080/8081/11434/5000/7317 등 **일반적으로 충돌하는 포트 목록**을 경고로 표시.

---

## 8. 파일 탐색기 · 워크스페이스 (요구 12, 13)

### 8.1 디렉토리 탐색 + 목록

- 좌측 트리 패널에 현재 워크스페이스 루트의 파일 트리.
  - 지연 로딩(폴더 클릭 시 하위만 조회), 접기/펼치기, 정렬(이름/크기/수정시각/확장자),
    숨김 파일 표시 토글, `node_modules/.git/.venv` 등 **자동 제외**(설정 가능).
  - 아이콘은 확장자별 최소 셋트(가벼움 우선 — 수천 개 SVG 아이콘은 번들 비용).
- 상단 경로 바: 현재 경로 표시, 상위 이동, "루트에서 열기", 경로 직접 입력.
- **빠른 검색**: `mod+P` 퍼지 파일 찾기, `mod+Shift+F` 워크스페이스 전체 문자열 검색
  (결과에 파일:라인 프리뷰, 클릭 시 해당 줄로 점프).

### 8.2 파일 열기 → 메인 IDE (요구 12)

- 파일 클릭 → **중앙 메인 에디터**에 탭으로 열림.
  - 언어 자동 감지, 접기 지원, 인덴트 규칙 적용.
  - **읽기 전용 표시**: `.harnesside/` 안쪽 파일, 빌드 산출물, 큰 바이너리는 열기 전에 안내.
  - **저장**: `mod+S`. 디스크 바깥(바깥으로 나간 파일) → 후속 저장 시 **명시적 확인 다이얼로그**.
  - **충돌**: 디스크가 변했으면 상단에 배너("디스크에서 변경됨 — 비교 / 무시 / 내 변경 유지").
  - **탭 상태**: `*` 미저장 표시, 닫을 때 저장 여부 질문, 파일별 편집 상태 메모리.
  - 2만 줄 초과 파일은 **가상 스크롤 + 라인 지연 로드**(한 번에 다 넣지 않는다).
  - 이미지에선 사이즈 표시, 지원 확장자가 아니면 **읽기 전용 텍스트 뷰**로 폴백(빈 화면 금지).

### 8.3 디렉토리 이동 = 워크스페이스 이동 (요구 13)

> "디렉토리 이동이 되면 코딩하는 작업 폴더도 이동이 되게 되어야 해"

- 루트 변경은 **단순 뷰 변경이 아니라 세 가지를 함께 바꾼다**:
  1. **파일 트리 루트**
  2. **에이전트의 작업 루트** — 모든 도구 호출의 상대경로 기준(baseDir)이 바뀐다.
     잘못된 기준 경로는 파일을 엉뚱한 곳에 쓰는 사고로 이어진다.
  3. **rule/skill 로딩 대상** — 새 루트의 `.harnesside/rules/`, `CLAUDE.md`, `AGENTS.md` 등
     을 **다시 로드**. 이전 루트의 규칙이 남으면 새 프로젝트에 잘못된 규칙이 적용된다.
- 추가 변경:
  4. **언어/빌드 도구 감지** — package.json/requirements.txt/Cargo.toml/pyproject.toml
     존재 여부로 프로젝트 종류를 감지하고 관련 액션(테스트 실행)을 활성화.
  5. **git 저장소 상태** — 루트 변경 시 현재 저장소 이탈 여부 확인.
- 세션 연속성 정책(명확히 해야 한다):
  - 루트 변경 시 **기존 대화·체크포인트는 유지**하되, 새 루트의 파일에 대한 도구 결과는
    "이전 워크스페이스에서 온 것"임을 컨텍스트에 명시한다(중간에서 경로가 바뀌면
    모델이 이전 경로를 계속 쓰기 때문이다).
  - 「새 세션」 버튼으로 정리 시작도 제공.
- 루트 변경은 **확인 다이얼로그**(변경 시 열린 탭·세션이 어떻게 되는지 명시) 후 수행.
- 최근 경로 목록(`~/.harnesside/recent.json`) + 부팅 시 마지막 경로 자동 복원.

---

## 9. 업데이트 · GitHub 연동 (요구 14, 15, 16)

### 9.1 CLI 바이너리 업데이트 + 버전 + README 실시간 (요구 14)

기존 `src/selfUpdate.ts` 의 **해시 2중 검증** 설계를 그대로 사용한다. UI로 옮기면서 추가:

- **버전 정보 패널**
  - 로컬: `package.json` version, git 커밋 SHA, 빌드 시각, Node/Chrome/llama-server 버전,
    활성 모델명.
  - 원격: GitHub Releases 최신 태그 + 배포 시각 + 릴리스 노트.
- **업데이트 버튼** → 진행 표시 → 해시 검증 → 설치 → **재시작**.
  - 재시작은 `spawnRestart()`(기존) 재사용. 업데이트 확인 시점에 **사전 공지**(설치 전에
    "새 버전 있음" 배너) — 원본에서 개선된 사항.
  - 네트워크 불가/해시 불일치/파싱 실패 시 **현재 버전으로 계속 구동**하고 사유만 표시.
    (원본 요구 "해시가 다르면 그냥 현재 버전 구동" 유지)
  - `HARNESSIDE_NO_UPDATE=1` 로 끄기(자체 개발 중 필수).
- **README 실시간 조회**
  - `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/README.md` 를
    5분 캐시 + 수동 새로고침 버튼으로 가져와 **IDE 안의 탭으로 렌더링**.
  - 마크다운 렌더링: `marked`(웹) + `DOMPurify` 로 **반드시 새니타이즈**한 뒤 `innerHTML` 에 넣는다.
    **반드시 XSS 새니타이즈** — 원격 마크다운을 그대로 `innerHTML`로 넣으면 위험하다.
  - 이미지 상대경로는 raw.githubusercontent 기준으로 재작성, 외부 이미지는 기본 차단
    (프라이버시/대역폭), 클릭 시 원본 링크.
  - GitHub 오프라인/_RATE_LIMIT 시 "가져오지 못함 + 마지막 캐시"로 우아하게 처리.

### 9.2 [15 — 원문 누락 항목, 보완] 진단 리포트 · 설정 백업

> 원본 요구사항에 15번이 없습니다. 다음을 보완 제안으로 넣는다. 다른 요구로 교체 가능.

- **설정 내보내기/가져오기**: `.harnesside/` 설정·레이아웃·바로가기·로그인 정보를
  하나의 JSON으로 내보내고, 다른 머신에서 복원. 모델 파일은 제외(경로만 기록).
- **진단 리포트 생성**: "버그 신고"용. 하드웨어, llama-server 플래그, llama 로그
  마지막 200줄, 서버 로그, 설정(시크릿 마스킹), 버전 정보, 최근 오류를
  `.harnesside/diagnostics/<timestamp>.md` 로 생성. **시크릿과 API 토큰은 반드시 마스킹**한 뒤에.

### 9.3 GitHub 연결 · 프로젝트 조회 · 로컬 동기화 (요구 16)

- **연결**: `owner/repo` URL 또는 SSH URL 입력. 선택적으로 GitHub PAT(개인 액세스 토큰).
  - PAT은 `~/.harnesside/credentials.json`에 `0600` 권한으로 저장, **로그/리포트에 절대 노출 금지**.
  - 토큰 없이 공개 저장소는 `git` 만으로 clone/pull 가능(비공개는 토큰 필요).
- **프로젝트 조회**: 사용자의 저장소 목록(API) 또는 전체 공개 검색.
  각 항목에 star/fork/language/last-push 표시 + `로컬 위치 지정` + `가져오기`.
- **로컬 동기화** (요구 16의 "조회된 프로젝트는 로컬도 동기화"):
  - clone(깊이 1) / pull(fast-forward 우선, 충돌 시 **중단하고 UI에 알림** — 자동 병합 금지) /
    push(브랜치 선택, **명시적 확인 후 실행**, `--force` 는 거부하고 force-with-lease만
    타이핑으로 허용) / fetch / log(최근 커밋 목록) / branch 전환 / stash 목록.
  - `git` CLI를 `execFile`로 호출하며 **인자를 배열로 전달**(쉸 문자열 조립 금지 — §보안).
  - 장시간 작업(clone/push)은 **백그라운드 블록**으로 표시하고 취소 가능(§5.6).
  - 작업 중 잠금 파일(`index.lock`)과 **동시 실행 충돌** 방지(작업 큐 직렬화).
- **저장소 상태 패널**: 현재 브랜치, ahead/behind, 변경 파일 목록, 각 파일 diff를
  §5.2의 가로 diff 뷰로 즉시 확인 → "에이전트에게 맡기기" 버튼으로 그 diff를 컨텍스트에 첨부.

---

## 10. 테스트 · 검증 전략 (요구 18)

> "완성도가 있도록 구현 과정에 테스트 코드 등을 통해 검증해 나아가면서 기존 구현의
> 사이트 이펙트가 없는지 등을 계속 점검해 나아가야 해"

### 10.1 원칙

1. **새 로직 = 새 테스트.** 순수 로직(파싱, diff, 레이아웃 계산, 포커스 조작, 적합도
   점수, 다운로드 조각 관리)은 유닛 테스트로, 화면/스트리밍/프로세스 수명은 통합·E2E로.
2. **모킹보다 실기.** Monaco/Ink 같은 렌더링은 실제 구동으로 확인하는 편이 신뢰도가 높다
   (원본에서 이미 그렇게 판단해 TUI를 유닛 테스트에서 제외했다). 웹에서도 같은 원칙을 적용:
   헤드리스 Chrome + CDP로 **실제 렌더링을 캡처**한다.
3. **회귀를 문서로 남긴다.** 발견한 버그는 README의 "구현 상태"에
   "현상 → 재현 → 근본 원인 → 수정 → 재발 방지 테스트" 형식으로 기록.

### 10.2 유닛 테스트 (npm test)

| 모듈 | 반드시 검증할 것 |
|---|---|
| `fs/safePath.ts` | `..` 탈출, 심볼릭 링크 탈출, 루트 정확히 일치, 빈 경로, 인코딩된 경로 |
| `fs/tree.ts` | 숨김 제외, 용량 초과 디렉토리, 심볼릭 링크 순환(**무한 재귀 방지**), 큰 디렉토리(10만 파일) |
| `models/hfSearch.ts` | 응답 파싱, 오류 응답, rate limit, 적합도 점수 경계값, tool-calling 미지원 감지 |
| **`models/recommend.ts`** | **Ornith 1순위 고정**(§7.2 의 4개 시나리오 전부), 양자화 표의 VRAM 경계값(16/18/22/26 GiB), 계열 미발견 시 폴백 + 사유 문구, 다른 계열 우선순위 추가/삭제 |
| `models/download.ts` | 조각 분할 경계(정확히 나누어 떨어짐), Range 미지원 강등, 재개 스냅샷, 해시 불일치, 429 백오프, 디스크 부족 |
| `models/ggufMeta.ts` | 헤더 파싱, 잘린 파일, 비 GGUF 파일 |
| `models/manager.ts` | 교체 트랜잭션 롤백, 헬스체크 실패 시 복원, 모델 파일 잠금 |
| `setup/tuning.ts` | **1/2/3코어 머신**(-t가 코어 수를 넘지 않는지), VRAM 0, GPU 없음, 초대형 모델(80B+), MoE 부족분 산출 |
| `setup/ports.ts` | llama/IDE 2포트 충돌 매트릭스 |
| `dock/layout.ts` | 드롭 존 판정(9영역), 경계값, 최소 크기 클램프, 저장/복원, 창 리사이즈 시 재배치 |
| `metrics/sampler.ts` | nvidia-smi CSV 파싱(various 버전), GPU 없음, 값 급변, 이상치(NaN) |
| **`server/browserFlags.ts`** | **GPU 모드 판정 3종**(off/budgeted/full 경계값), `off` 에 `--disable-gpu`·`--disable-software-rasterizer` 포함, **`--disable-features` 중복 키 0개**, `off`/`budgeted` 플래그 **상호배타**, `--no-sandbox` 부재, 포트/경로 이스케이프(공백·따옴표) |
| **`server/logRing.ts`** | 문자 상한(500k) 초과 시 **오래된 것만** 버려짐, 줄 상한, 한 줄 8KiB 절단, `sinceSeq` 재현성, 멀티바이트(한글/이모지) 문자 수 계산, 빈 입력 |
| **`server/daemon.ts`** | TTY 유무와 무관한 동일 경로, flock 경합 시 2번째 인스턴스 거부, `SIGHUP` 무시, `SIGTERM` 우아한 종료, `status` JSON 스키마 |
| **`server/noticeWatcher.ts`** | HF 응답 fixture: **파일 미변경 + 커밋만 변경 → 알림 없음**, 새 `.gguf` → 알림, **무시 목록 재발 방지**, 1일 3건 상한, 429 백오프, 네트워크 실패 시 조용히 통과, llama 버전 파싱 실패 시 무알림 |
| `server/wsHub.ts` | 하트비트 만료 판정, 재연결 재생(ring 버퍼 경계), 메시지 역직렬화 실패 격리 |
| `server/lifecycle.ts` | 종료 시그널 5종 각각, SIGTERM→SIGKILL 승격, 체크포인트 강제 기록 |
| `git/*` | 인자 배열화(쉼 인젝션 방지), 충돌 시 pull 중단, force 거부 |
| `web/*` 순수 로직 | 블록 상태 전이(버전/접힘), 접힘 요약 라벨 생성, 스트리밍 버퍼 커밋 주기, 퍼지 매칭 |
| **이식 모듈** | 기존 44개 테스트를 **그대로 통과**시켜야 한다(이식 검증) |

### 10.3 통합 테스트

- 가짜 OpenAI 호환 서버를 띄우고 스트리밍 SSE + tool_calls 파싱 end-to-end.
- 가짜 `llama-server` 프로세스를 스폰해 **기동 → 헬스체크 → 교체 → 재기동 → 종료** 시나리오.
- Chrome을 실제로 띄워 `--app` 창 + CDP 연결 + 창 종료 감지(S1~S5) 검증.
- 20GB급은 못 받으므로 **100MB 가짜 모델 파일**로 교체/해시/재개 시나리오를 수행.
- 네트워크를 실제로 끊고(route 차단) 업데이트/검색 실패 경로 검증.
- **데몬 시나리오 (§3.7)**: `stdio: 'ignore'` + `nohup`-equivalent 로 기동 →
  `status` 로 확인 → `logs -f` 1줄 확인 → `open` 으로 창만 추가 → 창 닫기 → 서버 생존 확인 →
  `down` 으로 종료. **TTY 없이 12단계가 전부 도는지**가 판정 기준.
- **로그 상한 (§5.12.2)**: 50만 자를 넘기는 로그를 흘리고, 위쪽(오래된 줄)이 버려지면서
  **최신 줄이 살아 있음**을 확인 + `log.status` 의 `droppedChars` 증가 확인.
- **업데이트 롤백 (§5.13.1)**: 가짜 릴리스(zip) → 검증 실패 → **적용되지 않음** →
  가짜 정상 릴리스 → 적용 → 부팅 실패 시뮬레이션 → **자동 롤백되어 이전 버전으로 부팅됨**.
- **추천 알림 (§5.13.2)**: 모킹한 HF/GitHub 응답으로 신규 양자화/신규 빌드 알림이 뜨고,
  "무시" 후 재발하지 않으며, 3건 초과분은 요약 배지로 합쳐지는지 확인.

### 10.3.1 보안 테스트 (추가 — 웹이라서 새로 생긴 영역)

| 시나리오 | 기대 |
|---|---|
| 토큰 없이 `GET /api/fs/file` | 401, 파일 내용 미노출 |
| 잘못된 토큰 | 401 |
| 토큰 정상 + `Origin: http://evil.com` 인 WebSocket 업그레이드 | 거절 |
| 토큰 정상 + `Host: evil.com` 인 HTTP 요청 | 거절 (DNS rebinding) |
| `?path=../../../../etc/passwd` | 403 + 사유 |
| 워크스페이스 밖 심볼릭 링크 경로 | 403 |
| 3 MiB 파일 `GET` | 2 MiB 절단 + 계속 읽기 안내 |
| 바이너리 파일 `GET` | 거부 + 메타만 |
| `PUT` 시 `baseVersion` 불일치 | 409 + 서버측 최신본(무음 덮어쓰기 없음) |
| `run_shell` 위험 명령 | 승인 게이트에서 **대기 상태** (실행되지 않음) |
| 승인 없이 60초 경과 | 자동 거절, 에이전트에 거절 전달 |
| `<img src=x onerror=...>` 형태의 파일명 저장 → 트리 렌더 | **스크립트 실행 안 됨** |
| 진단 리포트 생성 | PAT/토큰 문자열이 마스킹되어 있음 |
| `git` 인자에 `; rm -rf /` 주입 시도 | 배열 전달이므로 안전한 인자로 처리/거부 |

### 10.4 E2E (헤드리스 Chrome + CDP)

`scripts/e2e_check.ts` — `google-chrome --headless=new --remote-debugging-port` 로 실행:

- 부트스트랩 전체(모델 없음 → 빌드 스킵 설정) → 창 뜨는 것 확인.
- `Runtime.evaluate` 로 **실제 DOM**을 검사:
  - 주소창/탭바 요소가 DOM에 없음(`--app` 모드 확인)
  - 라운드 코너 CSS 적용 여부
  - `border-radius` 값이 0이 아님
  - 메인 에디터에 하이라이 spans가 실제로 생성됨
  - 접기/펼침 후 DOM 라인 수가 실제로 변함
  - 가로 diff가 **두 열**(좌/우)로 렌더됨
  - 도킹 드래그 시 패널 DOM이 다른 dock 영역으로 이동
  - 모니터 게이지의 SVG/canvas가 존재하고 값이 시간에 따라 변함
- **스크린샷 캡처**로 회귀 확인: `docs/screenshots/` 에 저장하고 이전 것과 픽셀 차이
  임계값을 넘는 변경을 경고(임계값 기반, 절대 동일 비교는 아니다 — 그 한계는 문서화).
- 콘솔 에러/미처리 Promise 거부 0건.
- **성능 예산**: 첫 유효 렌더 < 1.5s, 패널 드래그 60fps, 1만 줄 파일 스크롤 프레임 예산.
  - **`off` 모드에서 별도 예산을 둔다**: 소프트웨어 렌더이므로 스크롤 예산을
    `full` 과 **같은 값으로 두면 실패하는 것이 정상**이다. 모드별 기준을 각각 기록한다(§4.7.4).
- **GPU 검증 자동화**(§4.7.5): E2E 부팅 직후 `SystemInfo.getInfo` 로
  `glRenderer === "Disabled"` 를 **assertion** 으로 확인. 실패하면 CI 실패.
  (대조군 없이 `full` 모드 확인은 선택적으로 한 번 수행)

### 10.5 검증 매트릭스

| 축 | 범위 |
|---|---|
| 하드웨어 | GPU 없음 / VRAM 2·4·8·12·24GiB / RAM 4·8·16·32GiB / 코어 1·2·4·12·32 |
| 모델 | **Ornith-1.5-35B-A3B (5개 양자화 전부)** · 1B · 7B 밀집 · 70B+ (적합도 경계) |
| 네트워크 | 정상 / 느림(제한) / 끊김 / DNS 실패 / 429 |
| 브라우저 | Chrome stable / Chromium / **브라우저 없음** / 프로필 잠김 |
| 창 | 800×600 · 1366×768 · 1920×1080 · 4K · 다중 모니터(음수 좌표) |
| 입력 | 한글이 포함된 프롬프트 / 매우 긴 프롬프트(1만자) / 이미지 첨부 / 빈 입력 |
| 장시간 | 2시간 연속 실행, 컴팩션 20회 이상, 백그라운드 프로세스 10개 동시 |
| **VRAM 경쟁** | **8 GiB 카드에서 llama + 브라우저 동시 기동 30분 무 OOM**(§4.6) |
| **브라우저 GPU** | `off` / `budgeted` / `full` · GPU 없는 머신 · 구버전 Chrome(플래그 미지원) · 드라이버가 플래그를 무시하는 경우 (§4.7.5 검증 실패 경로) |
| **실행 모드** | TTY 있음 / TTY 없음(pipe) / `nohup` / systemd / 데몬+창 닫힘 (§3.7) |
| 보안 | §10.3.1 시나리오 전부 |

### 10.6 지속 검증 (CI / 자동화)

- `npm test` / `npm run typecheck` 는 **커밋마다** 도는 선행 게이트.
  "나중에 돌리자"가 되면 실제로는 영원히 안 돈다.
- **커버리지 하한선**을 CI 에서 강제한다. 수치는 Phase 마다 올린다:
  P0 60% (이식 모듈) → P11 70% → P17 **80% (서버 계층)**.
  - **제외**: `src/legacy-tui/`, `src/web/**` 순수 스타일.
  - 템플릿 기반 테스트(테스트를 위해서만 존재하는 코드)를 **금지**한다.
    커버리지 수치를 올리려고 무의미한 테스트를 쓰는 순간 그 수치는 거짓이 된다.
- **보안 스캔**: 커밋된 파일에 토큰 패턴(`ghp_`, `sk-`, `hf_`, `AKIA`)이 있는지 검사하고
  발견 시 실패. 설정 파일이 실수로 커밋되는 것을 CI 단계에서 막는다.
- **`grep -r "llamacli"` 금지어 검사**를 CI 에 넣는다(P0 이후).
- **부팅 스모크 테스트**(머신당 1회/일): fake llama-server 로 부트스트랩 12단계를
  돌리고, 로그가 예상 순서인지 검증한다. §3.2 순서는 손대면 회귀가 나기 쉽다.
  - **TTY 없이**(`stdio: 'ignore'`)로도 12단계가 끝까지 도는지 함께 확인한다(§3.7).
- **성능 회귀 감시**: 첫 렌더 < 1.5s, 도킹 드래그 60fps 를 CI 에 기록하고,
  기준 대비 20% 초과 시 경고(하드 실패로 두지 않는다 — 환경마다 다르므로).
- **E2E 는 PR 에서 자동 실행한다.** 2차 개정 시에는 "헤드리스 Chrome + GPU 의존이 불안정하다"는
  이유로 nightly 로 미뤘으나, **3차 개정에서 GPU 를 끄면서 이 근거가 사라졌다**(§4.7.1).
  소프트웨어 렌더는 오히려 결정적이며, E2E 가 `glRenderer === "Disabled"` 까지 assert 하면
  렌더링 경로의 재현성이 함께 검증된다.
  - Chrome 버전은 **CI 이미지에서 고정**한다(`chrome --version` 로그 남김). 로컬/러너의
    "최신"에 따라 스크린샷 회귀가 흔들리면 안 된다.
  - GPU 전용 러너는 필요 없다. 있으면 `full` 모드 대조군으로 한 번만 쓴다.
- **"무엇을 검증하지 않았는지"를 README 에 계속 적는다.** 검증되지 않은 것을
  검증된 것처럼 쓰는 것이 이 문서에서 가장 나쁜 결과다.

---

## 11. 추가 권장 기능 (요구 19)

> "지금까지 내용을 파악하여 부족한 편리 기능이나 추천하는 기능들이 있으면 모두 추가해줘"

아래는 요구사항에서 직접 언급되지 않았지만, 이 프로그램이 **실제로 매일 쓰이는 코딩 도구**가
되려면 반드시 있어야 한다고 판단한 항목이다. **필수(M)는 즉시 구현, 선택(O)은 여유가 되면.**

### 11.1 필수 기능 (M)

| # | 기능 | 이유 |
|---|---|---|
| M1 | **터미널 패널** (PTY 기반 셸, 탭 복수) | 파일 열기만 있고 실행할 수 없으면 코딩 도구가 아니다. 기존 `run_shell`과 같은 PTY 재사용 |
| M2 | **변경 사항 검토 패널** (Git diff 목록 + 항목별 승인/되돌리기) | 에이전트가 파일을 쓰면 **사람이 반드시 검토할 수 있어야 한다.** 요구 3의 diff가 "보기"만으로는 부족 |
| M3 | **실행 취소(Cancel) + 재개(Resume)** 버튼 | 긴 턴을 중간에 끊을 수 있어야 한다. 요구 7의 "업데이트가 영역만 되도록"과 짝을 이룬다 |
| M4 | **알림(Toast) + 오류 센터** | 창이 곧 IDE이므로 눈을 안 돌리고 진행 상황을 알려야 한다 |
| M5 | **명령 팔레트 + 전역 검색** | 키보드 중심 개발자 습관을 존중 |
| M6 | **자동 저장 + 세션 복원** | 창이 닫혀도 편집 내용과 레이아웃이 살아있어야 한다 |
| M7 | **입력창 드래프트 자동 저장** | 실수로 창을 닫아도 프롬프트가 사라지지 않는다 |
| M8 | **접근성**: 키보드 전용 조작, `aria-*`, 포커스 링, `prefers-reduced-motion` | §5.4의 드래그 대안 키바인딩이 여기 해당 |
| M9 | **한국어 UI** (전역 i18n 훅, 기본값 한국어) | 대상 사용자 언어. 원본 `rationale`/상태 메시지가 이미 한국어인 것과 일관 |
| M10 | **크래시 복구**: 서버 크래 시 마지막 상태로 자동 재시작 + 체크포인트 안내 | 원본 `crashHandler` 의 설계 의계를 웹으로 이식 |
| M11 | **서버 로그 패널** (상시 스트리밍, 상한 50만 자) | 서버가 데몬이라(§3.7) 이게 유일한 상태 창. §5.12 |
| M12 | **설정 화면 내 셀프 업데이트 · 버전 관리** | 요구 14를 UI로 완결. 롤백 가능해야 진짜 관리다. §5.13.1 |
| M13 | **추천 알림** (HF 모델 변경 · llama.cpp 빌드 변경) | 사용자가 모르게 낡은 모델/빌드를 쓰게 되는 것을 막는다. §5.13.2 |

### 11.2 선택 기능 (O) — 강력히 권장

| # | 기능 | 설명 |
|---|---|---|
| O1 | **이미지 첨부** (스크린샷 붙여서 에이전트에게) | 다국적 모델(Gemma3, Qwen2-VL) 지원 시 가치가 큼 |
| O2 | **코드베이스 인덱스 / 시맨틱 검색** | 토큰 아끼면서 대형 저장소 탐색. llama.cpp 임베dings API 사용 |
| O3 | **스니펫/템플릿 저장** | 자주 쓰는 프롬프트를 한 키로 |
| O4 | **작업 큐** (멀티태스크) | 여러 요구를 넣고 순차/병렬 처리 |
| O5 | **에이전트 personality 스위처** (설계/구현/리뷰/디버그) | 원본 `skills/` 를 활용한 프리셋 |
| O6 | **비용/토큰 통계 대시보드** | 로컬이라도 컨텍스트/속도 이력의 관찰 |
| O7 | **알림 규칙**: 턴 완료 시 데스크톱 알림 | 창을 안 보고 있을 때 |
| O8 | **테마 확장** (사용자 JSON 테마) | `~/.harnesside/themes/*.json` |
| O9 | **파일 워치 → 에이전트 알림** | 외부 편집을 에이전트가 인지 |
| O10 | **북마크/핀 파일** | 자주 여는 파일 고정 |
| O11 | **멀티 세션(탭별 대화)** | 서버는 1개, 대화 컨텍스트만 분리 |
| O12 | **오프라인 모드 명시 배너** | 네트워크 불가 상태를 숨기지 않는다 |
| O13 | **오픈Telemetry 없는 자체 익명 통계(로컬 전용 로그)** | 성능 병목 분석용, 외부 전송 없음 |
| O14 | **MCP 클라이언트 지원** | 외부 도구 연동 표준화. 모델이 작아서 툴이 많을수록 가치가 큼 |
| O15 | **멀티 모델 라우팅** (속도/품질 모델 분리:Thinking/실행) | 한 모델에 다 맡기지 않고 역할 분담. VRAM이 두 개를 동시에 못 올릴 수 있으므로 **순차 교체** 방식 |
| O16 | **편집기 설정 동기화** (VS Code 키맵/설정 import) | 익숙한 키 배치로 학습비용 제거 |
| O17 | **모델 워치 목록** (관심 저장소 구독 + 알림 이력 열람) | §5.13.2 의 알림이 쌓이는 자리가 필요하다 |
| O18 | **업데이트 미리보기(다운로드만 후 재시작 예약)** | 긴 빌드를 사용자가 아무 때나 받을 수 있게 |

### 11.3 UX 세부 개선 (실사용에서 반드시 겪는 것)

- **빈 상태 화면을 채운다**: 파일 없음 / 대화에 아직 메시지 없음 / 모델 미연결 —
  각각 "무엇을 할 수 있나"와 예시 프롬프트 버튼을 보여준다. 빈 화면은 결함이다.
- **오류 메시지는 사람이 읽을 문장**으로: `TypeError: fetch failed` 를 그대로 띄우지 않는다.
  (원본에서 이미 이 함정을 고친 이력 — 웹에서도 같은 기준을 적용)
- **느린 것에 대한 설명**: 모델 응답 대기/도구 실행 대기가 길면 **무엇을 하고 있는지**
  항상 보인다. "멈춘" 것처럼 보이는 순간이 가장 나쁜 UX다.
- **한국어 줄바꿈·너비**: 에디터와 로그 렌더링 모두 동아시아 너비를 정확히 처리.
- **첫 실행 가이드**: 3단계(모델 준비 → 워크스페이스 선택 → 시작) 토스트.

---

## 12. 구현 순서 (Phase)

각 Phase 는 **완료 시 검증 방법이 명시**되어 있고, 그 검증을 통과해야 다음으로 간다.
"동작하는 것 같음"은 완료 판정이 아니다.

| Phase | 내용 | 완료 검증 |
|---|---|---|
| **P0** | §1 복사·치환. 이식 모듈이 그대로 빌드/테스트 통과 | `npm test` (기존 44개 포함) 통과, `grep -r llamacli` 결과 0(허용 예외 외) |
| **P1** | §6.2 llama-server 부트스트랩 + §3.2 시퀀스 1~8. CLI로 모델 기동 확인 | llama-server가 웹 없이 기동하고 `/v1/models` 200 응답 |
| **P1.5** | **§3.6 보안 경계**(토큰·Origin/Host·승인 게이트) + **§6.4 설정 규약** | §10.3.1 보안 시나리오 전부 통과. **UI보다 먼저** — 뒤로 미루면 retrofit 이 된다 |
| **P2** | §4.1 Chrome `--app` 기동, 요구 8(메뉴 없음)·라운드 모서리, **§4.6 VRAM 예산**, **§4.7 GPU off 정책** | 창이 뜨고 주소창/탭바가 보이지 않음, 모서리 라운드 확인(스크린샷), 8GiB 카드에서 동시 기동 무 OOM, **CDP `glRenderer === "Disabled"`** 확인 |
| **P2.5** | **§3.7 데몬 모드** + **§5.12 로그 패널** + §2.3 로그 프로토콜 | TTY 없이 12단계 부팅, 서버 로그가 하단 패널에 상시 표시, **50만 자 상한 후 최신 줄 유지**, `harnesside status/logs/down` 동작 |
| **P3** | §2.3 WebSocket 허브 + §5.0 레이아웃 골격 + §5.7 입력창 | 브라우저에서 입력 → 서버 로그에 수신, 응답이 WS로 돌아와 화면에 표시 |
| **P4** | §5.6 에이전트 스트림 블록 + 접기/펼침(요구 7) + **§5.11 신규 도구** | 도구 호출이 블록으로 나타나고, 스트리밍 중 **다른 블록이 리렌더되지 않음**(측정으로 확인), 승인 게이트가 위험 도구를 실제로 차단 |
| **P5** | §5.1 Monaco 편집기 + §8.2 파일 열기/저장(요구 12) | 클릭 → 중앙 편집기에 하이라이트된 코드, 접기 동작, 저장 반영 |
| **P6** | §5.2 가로 diff(요구 3) | 변경 파일 2열 diff 렌더, 문자단위 강조 확인 |
| **P7** | §5.5 모니터 패널(요구 11) | 1초 갱신, 애니메이션, CPU 부하 시 프레임 예산 유지 |
| **P8** | §5.4 자석 도킹(요구 4) | 5개 드롭존 드래그 동작, 레이아웃 저장/복원, 키보드 대안 동작 |
| **P9** | §8.3 워크스페이스 이동(요구 13) | 루트 변경 시 트리·도구 기준경로·rule/skill 재로드가 **모두** 바뀜(테스트) |
| **P10** | §5.3 Think 애니메이션(요구 6) | reasoning 블록 애니메이션, 예산 초과 시 자동 강제 전환 |
| **P10.5** | **§5.10 세션 영속화** | 새로고침·재시작 후 마지막 상태가 **통째로** 복원(스트리밍 중 화면 교체 없음) |
| **P11** | §7 모델 관리(요구 5) | **Ornith 계열이 점수와 무관하게 1순위로 고정 표시** → 검색 → 추천 → **멀티 다운로드(중단/재개)** → 교체 → llama 재기동 → 새 모델 응답 확인 |
| **P12** | §4.4 창 종료 → llama 종료(요구 9) | 신호 S1~S5 각각 닫아 llama-server가 종료됨(각각 별도 검증) |
| **P13** | §9.1 업데이트·버전·README(요구 14) + **§5.13 설정 화면·셀프 업데이트·버전 관리** + **§5.13.2 추천 알림(HF 모델·llama.cpp)** | 버전 표시, README 렌더, 해시 불일치 시 현재 버전 유지, **검증 실패 시 롤백**, **HF 새 양자화 알림·무시 후 재발 없음**, **llama 빌드 뒤 알림** |
| **P14** | §9.3 GitHub 연동·동기화(요구 16) | clone → 파일 열기 → 커밋 → pull, 충돌 시 자동병합 없이 중단 |
| **P15** | §11 필수 기능 M1~M13 | 각각의 인수 기준 통과 |
| **P16** | §10.4 E2E + 스크린샷 회귀 + 성능 예산 + **§10.6 CI 파이프라인** | E2E 그린, 콘솔 에러 0, 첫 렌더 < 1.5s, 커버리지 하한선 강제 |
| **P17** | §5.9/§11 스타일 마감, i18n 전체 확인, 접근성 점검 | §10.5 매트릭스 전 항목 |

**주의 (원본에서 실제로 겪은 순서 오류)**: llama-server를 웹보다 먼저 띄우지 않은 채로
UI만 먼저 만들면, 모든 이후 작업이 "모델이 없으니 화면이 비어 보인다"는 상태에서 진행되어
디버깅이 배가 된다. **P1·P2를 UI 작업보다 먼저 끝내는 것이 순서가 아니다 — 이게 순서다.**

**두 번째 순서 경고**: **P1.5(보안)를 P2 이후로 미루지 마라.** REST API 로 파일을
읽고 쓰는 구조를 먼저 만들고 나중에 보안을 덧씌우면, 그동안 만들어진 모든 호출 경로에
"인증 빠진 길"이 생기고 그것을 전부 찾아낼 수 없다. §3.3 API 표를 처음부터
"토큰 필수"로 설계해야 한다.

**세 번째 순서 경고**: **P2.5(데몬 + 로그 패널)를 P3 이후로 미루지 마라.**
P3(WS) 직후에 넣으면 가장 싼 시점이다 — WS 허브가 처음 생기는 순간에
`log.append` 를 한 줄 추가하는 것 vs 나중에 모든 이벤트에 로깅을retrofit 하는 것은
작업량 차이가 10배다. 또 로그 패널이 나중에 생기면 **"뭐가 이미 놓쳤는지" 알 수 없다.**
서버가 데몬으로 굴러가는 동안의 부팅 실패는 사용자가 볼 방법이 없기 때문이다.
---

## 13. 수용 기준 체크리스트

각 항목은 `[ ]`로 시작하며, 검증 방법을 함께 적어 둔다. **구현이 끝나면 실제로 확인해
 체크 처리하고, 확인하지 못한 항목은 빈 채로 남긴다.** (원본 프로젝트의 원칙)

### 파생 (요구 1)
- [ ] llamacli가 수정되지 않았음 (`git status` in llamacli clean)
- [ ] 하드코딩된 `llamacli` 식별자 0건, `.harnesside/` 사용
- [ ] 이식 모듈 44개 테스트가 전부 통과

### 아키텍처 (요구 2)
- [ ] 서버가 도구 실행 + 모델 호출 전부 담당
- [ ] 화면 입출력은 브라우저에서 처리(서버 경유 아님)
- [ ] WS 프로토콜 문서과 구현이 일치

### 보안 (웹에서 새로 생긴 영역 — §3.6)
- [ ] **토큰 없이 어떤 `/api/*` 도 200 을 주지 않는다**
- [ ] 토큰이 URL 주소창에 남지 않는다(첫 렌더 후 제거)
- [ ] WebSocket 이 `Origin` 불일치 시 거절된다
- [ ] `Host` 헤더 위조(DNS rebinding) 차단
- [ ] 경로 탈출 · 심볼릭 링크 탈출 차단 테스트 통과
- [ ] XSS: 악성 파일명이 DOM 에서 스크립트를 실행하지 못한다
- [ ] **위험 도구가 승인 게이트에서 실제로 차단된다**(실행 안 됨)
- [ ] 승인 무응답 시 자동 거절, 에이전트에 사유 전달
- [ ] 진단 리포트에 토큰/시크릿이 마스킹되어 있다
- [ ] CI 시크릿 스캔 통과

### IDE 출력 (요구 3)
- [ ] 코드가 IDE 편집기로 표시되고 구문 하이라이트 + 색상 적용
- [ ] 인덴트 규칙 적용(자동 들여쓰기/정렬)
- [ ] 그룹핑으로 접기/펼치기가 모든 출력 종류에서 동작
- [ ] diff가 **가로(좌우 2열)** 비교이며 문자 단위 강조
- [ ] 인라인 폴백은 폭이 좁을 때만

### 창 도킹 (요구 4)
- [ ] 좌/우/상/하/중앙 5개 드롭존 동작
- [ ] 분리(탭 밖) 가능 + 되돌리기 가능
- [ ] 레이아웃 저장/복원
- [ ] 키보드만으로도 동일 조작 가능

### 모델 관리 (요구 5)
- [ ] llama.cpp 포트 조회/변경
- [ ] HuggingFace에서 PC 적합 모델 조회·정렬·추천(근거 표시)
- [ ] **Ornith 계열이 점수와 무관하게 항상 1순위 고정 표시(`★ 기본 추천`)**
- [ ] **VRAM에 맞는 Ornith 양자화 자동 선택**(16/18/22/26 GiB 경계 검증)
- [ ] Ornith 미설치 시 자동 다운로드하지 않고 "다운로드" 버튼만 제공
- [ ] Ornith 미발견(네트워크/레이트리밋) 시 폴백 + 사유 문구 노출
- [ ] 다른 계열 우선순위 추가/삭제 가능(기본 배열에 Ornith 포함)
- [ ] 멀티 다운로드 가속(조각 병렬)이 실제로 병렬임(검증)
- [ ] 중단/재개 후 이어받기
- [ ] 해시 검증
- [ ] 모델 교체 + llama.cpp 재기동 성공(교체 증거 = /v1/models의 모델명)
- [ ] 교체 실패 시 자동 롤백

### Think (요구 6)
- [ ] 결과 출력 **전에** thinking 애니메이션 표시
- [ ] `prefers-reduced-motion` 대응
- [ ] thinking 예산 상한 및 초과 시 자동 전환

### 백그라운드 (요구 7)
- [ ] 파일 처리/백그라운드 프로세스가 **병렬**로 실행됨
- [ ] 각 작업이 독립 블록으로 표시
- [ ] 한 블록 갱신이 다른 영역을 리렌더하지 않음(측정)
- [ ] 대용량 출력에서도 UI가 버팀(가상화)

### 창 형태 (요구 8)
- [ ] 주소창/탭바/북마크 없음(`--app` 모드)
- [ ] 모서리 라운드
- [ ] 창 크기/위치 복원
- [ ] **8 GiB 카드에서 llama + 브라우저 동시 기동 후 30분 무 OOM**(§4.6)
- [ ] 브라우저 VRAM 예산이 llama 튜닝 계산에서 차감되어 있고 그 사실이 rationale 에 표시됨

### 브라우저 GPU (3차 개정 — §4.7)
- [ ] **기본 모드가 `off`** 이며, 모델이 GPU 를 쓰면 자동으로 `off` 로 결정됨
- [ ] **`off` 일 때 CDP `SystemInfo.getInfo` 의 `glRenderer === "Disabled"`** (실측 검증)
- [ ] `featureStatus.webgl === "disabled_off"` 확인
- [ ] `nvidia-smi --query-compute-apps` 에 **chrome 항목이 없음**
- [ ] **대조군 확인**: 같은 머신에서 `full` 로 띄웠을 때 `glRenderer !== "Disabled"`
- [ ] `--disable-software-rasterizer` 가 `off` 에 포함(빠뜨리기 쉬운 항목)
- [ ] **`--disable-features` 중복 키 0개** (중복 시 앞의 것이 사라지는 함정 회피)
- [ ] `--no-sandbox` / `--disable-web-security` / `--single-process` 미포함
- [ ] 모드 판정 근거가 설정 화면과 `rationale` 에 표시됨
- [ ] **모드 변경이 "다음 기동 적용"임을 정확히 안내**(적용되지 않았는데 적용됨으로 표시되지 않음)
- [ ] 검증 실패 시 모드 강등 옵션을 제시하고 **조용히 넘어가지 않음**
- [ ] 설정 화면에 비용(스크롤 저하 등)이 표시됨
- [ ] `browser_*` 도구 세션도 같은 GPU 모드를 따르고 **동시 1개로 직렬화**됨

### 데몬 · 로그 패널 (4차 개정 — §3.7 · §5.12)
- [ ] **TTY 없이**(`nohup`/`stdio: 'ignore'`) 12단계 부팅이 끝까지 진행됨
- [ ] 서버가 TTY 를 읽거나 화면에 출력하지 않음(NDJSON 만 기록)
- [ ] `harnesside status` / `logs -f` / `down` 동작, TTY 유무와 무관하게 동일
- [ ] **단일 인스턴스 보장**(flock). 두 번째 실행이 거부되고 이유가 설명됨
- [ ] `daemon` 모드에서 창을 닫으면 서버·llama-server 가 유지됨
- [ ] `window` 모드(기본)에서는 창을 닫으면 5초 이내 종료됨 — **기본값이 바뀌지 않았음**
- [ ] **하단 "서버 로그" 패널에 로그가 상시 표시**되고 닫을 수 없음
- [ ] 부팅 12단계 로그가 패널에서 처음부터 끝까지 보인다
- [ ] 새로고침 후 `sinceSeq` 로 로그가 **이어지고** 흐름이 끊기지 않음
- [ ] **500,000자 상한** 동작, 초과 시 오래된 줄만 버려지고 **최신 줄은 남음**
- [ ] 상한 도달 시 "잘렸습니다" 배너가 **한 번만** 표시됨
- [ ] 소스 필터(서버/llama/브라우저)·레벨 필터·검색 동작
- [ ] `llama-server` stdout/stderr 가 패널에 tee 되고, 에러가 회전으로 지워져도 보존됨
- [ ] 로그 패널이 가상 스크롤을 사용해 5만 줄에서도 프레임 예산 유지
- [ ] 로그에 시크릿이 평문으로 남지 않음

### 설정 · 업데이트 · 버전 (5차 개정 — §5.13)
- [ ] `mod+,` 로 설정 화면이 열리고 6개 섹션(모델/브라우저/에이전트/로그/업데이트·버전/고급)이 보인다
- [ ] 모든 설정에 **현재 값 · 출처 · rationale** 이 함께 표시됨
- [ ] 버전 블록(현재 버전·채널·최신·상태·체크섬)이 표시됨
- [ ] 업데이트 확인 / 다운로드 / 검증 / 적용 / 되돌리기 버튼이 각각 동작
- [ ] **해시 불일치 시 적용되지 않고 파일이 삭제됨**
- [ ] **적용 실패 시 자동 롤백**되어 이전 버전으로 부팅됨
- [ ] **실행 중인 인스턴스를 덮어쓰지 않음**(안내 + `harnesside down` 힌트)
- [ ] 업데이트/되돌리기가 **승인 게이트를 통과해야만** 수행됨
- [ ] 자동 설치는 **기본 꺼짐**, 부팅 시 자동 확인도 꺼짐
- [ ] 개발 모드 배지가 표시됨
- [ ] **HF 신규 양자화/파일 알림이 뜸**(파일 변경이 있을 때만)
- [ ] 알림에 **이 PC 적합도 판정**이 함께 표시됨
- [ ] **무시 후 재발하지 않음**, 1일 3건 상한 동작
- [ ] **llama.cpp 새 빌드 알림**이 뜨고 릴리스 노트로 이동 가능
- [ ] 네트워크 불가 시 **조용히 넘어가고** 오프라인 배지가 표시됨
- [ ] 알림이 로그 패널과 섞이지 않고 별도 배지로 도착함
- [ ] 알림이 패널을 끌어다 놓지 않고(모달로) 표시됨

### 수명 (요구 9)
- [ ] 서버 구동 시 llama.cpp가 **먼저** 기동(순서 검증 로그 남김)
- [ ] 브라우저 닫으면 llama.cpp 종료 (5초 이내)
- [ ] 신호 S1~S5 각각 독립 검증 (+ S6 고아 데몬 감지)
- [ ] **daemon 모드에서는 창을 닫아도 종료되지 않음**(예외가 기본이 아님을 확인)
- [ ] S3(하트비트) 판정 전 백그라운드 프로세스 유무 확인
- [ ] 체크포인트 후 재기동 시 자동 재개

### 튜닝 (요구 10)
- [ ] 하드웨어 감지 후 자동 플래그 결정(질문 없이)
- [ ] GPU 우선 정책
- [ ] 각 결정의 근거가 UI에 표시
- [ ] 서버 실제 컨텍스트 크기와 클라이언트 임계치 정합
- [ ] 1/2/3코어 머신에서 스레드 수 초과 없음

### 모니터 (요구 11)
- [ ] CPU/RAM/VRAM/GPU/스토리지/컨텍스트 사용량 표시
- [ ] 애니메이션(게이지·보간·스파크라인)
- [ ] 부하 시 프레임 예산 유지

### 파일 (요구 12, 13)
- [ ] 디렉토리 이동 + 파일 리스트 표시
- [ ] 파일 클릭 → 메인 IDE에 표시
- [ ] 디렉토리 변경 시 작업 폴더도 함께 이동(도구 baseDir 일치)
- [ ] rule/skill 재로드
- [ ] 경로 탈출 차단 테스트 통과

### 업데이트/GitHub (요구 14, 16)
- [ ] 버전 정보 표시
- [ ] 바이너리 업데이트 + 해시 검증 + 재시작
- [ ] 실패 시 현재 버전 유지
- [ ] **검증 실패 시 자동 롤백**(부팅 실패 감지)
- [ ] README 실시간 조회·렌더(새니타이즈)
- [ ] GitHub 저장소 조회/동기화(clone/pull/push)
- [ ] push는 명시적 확인, 강제 푸시 거부
- [ ] **HF 모델 변경 알림**(파일 기준 판정) + 무시 시 재발 없음
- [ ] **llama.cpp 빌드 변경 알림** + 릴리스 노트 이동

### 스타일/품질 (요구 17, 18)
- [ ] 전체 IDE 계열 스타일, 테마 토큰 단일 출처
- [ ] 한글 렌더링 정상
- [ ] E2E 통과, 콘솔 에러 0
- [ ] README에 "검증됨/미검증"을 구분해 기록
- [ ] CI 에서 테스트·타입체크·커버리지 하한선이 강제된다
- [ ] §10.6 부팅 스모크 테스트 통과

### 세션 · 설정 (새로 추가한 요구)
- [ ] 새로고침해도 마지막 세션이 통째로 복원된다
- [ ] 서버 재시작 후 체크포인트에서 자동 재개된다
- [ ] WS 재연결은 메모리 상태를 유지한다(세션 재적재하지 않음)
- [ ] 설정 병합 우선순위가 한 곳에서 정의되고, 화면에 값의 출처가 표시된다
- [ ] 구버전 `config.yaml` 이 자동 마이그레이션된다(알 수 없는 키 보존)
- [ ] 설정 쓰기가 원자적(임시→fsync→rename)
- [ ] 비밀 값이 설정 파일에 없고 `credentials.json`(0600)에 있다
- [ ] 모델 파일이 프로젝트 디렉터리에 저장되지 않는다

### 추가 (요구 19)
- [ ] §11.1 필수 M1~M13 구현
- [ ] §11.2 선택 항목 구현 여부 명시

---

## 부록 A. 포트 · 프로세스 수명 요약

| 포트 | 용도 | 기본값 |
|---|---|---|
| 8080 | llama-server (OpenAI 호환) | 점유 중이면 8081 → … 탐색 |
| 7317 | harnesside HTTP + WebSocket | 점유 중이면 7318 (저장 후 재사용) |
| 9222 | Chrome CDP (harnesside 전용 창) | 점유 중이면 다른 프로필/포트를 **경고와 함께** 사용 |

```
harnesside (Node)  ← 부모
├─ llama-server    (SIGTERM → 5s → SIGKILL)
├─ google-chrome --app  (SIGTERM → 3s → SIGKILL)   ※ GPU off 플래그 포함(§4.7)
└─ (필요 시) git, ffmpeg 등 도구 자식 프로세스
```

- 종료 순서: 턴 취소 → 체크포인트 → llama 종료 → chrome 종료 → 로그 flush.
- **크래시 루프 방지**: 30분 내 5회 이상 재시작이면 자동 재기동 중단 + 알림.

**데몬 모드(§3.7)의 수명 규칙**

| 항목 | `window` (기본) | `daemon` |
|---|---|---|
| 창 닫힘 | 전체 종료 | 서버·llama 유지, 유휴 정책만 평가 |
| `harnesside down` | 종료 | 동일하게 종료 |
| 프로세스 그룹 | 부모 = 서버 | `setsid` 로 분리되어 터미널 종료에 영향받지 않음 |
| 재기동 | `harnesside` | `harnesside open` (창만) |
| 인스턴스 가드 | flock | flock (동일) |

- **두 모드 모두 종료 순서는 같다**: 턴 취소 → 체크포인트 → llama 종료 → chrome 종료 → 로그 flush.

---

## 부록 B. 용어

| 용어 | 의미 |
|---|---|
| **CDP** | Chrome DevTools Protocol. `--remote-debugging-port`로 떠 있는 브라우저에 붙어 제어 |
| **`--app` 모드** | 주소창/탭바 없이 단일 창으로 페이지를 여는 Chrome 모드 |
| **자석 도킹** | 패널을 화면 가장자리로 끌어다니면 그 방향 영역에 스냅되는 레이아웃 |
| **가로 diff** | 좌/우 두 열로 나란히 보여주는 변경 비교 (반대: 인라인/세로) |
| **컴팩션** | 컨텍스트가 임계치에 닿으면 과거 대화를 요약해 압축하고 자동 재개 |
| **체크포인트** | 컴팩션/종료 직전에 목표·진행단계·미완료 도구 호출을 구조화해 남기는 상태 파일 |
| **스킬/룰** | 트리거에 따라 지연 로드되는 작업 지침(skill) / 항상 적용되는 규칙(rule) |
| **WS 이벤트 프로토콜** | §2.3 에 정의한 서버↔웹 단방향 이벤트 명세. 코드에서는 `src/server/protocol.ts` |
| **도킹 vs 분리** | 도킹 = 같은 창 안에서 영역 이동 / 분리 = 독립된 오버레이 창으로 떼어냄 |
| **시드네시 재사용** | `~/.harnesside/` (머신 전역) / `<프로젝트>/.harnesside/` (rule·skill만 커밋) / `state/` (비영속) |
| **활성 도구 정의** | `activeToolDefs()` — 실제로 모델에 전송되는 도구 목록의 유일한 진실원 |
| **VRAM 예산** | 가용 VRAM − 브라우저 예약 = llama-server 가 쓸 수 있는 예산 (§4.6) |
| **GPU 모드** | 브라우저의 GPU 정책. `off`(기본)/`budgeted`/`full` (§4.7.2) |
| **`--disable-software-rasterizer`** | GPU 를 꺼도 소프트웨어 GPU(SwiftShader)가 살아나는 것을 막는 플래그. `--disable-gpu` 와 **쌍**으로 간다 |
| **데몬 모드** | 창 없이 계속 도는 서버 실행 방식 (§3.7). 기본값이 아니며 명시적 opt-in |
| **로그 링** | 메모리에 상한(500,000자)으로 유지되는 순환 로그 버퍼 (§5.12.2) |
| **`sinceSeq` / `epoch`** | 로그 재접속 이어받기. `seq`=단조 증가, `epoch`=프로세스 식별 (§2.3) |
| **알림(notice)** | 사용자에게 제시하는 권장(모델 변경·빌드 변경). 로그와 다른 채널 (§5.13.2) |
| **silence(무시 목록)** | 같은 알림이 다시 오지 않게 영구 차단하는 사용자 선택 |

---

## 부록 C. 이 문서 자체의 유지보수 규칙

명세서가 코드에서 뒤처지면 그 순간 이 프로젝트는 방향을 잃는다.

- **§12 Phase 표는 living document.** 구현·검증이 끝날 때마다 상태를 갱신한다.
  (원본 `PROMPT.md` §8 이 하던 방식)
- **발견한 버그는 "현상 → 재현 → 근본 원인 → 수정 → 재발 방지 테스트" 순서로 기록**한다.
  수정 설명 없이 커밋된 버그는 되돌아온다.
- **"설정했다"와 "동작한다"는 다른 문장으로 쓴다.** 설정 화면과 이 문서 모두에서
  둘을 구분한다(§4.7.5 · §5.13.1). 검증 수치와 그 측정 방법·시각을 함께 적는다.
- **요구사항 번호(1~19)를 절대 재해석하지 않는다.** 추가된 기능은 §11 에,
  원문에 없던 설계 결정은 해당 섹션에 "왜 이렇게 했는지"와 함께 적는다.
  **의도적인 예외(예: `daemon` 모드의 요구 9 예외)는 예외라고 명시해야 한다.**
- **이 문서의 수치(파일 크기·포트·기본값)는 실제 환경에서 재확인한다.**
  하드코딩된 수치가 입력값이 되는 곳(§6.3 튜닝, §4.6 VRAM 예산)이 특히 그렇다.
- **"검증됨"을 쓸 때는 언제 어떻게 확인했는지 함께 적는다.** 그러지 않으면
  검증됨과 검증 안 됨이 구별되지 않아 문서가 무의미해진다.

---

## 변경 이력

| 날짜 | 내용 |
|---|---|
| 2026-09-29 | 최초 작성. llamacli PROMPT.md/IMPROVEMENTS.md/README.md 및 소스를 근거로 작성 |
| 2026-09-29 | 2차 개정. §3.6 보안 경계 · §4.6 VRAM 예산 · §5.10 세션 영속화 · §5.11 도구 목록 · §6.4 설정 규약 · §10.3.1 보안 테스트 · §10.6 CI 추가. 오타/중국어 혼입/순환참조/부조화 교정 |
| 2026-09-29 | **3차 개정 — 브라우저 GPU 정책.** §4.7 신설(CDP 호출 시 GPU 비활성). 실측 근거(Chrome 153, RTX 2070 SUPER: GPU off 시 VRAM +10 MiB·compute-apps 무 chrome 항목·`glRenderer: "Disabled"`, total RSS 1.54 GiB) 반영. §4.1 플래그 단일 출처화(`browserFlags.ts`)·`--disable-features` 중복 키 함정 명시·`--remote-allow-origins` 추가. §4.6 예산을 GPU 모드별로 분리(`off`=0). §4.8 브라우저 도구에도 동일 정책. §3.2 를 12단계로 확장([5] GPU 정책/실측 VRAM 신설). §5.9 소프트웨어 렌더 예산, §10.2 `browserFlags` 테스트, §10.4 GPU 자동 검증, §10.5 매트릭스 확장. **"설정됨 ≠ 동작함" 원칙을 §4.7.5 · 부록 C 에 명문화** |
| 2026-09-29 | **4차 개정 — 데몬 + 상시 디버그 창.** §3.7 신설(TTY 비의존, `window`/`daemon` 2모드, flock 단일 인스턴스, `up/down/status/logs/open/doctor`). §5.12 신설(서버 로그 패널: 서버·llama-server·브라우저 3소스 상시 스트리밍, **보관 상한 500,000자/50,000줄/회전 25 MiB** 근거 명시, 가상 스크롤, `epoch`+`sinceSeq` 이어받기). §3.5.1 로그 파이프라인(NDJSON 단일 싱글턴), §2.3 `log.append`/`log.status`/`log.query`/`update.*`/`notice.push`, §3.3 로그·GPU·업데이트·알림 API 13종, §4.4 S6 추가 및 S3 유예 규칙, §3.6 승인 대기 중 창이 닫히면 자동 거절, P2.5 Phase 신설 |
| 2026-09-29 | **5차 개정 — 설정 메뉴 · 셀프 업데이트/버전 관리 · 추천 알림.** §5.13 신설(설정 화면 6섹션, 값의 출처/rationalle 표시, §5.13.1 업데이트 파이프라인: 해시 2중 검증·**자동 롤백**·버전 슬롯 3개·승인 게이트 연동·실행 중 덮어쓰기 금지, §5.13.2 **추천 알림**: HF 모델 변경을 **파일 기준**으로 감지하고 적합도 판정과 함께 알림(노이즈 규칙·silence), **llama.cpp 빌드 변경** 알림(실행 중 binary 기준·소스 리빌드 시 튜닝/GPU 모드 재적용 경고), 백그라운드 체크는 유휴 시·429 백오프·오프라인 조용 통과). §12 P13 확장, §13 체크리스트 3그룹 신설(브라우저 GPU·데몬/로그·설정/업데이트), §10.2/§10.3/§10.5 테스트 확장 |
