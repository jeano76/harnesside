/**
 * browserFlags 유닛 테스트 (§4.7.3 표, §10.2).
 *
 * 이 테스트가 통과한다는 것은 "브라우저가 GPU 를 쓰지 않는다"는 뜻이다.
 * 초기안에는 **반대** 결론("--disable-gpu 는 쓰지 않는다") 이 있었고, 실측으로 뒤집혔다.
 * 되돌아가지 않게 여기서 막는다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { launchFlags, gpuFlags, featureFlags, assertNoDuplicateKeys, clampScale, profileDir, type LaunchOptions } from "./browserFlags.js";

function opts(over: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    mode: "off",
    appUrl: "http://127.0.0.1:7317/?t=TOKEN",
    userDataDir: "/home/u/.harnesside/chrome-profile",
    ...over,
  };
}

const has = (args: string[], flag: string) => args.includes(flag);
const hasPrefix = (args: string[], prefix: string) => args.some((a) => a.startsWith(prefix));

// ---- GPU off : 핵심 -------------------------------------------------------

test("off 모드는 하드웨어 GPU 경로를 전부 닫는다", () => {
  const f = gpuFlags("off");
  for (const flag of [
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu-rasterization",
    "--disable-software-rasterizer",
    "--disable-accelerated-2d-canvas",
    "--disable-accelerated-video-decode",
  ]) {
    assert.ok(has(f, flag), `${flag} 누락 — 없으면 GPU 프로세스가 살아난다`);
  }
});

test("off 에 --disable-software-rasterizer 가 반드시 있다 — 가장 빠뜨리기 쉬운 항목", () => {
  // 이게 없으면 GPU 를 꺼도 SwiftShader 로 GPU 프로세스가 뜬다(실측 대조군).
  assert.ok(has(gpuFlags("off"), "--disable-software-rasterizer"));
});

test("off 에 존재하지 않는 --disable-vulkan 을 넣지 않는다 (feature 로 꺼야 한다)", () => {
  const args = launchFlags(opts()).args;
  assert.equal(has(args, "--disable-vulkan"), false, "존재하지 않는 플래그 — 조용히 무시된다");
  assert.ok(
    hasPrefix(args, "--disable-features=") && args.some((a) => a.includes("Vulkan")),
    "Vulkan 은 feature 로 꺼야 한다"
  );
});

test("off 에 --use-angle=swiftshader 를 넣지 않는다 — 소프트웨어 GL 을 켜는 플래그다", () => {
  const args = launchFlags(opts()).args;
  assert.equal(hasPrefix(args, "--use-angle=swiftshader"), false, "이건 GPU 를 끄는 플래그가 아니라 켜는 플래그다");
  assert.equal(has(args, "--use-gl=disabled"), true);
});

test("모드별 플래그는 상호배타 — budgeted 에 GPU 차단 플래그가 섞이면 안 된다", () => {
  const off = launchFlags(opts({ mode: "off" })).args;
  const budgeted = launchFlags(opts({ mode: "budgeted" })).args;
  const full = launchFlags(opts({ mode: "full" })).args;
  assert.ok(has(off, "--disable-gpu"));
  assert.equal(has(budgeted, "--disable-gpu"), false, "budgeted 에 --disable-gpu 가 섞였다");
  assert.equal(has(budgeted, "--disable-software-rasterizer"), false);
  assert.equal(has(full, "--disable-gpu"), false);
  assert.equal(has(full, "--disable-gpu-rasterization"), false);
  // 예산 모드는 예산 강제 플래그를 갖는다
  assert.ok(has(budgeted, "--disable-gpu-memory-buffer-video-frames"));
  assert.ok(has(budgeted, "--renderer-process-limit=1"));
});

test("절대 넣지 않는 플래그가 없다 — 보안 경계가 무효화되면 안 된다", () => {
  for (const mode of ["off", "budgeted", "full"] as const) {
    const args = launchFlags(opts({ mode })).args;
    for (const forbidden of ["--no-sandbox", "--disable-web-security", "--single-process", "--allow-running-insecure-content", "--disable-site-isolation-trials"]) {
      assert.equal(has(args, forbidden), false, `${mode}: ${forbidden} 가 들어갔다`);
    }
  }
});

test("노샌드박스는 사용자가 명시적으로 켠 경우에만, 그리고 경고가 붙는다", () => {
  const built = launchFlags(opts({ noSandbox: true }));
  assert.ok(has(built.args, "--no-sandbox"));
  assert.ok(built.rationale.some((r) => r.includes("보안 경계")), "위험한 설정은 반드시 경고한다");
});

test("기본값으로는 --no-sandbox 이 없다", () => {
  assert.equal(has(launchFlags(opts()).args, "--no-sandbox"), false);
});

// ---- 중복 키 : 초기안의 실제 버그 -----------------------------------------

test("--disable-features 는 정확히 한 번만 나온다", () => {
  for (const mode of ["off", "budgeted", "full"] as const) {
    const args = launchFlags(opts({ mode })).args;
    const n = args.filter((a) => a.startsWith("--disable-features=")).length;
    assert.equal(n, 1, `${mode}: ${n}번 나왔다 — 앞의 것이 무시된다`);
  }
});

test("중복 키가 있으면 예외를 던진다 — 틀린 설정으로 부팅하면 안 된다", () => {
  assert.throws(
    () => assertNoDuplicateKeys(["--disable-gpu", "--disable-gpu", "--app=x"]),
    /중복 키/
  );
  assert.doesNotThrow(() => assertNoDuplicateKeys(["--disable-gpu", "--disable-software-rasterizer"]));
});

test("launchFlags 는 스스로 중복을 검사한다", () => {
  assert.throws(() => launchFlags(opts({ extraArgs: ["--disable-gpu"] })), /중복 키/);
});

// ---- 기저 그룹 ------------------------------------------------------------

test("기저 그룹: --app / 프로필 / CDP / Origin 허용", () => {
  const args = launchFlags(opts()).args;
  assert.ok(args.some((a) => a.startsWith("--app=http://127.0.0.1:7317/?t=TOKEN")), "토큰이 붙은 부팅 URL");
  assert.ok(args.some((a) => a.startsWith("--user-data-dir=")));
  assert.ok(args.some((a) => a === "--remote-debugging-port=9222"));
  assert.ok(args.some((a) => a === "--remote-allow-origins=http://127.0.0.1:7317"), "CDP Origin 검증 통과에 필요");
});

test("remote-allow-origins 는 와일드카드가 아니다", () => {
  const args = launchFlags(opts()).args;
  const o = args.find((a) => a.startsWith("--remote-allow-origins="));
  assert.ok(o);
  assert.equal(o!.includes("*"), false, "와일드카드는 §3.6 을 무효화한다");
});

test("사용자 프로필을 공유하지 않는다 — 우리 프로필만 쓴다", () => {
  const args = launchFlags(opts()).args;
  const udd = args.find((a) => a.startsWith("--user-data-dir="));
  assert.ok(udd, "프로필 경로가 없다");
  // 기본 프로필(~/.config/google-chrome)이나 프로젝트 디렉터리를 가리키면 안 된다.
  assert.equal(udd!.includes(".config/google-chrome"), false, "사용자 기본 프로필을 쓰고 있다");
  assert.equal(udd!.includes("/src/"), false, "프로젝트 디렉터리에 프로필을 만들면 git 에 뜬다");
  assert.equal(udd!.includes(".harnesside"), true);
});

test("노샌드박스는 맨 뒤에 붙는다 — 그래야 기본값이 이긴다", () => {
  const args = launchFlags(opts({ noSandbox: true })).args;
  assert.equal(args[args.length - 1], "--no-sandbox");
});

test("경로에 공백이 있어도 플래그가 깨지지 않는다 — spawn 은 배열로 준다", () => {
  const built = launchFlags(opts({ userDataDir: "/home/my user/.harnesside/chrome profile" }));
  const i = built.args.findIndex((a) => a.startsWith("--user-data-dir="));
  assert.ok(i >= 0);
  // 배열 원소 하나에 통째로 들어 있어야 따옴표로 감쌀 필요가 없다
  assert.equal(built.args[i], "--user-data-dir=/home/my user/.harnesside/chrome profile");
});

test("부팅 자식 로그를 서버가 받을 수 있게 로깅을 켠다 (§5.12 의 llama 소스 옆에 붙는다)", () => {
  for (const mode of ["off", "budgeted", "full"] as const) {
    assert.ok(has(launchFlags(opts({ mode })).args, "--enable-logging=stderr"), mode);
  }
});

test("extraArgs 는 사용자의 명시적 값이라 맨 앞에 온다 (우리 값이 이긴다)", () => {
  const args = launchFlags(opts({ extraArgs: ["--lang=ko"] })).args;
  assert.equal(args[0], "--lang=ko");
});

// ---- 디바이스 배율 (소프트웨어 렌더 비용) ---------------------------------

test("HiDPI 배율을 1.25 로 클램프한다 — 픽셀 비용은 배율의 제곱", () => {
  assert.equal(clampScale(2), 1.25);
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(1.5), 1.25);
  assert.equal(clampScale(0.5), 1, "너무 작게 잡아도 의미 없다");
  assert.equal(clampScale(undefined), 1);
  assert.equal(clampScale(Number.NaN), 1);
  assert.equal(clampScale(-1), 1);
});

test("오프 모드에서 JS 힙은 1 GiB 로 제한된다 — 로그 링(50만 자)이 여기 산다", () => {
  assert.ok(launchFlags(opts({ mode: "off" })).args.some((a) => a.includes("--max-old-space-size=1024")));
  assert.ok(launchFlags(opts({ mode: "full" })).args.some((a) => a.includes("--max-old-space-size=2048")));
});

// ---- 근거 -----------------------------------------------------------------

test("rationale 에 모드와 그 이유가 들어간다 — '왜 내 창이 느린데' 에 답해야 한다", () => {
  for (const mode of ["off", "budgeted", "full"] as const) {
    const { rationale } = launchFlags(opts({ mode }));
    assert.ok(rationale.length >= 2, mode);
    assert.ok(rationale.some((r) => r.includes(mode)), `${mode}: 근거에 모드가 없다`);
    assert.ok(rationale.every((r) => r.trim().length > 0));
  }
  // off 는 측정 근거를 싣는다
  assert.ok(launchFlags(opts({ mode: "off" })).rationale.some((r) => r.includes("+10 MiB")));
});

test("프로필 경로는 홈 아래 .harnesside (프로젝트 디렉터리가 아님)", () => {
  assert.equal(profileDir("/home/jeano"), "/home/jeano/.harnesside/chrome-profile");
  assert.equal(profileDir("/home/jeano/"), "/home/jeano/.harnesside/chrome-profile");
  assert.equal(profileDir("/home/jeano").includes("/src/"), false);
});
