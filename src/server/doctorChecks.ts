/**
 * `harnesside doctor` 의 **판정 모듈** (2026-10-04 · Q-13).
 *
 * ── 왜 파일이 따로 있는가 ───────────────────────────────────────────────────
 * `cli.ts` 의 `cmdDoctor` 는 출력만 한다. 판정을 그 안에 박아두면 두 가지가
 * 불가능해진다: 브라우저·포트·설정을 **실제로 만지지 않고** 결과를 조작해 검사하는
 * 것과, "이 판정이 무엇을 보기 때문에 거짓말할 수 있는가" 를 한 곳에 적는 것.
 * 그래서 규칙(.ts)과 렌더(.cli.ts 를 거친 출력)를 나눴다. 이 저장소 관례와 같다
 * (`ToolBlock`/`blocks.ts`, `/help`/`renderHelpText`).
 *
 * ── 설계 규칙: 읽기 전용 ────────────────────────────────────────────────────
 * 이 모듈은 **판정만 한다.** 파일을 쓰지 않고, 포트를 열지 않고, 프로세스를
 * 끝내지 않는다. `doctor` 가 사용자가 감수할 위험의 크기를 알고 부르는 명령이기
 * 때문이다 — 확인하러 왔더니 cmake 가 돌거나 20GB 가 받는 것은 진단이 아니다.
 * (설치는 오직 `doctor --install` 뿐이고, 그건 `setup/firstRun.ts` 가 한다.)
 * 이 규칙이 깨졌는지는 `doctorChecks.readonly.test.ts` 가 파일시스템·포트를
 * 전후로 비교해 **실측**한다 — 소스 grep 으로는 증명되지 않는다(쓰는 라이브러리를
 * 바꿔도 검사는 통과한다).
 *
 * ── 이 판정이 거짓말할 수 있는 경우 ─────────────────────────────────────────
 *  1. `dist` 대 `src` 는 **mtime** 비교다. 체크아웃·복사·빌드 순서로 같거나
 *     거짓이 된다(가장 자주 어긋나는 축 — 그래서 파일 경로와 시각을 둘 다 찍는다).
 *  2. 포트의 "누가 씀" 은 `ss`/`netstat` 출력 해석이다. 그 도구가 없거나
 *     파싱이 안 되면 **`free` 가 아니라 `unknown`** 이다. 조회 실패를 빈 것으로
 *     읽으면 사용자에게 "비어 있음" 이라고 말하게 되고, 그건 거짓말이다.
 *  3. 모델 판정은 **헤더만** 읽는다(기본 4MiB). 용량·Sanitize 는 여기서 모른다.
 *  4. 터미널 capability 는 **이 프로세스의** 환경값이다. 서버가 데몬이면
 *     사용자의 터미널 환경변수를 상속하지 못한다 — 그래서 "이 창에서 실행했을 때" 라고
 *     명시한다. 웹 UI 를 그리는 브라우저의 capability 는 여기서 **모른다**(미확인).
 *  5. 설정의 provenance 를 보려면 **설정을 실제로 읽어야** 한다. 읽되 비밀 값은
 *     절대 옮기지 않는다 — 키 **이름**까지만 본다(`ci-checks.mjs` 규칙 2의 이유).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { IDE_PORT, LLAMA_PORT, tcpPortProbe, type PortProbe } from "../setup/ports.js";
import { getCapabilities, type TerminalCapabilities } from "../setup/terminal.js";
import { pidOnPort, readCmdline } from "../setup/modelSwitch.js";
import { readGgufArchInfo, type GgufArchInfo } from "../setup/ggufMeta.js";
import { CDP_DEFAULT_PORT } from "./browserFlags.js";
import { SCHEMA_VERSION, findSecrets, loadConfig } from "../config/contract.js";
import { C } from "./daemon.js";

// ────────────────────────────────────────────────────────────────────────────
// 판정 결과 — `unknown` 이 상태로 존재한다는 것이 이 모듈의 중심이다.
// ────────────────────────────────────────────────────────────────────────────

/**
 * `ok` · `warn` · `fail` · **`unknown`**.
 *
 * `unknown` 이 별도 상태인 이유: 모르는 것을 `false`·`0`·`free` 로 채우면
 * 사용자는 그것을 측정값으로 읽는다. 이 저장소 규칙("모르는 것을 아는 것처럼
 * 쓰지 않는다", 게이지의 `null ≠ 0`)이 그대로 판정에 적용되는 지점이다.
 */
export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface DoctorCheck {
  /** 안정된 식별자(테스트·문서가 이름으로 참조). */
  id: string;
  /** 화면에 찍을 이름. */
  label: string;
  /** **측정한 값.** 모르면 판정만 하고 값을 비운다("미확인"). */
  value: string;
  state: CheckState;
  /** 왜 이 판정이 나왔는지 — 사용자가 "왜냐면" 을 요구하지 않아도 답이 있어야 한다. */
  note?: string;
  /** 사용자가 **지금** 할 수 있는 행동. 판정에 행동이 없으면 요구(Q-13)가 실패한다. */
  action?: string;
}

const UNKNOWN_VALUE = "미확인";

/**
 * 설정 **키 이름** 중 비밀처럼 보이는 것. 이름만 본다 — 값을 읽지 않는다.
 *
 * 왜 키 이름과 `findSecrets`(값의 모양) 둘 다 쓰는가: 키 이름만 보면 사람이
 * `authorization` 이라 이름 짓고 넣은 값을 놓치고, 값 모양만 보면 평범한
 * 비밀("내 vault 의 값")을 놓친다. 두 근거가 다르면 **몇 개인지** 알려줄 수 있다.
 */
const SECRET_KEY_NAME = /(api[-_]?key|token|secret|password|passwd|credential|authorization)/i;

// ────────────────────────────────────────────────────────────────────────────
// 순수 판정 — I/O 없음. 여기가 검사되는 부분이다.
// ────────────────────────────────────────────────────────────────────────────

/** `engines.node` 의 `">=22"` · `">=22.1"` 같은 범위에서 최소 major[.minor] 를 뽑는다. */
export function parseEnginesFloor(range: string): { major: number; minor?: number } | null {
  const m = /(\d+)(?:\.(\d+))?/.exec(range ?? "");
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] === undefined ? undefined : Number(m[2]) };
}

/**
 * Node 버전 — major/minor 를 **둘 다** prints(Q-13 요구).
 *
 * 왜 major/minor 를 둘 다 보이는가: CI 는 major 하나만 본다(Q-9). 실제로
 * Node 20.20.2 에서 6개 파일이 죽었듯, minor 가 구별되는 문제가 있었다.
 */
export function judgeNodeVersion(
  running: string,
  enginesNode: string,
): DoctorCheck {
  const floor = parseEnginesFloor(enginesNode);
  const label = "Node";
  if (!floor) {
    return { id: "node", label, value: `${running} (요구 범위 파싱 실패: ${enginesNode})`, state: "unknown", note: "`engines.node` 를 읽지 못했다 — 최소 버전을 모른다" };
  }
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(running);
  const required = floor.minor === undefined ? String(floor.major) : `${floor.major}.${floor.minor}`;
  if (!m) {
    return { id: "node", label, value: `판독 불가 (${running}) · 요구 >=${required}`, state: "unknown", note: "버전 문자열을 읽지 못했다" };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const value = `${major}.${minor}.${m[3]} (major.minor ${major}.${minor} · 요구 >=${required})`;
  const okMajor = major > floor.major;
  const okMinor = major === floor.major && (floor.minor === undefined || minor >= floor.minor);
  if (okMajor || okMinor) {
    return { id: "node", label, value, state: "ok" };
  }
  return {
    id: "node",
    label,
    value,
    state: "fail",
    note: "이 버전에서는 이미 재현된 실패가 있다 (Node 20: node-pty 가 종료 시 SIGSEGV, 브라우저 도구에 WebAPI 없음)",
    action: `Node ${required} 이상으로 올리십시오 (nvm use ${required})`,
  };
}

/** 알려진 터미널 목록. `identifyTerminal` 이 뱉는 이름과 같은 표기여야 한다.
 *
 *  여기 있는 목록은 **"그 단말을 검증했다" 는 뜻이 아니다** — `docs/VERIFICATION.md`
 *  의 실행환경 매트릭스에는 Linux x64 하나만 `검증됨` 이라고 적혀 있다. 이 목록의
 *  목적은 "알려지지 않았다" 와 "모른다" 를 구분하는 것이지 통과를 주장하는 것이 아니다. */
export const KNOWN_TERMINALS = [
  "WezTerm", "ghostty", "kitty", "Alacritty", "iTerm.app", "vscode",
  "Windows Terminal", "JetBrains-JediTerm", "rio", "foot", "Windows conhost",
  "ConEmu", "ANSICON", "Apple_Terminal", "GNOME VTE / gnome-terminal",
  "tmux", "GNU screen", "rxvt", "Linux console", "legacy VT",
  "MSYS/Git Bash",
];

/** 판단 불가한 이름들 — `identifyTerminal` 이 못 알아본다는 뜻. */
const UNIDENTIFIABLE = new Set(["unknown", "", "dumb"]);

/**
 * 감지된 단말 → **3가지를 구분한다**: 알려짐 / 미지원 / 판단 불가.
 *
 * 셋을 합치면 왜 문제가 생겼는지 알 수 없다: "미지원" 은 무엇을 고르면 되는지
 * 말해줄 수 있고, "판단 불가" 는 아무것도 말할 수 없다.
 */
export function judgeTerminalIdentity(terminal: string): DoctorCheck {
  const label = "단말";
  const t = (terminal ?? "").trim();
  if (UNIDENTIFIABLE.has(t.toLowerCase())) {
    return {
      id: "terminal-identity",
      label,
      value: "판단 불가 (TERM 이 실명을 알려주지 않음)",
      state: "unknown",
      note: "TERM_PROGRAM · WT_SESSION · VTE_VERSION 등 단말을 밝히는 변수가 없다",
      action: "TERM_PROGRAM 등 단말을 밝히는 환경변수를 주면 판정이 정확해집니다",
    };
  }
  if (KNOWN_TERMINALS.some((k) => k.toLowerCase() === t.toLowerCase())) {
    return { id: "terminal-identity", label, value: `${t} (알려진 단말)`, state: "ok" };
  }
  return {
    id: "terminal-identity",
    label,
    value: `${t} (목록에 없음)`,
    state: "unknown",
    note: "모르는 단말이라고 **실패한 것**은 아니다 — 그 단말을 검증한 적이 없다",
    action: "화면이 깨져 보이면 TERM 을 xterm-256color 로 두고 다시 실행하십시오",
  };
}

/**
 * 터미널 capability 5종 — 요구는 `getCapabilities` 를 **재사용**하라고 적었다.
 * 여기서 새 판정 규칙을 쓰지 않고 그 결과를 그대로 옮긴다.
 *
 * 왜 "이 창에서 실행했을 때" 라고 단서를 달았나: 서버는 데몬일 수 있다. 데몬은
 * 사용자의 터미널 환경변수를 상속하지 못하므로, 이 줄은 **사용자의 단말이 아니라
 * 이 프로세스의 감지 결과** 다. 웹 창을 그리는 브라우저의 capability 는 여기서
 * **모른다** — 그래서 단말 항목을 "확인됨" 으로 올리지 않는다.
 */
export function terminalCapabilityChecks(caps: TerminalCapabilities): DoctorCheck[] {
  const cap = (id: string, label: string, on: boolean, yes: string, no: string): DoctorCheck => ({
    id,
    label,
    value: on ? `가능 (${yes})` : `없음 (${no})`,
    // capability 부재는 **실패가 아니다** — 모든 화면이 그에 맞춰 그려진다.
    state: on ? "ok" : "warn",
    note: on ? undefined : "이 기능이 없어도 동작한다 — 화면이 ASCII 로 내려간다",
  });
  return [
    {
      id: "cap-color-depth",
      label: "단말 capability · 색",
      value: `${caps.colorDepth} 비트`,
      // 0 도 **측정값**이다 (비-TTY 또는 NO_COLOR) — "모름" 이 아니므로 unknown 이 아니다.
      state: caps.colorDepth >= 8 ? "ok" : "warn",
      note:
        caps.colorDepth === 0
          ? "0 이면 이 프로세스는 색을 내보내지 않는다 — 비-TTY 또는 NO_COLOR. 판정은 그대로 읽힌다"
          : caps.colorDepth < 8
            ? "16색 이하라 밝은 색(90-97)이 다른 색으로 옮겨 칠해진다"
            : undefined,
    },
    cap("cap-unicode", "단말 capability · 유니코드", caps.unicode, "글리프 폭이 기대대로", "ASCII 로 강등됨"),
    cap("cap-alt-screen", "단말 capability · 대체 화면", caps.altScreen, "1049 사용", "스크롤보크를 보존 위해 미사용"),
    cap("cap-mouse-sgr", "단말 capability · 마우스(SGR)", caps.mouseSgr, "1006 수신", "마우스 끔"),
    cap("cap-sync-output", "단말 capability · 동기 출력", caps.synchronizedOutput, "2026 프레임 단위", "테어링 가능"),
  ];
}

/** 포트 3상태 + "판단 불가". 요구: 비어 있음 / 우리가 씀 / 남이 씀 을 구분한다. */
export type PortVerdict = "free" | "ours" | "foreign" | "unknown";

export interface PortObservation {
  /** TCP 로 붙을 수 있었는가(`ports.ts` 의 `PortProbe` — 그 정본을 재사용). */
  reachable?: boolean;
  /** listening pid. `null` 이면 "누군가 있다" 가 아니라 "누군데 있는지 모른다". */
  pid?: number | null;
  /** 그 pid 의 명령줄. **읽지 못했으면 `null`** — "llama 가 아니다" 의 근거가 아니다. */
  cmdline?: string | null;
  /** 조회 자체가 실패했는지(`known: false`, 또는 `ss`/`netstat` 부재). */
  lookupFailed?: boolean;
  /** 판단할 근거가 전혀 없음을 명시적으로 알렸을 때. */
  reason?: string;
}

const OURS_PATTERNS: Array<[RegExp, string]> = [
  [/llama-server/i, "llama-server"],
  [/harnesside/i, "harnesside"],
  [/dist[\\/]server[\\/]index\.(js|mjs|cjs)/i, "harnesside 서버"],
  [/remote-debugging-port=\d+/i, "Chrome (CDP)"],
];

/**
 * 관측 → 판정. **추측으로 채우지 않는다**: 명령줄을 못 읽으면 `foreign` 가 아니라
 * `unknown` 이다. `foreign` 은 "읽었는데 우리 것이 아니다" 라는 사실이고,
 * 못 읽었다는 그 자체로 근거가 없다(`modelSwitch.ts` 의 같은 판단과 같은 이유).
 */
export function judgePort(
  label: string,
  port: number,
  obs: PortObservation,
  /** 이 포트에서 "우리 것" 의 근거. 없으면 일반 패턴을 쓴다. */
  ours?: RegExp,
  /** 이 포트에서 "우리 것" 의 출력 이름. */
  oursLabel?: string,
  /**
   * **기록된 우리 프로세스 pid.** 명령줄보다 강한 근거다 — 명령줄은 경로에 따라
   * 매칭이 틀릴 수 있지만, 인스턴스 파일에 적힌 pid 는 이 프로그램이 직접 썼다.
   */
  ourPids?: ReadonlySet<number>,
): DoctorCheck {
  const id = `port-${port}`;
  if (obs.lookupFailed) {
    return {
      id, label: `${label} (${port})`,
      value: `판단 불가 — ${obs.reason ?? "listening-port 조회 실패"}`,
      state: "unknown",
      note: "조회 실패를 '비어 있음' 으로 읽으면 포트를 남의 것이 밀어낸 것으로 착각한다",
      action: `ss 또는 netstat 가 있는 셸에서 \`ss -ltnp | grep ${port}\` 로 직접 확인하십시오`,
    };
  }
  if (obs.reachable === false) {
    return { id, label: `${label} (${port})`, value: "비어 있음", state: "ok" };
  }
  if (obs.cmdline == null) {
    return {
      id, label: `${label} (${port})`,
      value: `누군가 씀 (pid ${obs.pid ?? UNKNOWN_VALUE}) · 명령줄 ${UNKNOWN_VALUE}`,
      state: "unknown",
      note: "명령줄을 읽지 못했다 — '우리 것 아님' 을 말할 근거가 없다",
      action: `ps -p ${obs.pid ?? "<pid>"} -o args= 로 직접 확인하십시오`,
    };
  }
  if (obs.pid !== undefined && obs.pid !== null && ourPids?.has(obs.pid)) {
    return {
      id, label: `${label} (${port})`,
      value: `우리가 씀 (pid ${obs.pid} · 기록된 인스턴스)`,
      state: "ok",
    };
  }
  const cmdline = obs.cmdline;
  const hit = (ours ? ([[ours, oursLabel ?? "우리 프로세스"]] as Array<[RegExp, string]>) : OURS_PATTERNS)
    .find(([re]) => re.test(cmdline));
  if (hit) {
    return {
      id, label: `${label} (${port})`,
      value: `우리가 씀 (pid ${obs.pid} · ${hit[1]})`,
      state: "ok",
    };
  }
  return {
    id, label: `${label} (${port})`,
    value: `다른 프로그램이 씀 (pid ${obs.pid})`,
    state: "warn",
    note: "읽었는데 우리 프로그램의 명령줄이 아니다 — 부팅이 이 포트를 못 쓸 수 있다",
    action: `다른 프로그램이 ${port} 를 놓아주도록 조치하거나, 해당 포트를 지정해 다시 실행하십시오`,
  };
}

/**
 * `dist` 가 `src` 보다 오래됐는가 — 요구가 "지금 실제로 그 상태다"(§2.2 7)고
 * **이 한 줄이 지금 가장 값싸다** 고 적힌 항목.
 *
 * mtime 비교의 한계를 값에도 적는다: 파일 경로와 ISO 시각을 **둘 다** 찍는다.
 * 체크아웃하면 둘이 같은 시각이 되고, "최신" 은 커밋 순서가 아니라 파일 시각의
 * 사실일 뿐이다.
 */
export function judgeDistFreshness(
  dirs: { distNewest?: number; srcNewest?: number; distExists: boolean; srcExists: boolean },
): DoctorCheck {
  const id = "dist-freshness";
  const label = "dist 최신성";
  if (!dirs.distExists) {
    return {
      id, label,
      value: "dist 없음",
      state: "fail",
      note: "설치된 바이너리가 없다 — 곧바로 실행될 것이 없다",
      action: "npm run build",
    };
  }
  if (!dirs.srcExists) {
    // 패키징된 설치(설치 후 `src` 가 없음)에서는 정상이다. 실패로 쓰면 안 된다.
    return { id, label, value: "src 없음 (설치본) — 비교 대상 없음", state: "unknown" };
  }
  if (dirs.distNewest === undefined || dirs.srcNewest === undefined) {
    return { id, label, value: `${UNKNOWN_VALUE} (mtime 읽기 실패)`, state: "unknown" };
  }
  const dist = dirs.distNewest;
  const src = dirs.srcNewest;
  const value = `dist ${new Date(dist).toISOString()} · src ${new Date(src).toISOString()}`;
  if (dist < src) {
    const behindMin = Math.max(1, Math.round((src - dist) / 60000));
    return {
      id, label,
      value: `${value} — src 가 ${behindMin}분 더 최근`,
      state: "fail",
      note: "지금 실행하면 **이전 코드**가 돈다 — 화면과 문서가 어긋나는 직접 원인",
      action: "npm run build (또는 npm start 전에 반드시)",
    };
  }
  return { id, label, value: `${value} — dist 가 최신`, state: "ok" };
}

/** 설정 판정 입력. 비밀 **값**은 이 구조체에 들어오지 않는다 — 이름만 온다. */
export interface ConfigObservation {
  path: string;
  exists: boolean;
  /** 파일에 적힌 `schemaVersion`. */
  schemaVersion?: number;
  /** 비밀로 보이는 **이름**만. 값은 이 모듈이 읽지도 옮기지 않는다. */
  secretNames?: string[];
  /** provenance(어느 파일·환경변수에서 왔는지). 키 이름만. */
  sourcedKeys?: Array<{ key: string; from: string }>;
  warnings?: string[];
}

/**
 * 설정 파일 — 존재 · 스키마 버전 · 비밀 **존재 여부(값은 절대 출력 안 함)**.
 *
 * 값을 출력하지 않는 건 보안 hygiene 가 아니라 **이 저장소의 명시 규칙**
 * (`ci-checks.mjs` 규칙 2, `.ci/rules.json` 의 비밀 패턴 6종)이다.
 * 진단 출력을 스크린샷·이슈에 붙이는 것이 이 프로그램의 정상적인 사용처라,
 * "진단란에 비밀을 빼면 쓰기 불편해서" 출력하는 순간 규칙이 무너진다.
 */
export function judgeConfig(obs: ConfigObservation): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (!obs.exists) {
    checks.push({
      id: "config-exists",
      label: `설정 (${obs.path})`,
      value: "없음 — 기본값으로 동작",
      state: "unknown",
      note: "없음과 '비어 있음' 은 다르다 — 파일을 못 읽었을 수도 있다",
      action: "값을 고정하려면 위 경로에 config.yaml 을 만들거나 /models · /server 로 기록하십시오",
    });
    return checks;
  }
  const want = obs.schemaVersion ?? SCHEMA_VERSION;
  const known = obs.schemaVersion === undefined ? undefined : obs.schemaVersion === SCHEMA_VERSION;
  checks.push({
    id: "config-exists",
    label: `설정 (${obs.path})`,
    value: "있음",
    state: "ok",
  });
  checks.push({
    id: "config-schema",
    label: "설정 · 스키마 버전",
    value: `${obs.schemaVersion ?? UNKNOWN_VALUE} (코드 정본 ${SCHEMA_VERSION})`,
    state: known === undefined ? "unknown" : known ? "ok" : "warn",
    note: known === false
      ? "옛 버전 설정이다 — 읽을 때 마이그레이션되지만 원본 파일은 그대로다"
      : undefined,
    action: known === false ? "harnesside doctor --install 로 함께 정리하거나 파일을 직접 고치십시오" : undefined,
  });
  const names = obs.secretNames ?? [];
  checks.push({
    id: "config-secrets",
    label: "설정 · 비밀",
    // **이름만** 센다. 값은 이 어디에도 없다 — 읽지도 않는다.
    value: names.length
      ? `${names.length}개 존재 (${names.join(", ")}) — 값은 출력하지 않음`
      : "없음",
    state: "ok",
    note: "이름만 센다. 값이 필요하면 그 프로그램만 읽게 하십시오",
  });
  const src = obs.sourcedKeys ?? [];
  if (src.length) {
    checks.push({
      id: "config-provenance",
      label: "설정 · 출처",
      value: src.map((s) => `${s.key}←${s.from}`).join(" · "),
      state: "ok",
      note: "값이 어디서 왔는지 — ' 내가 안 바꾼 값이 바뀌었다' 의 유일한 답",
    });
  }
  for (const w of obs.warnings ?? []) {
    checks.push({ id: `config-warn-${w.slice(0, 24)}`, label: "설정 · 경고", value: w, state: "warn" });
  }
  return checks;
}

/** 모델 파일 — 경로 존재 · 크기 · GGUF 헤더. 값은 `ggufMeta` 정본에서만 읽는다. */
export function judgeModelFile(obs: {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  arch?: string;
  moe?: boolean | undefined;
  conclusive: boolean;
}): DoctorCheck {
  const id = "model-file";
  const label = "모델 파일";
  if (!obs.exists) {
    return {
      id, label, value: `없음 — ${obs.path}`,
      state: "warn",
      note: "설정된 경로에 파일이 없다",
      action: "harnesside doctor --install 로 받거나 HARNESSIDE_MODELS_DIR 을 확인하십시오",
    };
  }
  const size = obs.sizeBytes === undefined ? UNKNOWN_VALUE : formatBytes(obs.sizeBytes);
  const arch = obs.conclusive ? (obs.arch ?? "헤더에 arch 없음") : `${UNKNOWN_VALUE} (GGUF 헤더를 끝까지 못 읽음)`;
  const moe = obs.moe === undefined ? UNKNOWN_VALUE : obs.moe ? "MoE" : "dense";
  return {
    id,
    label,
    value: `${obs.path} · ${size} · arch ${arch} · ${moe}`,
    // 헤더를 못 읽은 파일은 "문제가 있다" 의 근거가 아니라 "모른다" 다.
    state: obs.conclusive ? "ok" : "unknown",
    note: obs.conclusive ? undefined : "GGUF 가 아닐 수 있다 — 헤더 매직을 확인하지 못했다",
    action: obs.conclusive ? undefined : "파일 앞 4바이트가 GGUF 인지 확인하십시오",
  };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 수집 — I/O. 전부 주입 가능해야 브라우저·서버 없이 검사된다.
// ────────────────────────────────────────────────────────────────────────────

export interface PortPlan {
  label: string;
  port: number;
  /** 이 포트를 "우리가 쓰는 것" 으로 볼 때의 근거(없으면 일반 판정). */
  ours?: RegExp;
  /** 위 근거가 맞았을 때 출력에 함께 붙일 이름. 없으면 "우리 프로세스". */
  oursLabel?: string;
}

/** CDP 포트를 **호출 시점**에 읽는다 — 모듈 로드 시점의 값은 환경변수를 못 따라간다. */
export function defaultPortPlan(env: NodeJS.ProcessEnv = process.env): PortPlan[] {
  const cdp = Number(env.HARNESSIDE_CDP_PORT ?? CDP_DEFAULT_PORT);
  return [
    // 웹 IDE 포트: **경로 이름이 아니라 서버 진입점**으로 판정한다. 설치 경로가
    // `harnesside` 가 아닐 수 있다(실측: 이 저장소는 `harnessCli` 다) — 이름만 보면
    // **우리가 띄운 서버를 "다른 프로그램" 이라고 말한다.** 사용자가 그 문장을
    // 믿으면 자기 서버를 죽이려 한다.
    { label: "웹 IDE", port: IDE_PORT, ours: /harnesside|dist[\\/]server[\\/]index\./i, oursLabel: "harnesside 서버" },
    { label: "llama-server", port: LLAMA_PORT, ours: /llama-server/i, oursLabel: "llama-server" },
    { label: "Chrome CDP", port: Number.isFinite(cdp) && cdp > 0 ? cdp : CDP_DEFAULT_PORT, ours: /remote-debugging-port=\d+/i, oursLabel: "Chrome (CDP)" },
  ];
}

export interface CollectOptions {
  projectRoot: string;
  home: string;
  /**
   * **실행 중인 코드가 있는 `dist` 디렉터리.**
   *
   * 없으면 `projectRoot/dist` 로 되돌아간다. 전역 설치에서 projectRoot 는 사용자의
   * cwd(프로젝트가 아닐 수도 있다)라 `dist` 가 없다 → "바이너리가 없다" 라는
   * **거짓말**이 나온다(전역 설치에서 실측). 그래서 호출자가 **자기 모듈 옆** 경로를
   * 넘긴다.
   */
  distDir?: string;
  ports?: PortPlan[];
  /** 주입점들 — 전부 기본값이 진짜 I/O 다. */
  probe?: PortProbe;
  pidOn?: typeof pidOnPort;
  readCmd?: typeof readCmdline;
  caps?: TerminalCapabilities;
  /** `engines.node` 원문 (기본 package.json). */
  enginesNode?: string;
  /** 디렉터리에서 가장 최근 파일의 mtime. */
  newestMtime?: (dir: string) => Promise<number | undefined>;
  /** 설정 파일 경로 — 정본은 `daemon.defaultPaths()` 다. 여기서 새로 맞추지 않는다. */
  configPath?: string;
  /** 실행 중인 우리 서버의 pid(인스턴스 기록에서). 있으면 포트 판정의 최우선 근거다. */
  serverPid?: number;
  /** 설정 관측 — 기본은 실제 파일을 읽는다. */
  readConfigObs?: (opts: { configPath: string }) => Promise<ConfigObservation>;
  /** 모델 관측 — 기본은 config 의 모델 경로를 읽는다. */
  readModelObs?: (opts: { projectRoot: string; home: string }) => Promise<{
    path: string;
    exists: boolean;
    sizeBytes?: number;
    arch?: string;
    moe?: boolean | undefined;
    conclusive: boolean;
  }>;
}

/** 디렉터리(재귀) 안 가장 최근 mtime. `dist`·`src` 비교의 유일한 근거. */
export async function newestMtimeIn(dir: string): Promise<number | undefined> {
  let newest: number | undefined;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await walk(p, depth + 1);
      } else {
        const st = await stat(p).catch(() => null);
        if (st?.isFile() && (newest === undefined || st.mtimeMs > newest)) newest = st.mtimeMs;
      }
    }
  };
  await walk(dir, 0);
  return newest;
}

/** 설정 관측 — **비밀 값은 읽지 않는다.** 이름(`findSecrets` 의 결과)만 쓴다. */
async function defaultConfigObs(opts: { configPath: string }): Promise<ConfigObservation> {
  const path = opts.configPath;
  const loaded = await loadConfig({ projectConfigPath: path }).catch(() => null);
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    return { path, exists: false };
  }
  // 비밀은 **두 근거**로 센다. 둘 다 **이름만** 쓴다.
  //  (1) 설정 **키 이름**이 비밀처럼 보이는가 (`apiKey`·`token`·`password`…).
  //      정규식으로 키 이름만 뽑는다 — 값을 파싱해 들여오지 않는다.
  //  (2) `findSecrets` 가 **값의 모양**으로 알아낸 종류 (OpenAI·GitHub PAT…).
  //      이건 저장소 규칙(`.ci/rules.json`)과 같은 목록이라 두 곳이 어긋나지 않는다.
  const keyNames = [...raw.matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((m) => m[1]!);
  const secretNames = [
    ...new Set([
      ...keyNames.filter((k) => SECRET_KEY_NAME.test(k)),
      ...findSecrets(raw).map((s) => s.name),
    ]),
  ];
  const sourcedKeys = Object.entries(loaded?.sources ?? {})
    .slice(0, 12)
    .map(([key, from]) => ({ key, from: typeof from === "string" ? from : "설정" }));
  return {
    path,
    exists: true,
    schemaVersion: loaded?.schemaVersion,
    secretNames,
    sourcedKeys,
    warnings: loaded?.warnings ?? [],
  };
}

async function defaultModelObs(o: { projectRoot: string; home: string }): Promise<{
  path: string; exists: boolean; sizeBytes?: number; arch?: string; moe?: boolean | undefined; conclusive: boolean;
}> {
  const { projectRoot, home } = o;
  // 전역(~/.harnesside) < 프로젝트 순으로 본다. 프로젝트 설정만 보면, 폴더를 바꿔 실행했을 때 사용자가 전역
  // 설정에 적어 둔 모델이 "설정에 기록된 모델 없음" 으로 나온다(부팅의 모델 결정과 같은 답을 내야 한다).
  const loaded = await loadConfig({
    globalConfigPath: join(home, ".harnesside", "config.yaml"),
    projectConfigPath: join(projectRoot, ".harnesside", "config.yaml"),
  }).catch(() => null);
  const cfg = (loaded?.values?.llama ?? {}) as Record<string, unknown>;
  const modelsDir = process.env.HARNESSIDE_MODELS_DIR ?? join(home, ".harnesside", "models");
  const configured = typeof cfg.modelPath === "string" ? cfg.modelPath : "";
  const path = configured || `${modelsDir}/(설정에 기록된 모델 없음)`;
  if (!configured) {
    return { path, exists: false, conclusive: false };
  }
  const st = await stat(configured).catch(() => null);
  if (!st?.isFile()) return { path, exists: false, conclusive: false };
  // GGUF 헤더는 **정본(`ggufMeta`)**에서 읽는다 — 매직을 여기서 다시 검사하지 않는다.
  const info: GgufArchInfo = await readGgufArchInfo(configured).catch(() => ({ conclusive: false }));
  const moe = info.expertCount ? true : info.conclusive ? false : undefined;
  return { path, exists: true, sizeBytes: st.size, arch: info.arch, moe, conclusive: info.conclusive };
}

/** 포트 하나를 **관측만** 한다(연결·명령줄 조회). 아무것도 바꾸지 않는다. */
async function observePort(port: number, opts: CollectOptions): Promise<PortObservation> {
  const probe = opts.probe ?? tcpPortProbe;
  const state = await probe(port).catch(() => "unknown" as const);
  if (state === "free") return { reachable: false };
  if (state === "unknown") {
    return { lookupFailed: true, reason: "TCP 조회가 시간 초과 또는 실패 (방화벽이 DROP)" };
  }
  const run = async (file: string, args: string[], timeoutMs: number) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(file, args, { timeout: timeoutMs });
    return String(stdout);
  };
  const found = await (opts.pidOn ?? pidOnPort)(port, run).catch(() => ({ pid: null, known: false }));
  if (!found.known) {
    return { lookupFailed: true, reason: "listening-port 조회 실패 (ss/netstat 없음 또는 파싱 불가)" };
  }
  const cmdline = await (opts.readCmd ?? readCmdline)(found.pid!).catch(() => null);
  return { reachable: true, pid: found.pid, cmdline };
}

/** 판정을 모은다. 순수 판정만 쓰고, **아무것도 고치지 않는다.** */
export async function collectDoctorChecks(opts: CollectOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1) Node 버전
  const enginesNode = opts.enginesNode ?? (await readEnginesNode());
  checks.push(judgeNodeVersion(process.version, enginesNode));

  // 2) 터미널 — 감지 정본(`getCapabilities`)을 재사용한다.
  const caps = opts.caps ?? getCapabilities();
  checks.push(judgeTerminalIdentity(caps.terminal));
  checks.push(...terminalCapabilityChecks(caps));

  // 3) 포트 3상태 ×3
  for (const p of opts.ports ?? defaultPortPlan()) {
    const ourPids = new Set<number>();
    if (opts.serverPid !== undefined) ourPids.add(opts.serverPid);
    const observation = await observePort(p.port, opts);
    // **OS가 알려주는 이 포트의 리스너 pid**도 "우리가 켠 서버"다. `serverPid`는 daemon이
    // 이 IDE를 알 때만 있고(Q-13), 이름 cmdline 매칭은 설치 경로에 따라 틀릴 수 있다(p.ours / p.oursLabel).
    // 그래서 관측된 pid가 있으면 ourPids 에 보강한다 — 조회 실패(free 또는 lookupFailed)는 pid 가 없으니
    // 아무것도 붙지 않는다(이전과 동일).
    if (observation.pid !== undefined) {
      ourPids.add(observation.pid);
    }
    checks.push(judgePort(p.label, p.port, observation, p.ours, p.oursLabel, ourPids));
  }

  // 4) dist 가 src 보다 오래됐는가
  //
  // **어느 `dist` 를 보는가**가 이 검사의 전부다(전역 설치에서 실측).
  //
  // 예전엔 `<projectRoot>/dist` 만 봤다. 전역 설치로 `harnesside doctor` 를 돌리면
  // projectRoot 에 `dist` 가 없어서 **"설치된 바이너리가 없다 — 곧바로 실행될 것이 없다"**
  // 라고 말했다. 그런데 **바로 그 명령이 실행 중**이었다 — 이 문장이 거짓이었다.
  //
  // 그래서 **실행 중인 모듈 옆**의 `dist` 를 본다(`opts.distDir`). 값이 없으면
  // 예전처럼 projectRoot 로 되돌아간다. 개발 실행이면 저쪽이 옳고,
  // 전역 설치면 이쪽이 옳다 — 둘 다 "지금 실행되는 코드가 있는 곳"을 가리킨다.
  const newest = opts.newestMtime ?? newestMtimeIn;
  const distDir = opts.distDir ?? join(opts.projectRoot, "dist");
  const srcDir = join(opts.projectRoot, "src");
  const [distExists, srcExists, distNewest, srcNewest] = await Promise.all([
    stat(distDir).then((s) => s.isDirectory()).catch(() => false),
    stat(srcDir).then((s) => s.isDirectory()).catch(() => false),
    newest(distDir),
    newest(srcDir),
  ]);
  checks.push(judgeDistFreshness({ distExists, srcExists, distNewest, srcNewest }));

  // 5) 설정 (비밀 값은 읽지 않는다)
  const configPath = opts.configPath ?? join(opts.projectRoot, ".harnesside", "config.yaml");
  checks.push(...judgeConfig(await (opts.readConfigObs ?? defaultConfigObs)({ configPath })));

  // 6) 모델 파일
  checks.push(
    judgeModelFile(await (opts.readModelObs ?? defaultModelObs)({ projectRoot: opts.projectRoot, home: opts.home })),
  );
  return checks;
}

/** 정본은 package.json(Q-7). 값을 복사하지 않고 **읽는다**. */
async function readEnginesNode(): Promise<string> {
  // 소스에서 실행할 때와 `dist/` 로 빌드되어 실행될 때 package.json 의 깊이가 다르다.
  // 한쪽만 보면 **설치본에서 조용히 미확인** 이 되고, 그게 그대로 사용자에게 보인다.
  const candidates = [
    new URL("../../package.json", import.meta.url), // dist/server/ → 저장소 루트
    new URL("../package.json", import.meta.url), // src/server/ → 저장소 루트
  ];
  for (const c of candidates) {
    const text = await readFile(c, "utf8").catch(() => null);
    if (text === null) continue;
    try {
      const pkg = JSON.parse(text) as { engines?: { node?: string } };
      if (pkg.engines?.node) return pkg.engines.node;
    } catch {
      // 파싱 실패는 다음 후보로 — 둘 다 없으면 `미확인` 이다(0 으로 채우지 않는다).
    }
  }
  return UNKNOWN_VALUE;
}

// ────────────────────────────────────────────────────────────────────────────
// 렌더 — 판정에서 분리. 색은 여기서만.
// ────────────────────────────────────────────────────────────────────────────

const STATE_MARK: Record<CheckState, (s: string) => string> = {
  ok: C.green,
  warn: C.yellow,
  fail: C.red,
  unknown: C.dim,
};

export function formatCheck(c: DoctorCheck): string {
  const head = `  ${STATE_MARK[c.state](pad(c.label, 26))}${c.value}`;
  const lines = [head];
  if (c.note) lines.push(`  ${" ".repeat(26)}${C.dim(c.note)}`);
  if (c.action) lines.push(`  ${" ".repeat(26)}${C.dim("→ " + c.action)}`);
  return lines.join("\n");
}

/**
 * 라벨 열을 맞춘다. **항상 최소 한 칸**을 남긴다 — 폭이 정확히 같으면 값이
 * 라벨에 붙어서 "유니코드없음" 처럼 읽힌다(실측으로 실제로 그렇게 보였다).
 *
 * CJK 는 폭이 2 라 `padEnd` 로는 열이 밀린다 — 그래서 표시 폭을 계산한다.
 */
function pad(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? `${s} ` : s + " ".repeat(width - w + 1);
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

/**
 * "다음에 할 수 있는 행동" — 요구(Q-13): 출력에 행동이 **1개 이상** 있어야 한다.
 *
 * `fail` → `warn` → `unknown` 순으로 먼저 손댈 것을 고른다. `ok` 은 아무 것도
 * 요구하지 않으므로 행동 목록에 나오지 않는다.
 */
export function nextActions(checks: DoctorCheck[]): string[] {
  const order: CheckState[] = ["fail", "warn", "unknown"];
  return order
    .flatMap((state) => checks.filter((c) => c.state === state && c.action))
    .map((c) => `${c.label}: ${c.action}`);
}

/** `unknown` 개수 — 요약 줄에 그대로 찍는다. 조용히 없애지 않는다. */
export function countUnknown(checks: DoctorCheck[]): number {
  return checks.filter((c) => c.state === "unknown").length;
}
