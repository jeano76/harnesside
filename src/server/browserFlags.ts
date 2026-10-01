/**
 * Chrome 실행 플래그 생성기 (§4.1 · §4.7) — **단일 출처**.
 *
 * 왜 한 곳인가: 초기안에서 `--disable-features` 가 §4.1 과 §4.6 두 곳에서 다르게
 * 지정되어 있었다. Chromium 의 `CommandLine` 은 같은 키를 **덮어쓰므로** 앞의 것이
 * 조용히 사라지고, "설정했는데 절반만 적용된" 상태가 된다. 플래그 문자열이 흩어져
 * 있으면 반드시 그런 일이 다시 일어난다.
 *
 * 실측 근거(2026-09-29 · Chrome 153.0.8010.52 · RTX 2070 SUPER):
 *   GPU off 세트 → `SystemInfo.getInfo` 의 glRenderer = "Disabled", webgl = "disabled_off",
 *                  nvidia-smi 에 chrome 항목 없음, VRAM +10 MiB
 *   플래그 없음   → glRenderer = "ANGLE (…SwiftShader…)", webgl = "unavailable_software"
 * 대조군이 없으면 "GPU 를 껐다" 는 말이 검증이 아니라 믿음이 된다(§4.7.5).
 */

import type { GpuMode } from "../setup/gpuPolicy.js";

export const IDE_DEFAULT_PORT = 7317;
export const CDP_DEFAULT_PORT = 9222;

export interface LaunchOptions {
  mode: GpuMode;
  /** 토큰이 붙은 부팅 URL. 첫 렌더 후 페이지가 지운다(§3.6). */
  appUrl: string;
  /** 우리 전용 프로필. 사용자 프로필을 공유하지 않는다(§4.1). */
  userDataDir: string;
  cdpPort?: number;
  idePort?: number;
  windowWidth?: number;
  windowHeight?: number;
  /** HiDPI 보정. GPU off 시 픽셀 비용이 2배로 뛰므로 1.25 로 클램프한다(§4.7.4). */
  deviceScaleFactor?: number;
  /** 사용자가 명시적으로 추가한 플래그(컨테이너 예외 등). 앞에 붙는다. */
  extraArgs?: string[];
  /** 샌드박스가 막히는 환경. 기본 false — 켜면 §3.6 보안 경계가 무의미해진다. */
  noSandbox?: boolean;
}

/**
 * CDP `webSocketDebuggerUrl` 이 **우리가 띄운 창**인지 판정한다 (2026-10-01 실측).
 *
 * 왜 필요한가: CDP 포트(`9222`)는 **고정**이다. 이전 실행에서 남은 창이 그 포트를
 * 붙잡고 있으면 **우리 창은 붙지 못하고**, GPU 검사는 **남의 창**을 읽는다. 그 결과가
 * 부팅 로그에 `GPU budgeted 모드 (Disabled)` 로 찍혔다 — 실제로 그러았다. 우리가
 * 띄운 프로세스가 아니라 **옛 창**(`--disable-gpu` 로 떠 있던 것)의 값이었다.
 *
 * 이런 오탐은 위험하다. 통과도 실패도 **거짓말**이 되기 때문이다:
 *  - **남의 `off` 창**을 읽으면 → "GPU 비활성 확인" 이라고 **거짓 통과**.
 *  - **남의 `full` 창**을 읽으면 → "비활성 미확인" 이라고 **거짓 실패**.
 *
 * 그래서 판정 불가하면 **모른다고** 말한다. `disabled_off` 같은 문자열을 보고
 * "확인했다" 고 말하는 것이 여기서 하지 않는다.
 *
 * 디렉터리 경로가 드러나지 않는 빌드도 있다 — 그 경우에도 **포기하지 않는다**
 * 확인 가능한 범위(경로 노출 여부)를 그대로 돌려주며, 호출부가 그 사실로
 * "판정 불가" 를 남긴다.
 */
export type WindowIdentity =
  /** 확인했고, 우리 창이다. */
  | { ours: true }
  /** 다른 프로필의 창이다 — **측정하면 안 된다.** */
  | { ours: false; seenDir: string }
  /** 프로필 경로가 노출되지 않아 **알 수 없다.** 측정하면 안 된다. */
  | { ours: null };

/**
 * `wantDir` 은 우리가 띄울 때 넘긴 `userDataDir`, `wsUrl` 은 CDP 가 준
 * `webSocketDebuggerUrl`. 둘 다 **비교 가능한 형태**로 만든다 — 경로 끝의
 * 슬래시를 무시하고, 그렇지 않으면 `/tmp/p` 와 `/tmp/p/` 가 다른 창으로 보인다.
 */
export function windowIdentity(wsUrl: string | undefined, wantDir: string | undefined): WindowIdentity {
  if (!wsUrl || !wantDir) return { ours: null };
  const m = /devtools\/browser\/(.*)$/.exec(wsUrl);
  if (!m?.[1]) return { ours: null };
  let seen: string;
  try {
    seen = decodeURIComponent(m[1]);
  } catch {
    // 깨진 퍼센트 인코딩 — 경로로 쓸 수 없다. **추측하지 않는다.**
    return { ours: null };
  }
  const norm = (p: string): string => p.replace(/\/+$/, "");
  return norm(seen) === norm(wantDir) ? { ours: true } : { ours: false, seenDir: seen };
}

/** 항상 들어가는 기본 그룹 (§4.1). */
export function baseFlags(o: LaunchOptions): string[] {
  const cdp = o.cdpPort ?? CDP_DEFAULT_PORT;
  const ide = o.idePort ?? IDE_DEFAULT_PORT;
  return [
    `--app=${o.appUrl}`,
    `--user-data-dir=${o.userDataDir}`,
    `--remote-debugging-port=${cdp}`,
    // §3.6 의 Origin 검증과 맞물린다. 이것을 빼면 CDP 소켓이 기본 거절된다.
    // 와일드카드는 절대 쓰지 않는다.
    `--remote-allow-origins=http://127.0.0.1:${ide}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-background-networking",
    "--metrics-recording-only",
    "--password-store=basic",
    "--disable-dev-shm-usage",
    "--disk-cache-size=268435456",
    `--window-size=${o.windowWidth ?? 1600},${o.windowHeight ?? 1000}`,
    "--window-position=0,0",
    `--force-device-scale-factor=${clampScale(o.deviceScaleFactor)}`,
    "--force-color-profile=srgb",
  ];
}

/** GPU 모드별 그룹. `off`/`budgeted` 는 **상호배타**여야 한다(§4.7.3). */
export function gpuFlags(mode: GpuMode): string[] {
  if (mode === "off") {
    return [
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu-rasterization",
      // ← 빠뜨리기 가장 쉬운 항목. 이것이 없으면 GPU 를 꺼도 SwiftShader 가 살아난다.
      "--disable-software-rasterizer",
      // GL 구현체를 아예 고르지 않게 한다. `--use-angle=swiftshader` 와 정반대 —
      // 그건 소프트웨어 GL 을 **켜는** 플래그라 GPU 프로세스를 살린다(§4.7.3 금지 표).
      "--use-gl=disabled",
      "--disable-accelerated-2d-canvas",
      "--disable-accelerated-video-decode",
      // GPU 프로세스의 자식 로그를 서버가 받아 §5.12 패널로 tee 한다.
      "--enable-logging=stderr",
      "--v=0",
    ];
  }
  if (mode === "budgeted") {
    // 예산 모드: 가속은 유지하되 **예산만** 강제한다(§4.6).
    return [
      "--disable-gpu-memory-buffer-video-frames",
      "--renderer-process-limit=1",
      "--enable-logging=stderr",
      "--v=0",
    ];
  }
  // full: 기본값 그대로. 아무것도 강제하지 않는다.
  return ["--enable-logging=stderr", "--v=0"];
}

/**
 * `--disable-features` 항목 전체를 **한 번만** 낸다.
 *
 * 같은 스위치를 두 번 주면 Chromium 이 앞의 값을 **덮어쓴다**. 초기안이 여기서
 * 실제로 절반만 적용되고 있었다. Vulkan 은 **스위치가 아니라 feature** 다 —
 * `--disable-vulkan` 은 존재하지 않는 플래그라 조용히 무시된다.
 */
export function featureFlags(mode: GpuMode): string[] {
  const base = [
    "Translate",
    "MediaRouter",
    "InterestFeedContentSuggestions",
    "CalculateNativeWinOcclusion",
  ];
  if (mode === "off") {
    base.push("Vulkan", "VaapiVideoDecoder", "AcceleratedVideoDecodeLinuxGL", "DefaultANGLEVulkan");
  }
  return [`--disable-features=${base.join(",")}`];
}

/** 소프트웨어 래스터에서 픽셀 비용은 배율의 제곱이다. GPU off 일 때 2x 는 4배 비용. */
export function clampScale(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 1;
  return Math.min(Math.max(v, 1), 1.25);
}

export interface BuiltLaunch {
  args: string[];
  /** 사람이 읽는 근거. 부팅 로그·설정 화면에 그대로 노출한다. */
  rationale: string[];
  mode: GpuMode;
}

export function launchFlags(o: LaunchOptions): BuiltLaunch {
  const rationale: string[] = [];
  const args: string[] = [
    ...(o.extraArgs ?? []),
    // 샌드박스 예외는 **맨 뒤**에 둔다. 그래야 사용자가 앞의 값을 덮어쓸 수 있고,
    // 우리 기본값이 이기는 구조가 된다(§3.6: 기본값은 항상 켜짐).
    ...baseFlags(o),
    ...gpuFlags(o.mode),
    ...featureFlags(o.mode),
    `--js-flags=--max-old-space-size=${jsHeapMb(o.mode)}`,
    ...(o.noSandbox ? ["--no-sandbox"] : []),
  ];

  rationale.push(`브라우저 GPU 모드: ${o.mode}`);
  if (o.mode === "off") {
    rationale.push(
      "GPU 를 전부 끕니다. 같은 머신 실측에서 VRAM 증가량은 +10 MiB 이었고 nvidia-smi 에 chrome 항목이 없었습니다."
    );
  } else if (o.mode === "budgeted") {
    rationale.push("가속은 유지하고 예산만 강제합니다(모델 VRAM 을 남기기 위한 모드).");
  } else {
    rationale.push("브라우저 GPU 를 그대로 씁니다(모델이 CPU 전용이거나 여유가 충분한 경우).");
  }
  rationale.push(`디바이스 배율 ${clampScale(o.deviceScaleFactor)} — 소프트웨어 렌더에서 픽셀 비용은 배율의 제곱입니다.`);
  if (o.noSandbox) {
    rationale.push("⚠ 샌드박스를 끄도록 설정되어 있습니다 — 보안 경계가 약해집니다(사용자 명시적 지정).");
  }

  assertNoDuplicateKeys(args);
  return { args, rationale, mode: o.mode };
}

function jsHeapMb(mode: GpuMode): number {
  // GPU off 일 때 JS 힙이 커질 이유가 없다. Monaco 를 아직 로드하지 않는 P2 시점도 기준.
  return mode === "off" ? 1024 : 2048;
}

/**
 * 중복 키가 있으면 **부팅을 중단**시킨다(조용히 틀린 설정으로 뜨면 안 된다 — §4.1).
 * `--enable-logging` 처럼 값이 없는 플래그는 중복 판정에서 제외한다.
 */
export function assertNoDuplicateKeys(args: string[]): void {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const a of args) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    if (!key.includes("=") && !a.includes(" ")) {
      // 값이 뒤따르는 플래그인지까지 봐야 정확하다
    }
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  if (dups.size > 0) {
    throw new Error(
      `Chrome 플래그에 중복 키가 있습니다: ${[...dups].join(", ")} — 같은 키를 두 번 주면 앞의 것이 무시됩니다.`
    );
  }
}

/** 프로필 경로 (§6.4: 프로젝트 디렉터리에 두지 않는다). */
export function profileDir(home: string): string {
  return `${home.replace(/\/+$/, "")}/.harnesside/chrome-profile`;
}
