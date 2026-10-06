/**
 * 머신 프로필 — `Hardware` 가 담지 않는 축(CPU 명령어 확장 · 물리/P·E 코어 · 셸 · WSL).
 *
 * ── 왜 별도 모듈인가 ───────────────────────────────────────────────────────
 * `hardware.ts` 는 "모델과 엔진을 고르는 데 필요한 최소" 다(GPU·VRAM·RAM·백엔드).
 * 여기는 **설치 시 실측(`measure.ts`)** 과 `doctor` 가 쓰는 보조 사실이다:
 *  - 스레드 후보: 논리 코어(`cpuCount`)만으로는 하이브리드 CPU(E코어)와 SMT 를 구분 못 한다.
 *  - CPU 명령어 확장: AVX2 없는 CPU 에서 기본 CPU 빌드가 `Illegal instruction` 으로 죽을 수 있다.
 *    엔진이 동적 로드로 스스로 고르는지는 릴리스마다 다르므로, 우리는 **사실만 기록**한다.
 *  - 셸·WSL: 런처와 안내 문구가 셸마다 다르다.
 *
 * 규칙: 모르면 `null` 이다. `false`·`0` 으로 채우지 않는다(이 저장소의 `unmeasured` 원칙).
 * 파서는 순수 함수이고, 감지 함수는 `read`/`run` 을 주입받아 테스트된다.
 */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, win32 } from "node:path";
import { cpus } from "node:os";

const execFileP = promisify(execFile);

export interface CpuFeatures {
  avx: boolean | null;
  avx2: boolean | null;
  avx512: boolean | null;
  fma: boolean | null;
  /** ARM Advanced SIMD (NEON / `asimd`). */
  neon: boolean | null;
  sve: boolean | null;
}

export interface CpuProfile {
  model: string | null;
  /** 논리 코어 — `os.cpus().length` 와 같다. */
  logicalCores: number;
  /** 물리 코어. 모르면 null. */
  physicalCores: number | null;
  /** 하이브리드 CPU 의 성능/효율 코어 수. 하이브리드가 아니거나 모르면 null. */
  performanceCores: number | null;
  efficiencyCores: number | null;
  features: CpuFeatures;
  /** 어디서 읽었는가 — "proc-cpuinfo" | "sysctl" | "cim" | "none". */
  source: string;
}

export interface ShellProfile {
  /** "bash" | "zsh" | "fish" | "sh" | "pwsh" | "powershell" | "cmd" | … | null */
  name: string | null;
  path: string | null;
  /** 어떻게 알았는가 — 셸은 자식 프로세스에서 확실히 알 수 없다. */
  source: "SHELL" | "PSModulePath" | "ComSpec" | "none";
}

export interface MachineProfile {
  platform: string;
  arch: string;
  libc: "glibc" | "musl" | null;
  wsl: boolean | null;
  cpu: CpuProfile;
  shell: ShellProfile;
}

const UNKNOWN_FEATURES: CpuFeatures = { avx: null, avx2: null, avx512: null, fma: null, neon: null, sve: null };

// ── 순수 파서 ────────────────────────────────────────────────────────────────

/** `/proc/cpuinfo` → 명령어 확장 + 물리 코어 + 모델명. x86 은 `flags`, ARM 은 `Features`. */
export function parseProcCpuinfo(text: string): { model: string | null; physicalCores: number | null; features: CpuFeatures } {
  const lines = text.split("\n");
  // 키는 **정확히** 맞춘다. x86 에는 숫자 필드 `model`(예: 151)과 이름 필드 `model name` 이
  // 함께 있고, ARM 은 이름을 `Model`/`Hardware` 에 둔다 — 대소문자 무시로 묶으면 숫자가 이름이 된다.
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      for (const l of lines) {
        const m = /^([^:]+?)\s*:\s*(.*)$/.exec(l);
        if (m && m[1].trim() === key && m[2].trim()) return m[2].trim();
      }
    }
    return null;
  };
  const flagsLine = first("flags", "Features");
  const model = first("model name", "Model", "Hardware", "cpu model");
  let features: CpuFeatures = { ...UNKNOWN_FEATURES };
  if (flagsLine !== null) {
    const f = new Set(flagsLine.split(/\s+/));
    const x86 = f.has("sse2") || f.has("sse") || f.has("avx");
    const arm = f.has("asimd") || f.has("fp") || f.has("neon");
    features = {
      avx: x86 ? f.has("avx") : null,
      avx2: x86 ? f.has("avx2") : null,
      avx512: x86 ? [...f].some((x) => x.startsWith("avx512")) : null,
      fma: x86 ? f.has("fma") : null,
      neon: arm ? f.has("asimd") || f.has("neon") : x86 ? false : null,
      sve: arm ? f.has("sve") : x86 ? false : null,
    };
  }
  // 물리 코어: (physical id, core id) 쌍의 수. ARM 커널은 이 필드를 주지 않는다 → null.
  const pairs = new Set<string>();
  let phys: string | null = null;
  for (const l of lines) {
    const m = /^(physical id|core id)\s*:\s*(\d+)/.exec(l);
    if (!m) continue;
    if (m[1] === "physical id") phys = m[2];
    else pairs.add(`${phys ?? "0"}:${m[2]}`);
  }
  return { model, physicalCores: pairs.size > 0 ? pairs.size : null, features };
}

/** sysfs CPU 목록("0-7,16-23") → 개수. 읽을 수 없는 형식이면 null. */
export function countCpuList(list: string): number | null {
  const t = list.trim();
  if (!t) return null;
  let n = 0;
  for (const part of t.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    n += m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1;
  }
  return n;
}

/** macOS `sysctl` 키 값 묶음 → CPU 프로필. 값이 없는 키는 모르는 것이다. */
export function parseDarwinSysctl(v: Record<string, string | undefined>, arch: string, logical: number): CpuProfile {
  const num = (k: string): number | null => {
    const x = v[k];
    if (x === undefined || x.trim() === "") return null;
    const n = Number(x.trim());
    return Number.isFinite(n) ? n : null;
  };
  const flag = (k: string): boolean | null => {
    const n = num(k);
    return n === null ? null : n === 1;
  };
  const arm = arch === "arm64";
  const p = num("hw.perflevel0.physicalcpu");
  const e = num("hw.perflevel1.physicalcpu");
  return {
    model: v["machdep.cpu.brand_string"]?.trim() || null,
    logicalCores: num("hw.logicalcpu") ?? logical,
    physicalCores: num("hw.physicalcpu"),
    performanceCores: p !== null && e !== null && e > 0 ? p : null,
    efficiencyCores: p !== null && e !== null && e > 0 ? e : null,
    features: arm
      ? { avx: false, avx2: false, avx512: false, fma: null, neon: true, sve: false }
      : {
          avx: flag("hw.optional.avx1_0"),
          avx2: flag("hw.optional.avx2_0"),
          avx512: flag("hw.optional.avx512f"),
          fma: flag("hw.optional.fma"),
          neon: false,
          sve: false,
        },
    source: "sysctl",
  };
}

/** 셸 — 우리를 띄운 셸을 정확히 아는 방법은 없다. 환경변수로 **추정하고 출처를 적는다.** */
export function detectShell(env: NodeJS.ProcessEnv, platform: string): ShellProfile {
  if (env.SHELL) return { name: basename(env.SHELL).replace(/\.exe$/i, ""), path: env.SHELL, source: "SHELL" };
  if (platform === "win32") {
    // PowerShell 7 은 PSModulePath 에 `PowerShell\7` 을, 5.1 은 `WindowsPowerShell` 만 둔다.
    // cmd 에서 띄우면 PSModulePath 는 시스템 기본값(WindowsPowerShell)만 있어 구분이 안 된다 —
    // 그래서 5.1 판정은 하지 않고, 7 이 보일 때만 pwsh 라고 말한다.
    const ps = env.PSModulePath ?? "";
    if (/[\\/]PowerShell[\\/]7/i.test(ps) && /Documents[\\/]PowerShell/i.test(ps)) return { name: "pwsh", path: null, source: "PSModulePath" };
    // `win32.basename` — 이 판정은 테스트에서 Linux 위로도 돈다. POSIX basename 은 `\` 를 나누지 않는다.
    if (env.ComSpec) return { name: win32.basename(env.ComSpec).replace(/\.exe$/i, "").toLowerCase(), path: env.ComSpec, source: "ComSpec" };
  }
  return { name: null, path: null, source: "none" };
}

/** `/proc/version` 에 Microsoft 가 있으면 WSL. Linux 가 아니면 false, 못 읽으면 null. */
export function isWsl(procVersion: string | null, platform: string): boolean | null {
  if (platform !== "linux") return false;
  if (procVersion === null) return null;
  return /microsoft/i.test(procVersion);
}

// ── 감지 (주입 가능) ─────────────────────────────────────────────────────────

export interface ProbeIo {
  platform: string;
  arch: string;
  env: NodeJS.ProcessEnv;
  read: (path: string) => string | null;
  run: (file: string, args: string[]) => Promise<string>;
  logicalCores: number;
}

export function defaultProbeIo(): ProbeIo {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    run: async (file, args) => (await execFileP(file, args, { timeout: 15_000, windowsHide: true })).stdout,
    logicalCores: cpus().length || 1,
  };
}

async function detectCpu(io: ProbeIo): Promise<CpuProfile> {
  const base: CpuProfile = {
    model: null,
    logicalCores: io.logicalCores,
    physicalCores: null,
    performanceCores: null,
    efficiencyCores: null,
    features: { ...UNKNOWN_FEATURES },
    source: "none",
  };
  if (io.platform === "linux") {
    const text = io.read("/proc/cpuinfo");
    if (text === null) return base;
    const p = parseProcCpuinfo(text);
    // Intel 하이브리드: 커널이 `cpu_core`(P) · `cpu_atom`(E) PMU 를 따로 노출한다. 논리 CPU 목록이다.
    const pList = io.read("/sys/devices/cpu_core/cpus");
    const eList = io.read("/sys/devices/cpu_atom/cpus");
    const pLogical = pList !== null ? countCpuList(pList) : null;
    const eLogical = eList !== null ? countCpuList(eList) : null;
    return {
      ...base,
      model: p.model,
      physicalCores: p.physicalCores,
      // E 코어는 SMT 가 없어 논리 수 = 물리 수다. P 코어 물리 수는 전체 물리에서 E 를 뺀 것 —
      // P 의 논리 수(SMT 켜짐/꺼짐)로 추정하지 않는다.
      performanceCores:
        pLogical !== null && eLogical !== null && eLogical > 0 && p.physicalCores !== null && p.physicalCores > eLogical
          ? p.physicalCores - eLogical
          : null,
      efficiencyCores: pLogical !== null && eLogical !== null && eLogical > 0 ? eLogical : null,
      features: p.features,
      source: "proc-cpuinfo",
    };
  }
  if (io.platform === "darwin") {
    const keys = [
      "machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu",
      "hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu",
      "hw.optional.avx1_0", "hw.optional.avx2_0", "hw.optional.avx512f", "hw.optional.fma",
    ];
    const v: Record<string, string | undefined> = {};
    // 키 하나가 없으면 sysctl 전체가 실패한다 — 하나씩 묻는다.
    for (const k of keys) v[k] = await io.run("sysctl", ["-n", k]).catch(() => undefined);
    return parseDarwinSysctl(v, io.arch, io.logicalCores);
  }
  if (io.platform === "win32") {
    try {
      const out = await io.run("powershell", [
        "-NoProfile", "-Command",
        "$p = Get-CimInstance Win32_Processor; " +
          "($p | Measure-Object -Property NumberOfCores -Sum).Sum; " +
          "($p | Select-Object -First 1).Name",
      ]);
      const [cores, name] = out.split(/\r?\n/).map((s) => s.trim());
      const n = Number(cores);
      // 명령어 확장: .NET Core 의 Intrinsics 는 pwsh 7 에만 있다. 5.1 이면 모르는 것으로 둔다.
      const avx2 = await io
        .run("pwsh", ["-NoProfile", "-Command", "[System.Runtime.Intrinsics.X86.Avx2]::IsSupported; [System.Runtime.Intrinsics.X86.Avx]::IsSupported; [System.Runtime.Intrinsics.X86.Fma]::IsSupported; [System.Runtime.Intrinsics.X86.Avx512F]::IsSupported"])
        .then((o) => o.split(/\r?\n/).map((s) => s.trim().toLowerCase()))
        .catch(() => null);
      const b = (i: number): boolean | null => (avx2 && (avx2[i] === "true" || avx2[i] === "false") ? avx2[i] === "true" : null);
      const arm = io.arch === "arm64";
      return {
        ...base,
        model: name || null,
        physicalCores: Number.isFinite(n) && n > 0 ? n : null,
        features: arm
          ? { avx: false, avx2: false, avx512: false, fma: null, neon: true, sve: null }
          : { avx: b(1), avx2: b(0), avx512: b(3), fma: b(2), neon: false, sve: false },
        source: "cim",
      };
    } catch {
      return base;
    }
  }
  return base;
}

function detectLibc(io: ProbeIo): "glibc" | "musl" | null {
  if (io.platform !== "linux") return null;
  // `/etc/alpine-release` 또는 musl 로더가 있으면 musl. `hardware.ts` 의 판정과 같은 근거.
  if (io.read("/etc/alpine-release") !== null) return "musl";
  return "glibc";
}

export async function probeMachine(io: ProbeIo = defaultProbeIo()): Promise<MachineProfile> {
  return {
    platform: io.platform,
    arch: io.arch,
    libc: detectLibc(io),
    wsl: isWsl(io.read("/proc/version"), io.platform),
    cpu: await detectCpu(io),
    shell: detectShell(io.env, io.platform),
  };
}

/** 사람이 읽는 한 줄. 모르는 값은 "미확인". */
export function describeMachine(m: MachineProfile): string {
  const f = m.cpu.features;
  const isa = [
    f.avx2 === true ? "AVX2" : f.avx2 === false ? "AVX2 없음" : null,
    f.avx512 === true ? "AVX-512" : null,
    f.neon === true ? "NEON" : null,
  ].filter(Boolean);
  const cores =
    m.cpu.performanceCores !== null && m.cpu.efficiencyCores !== null
      ? `P${m.cpu.performanceCores}+E${m.cpu.efficiencyCores}`
      : m.cpu.physicalCores !== null
        ? `물리 ${m.cpu.physicalCores}`
        : "물리 미확인";
  return [
    `${m.platform}-${m.arch}${m.libc ? `/${m.libc}` : ""}${m.wsl ? " (WSL)" : ""}`,
    `${m.cpu.model ?? "CPU 미확인"} · ${cores}/논리 ${m.cpu.logicalCores} · ${isa.length ? isa.join(" ") : "명령어 확장 미확인"}`,
    `셸 ${m.shell.name ?? "미확인"}${m.shell.source !== "SHELL" && m.shell.name ? ` (${m.shell.source} 기준 추정)` : ""}`,
  ].join(" · ");
}
