# PROMPT_PLATFORM_ENGINES — 플랫폼별 배포물 × 엔진 × 모델 × calibration

> 목표: **OS · CPU 아키텍처 · libc · 셸 · GPU 벤더**가 다른 어떤 머신에서든
> 그 플랫폼용 배포물을 설치하면 ① 돌아가는 모델 서버(엔진 rung)와 ② 그 머신에 맞는
> 모델이 자동으로 골라지고, ③ calibration으로 설정값이 **실측 최적값**으로 수렴해야 한다.
>
> 지금은 Linux+NVIDIA(CUDA)만 실측된 상태다. 이대로 매트릭스를 넓히면
> "받아지지만 돌지 않는" 설치물이 플랫폼 수만큼 생긴다.
> 그래서 넓히는 기준은 **측정**이다. 추측으로 넓히지 않는다.

## 구현 현황 (2026-10-07 갱신)

| 항목 | 상태 | 어디 |
|---|---|---|
| 배포 단일화 — 포터블 zip 만 (설치·셀프업데이트 공용) | **구현** · `verify:selfupdate` 45/45 | `scripts/make-portable.mjs` · `src/server/updateService.ts` · `.github/workflows/release.yml` |
| 옛 경로 제거 — tar.gz 릴리스 · `npm run install:g` | **삭제** | README 설치 가이드도 포터블로 교체 |
| 배포물 매트릭스 6종 (linux/win32 × x64/arm64, darwin × arm64/x64) | **워크플로 구현** · 첫 태그에서 CI 결과 확인 필요 | `release.yml` `build-portable` |
| 설치 시 실측 (`harnesside measure`, 설치 스크립트가 자동 실행) | **구현** · 이 머신 실측 기록 있음 | `src/setup/measure.ts` · `scripts/install-portable.mjs` · `scripts/install.sh` |
| CPU 명령어 확장 · 물리/P·E 코어 · 셸 · WSL 감지 | **구현** | `src/setup/machineProbe.ts` |
| 백엔드별 메모리 측정 수단 (nvidia-smi · amdgpu sysfs · RAM/통합) | **구현** (Intel·Windows AMD 는 "없음"으로 기록) | `memoryProbeFor` |
| 실측값 재사용 (엔진·모델·컨텍스트·오프로드 키) | **구현** — 스레드만 머신 단위로 재사용 | `~/.harnesside/machine-profile.json` · `bootstrap.ts` |
| ROCm 사전 빌드 | **정정**: 게시되고 있다 (아래 §0.2) | `docs/PLATFORM_MATRIX.md` §2 |
| Vulkan(AMD·Intel) 실머신 hardening | 미착수 — 실머신 필요 | §5.1 |
| macOS MLX | 미착수 — Apple Silicon 필요 | §6 |
| 모델 티어 일반화 · 하위 티어 | 미착수 | §3 |
| 측정 키에 드라이버 버전 | 미구현 — 지금은 엔진 경로·모델·ctx·ngl 만 | §4.4 |

---

## 0. 검증된 현 상태 (2026-10-07 · 코드 기준, 추측 아님 — 작업 전 기록)

### 0.1 배포물 · OS · 셸

| 축 | 상태 | 근거 |
|---|---|---|
| 포터블 배포물 | linux-x64 · win32-x64 **두 개만** | `release.yml` `build-portable` 매트릭스 = `ubuntu-latest`(bash) · `windows-latest`(pwsh). 파일명 `harnesside-portable-${process.platform}-${process.arch}.zip` (`make-portable.mjs:31`) |
| macOS 포터블 | 없음 | 매트릭스에 macOS 러너 없음. node-pty darwin 프리빌트 여부 미확인 |
| arm64 (Linux/Windows) | 없음 | 매트릭스에 arm 러너 없음 |
| Linux musl(Alpine) | 소스빌드로만 | `stockRungsFor`가 musl이면 `[]` 반환 (glibc 전용 프리빌트) |
| WSL | 부분 대응 | `engineCommon.ts` WSL CUDA 런타임 안내 문자열 존재. WSL 전용 감지·실측 기록 없음 |
| 실행 셸 / 런처 | bash · cmd · PowerShell 런처 존재 | `scripts/harnesside.sh` · `harnesside.cmd` · `Install-Portable.ps1`. `verify-shell.mjs`가 실 PTY로 셸 호환 확인. zsh·fish·Git Bash·pwsh 7 vs Windows PowerShell 5.1 **구분 실측 기록 없음** |

### 0.2 하드웨어 감지 · 엔진

| 축 | 상태 | 근거 |
|---|---|---|
| NVIDIA CUDA | 실측 동작 | `stockRuntime` CUDA 사전빌드 + cudart 번들, `engineCommon.detectCudaVersion`, 8GiB 카드 `-ngl 999` 실측 (`calibrateTuning.ts` 주석) |
| macOS | llama.cpp Metal 사전빌드만 | `stockRungsFor` darwin 분기 = 단일 `bin-macos-<arch>` 자산 (arm64=Metal, x64=CPU). **MLX 언급 0건** |
| AMD ROCm 사전빌드 | 코드 있음, **자산 있음(실측)** | `*-rocm-*` rung 존재. 2026-10-07 실측: `ubuntu-rocm-10.0-x64` · `win-rocm-10.0-x64` 가 최신 5개 릴리스 모두에 게시됨 — rung 은 살아 있다 (`docs/PLATFORM_MATRIX.md` §2) |
| AMD/Intel Vulkan | 코드만, 실측 없음 | `ubuntu-vulkan`·`win-vulkan` rung 존재. 실 AMD/Intel 카드 기동·플래그 호환 **측정 없음** |
| AMD 감지 | Linux sysfs + Windows 어댑터명 | `detectAmdGpus`(sysfs), `windowsAdapterHasVulkanGpu`(문자열). Windows VRAM은 못 읽음 → CPU 기준 사이징 (의도된 절충) |
| Intel GPU (Arc/iGPU) | 벤더 타입만 존재 | `GpuVendor`에 `"intel"` 있음. Intel 전용 감지·SYCL 경로·실측 없음 |
| APU/iGPU 공유 메모리 | 미고려 | VRAM=전용 메모리 전제. AMD APU·Intel iGPU·Apple 통합 메모리는 RAM과 같은 풀 |
| **CPU 기능 감지** | **없음** | `Hardware`는 `cpuCount`·`arch`만. AVX2/AVX-512/NEON/SVE 감지 0건 (`grep -i avx` 무결과). P/E 하이브리드 코어 구분 없음 (`threadPlan(cpuCount)`) |
| 서빙 | llama-server 전용 스폰 | `LlamaServerManager`·`llamaLauncher`는 llama-server argv 전제. `OpenAICompatibleClient`는 baseUrl만 보므로 다른 OpenAI 호환 서버도 붙을 수는 있음 |

### 0.3 모델 · calibration

| 축 | 상태 | 근거 |
|---|---|---|
| 모델 카탈로그 | GGUF 2종 고정 | `Ornith-1.5-35B-A3B-GGUF` · `Ornith-1.5-9B-GGUF`, Q4_K_M 우선 (`modelCatalog.ts`) |
| 모델 선택 | VRAM/RAM 두 갈래 | `chooseModel`: VRAM ≥ `MIN_35B_VRAM_GIB` && RAM 충분 → 35B, 아니면 9B. **9B도 못 올리는 머신(저RAM)의 하위 티어 없음** |
| 예측 튜닝 | 있음 | `tuneForHardware` (산술 예측: `-ngl`·`--n-cpu-moe`·ctx·KV 타입·스레드) |
| calibration | **NVIDIA 전용 실측** | `calibrate.ts` `defaultReadGpuName`·`defaultReadVramFreeMiB` 모두 `runNvidiaSmi`. AMD·Intel·Apple·CPU 전용 머신에서는 측정값이 `undefined` → 사실상 예측값 그대로 |
| calibration 대상 | 메모리 적합성만 | `planCalibration`은 VRAM·GGUF 헤더로 `-ngl`·`--n-cpu-moe`·ctx·KV·스레드 재계산. **처리량(tok/s) 측정·rung 간 비교 없음** |
| calibration 키 | 모델경로+ctx+GPU이름 | `calibrationKey(modelPath, contextSize, gpuName)`. 엔진 빌드 태그·백엔드·드라이버 버전이 키에 없음 → 드라이버/엔진 업데이트 후에도 옛 값 재사용 |

---

## 1. 지원 매트릭스 정의 (먼저 문서로 고정, 코드는 나중)

모든 작업의 기준표. `docs/PLATFORM_MATRIX.md`로 만들고, 각 셀은
`지원(실측)` / `지원(CI만)` / `미측정` / `미지원(이유)` 중 하나. **빈 칸·추정 금지.**

### 1.1 배포물 축 (= 포터블 zip 하나 단위)

배포물은 **`<platform>-<arch>`(+libc) 단위**로 나눈다. GPU 벤더별로 zip을 나누지 않는다 —
GPU 엔진은 설치 시 감지 후 `stockRuntime` 사다리로 받는다 (현 설계 유지, 이유: GPU 조합 수만큼
zip을 만들면 매트릭스가 곱셈으로 늘고, 사용자가 자기 GPU를 고르게 만들면 틀린 선택이 생긴다).

| 배포물 | 러너 (확인 필요) | 엔진 후보 (설치 시 선택) | 선결 조건 |
|---|---|---|---|
| `linux-x64` (glibc) | `ubuntu-latest` | CUDA → Vulkan → CPU (+ROCm 소스빌드) | 현행 |
| `linux-arm64` (glibc) | `ubuntu-24.04-arm` | Vulkan? → CPU | llama.cpp `ubuntu-arm64` 자산 존재 실측, node-pty linux-arm64 빌드 |
| `linux-x64-musl` | 컨테이너 잡 | CPU 소스빌드만 | 소스빌드 툴체인 안내. 우선순위 최하 |
| `win32-x64` | `windows-latest` | CUDA → Vulkan → CPU | 현행 |
| `win32-arm64` | `windows-11-arm` | CPU (→ Vulkan/OpenCL은 실측 후) | llama.cpp `win-cpu-arm64` 자산 실측, node-pty win-arm64 |
| `darwin-arm64` | `macos-14`+ | Metal llama.cpp, MLX(작업 4 이후) | node-pty darwin-arm64, 서명/공증(Gatekeeper) 정책 결정 |
| `darwin-x64` | Intel Mac 러너 가용성 확인 | CPU (Metal 불가 취급) | 러너 단종 여부 확인. 없으면 `미지원(러너 없음)`으로 적는다 |

- 러너 이름은 **작업 시점에 GitHub 문서로 재확인**. 존재하지 않는 러너를 매트릭스에 넣지 않는다.
- 파일명 `<plat>-<arch>`는 `process.platform`-`process.arch` 그대로 (`win32`를 `win`으로 바꾸지 않는다 — 받는 쪽 검증과 어긋난다). musl만 `-musl` 접미사 추가하고 받는 쪽 검증도 같이 고친다.
- 셀프업데이트(`verify:selfupdate`)가 **자기 `<plat>-<arch>` 자산만** 고르는지 각 배포물에서 확인.

### 1.2 셸 축

배포물마다 아래 셸에서 "설치 → 실행 → 에이전트 터미널에서 명령 1개"가 돼야 한다.

| OS | 셸 | 확인 항목 |
|---|---|---|
| Linux | bash · zsh · fish · sh(dash) | 런처 shebang이 `/bin/sh` 호환인가, fish에서 `export` 문법 안내가 깨지지 않는가, PTY 기본 셸 = `$SHELL` |
| macOS | zsh(기본) · bash 3.2 | bash 3.2 비호환 문법(`declare -A`, `${x,,}`) 금지, quarantine 속성 제거 안내 |
| Windows | PowerShell 5.1 · pwsh 7 · cmd · Git Bash | `Install-Portable.ps1`의 실행 정책(`-ExecutionPolicy Bypass` 범위), `.cmd`는 shell 경유로만 실행(커밋 4604c02), 5.1에서 UTF-8 콘솔 코드페이지, 경로에 공백·한글 |
| WSL | bash in WSL2 | Linux 배포물을 쓰되 GPU는 Windows 드라이버 경유. `/mnt/c` 모델 경로 I/O 성능 경고 |

- `verify-shell.mjs`를 셸 인자로 받게 확장하고 CI 매트릭스에서 셸별로 돌린다. 셸 실측이 불가능한 조합은 `미측정`.
- 경로 처리: 공백·비ASCII 경로를 테스트 픽스처에 반드시 포함 (외장 드라이브 모델 경로가 이 머신의 정상 케이스).

### 1.3 CPU 축 (신규 감지 필요)

| 항목 | 감지 방법 | 쓰는 곳 |
|---|---|---|
| ISA 확장 | Linux `/proc/cpuinfo` flags · macOS `sysctl hw.optional.*` · Windows `IsProcessorFeaturePresent` 또는 PowerShell | CPU rung 선택(AVX2 미지원 CPU에서 기본 CPU 빌드가 `Illegal instruction`으로 죽는지 실측), 진단 메시지 |
| 물리/논리 코어 · P/E 코어 | Linux `lscpu`/sysfs `cpu_capacity`, macOS `hw.perflevel0.physicalcpu`, Windows `Win32_Processor` | `threadPlan` — 현재는 `cpuCount`만 사용. 하이브리드 CPU에서 E코어까지 쓰면 느려지는지 calibration으로 결정 |
| 메모리 대역폭 클래스 | 감지 대신 calibration 실측 (tok/s) | CPU 전용 머신의 모델 티어 결정 |

- llama.cpp 최근 릴리스가 CPU 변형을 동적 로드(`ggml-cpu-*` 백엔드)하는지 **릴리스 자산을 열어 확인**. 동적 로드면 ISA 분기는 엔진이 하고, 우리는 감지 결과를 `doctor`·로그에만 쓴다. 아니면 rung 선택에 반영한다. 확인 전에는 어느 쪽도 가정하지 않는다.
- 감지 실패는 `unknown`이지 `false`가 아니다.

### 1.4 GPU 축

| 벤더 | 1순위 엔진 | 2순위 | 메모리 측정 수단 (calibration용) |
|---|---|---|---|
| NVIDIA | CUDA 사전빌드 (드라이버→CUDA 버전 매칭, 현행) | Vulkan → CPU | `nvidia-smi` (현행) |
| AMD dGPU | Vulkan 사전빌드 | ROCm 소스빌드(Linux, 툴킷 있을 때) → CPU | Linux: sysfs `mem_info_vram_total/used`. Windows: **미측정** — 서버 로그의 장치 메모리 줄로 대체 가능한지 실측 |
| Intel Arc / iGPU | Vulkan 사전빌드 | (SYCL은 소스빌드, 우선순위 낮음) → CPU | Linux: `xe`/`i915` sysfs 가능 여부 실측. 불가면 서버 로그 |
| AMD APU · Intel iGPU | Vulkan, **통합 메모리 규칙** | CPU | 전용 VRAM이 아니라 RAM 공유 → `chooseModel`·`tuneForHardware`가 VRAM과 RAM을 **이중으로 세지 않게** 별도 플래그(`unifiedMemory: true`) |
| Apple Silicon | Metal llama.cpp | MLX (작업 4) | 통합 메모리. `recommendedMaxWorkingSetSize` 상당 값을 서버 로그/`sysctl`에서 실측 |
| 없음 / 감지 실패 | CPU | — | RAM만 |

- 다중 GPU(NVIDIA+iGPU 등): `pickPrimaryGpu` 결과를 로그에 이유와 함께 남기고, iGPU를 1순위로 고르지 않는 테스트를 둔다.

---

## 2. 설치 시 자동 결정 파이프라인 (모든 플랫폼 공통)

설치(첫 실행 `setup`)는 아래 순서를 **항상 같은 순서**로 밟고, 단계마다 결과를
`machineProfile`(설치 로그 + config)에 기록한다. 단계가 모르면 `unknown`으로 남기고 다음 단계는
보수적 기본값을 쓴다.

```
1. 감지     OS/arch/libc/셸/CPU ISA·코어/RAM/GPU(벤더·VRAM·통합메모리·드라이버)
2. 엔진     stockRuntime 사다리: 플랫폼별 rung 후보 → 받기 → verifyLlamaServer(실기동) → 첫 성공 rung 채택
            (전부 실패 → 소스빌드 가능하면 안내/실행, 아니면 원인 + 다음 행동을 말하고 중단)
3. 모델     모델 티어표(§3)로 후보 선택 → 디스크 여유 확인 → 다운로드(재개·해시)
4. 예측튜닝 tuneForHardware (엔진 백엔드·통합메모리 반영)
5. 기동     서버 기동 → 헬스체크 → 모델 로드 확인(offloaded N/N 등 백엔드별 신호)
6. 빠른보정 §4의 quick calibration (시간 상한 있음, 건너뛰기 가능)
7. 기록     machineProfile + calibration 결과 + 선택 이유를 저장, `doctor`가 그대로 읽어 말한다
```

- 2단계에서 rung이 실패하면 **실패 이유를 rung별로** 남긴다 (`attempts`가 이미 있음 — 설치 로그에 노출).
- 엔진·모델 결정은 각각 "왜 이걸 골랐는지" 한 문장(`reason`)을 갖는다 (`ModelChoice.reason` 패턴을 엔진에도 적용).
- 사용자가 고른 값(모델 핀, 엔진 강제)은 자동 결정보다 우선하고, 덮어쓰지 않는다.

---

## 3. 모델 · 모델 서버 티어표

`chooseModel`의 두 갈래(35B/9B)를 **메모리 클래스 × 엔진** 표로 일반화한다.
표는 코드 한 곳(`modelCatalog.ts`)에만 두고 문서는 그 표를 생성/인용한다.

| 클래스 (가용 메모리 기준) | 모델 | 서버 | 비고 |
|---|---|---|---|
| dGPU VRAM ≥ 임계 && RAM 충분 | Ornith 35B-A3B Q4_K_M | llama-server (CUDA/Vulkan) | 현행. MoE 일부 CPU 오프로드 허용 |
| VRAM 부족, RAM 충분 | Ornith 35B-A3B (`--n-cpu-moe`) 또는 9B | llama-server | **어느 쪽이 빠른지는 calibration tok/s로 결정** — 현재는 산술로만 결정 |
| 통합 메모리 (Apple/APU) | RAM×허용비율로 판정 | Metal llama.cpp / MLX / Vulkan | VRAM·RAM 이중 계산 금지 |
| CPU 전용 | 9B (또는 하위 티어) | llama-server CPU | 처리량 하한 미달이면 경고 |
| 9B도 못 올림 (저RAM) | **하위 티어 — 미정** | — | 게시자 저장소에 실제 존재하는 소형 모델만 추가. 없으면 "이 머신은 로컬 모델 미지원 + 원격 OpenAI 호환 endpoint 연결 안내"로 끝낸다. 모델 ID를 지어내지 않는다 |

- 임계값(`MIN_35B_VRAM_GIB`, `MIN_RAM_MULTIPLE`)은 실측 머신 기록과 함께 둔다. 플랫폼별로 다르면 상수가 아니라 표의 열로.
- 양자화 선택: 기본 Q4_K_M. 메모리 경계에 걸리면 `QUANT_PREFERENCE` 하위로 내리되, **내린 사실과 이유를 사용자에게 말한다.**
- 서버 프로필: 엔진별로 `ServerProfile { engine, argvBuilder, healthCheck, loadSignal, memoryProbe }` 하나씩. llama-server(백엔드 플래그 차이 포함)와 MLX는 **다른 프로필, 다른 모듈**.
- 백엔드별 플래그 호환(`-fa`, `--cache-type-k q8_0`, `--n-cpu-moe`, `-np 1 -no-kvu`)은 실측 매트릭스로 확정 후 `buildServerArgs(backend)`에서 분기. 미측정 백엔드는 현행 argv + 거부 시 해당 플래그 제거 재시도 1회 (거부 로그를 남김).

---

## 4. Calibration — 플랫폼 공통 설계 (우선순위 1과 같이 진행)

현재 calibration은 "NVIDIA에서 메모리가 맞는가"만 본다. 모든 플랫폼에서
**"이 머신에서 이 설정이 실제로 최적인가"**를 측정하도록 넓힌다.

### 4.1 측정 수단을 백엔드별로 분리

`calibrate.ts`의 `defaultReadGpuName`/`defaultReadVramFreeMiB`(nvidia-smi 고정)를
`MemoryProbe` 인터페이스로 바꾼다:

```ts
interface MemoryProbe {
  backend: "cuda" | "vulkan" | "rocm" | "metal" | "mlx" | "cpu";
  deviceName(): Promise<string | undefined>;
  freeMiB(): Promise<number | undefined>;   // 모르면 undefined — 0으로 채우지 않는다
  source: string;                            // "nvidia-smi" | "sysfs" | "server-log" | "sysctl" …
}
```

- NVIDIA = nvidia-smi(현행), AMD Linux = sysfs, Apple = sysctl + 서버 로그, CPU = 가용 RAM.
- 측정 수단이 없는 백엔드는 **서버 로그 파싱**(로드 시 장치 메모리 줄)을 대체 수단으로 실측해 보고, 그것도 없으면 `undefined` → 예측값 유지 + `doctor`에 "보정 불가(측정 수단 없음)"로 표시.

### 4.2 메모리 적합성 + 처리량 두 단계

1. **적합성(현행 확장)**: 실측 여유 메모리 + GGUF 헤더 → `-ngl` · `--n-cpu-moe` · ctx · KV 타입 재계산 (`planCalibration` 산식 = `tuneForHardware`, 규칙은 한 곳).
2. **처리량(신규)**: 고정 프롬프트(프리필 ~2k 토큰 + 생성 128 토큰)로 후보 2~4개를 짧게 측정:
   - 스레드 수 (물리 코어 / P코어만 / 논리 코어)
   - `--n-cpu-moe` 경계값 ±k (MoE)
   - 35B+CPU오프로드 vs 9B 전량 GPU (§3 두 번째 행)
   - 동일 머신에서 rung이 2개 이상 성공했다면 rung 간 비교 (예: CUDA vs Vulkan) — **선택적, 긴 보정에서만**
   - 지표: 프리필 tok/s, 생성 tok/s, 피크 메모리, OOM 여부. 생성 tok/s 우선, 동률이면 메모리 여유 큰 쪽.

### 4.3 실행 모드와 안전장치

| 모드 | 언제 | 시간 상한 | 범위 |
|---|---|---|---|
| quick | 설치 직후 자동 (건너뛰기 가능) | 약 2~3분 | 적합성 + 스레드 2후보 |
| full | `/server calibrate --full` | 약 10~15분 | §4.2 전체 |
| re-check | 키 불일치 감지 시 (아래) | quick과 동일 | 사용자에게 먼저 묻는다 |

- 기존 원칙 유지: 바뀌는 값은 **미리보기 → confirm**, 실패하면 직전 설정으로 롤백.
- OOM 패턴: 백엔드별 문자열 표 (`ErrorOutOfDeviceMemory`·CUDA OOM·Metal 할당 실패 등)를 **실제 로그와 대조해서만** 추가.
- 측정 중 다른 GPU 사용자(브라우저·게임)가 있으면 결과가 흔들린다 → 측정 전후 여유 메모리 차이가 크면 "불안정 측정"으로 표시하고 적용하지 않는다.

### 4.4 결과 저장 · 무효화

- `calibrationKey`에 **엔진 빌드 태그 · 백엔드 · 드라이버 버전 · 모델 파일 해시(또는 크기+mtime) · ctx**를 포함.
- 키가 바뀌면(드라이버 업데이트, 엔진 rung 교체, 모델 교체) 저장된 값을 자동 재사용하지 않고 re-check 제안.
- 저장 항목: 채택값, 후보별 측정치, 측정 수단(`MemoryProbe.source`), 날짜. `doctor`와 `/server` 리포트가 그대로 출력.

완료 조건: NVIDIA(현행) + 최소 1개 비NVIDIA 백엔드(Apple Metal 또는 AMD Vulkan) 실머신에서 quick/full calibration 결과가 `docs/VERIFICATION.md`에 수치로 기록됨.

---

## 5. 작업 순서

| 순위 | 작업 | 산출물 | 실머신 필요 |
|---|---|---|---|
| 0 | §1 매트릭스 문서 + 릴리스 자산 실측 — **완료** | `docs/PLATFORM_MATRIX.md` | 아니오 |
| 1 | 감지 확장: CPU ISA·코어, 셸, WSL — **완료** (Intel GPU 전용 감지는 남음) | `machineProbe.ts` + 테스트 | 아니오 |
| 2 | Calibration 일반화 (§4): `MemoryProbe`, 처리량 단계, 키 — **완료** (설치 스크립트가 `measure` 실행, 드라이버 버전 키는 남음) | `measure.ts` + 테스트 | NVIDIA 실측 완료 |
| 3 | 배포물 매트릭스 확장 6종 — **워크플로 완료**, 첫 태그 CI 결과 대기 | `release.yml` | CI 러너 |
| 4 | Vulkan(AMD·Intel) 실측 hardening | 플래그 호환 매트릭스, Windows AMD VRAM 대안(없으면 `unmeasured`) | **AMD/Intel 실머신 필수** |
| 5 | macOS MLX 엔진 (아래 §6) | `mlx.ts`, `MlxServerManager` | **Apple Silicon 필수** |
| 6 | 모델 티어표 일반화 (§3) + 하위 티어 결정 | `modelCatalog.ts` 표 | 저RAM 머신 1대 |

실머신이 없는 항목은 코드를 미리 써도 되지만 **"지원"으로 표시하지 않는다.** CI 러너 실측은 `지원(CI만)` — GPU 경로는 CI에서 검증되지 않는다는 뜻이다. GPU 없는 CI에서는 `scripts/fake-llama-server.mjs`로 파이프라인(§2) 흐름만 검증한다.

### 5.1 Vulkan(AMD·Intel) 세부 (작업 4)

1. AMD 실머신에서 Vulkan 사전빌드 기동 → `offloaded N/N` · VRAM · 프리필/생성 tok/s 기록.
2. 플래그 호환 매트릭스: `--n-cpu-moe` · `-fa on` · `--cache-type-k q8_0` · `-c` · `-np 1 -no-kvu`. 거부 플래그가 있으면 `buildServerArgs(backend)` 분기 (기본값은 현행 유지).
3. ROCm 자산이 릴리스에 없으면 rung을 **삭제하지 말고** `unmeasured: ["ROCm 사전빌드 (릴리스에 자산 없음)"]` + 소스빌드(HIP) 경로만 남긴다.
4. Windows AMD VRAM: `Win32_VideoController.AdapterRAM`은 32비트라 4GiB에서 잘린다. 대안(레지스트리 `HardwareInformation.qwMemorySize`, 서버 로그) 실측. 불가면 CPU 사이징 유지. **추정치로 VRAM을 지어내지 않는다.**

## 6. macOS MLX 엔진 (작업 5, 신규 백엔드)

llama.cpp Metal은 유지한다. MLX는 **대체 엔진**이며 채택은 측정 기반:

1. **선택 규칙**: Apple Silicon + RAM ≥ 16GB → MLX 후보. 동일 모델 체급·동일 프롬프트에서 Metal llama.cpp vs `mlx-lm`의 프리필/생성/메모리를 calibration(§4.2 rung 비교)으로 측정해 빠른 쪽을 기본값으로. MLX가 느리면 추가하지 않는다 — "네이티브"는 근거가 아니다.
2. **모듈** (llama 경로 옆에, 안 건드리고):
   - 신규 모듈 mlx.ts (src/setup 아래): `uv`/`pipx`/`brew` 중 있는 것으로 `mlx-lm` 확인. 없으면 `manual` 안내 (`planBuildEnv` 패턴, Homebrew 없는 Mac에 brew를 깔지 않는다).
   - 모델: `mlx-community/*` safetensors 매핑 — **GGUF 카탈로그와 별도 테이블**. 해당 Ornith MLX 변환본이 실제로 있는지 Hub에서 확인, 없으면 MLX 경로는 `미지원(모델 없음)`.
   - 스폰: `python -m mlx_lm.server --model <id> --port <p>`, 헬스체크 `/v1/models`. `MlxServerManager` 분리 (`GPU_LOG_LINE`의 `offloaded` 정규식은 MLX 로그에 없음).
   - `findMlxServer`: 프로세스 귀속 + 버전 프로브.
3. **Tool calling 검증 필수**: `mlx_lm.server`의 tool-call이 `agent/loop.ts` 스트리밍 파서와 맞는지 실서버로 확인. 안 맞으면 **미지원**으로 기록.
4. **튜닝**: `-ngl`·`--n-cpu-moe` 개념 없음 → 별도 `tuneMlxForHardware` (ctx·메모리 한도만). calibration은 같은 `MemoryProbe`/처리량 프레임 사용.

완료 조건: Apple Silicon 실머신에서 `setup`이 엔진을 측정으로 고르고 기동, 에이전트 1턴(도구 호출 포함) 성공 로그.

---

## 7. 하지 말 것

- ROCm·arm64·CPU 변형 사전빌드가 "있을 것"이라 가정 — 릴리스 자산 실측 후 없으면 `unmeasured`/`미지원(이유)` 명시.
- GPU 벤더별로 배포 zip을 쪼개기 — 배포물은 `<plat>-<arch>`, 엔진은 설치 시 감지·사다리.
- MLX를 llama.cpp 스폰·튜닝·calibration 코드에 `if mlx`로 끼워넣기 — 엔진이 다르면 모듈이 다르다. 공유하는 건 `MemoryProbe`·calibration 프레임 같은 **인터페이스**뿐.
- 통합 메모리 머신에서 VRAM과 RAM을 따로 세서 두 배로 잡기.
- 실머신 없는 플랫폼의 tok/s·VRAM 수치 인용 — 합성 수치·문서 베끼기 금지. `미측정`.
- GGUF 카탈로그와 MLX 모델 ID를 같은 테이블에 섞기. 존재 확인 안 된 모델 ID 추가.
- calibration 측정 실패를 0·false로 기록하거나, 측정 없이 예측값을 "보정됨"으로 표시.
- 셸별 차이를 bash 기준 한 스크립트로 덮기 — PowerShell 5.1·bash 3.2·fish는 각각 확인.

## 8. 검증 게이트 (공통)

- `npm run typecheck` · `npm test` · `node scripts/ci-checks.mjs` 통과
- 신규 감지·판정·측정은 `unknown`/`unmeasured` 상태를 가질 것 (0·false·"없음"으로 채우지 않는다)
- 새 배포물은 `release.yml`에서 해시·manifest 검증 + 해당 러너에서 `verify-shell.mjs`(셸별) + fake 서버로 §2 파이프라인 1회 통과
- `docs/PLATFORM_MATRIX.md`의 각 셀이 `docs/VERIFICATION.md`의 실측 기록(머신·OS·셸·GPU·드라이버·엔진 태그·날짜·수치)과 연결됨. 실측 없는 셀은 `미측정`
- `harnesside doctor`가 머신 프로필·채택 엔진 rung·모델·calibration 상태(측정 수단 포함)를 말할 수 있을 것 (모르면 "미확인")
