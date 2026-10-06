# PROMPT_PLATFORM_ENGINES — 엔진 3축: CUDA / Vulkan(AMD·Intel) / MLX(Apple Silicon)

> 포터블 배포가 플랫폼별로 나뉜 지금, 엔진 선택이 따라가지 못했다.
> Linux+NVIDIA(CUDA)만 실측된 상태로 플랫폼 매트릭스를 넓히면
> "받아지지만 돌지 않는" 설치물이 플랫폼 수만큼 생긴다.
> 그래서 엔진 결정을 **측정으로** 넓힌다. 추측으로 넓히지 않는다.

## 0. 검증된 현 상태 (2026-10-07 · 코드 기준, 추측 아님)

| 축 | 상태 | 근거 |
|---|---|---|
| NVIDIA CUDA | 실측 동작 | `stockRuntime` CUDA 사전빌드 + cudart 번들, `engineCommon.detectCudaVersion`, 실머신 8GiB 카드에서 `-ngl 999` 실측 기록 (`calibrateTuning.ts` 주석) |
| macOS | llama.cpp Metal 사전빌드만 | `stockRungsFor` darwin 분기 = 단일 `bin-macos` 자산. **MLX 언급 0건** (`grep mlx` 전수 무결과) |
| AMD ROCm 사전빌드 | 코드만 있고 자산 없음 | `stockRungsFor`가 `*-rocm-*` 자산을 찾지만, ggml-org 릴리스에 ROCm 프리빌트는 게시되지 않는다 → 이 rung은 매번 스킵되는 죽은 분기일 가능성이 큼. 릴리스 자산 목록 실측으로 확인할 것 |
| AMD/Intel Vulkan 사전빌드 | 코드 존재, 실측 없음 | `ubuntu-vulkan` / `win-vulkan` rung 존재. Vulkan 빌드가 실제 AMD 카드에서 뜨는지, `--n-cpu-moe`·`-fa`·`--cache-type-k q8_0` 플래그를그대로 받는지 **측정 없음** |
| AMD 감지 | Linux sysfs + Windows 어댑터명 | `hardware.detectAmdGpus` (sysfs), `windowsAdapterHasVulkanGpu` (문자열 매칭). Windows에서 VRAM 크기는 못 읽어 CPU 기준 사이징 + Vulkan 빌드 — 의도된 절충 |
| 서빙 | llama-server 전용 스폰 | `LlamaServerManager`·`llamaLauncher`는 llama-server argv 전제. `OpenAICompatibleClient`는 baseUrl만 보므로 **다른 OpenAI 호환 서버도 붙을 수는 있음** — 스폰·헬스체크·모델검증은 llama 전제 |
| 모델 카탈로그 | GGUF 전용 | `ornith-ai/Ornith-1.5-35B-A3B-GGUF` · `Ornith-1.5-9B-GGUF` 고정 + Q4_K_M 우선. MLX(safetensors, `mlx-community/*`) 경로는 없음 |
| 포터블 | linux-x64 · win32-x64 실측 빌드 | `v0.3.5` 릴리스 자산 9개. **macOS 포터블 없음** (node-pty darwin-arm64 프리빌트 존재는 별도 확인 필요) |

## 1. 작업 1 — Vulkan(AMD·Intel) 실측 hardening (우선순위 1)

Vulkan 코드는 있지만 "Vulkan 머신에서 돌려봤다"는 기록이 없다. 순서:

1. **릴리스 자산 실측**: 최신 llama.cpp 릴리스 5개의 자산 목록을 GitHub API로 읽어 `*-vulkan-*` · `*-rocm-*` 존재 여부를 표로 확정. ROCm 자산이 없으면 rocm rung을 **삭제하지 말고** `unmeasured: ["ROCm 사전빌드 (릴리스에 자산 없음)"]`로 명시하고 소스빌드(HIP) 경로만 남길 것. 없는 것을 지우는 게 아니라 모른다고 말하는 게 이 저장소 규칙.
2. **AMD 실머신 1대 확보 후 측정** (실머신 없이 이 항은 진행 금지):
   - Vulkan 사전빌드 기동 → `offloaded N/N` · VRAM · 프리필/생성 tok/s 기록
   - 플래그 호환 매트릭스: `--n-cpu-moe` (MoE) · `-fa on` · `--cache-type-k q8_0` · `-c` · `-np 1 -no-kvu` — 거부되는 플래그가 있으면 백엔드별 argv 분기 (`buildServerArgs`에 `backend` 인자, 기본값은 현행 유지)
   - `calibrate.ts` OOM 패턴에 Vulkan OOM 문자열 (`ErrorOutOfDeviceMemory` 이미 있음 — 실제 로그와 대조)
3. **Windows AMD VRAM**: `Win32_VideoController.AdapterRAM`은 32비트라 4GiB에서 잘린다(현 코드 주석). 대안 실측: `nvidia-smi`식 per-process 조회의 AMD 대응 (`rocm-smi` Linux, Windows는 `wmic`…이 아니라 `Get-Counter` GPU Engine? — 미측정이면 `unmeasured`로 남기고 CPU 사이징 유지). **추정치로 VRAM을 지어내지 않는다.**

완료 조건: AMD 1대 이상에서 `setup` → 기동 → `/server calibrate` → tok/s 기록이 `docs/VERIFICATION.md`에 있음.

## 2. 작업 2 — macOS MLX 엔진 (우선순위 2, 신규 백엔드)

llama.cpp Metal은 유지한다. MLX는 **대체 엔진**으로 추가하며, 선택 규칙은 측정 기반:

1. **선택 규칙 (먼저 정하고, 코드는 나중)**:
   - Apple Silicon + RAM ≥ 16GB → MLX 후보, 그 외 → llama.cpp Metal (현행)
   - 규칙의 근거를 숫자로: 동일 모델·동일 프롬프트에서 Metal llama.cpp vs `mlx-lm`의 프리필/생성/메모리. MLX가 느리면 추가하지 않는다 — "네이티브"는 근거가 아니다.
2. **필요한 신규 모듈** (기존 llama 경로를 건드리지 않고 옆에):
   - `src/setup/mlx.ts`: `uv`/`pipx`/`brew` 중 있는 것으로 `mlx-lm` 설치 확인 (없으면 `manual` 안내 — 자동 설치는 `planBuildEnv` 패턴 재사용, Homebrew 없는 Mac에 brew를 깔지 않는다)
   - 모델: `mlx-community/*` safetensors 매핑 (GGUF 카탈로그와 별도 테이블 — 섞으면 양자화 매칭이 깨진다)
   - 스폰: `python -m mlx_lm.server --model <id> --port <p>` (OpenAI 호환 `/v1`). 헬스체크는 `/v1/models` — `LlamaServerManager`를 재사용하지 말고 `MlxServerManager` 분리 (argv·로그 패턴이 다름. `GPU_LOG_LINE`의 `offloaded` 정규식은 MLX 로그에 없음)
   - `findLlamaServer`와 동등한 `findMlxServer`: `mlx_lm.server` 프로세스 귀속 + 버전 프로브
3. **Tool calling 검증 필수**: `mlx_lm.server`의 tool-call이 이 에이전트의 스트리밍 파서(`agent/loop.ts`)와 맞는지 실서버로 확인. 안 맞으면 MLX는 "추론용"이 아니라 **미지원**으로 기록 (붙여놓고 안 되는 게 최악).
4. **튜닝**: MLX는 `-ngl`·`--n-cpu-moe` 개념이 없음. `tuneForHardware`에 MLX 분기를 넣지 말고 **별도 `tuneMlxForHardware`** (컨텍스트·스레드·메모리 한도만). 규칙 둘 금지 원칙은 "같은 규칙은 한 곳에"이지 "다른 엔진을 한 함수에"가 아니다.

완료 조건: Apple Silicon 실머신에서 `setup`이 MLX를 선택·기동하고, 에이전트 1턴(도구 호출 포함)이 성공한 로그.

## 3. 작업 3 — 포터블 매트릭스 완성 (우선순위 3)

1. `release.yml` 매트릭스에 `macos-14` (arm64) 추가 전제 확인: `node-pty` darwin-arm64 프리빌트 존재 여부를 `npm view` + 실빌드로 확인. 없으면 매트릭스에 넣지 않고 이유를 릴리스 노트에 적는다.
2. 포터블 zip 파일명 규칙 고정: `<plat>-<arch>`는 `process.platform`-`process.arch` 그대로 (`win32` 표기를 `win`으로 "예쁘게" 바꾸지 않는다 — 받는 쪽 검증 코드와 어긋난다).
3. 각 플랫폼 zip에 그 플랫폼의 엔진 rung이 실제로 포함·동작하는지: Linux=CUDA·Vulkan·CPU, Windows=CUDA·Vulkan·CPU, macOS=Metal(+MLX, 작업 2 완료 후). rung별 `verifyLlamaServer` 결과를 설치 로그에 남긴다.

## 4. 하지 말 것

- ROCm 사전빌드 "있을 것"이라 가정하고 코드 유지 — 자산 실측 후 없으면 `unmeasured` 명시.
- MLX를 llama.cpp 스폰·튜닝·calibration 코드에 `if mlx`로 끼워넣기 — 엔진이 다르면 모듈이 다르다.
- 실머신 없는 플랫폼의 tok/s·VRAM 수치 인용 — 합성 수치·문서 베끼기는 금지. `미측정`으로 적는다.
- GGUF 카탈로그에 MLX 모델 ID를 같은 테이블에 추가 — 포맷이 다르면 테이블이 다르다.

## 5. 검증 게이트 (공통)

- `npm run typecheck` · `npm test` · `node scripts/ci-checks.mjs` 통과
- 신규 판정은 `unmeasured` 상태를 가질 것 (0·false·"없음"으로 채우지 않는다)
- `docs/VERIFICATION.md`에 실측 머신·날짜·수치 기록. 실측 없는 항목은 "미측정" 표 유지
- `harnesside doctor`가 새 엔진 상태를 말할 수 있을 것 (모르면 "미확인")
