/**
 * `doctorChecks` 의 순수 판정 (2026-10-04 · Q-13).
 *
 * 이 테스트가 지킬 것은 세 가지다:
 *  1. **`unknown` 이 살아 있다.** 모르는 것을 `false`·`0`·`free` 로 바꾸면
 *     사용자는 그걸 측정값으로 읽는다. 이게 깨지면 아래 세 테스트가 같이 죽는다.
 *  2. **포트 3상태가 실제로 3개다.** "비어 있음 / 우리가 씀 / 다른 프로그램" 을
 *     합치면 왜 안 되는지 알 수 없다.
 *  3. **비밀 값이 출력 경로에 없다.** 이름만 센다.
 *
 * 그리고 이 테스트가 **못 하는 것**: 실제 화면·포트·파일이 이 모양인지.
 * 그건 `doctorChecks.readonly.test.ts` 가 진짜 프로세스로 잰다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countUnknown,
  defaultPortPlan,
  formatBytes,
  judgeConfig,
  judgeDistFreshness,
  judgeModelFile,
  judgeNodeVersion,
  judgePort,
  judgeTerminalIdentity,
  nextActions,
  parseEnginesFloor,
  terminalCapabilityChecks,
  type DoctorCheck,
} from "./doctorChecks.js";

// ── Node 버전 ───────────────────────────────────────────────────────────────

test("Node 판정: major/minor 를 **둘 다** 보인다 (요구)", () => {
  const c = judgeNodeVersion("v22.14.0", ">=22");
  assert.equal(c.state, "ok");
  // major 만 보이는 것으로 충분하지 않다 — CI 는 major 하나만 보고, 실제로
  // minor 가 구별되는 실패가 있었다(Node 20.20.2).
  assert.match(c.value, /22\.14\.0/, "전체 버전이 안 보인다");
  assert.match(c.value, /major\.minor 22\.14/, "major.minor 가 안 보인다");
  assert.match(c.value, />=22/, "요구 범위가 안 보인다");
});

test("Node 판정: 요구보다 낮으면 **왜 · 무엇을** 말한다", () => {
  const c = judgeNodeVersion("v20.20.2", ">=22");
  assert.equal(c.state, "fail");
  assert.match(c.note!, /SIGSEGV|WebSocket/, "재현된 실패를 근거로 말하지 않는다");
  assert.match(c.action!, /nvm use 22/, "사용자가 할 수 있는 행동이 없다");
});

test("Node 판정: 요구 범위(major.minor)를 실제로 지킨다", () => {
  assert.equal(judgeNodeVersion("v22.0.0", ">=22.1").state, "fail");
  assert.equal(judgeNodeVersion("v22.1.0", ">=22.1").state, "ok");
  assert.equal(judgeNodeVersion("v23.0.0", ">=22.1").state, "ok");
});

test("Node 판정: **모르면 미확인** — 0·false 로 채우지 않는다", () => {
  const noFloor = judgeNodeVersion("v22.14.0", "");
  assert.equal(noFloor.state, "unknown");
  assert.match(noFloor.value, /미확인|파싱 실패/);
  const badVersion = judgeNodeVersion("what", ">=22");
  assert.equal(badVersion.state, "unknown", "판독 불가한 버전을 통과로 썼다");
});

// ── 단말 ────────────────────────────────────────────────────────────────────

test("단말 판정: **알려짐 / 미지원 / 판단 불가** 를 3가지로 구분한다", () => {
  const known = judgeTerminalIdentity("ghostty");
  assert.equal(known.state, "ok");
  assert.match(known.value, /알려진 단말/);

  // 목록에 없는 단말은 "실패"가 아니라 "검증한 적 없다" 다.
  const unknownName = judgeTerminalIdentity("my-tty-9000");
  assert.equal(unknownName.state, "unknown", "미지원 단말을 실패로 썼다");
  assert.match(unknownName.value, /목록에 없음/);

  // TERM 이 말해 주지 못한 경우도 미확인이고, 위와 **구분된다**.
  const unknowable = judgeTerminalIdentity("unknown");
  assert.equal(unknowable.state, "unknown");
  assert.match(unknowable.value, /판단 불가/);
  assert.notEqual(unknowable.value, unknownName.value, "두 미확인이 구분되지 않는다");
});

test("단말 capability 5종 — 판정 정본(getCapabilities)의 결과를 그대로 옮긴다", () => {
  const checks = terminalCapabilityChecks({
    ansi: true, colorDepth: 24, unicode: true, altScreen: true,
    synchronizedOutput: true, hyperlink: true, mouse: true, mouseSgr: true,
    terminal: "ghostty", inMultiplexer: false, reason: "테스트",
  });
  assert.equal(checks.length, 5, "요구된 capability 가 5종인데 다른 수다");
  for (const id of ["cap-color-depth", "cap-unicode", "cap-alt-screen", "cap-mouse-sgr", "cap-sync-output"]) {
    assert.ok(checks.some((c) => c.id === id), `${id} 항목이 없다`);
  }
  assert.ok(checks.every((c) => c.state === "ok"));
});

test("단말 capability 부재는 **실패가 아니다** — 무엇이 바뀌는지 말하고 warn 으로 둔다", () => {
  const checks = terminalCapabilityChecks({
    ansi: false, colorDepth: 0, unicode: false, altScreen: false,
    synchronizedOutput: false, hyperlink: false, mouse: false, mouseSgr: false,
    terminal: "unknown", inMultiplexer: false, reason: "테스트",
  });
  assert.ok(
    checks.every((c) => c.state === "warn"),
    "capability 부재를 실패나 unknown 으로 만들었다 — 측정값인데 그렇게 보이지 않는다",
  );
  const unicode = checks.find((c) => c.id === "cap-unicode")!;
  assert.match(unicode.note!, /ASCII/, "무엇이 바뀌는지 말하지 않는다");
  const color = checks.find((c) => c.id === "cap-color-depth")!;
  assert.match(color.value, /0 비트/, "0 비트인데 값이 가려졌다");
});

// ── 포트 ────────────────────────────────────────────────────────────────────

test("포트: 비어 있음 / 우리가 씀 / 다른 프로그램 — **셋이 다르게 보인다**", () => {
  const free = judgePort("웹 IDE", 7317, { reachable: false });
  assert.equal(free.state, "ok");
  assert.match(free.value, /비어 있음/);

  const ours = judgePort("웹 IDE", 7317, { reachable: true, pid: 111, cmdline: "node /x/harnesside/dist/server/index.js" });
  assert.equal(ours.state, "ok");
  assert.match(ours.value, /우리가 씀/);
  assert.match(ours.value, /111/, "누가인지(pid)가 없다");

  const foreign = judgePort("웹 IDE", 7317, { reachable: true, pid: 222, cmdline: "python -m http.server 7317" });
  assert.equal(foreign.state, "warn");
  assert.match(foreign.value, /다른 프로그램이 씀/);
  assert.ok(foreign.action, "막혔을 때 할 행동을 말하지 않는다");
});

test("포트: **명령줄을 못 읽으면 foreign 가 아니라 unknown** — 근거가 없다", () => {
  // `wmic` 이 없는 Windows 가 이 상태의 정상 경로다. 여기서 foreign 를 말하면
  // 사용자는 "harnesside 가 모르는 프로세스가 7317 을 잡고 있다" 는 거짓말을 믿는다.
  const c = judgePort("llama-server", 8080, { reachable: true, pid: 333, cmdline: null });
  assert.equal(c.state, "unknown");
  assert.match(c.value, /미확인/);
  assert.match(c.note!, /근거가 없다/);
});

test("포트: **조회 실패를 '비어 있음' 으로 읽지 않는다**", () => {
  const c = judgePort("Chrome CDP", 9222, { lookupFailed: true, reason: "ss 없음" });
  assert.equal(c.state, "unknown");
  assert.notEqual(c.value, "비어 있음");
  assert.match(c.action!, /ss -ltnp/, "직접 확인할 방법을 말하지 않는다");
});

test("포트: 포트마다 '우리 것' 의 근거를 따로 준다", () => {
  // Chrome CDP 포트에 harnesside 서버가 떠 있으면 그건 **다른 프로그램** 이다.
  const cdp = judgePort("Chrome CDP", 9222, { reachable: true, pid: 9, cmdline: "node dist/server/index.js" }, /remote-debugging-port=\d+/i);
  assert.equal(cdp.state, "warn", "CDP 포트의 우리-것 판정 Criteria 가 다른 서비스 판정과 섞였다");
});

test("포트: **기록된 우리 pid** 는 명령줄 매칭보다 앞선다 (실측에서 고친 결함)", () => {
  // 실측(2026-10-04): 이 저장소의 설치 경로는 `harnessCli` 라 `/harnesside/i` 로는
  // 매칭되지 않았고, **우리가 띄운 웹 서버를 "다른 프로그램이 씀"** 이라고 말했다.
  // 사용자가 그 문장을 믿으면 자기 서버를 죽이려 한다.
  const obs = { reachable: true, pid: 2514126, cmdline: "node /home/jeano/harnessCli/dist/server/index.js" };
  const wrong = judgePort("웹 IDE", 7317, obs, /harnesside/i);
  assert.equal(wrong.state, "warn", "이 결함의 재현 조건이 바뀌었다 (그래도 경고여야 한다)");
  const fixed = judgePort("웹 IDE", 7317, obs, /harnesside|dist[\\/]server[\\/]index\./i, "harnesside 서버");
  assert.equal(fixed.state, "ok");
  assert.match(fixed.value, /harnesside 서버/);
  // 그리고 **pid 기록**이 있으면 정규식과 무관하게 우리 것으로 본다.
  const byPid = judgePort("웹 IDE", 7317, obs, /아무것도_안_맞음/, undefined, new Set([2514126]));
  assert.equal(byPid.state, "ok");
  assert.match(byPid.value, /기록된 인스턴스/);
  // 다른 pid 면 기록이 없다 — 집합에 없으면 근거가 아니다.
  assert.equal(judgePort("웹 IDE", 7317, obs, /아무것도_안_맞음/, undefined, new Set([1])).state, "warn");
});

test("포트: 출력에 붙는 이름은 근거마다 다르다 (모두 '우리 프로세스' 라고 말하지 않는다)", () => {
  const cdp = judgePort("Chrome CDP", 9222, { reachable: true, pid: 7, cmdline: "chrome --remote-debugging-port=9222" }, /remote-debugging-port=\d+/i, "Chrome (CDP)");
  assert.match(cdp.value, /Chrome \(CDP\)/);
});

test("포트: **이름 cmdline이 매칭 안 돼도 OS 리스너 pid 하나면 우리 것으로 인정** (Q-13)", () => {
  // 재현(2026-10-04): 포트를 잡은 프로세스 cmdline = `node .../.npm-global/bin/harnesside`.
  // defaultPlan ours 정규식 `/harnesside|dist/server/index\./i` 는 여기에 매칭하지만,
  // 설치 경로가 이걸 더 이상 안 담는 저장소에서는 "다른 프로그램이 씀"으로 보였다.
  // fix: ourPids 에 observePort 가 반환한 OS 리스너 pid 를 보강한다(p.serverPid 가 없어도).
  const obs = { reachable: true, pid: 63218, cmdline: "node /some/unexpected/path/ide-server.js" };
  const byOsPid = judgePort("웹 IDE", 7317, obs, /harnesside/i, undefined, new Set([63218]));
  assert.equal(byOsPid.state, "ok", "OS 가 이 포트의 리스너를 '우리가 켠 서버'라고 알려준다");
  // 집합에 그 pid 가 없으면? 이전과 마찬가지로 foreign 로 간다.
  const without = judgePort("웹 IDE", 7317, obs, /harnesside/i, undefined, new Set([1]));
  assert.equal(without.state, "warn");
});

// ── dist 최신성 ─────────────────────────────────────────────────────────────

test("dist 최신성: **dist 가 src 보다 오래면 실패** — 지금 실제로 그 상태인 축", () => {
  const old = judgeDistFreshness({ distExists: true, srcExists: true, distNewest: 1_000_000, srcNewest: 1_060_000 });
  assert.equal(old.state, "fail");
  assert.match(old.action!, /npm run build/);
  assert.match(old.value, /ISO|:/, "시각을 ISO 로 남기지 않는다 — 언제인지 알 수 없다");
});

test("dist 최신성: 최신이면 ok, **src 없음(설치본)은 실패가 아니다**", () => {
  const fresh = judgeDistFreshness({ distExists: true, srcExists: true, distNewest: 2_000_000, srcNewest: 1_000_000 });
  assert.equal(fresh.state, "ok");
  const installed = judgeDistFreshness({ distExists: true, srcExists: false });
  assert.equal(installed.state, "unknown");
  assert.notEqual(installed.state, "fail", "설치본을 '깨진 배포물' 로 보고했다");
  const missing = judgeDistFreshness({ distExists: false, srcExists: true });
  assert.equal(missing.state, "fail");
  assert.match(missing.action!, /npm run build/);
});

// ── 설정 · 비밀 ─────────────────────────────────────────────────────────────

test("설정 판정: 비밀은 **이름만** — 값이 들어올 자리가 없다", () => {
  const checks = judgeConfig({ path: "/p/.harnesside/config.yaml", exists: true, schemaVersion: 2, secretNames: ["apiKey"] });
  const secrets = checks.find((c) => c.id === "config-secrets")!;
  assert.equal(secrets.state, "ok");
  assert.match(secrets.value, /apiKey/, "이름도 안 보인다");
  assert.match(secrets.value, /값은 출력하지 않음/, "값을 뺀 이유가 없다");
});

test("설정 판정: 파일 없음은 **unknown** — '없음' 과 '못 읽음' 을 구분한다", () => {
  const checks = judgeConfig({ path: "/p/.harnesside/config.yaml", exists: false });
  assert.equal(checks.length, 1, "없음일 때 다른 판정을 붙였다");
  assert.equal(checks[0]!.state, "unknown");
  assert.match(checks[0]!.note!, /없음과/);
});

test("설정 판정: 옛 스키마 버전은 **warn + 이유**, 최신은 ok", () => {
  const old = judgeConfig({ path: "/p/config.yaml", exists: true, schemaVersion: 1 }).find((c) => c.id === "config-schema")!;
  assert.equal(old.state, "warn");
  assert.match(old.action!, /doctor --install/);
  const cur = judgeConfig({ path: "/p/config.yaml", exists: true, schemaVersion: 2 }).find((c) => c.id === "config-schema")!;
  assert.equal(cur.state, "ok");
});

// ── 모델 ────────────────────────────────────────────────────────────────────

test("모델 판정: 크기 · arch 를 보이고, 헤더를 못 읽으면 **unknown**", () => {
  const ok = judgeModelFile({ path: "/m/a.gguf", exists: true, sizeBytes: 4 * 1024 ** 3, arch: "qwen3moe", moe: true, conclusive: true });
  assert.equal(ok.state, "ok");
  assert.match(ok.value, /4\.0 GiB/);
  assert.match(ok.value, /qwen3moe/);
  assert.match(ok.value, /MoE/);

  const unclear = judgeModelFile({ path: "/m/a.gguf", exists: true, sizeBytes: 10, conclusive: false });
  assert.equal(unclear.state, "unknown", "헤더를 못 읽은 파일을 정상으로 보고했다");
  assert.match(unclear.value, /미확인/);

  const gone = judgeModelFile({ path: "/m/a.gguf", exists: false, conclusive: false });
  assert.equal(gone.state, "warn");
  assert.match(gone.action!, /doctor --install/);
});

// ── 요약 · 행동 ─────────────────────────────────────────────────────────────

test("행동 목록: 요구(Q-13)대로 **행동이 1개 이상** 나오고, 실패가 먼저 온다", () => {
  const checks: DoctorCheck[] = [
    { id: "w", label: "경고 항목", value: "v", state: "warn", action: "A" },
    { id: "f", label: "실패 항목", value: "v", state: "fail", action: "B" },
    { id: "o", label: "정상 항목", value: "v", state: "ok" },
    { id: "u", label: "미확인 항목", value: "v", state: "unknown" },
  ];
  const actions = nextActions(checks);
  assert.ok(actions.length >= 1, "행동이 0개다 — 요구가 실패한다");
  assert.equal(actions[0], "실패 항목: B", "실패 항목이 먼저 와야 손댈 순서가 된다");
  assert.ok(actions.includes("경고 항목: A"));
  assert.ok(!actions.some((a) => a.startsWith("정상")), "정상 항목에 행동을 붙였다");
});

test("미확인 개수는 **숫자로 남는다** — 조용히 사라지지 않는다", () => {
  const checks: DoctorCheck[] = [
    { id: "a", label: "a", value: "v", state: "unknown" },
    { id: "b", label: "b", value: "v", state: "unknown" },
    { id: "c", label: "c", value: "v", state: "ok" },
  ];
  assert.equal(countUnknown(checks), 2);
});

test("디렉터리 최신 시각은 **호출 시점의 환경변수**를 따른다", () => {
  const a = defaultPortPlan({ HARNESSIDE_CDP_PORT: "9333" } as NodeJS.ProcessEnv);
  const b = defaultPortPlan({} as NodeJS.ProcessEnv);
  assert.equal(a.find((p) => p.label.includes("CDP"))!.port, 9333);
  assert.equal(b.find((p) => p.label.includes("CDP"))!.port, 9222, "기본값이 9222 가 아니다");
  // 잘못된 값은 조용히 0 포트를 만들지 않고 기본값으로 돌아간다.
  assert.equal(defaultPortPlan({ HARNESSIDE_CDP_PORT: "abc" } as NodeJS.ProcessEnv).find((p) => p.label.includes("CDP"))!.port, 9222);
});

test("작은 보조 함수 — 바이트 표기 · engines 파싱", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.deepEqual(parseEnginesFloor(">=22"), { major: 22, minor: undefined });
  assert.deepEqual(parseEnginesFloor(">=22.1"), { major: 22, minor: 1 });
  assert.equal(parseEnginesFloor(""), null);
});
