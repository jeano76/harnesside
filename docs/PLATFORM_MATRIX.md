# 플랫폼 매트릭스 — 배포물 × 엔진 × 실측

> 정본 규칙: 각 칸은 `지원(실측)` / `지원(CI)` / `코드만(미측정)` / `미지원(이유)` 중 하나다.
> 빈 칸·추정 금지. 실측은 **설치 스크립트(`harnesside measure`)가 각 머신에서** 하고,
> 여기에는 그 기록을 옮긴다. 기록이 없는 칸은 `미측정` 이다.
>
> 근거 날짜: 2026-10-07. 다시 확인하는 법은 각 절 끝에 적었다.

## 1. 배포물 (포터블 zip — 유일한 설치·업데이트 경로)

| 배포물 | 릴리스 러너 | node-pty | 상태 | 비고 |
|---|---|---|---|---|
| `linux-x64` | `ubuntu-latest` | 소스 빌드(러너) | **지원(실측)** | §4 머신. 로컬에서 만든 zip 을 풀어 `install.sh --check-only`(2622개 파일 대조·플랫폼 일치) · `node-pty` 로드 · `setup`(하드웨어·엔진·모델 선택까지) · 런처로 `measure` 확인 |
| `win32-x64` | `windows-latest` | 프리빌드 `win32-x64` | 지원(CI) | 실머신 실측 기록 없음 |
| `linux-arm64` | `ubuntu-24.04-arm` | 소스 빌드(러너) | 코드만(미측정) | 첫 태그 릴리스에서 CI 결과로 갱신 |
| `win32-arm64` | `windows-11-arm` | 프리빌드 `win32-arm64` | 코드만(미측정) | 〃 |
| `darwin-arm64` | `macos-15` | 프리빌드 `darwin-arm64` | 코드만(미측정) | 서명·공증 없음 — `install.sh` 가 quarantine 속성 제거 |
| `darwin-x64` | `macos-15-intel` | 프리빌드 `darwin-x64` | 코드만(미측정) | 〃 |
| `linux-x64` musl (Alpine) | — | — | 미지원(배포물 없음) | 엔진 사전 빌드가 glibc 전용 — 소스 빌드 경로만 있음 |

- node-pty 1.1.0 의 프리빌드 목록(`node_modules/node-pty/prebuilds`): `darwin-arm64` `darwin-x64` `win32-arm64` `win32-x64`. Linux 는 설치 시 `node-gyp` 로 빌드되므로 **그 플랫폼 러너에서 만든 zip** 에만 맞는 바이너리가 들어간다.
- 러너 레이블 확인: GitHub 문서 "GitHub-hosted runners" (2026-10-07). macOS Intel 은 `macos-15-intel`·`macos-26-intel` 만 남아 있다.
- 릴리스 워크플로는 각 러너에서 zip 을 **풀어서** `install-portable.mjs --check-only` · `node-pty` 로드 · `--version` · `doctor` 를 돌린다. "지원(CI)" 는 그 통과를 뜻한다 — **GPU 경로는 CI 에서 검증되지 않는다.**

## 2. 엔진 — llama.cpp 사전 빌드 자산 (실측)

GitHub API 로 최신 릴리스 5개(`b11438`–`b11445`, 2026-10-06)의 자산을 읽었다. 5개 모두 같은 구성이다.

| OS | 아키 | CPU | CUDA | ROCm | Vulkan | 기타 |
|---|---|---|---|---|---|---|
| Linux (ubuntu) | x64 | ✓ | 12.8 · 13.4 (+cudart) | **10.0** | ✓ | SYCL fp16/fp32 · OpenVINO |
| Linux (ubuntu) | arm64 | ✓ | 13.4 (+cudart) | — | ✓ | — |
| Windows | x64 | ✓ | 12.4 · 13.4 (+cudart) | **10.0** | ✓ | SYCL · OpenVINO |
| Windows | arm64 | ✓ | 13.4 (+cudart) | — | ✓ | OpenCL (Adreno) |
| macOS | arm64 | Metal 포함 단일 빌드 | — | — | — | — |
| macOS | x64 | ✓ | — | — | — | — |

**정정**: `PROMPT_PLATFORM_ENGINES.md` 초판은 "ROCm 프리빌트는 게시되지 않는다 → 죽은 분기일 가능성" 이라고 적었다. **틀렸다.** `ubuntu-rocm-10.0-x64` · `win-rocm-10.0-x64` 가 게시되고 있고, `stockRungsFor` 의 ROCm rung 은 살아 있다.

다시 확인하는 법:
```bash
curl -s "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5" | jq -r '.[0].assets[].name'
```

## 3. 엔진 선택 — 현재 코드가 실제 릴리스에서 고르는 사다리

`stockRungsFor(b11445, machine)` 를 플랫폼·GPU 조합마다 실행한 결과(2026-10-07). 사다리의 각 rung 은 설치 시 **실행해서 뜨는지** 확인된 뒤에만 쓰인다.

| 머신 | 사다리 (앞이 우선) |
|---|---|
| linux-x64 · NVIDIA | CUDA 12.8 → Vulkan → CPU |
| linux-x64 · AMD | ROCm 10.0 → Vulkan → CPU |
| linux-x64 · Intel/기타 GPU | Vulkan → CPU |
| linux-x64 · GPU 없음 | CPU |
| linux-arm64 · NVIDIA | CUDA 13.4 → Vulkan → CPU |
| linux-arm64 · 기타 | Vulkan → CPU / CPU |
| win32-x64 · NVIDIA | CUDA 13.4 → Vulkan → CPU |
| win32-x64 · AMD | ROCm 10.0 → Vulkan → CPU |
| win32-x64 · Intel/기타 | Vulkan → CPU / CPU |
| win32-arm64 · NVIDIA | CUDA 13.4 → Vulkan → CPU |
| win32-arm64 · 기타 | Vulkan → CPU / CPU |
| darwin-arm64 | Metal (같은 바이너리로 `--device none` CPU 폴백) |
| darwin-x64 | macOS x64 (CPU) |

빈 곳 (코드에 없음 — 추가하려면 실머신 측정이 먼저):
- Intel GPU 의 SYCL · OpenVINO rung — 지금은 Vulkan 으로 간다.
- Windows on ARM (Snapdragon) 의 OpenCL(Adreno) rung.
- macOS MLX — `PROMPT_PLATFORM_ENGINES.md` §6.

## 4. 설치 시 실측 기록

`harnesside measure` 의 출력에서 옮긴다(`.harnesside/state/measurements.json`). 같은 프롬프트(약 1500 토큰 프리필 + 128 토큰 생성, `ignore_eos`)로 잰다.

### 2026-10-07 · linux-x64 · i5-12400F (물리 6 / 논리 12, AVX2) · RTX 2070 SUPER 8 GiB · bash

엔진: 로컬 빌드 `llama.cpp/build-opt` (CUDA) · 모델 `Ornith-1.5-9B-Q4_K_M` · `-c 81920 -ngl 28` · KV q8_0 · 메모리 측정 `nvidia-smi`

| 설정 | 프리필 tok/s | 생성 tok/s | 남은 VRAM |
|---|---|---|---|
| **기준 `-t 6` (물리 코어)** | 1052 | **25.9** | 1567 MiB |
| `-t 12` (논리 코어, SMT 포함) | 1053 | 19.9 (−23%) | — |

같은 날 **포터블 zip 을 풀어 둔 설치 폴더**에서 런처(`./harnesside.sh measure`)로 다시 잰 값: 기준 프리필 1048 · 생성 25.8 / `-t 12` 프리필 980 · 생성 18.1 tok/s — 같은 결론.

결론: 기준 유지. SMT 스레드까지 쓰면 생성이 23% 느려진다 — 생성은 메모리 대역폭에 묶여 있어 스레드를 늘리면 경합만 늘어난다. **예측(`tuneForHardware`)으로는 이 차이를 알 수 없었고**, 이것이 설치 시 실측을 두는 이유다.

### 확인 중 드러난 것

- `setup` 은 로컬에 있던 `Ornith-1.5-35B-A3B-Q4_K_M.gguf`(21,864,081,056 B)를 재사용하지 않고 Hub 의 `Ornith-1.5-35B-Q4_K_M.gguf`(20.2 GiB)를 받으려 했다. 크기가 달라 **다른 파일**이 맞다 — 재사용 규칙(같은 양자화 + 정확히 같은 크기)은 의도대로 동작했다. 이 확인에서는 다운로드를 멈추고 9B 설정으로 `measure` 를 돌렸다.
- 후보 서버를 내린 직후 같은 포트에 옛 서버가 아직 떠 있었다(SIGTERM 처리 중). 그대로 다음 후보를 띄우면 "포트 사용 중" 실패가 그 설정의 결과로 기록된다 → `runMeasure` 가 포트가 빌 때까지 기다리게 고쳤다.

### 그 외 플랫폼

미측정. 설치 스크립트가 각 머신에서 재고, 그 출력(`harnesside measure` 의 표)을 여기 붙인다.
