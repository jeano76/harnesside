import { test } from "node:test";
import assert from "node:assert/strict";
import { countCpuList, describeMachine, detectShell, isWsl, parseDarwinSysctl, parseProcCpuinfo, probeMachine, type ProbeIo } from "./machineProbe.js";

// 실측 픽스처 — i5-12400F (이 저장소의 개발 머신) /proc/cpuinfo 의 앞부분 모양.
const X86 = [
  "processor\t: 0",
  "vendor_id\t: GenuineIntel",
  "model\t\t: 151",
  "model name\t: 12th Gen Intel(R) Core(TM) i5-12400F",
  "physical id\t: 0",
  "core id\t\t: 0",
  "flags\t\t: fpu sse sse2 avx fma avx2 bmi2",
  "",
  "processor\t: 1",
  "model\t\t: 151",
  "model name\t: 12th Gen Intel(R) Core(TM) i5-12400F",
  "physical id\t: 0",
  "core id\t\t: 0",
  "flags\t\t: fpu sse sse2 avx fma avx2 bmi2",
  "",
  "processor\t: 2",
  "physical id\t: 0",
  "core id\t\t: 1",
  "flags\t\t: fpu sse sse2 avx fma avx2 bmi2",
].join("\n");

const ARM = ["processor\t: 0", "Features\t: fp asimd evtstrm aes sve", "CPU implementer\t: 0x41", "", "Model\t: Raspberry Pi 5"].join("\n");

test("x86 cpuinfo — 숫자 필드 `model` 을 이름으로 착각하지 않는다 (실측 버그: '151')", () => {
  const p = parseProcCpuinfo(X86);
  assert.equal(p.model, "12th Gen Intel(R) Core(TM) i5-12400F");
  assert.equal(p.physicalCores, 2, "(physical id, core id) 쌍으로 센다 — SMT 형제는 하나");
  assert.deepEqual(p.features, { avx: true, avx2: true, avx512: false, fma: true, neon: false, sve: false });
});

test("ARM cpuinfo — 물리 코어 필드가 없으면 null (0 이 아니다)", () => {
  const p = parseProcCpuinfo(ARM);
  assert.equal(p.physicalCores, null);
  assert.equal(p.features.neon, true);
  assert.equal(p.features.sve, true);
  assert.equal(p.features.avx2, null, "ARM 에 AVX2 를 false 라고 단정하지 않는다 — 해당 없음");
  assert.equal(p.model, "Raspberry Pi 5");
});

test("flags 줄이 없으면 명령어 확장은 전부 미확인", () => {
  const p = parseProcCpuinfo("processor\t: 0\n");
  assert.ok(Object.values(p.features).every((v) => v === null));
});

test("sysfs CPU 목록 개수 — 빈 목록(하이브리드 아님)은 null", () => {
  assert.equal(countCpuList("0-11\n"), 12);
  assert.equal(countCpuList("0-7,16-23"), 16);
  assert.equal(countCpuList("12"), 1);
  assert.equal(countCpuList("\n"), null, "i5-12400F 는 cpu_atom 이 있지만 비어 있다 — E코어 0 이 아니라 해당 없음");
  assert.equal(countCpuList("x-y"), null);
});

test("macOS Apple Silicon — P/E 코어와 NEON", () => {
  const p = parseDarwinSysctl(
    { "machdep.cpu.brand_string": "Apple M2 Pro", "hw.physicalcpu": "10", "hw.logicalcpu": "10", "hw.perflevel0.physicalcpu": "6", "hw.perflevel1.physicalcpu": "4" },
    "arm64",
    10
  );
  assert.equal(p.performanceCores, 6);
  assert.equal(p.efficiencyCores, 4);
  assert.equal(p.features.neon, true);
});

test("macOS Intel — 없는 sysctl 키는 미확인", () => {
  const p = parseDarwinSysctl({ "hw.physicalcpu": "4", "hw.optional.avx2_0": "1" }, "x64", 8);
  assert.equal(p.features.avx2, true);
  assert.equal(p.features.avx512, null);
  assert.equal(p.performanceCores, null, "perflevel 이 없으면 하이브리드가 아니다");
  assert.equal(p.logicalCores, 8);
});

test("셸 — $SHELL 이 우선, Windows 는 출처를 적고 추정", () => {
  assert.deepEqual(detectShell({ SHELL: "/usr/bin/fish" }, "linux"), { name: "fish", path: "/usr/bin/fish", source: "SHELL" });
  assert.equal(detectShell({ PSModulePath: "C:\\Users\\u\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules" }, "win32").name, "pwsh");
  assert.equal(detectShell({ ComSpec: "C:\\Windows\\system32\\cmd.exe" }, "win32").name, "cmd");
  assert.equal(detectShell({}, "linux").name, null, "모르면 null");
});

test("WSL — /proc/version 의 Microsoft, 못 읽으면 null", () => {
  assert.equal(isWsl("Linux version 5.15.153.1-microsoft-standard-WSL2", "linux"), true);
  assert.equal(isWsl("Linux version 7.0.0-34-generic", "linux"), false);
  assert.equal(isWsl(null, "linux"), null);
  assert.equal(isWsl(null, "darwin"), false);
});

test("probeMachine — 주입한 Linux 하이브리드 머신 (P6+E8)", async () => {
  // 6 P코어(SMT) + 8 E코어 = 물리 14, 논리 20.
  const lines: string[] = [];
  let cpu = 0;
  for (let core = 0; core < 14; core++) {
    const smt = core < 6 ? 2 : 1;
    for (let k = 0; k < smt; k++) lines.push(`processor\t: ${cpu++}`, "model name\t: Intel Core i7-13700H", "physical id\t: 0", `core id\t\t: ${core}`, "flags\t\t: sse2 avx avx2 fma", "");
  }
  const files: Record<string, string> = {
    "/proc/cpuinfo": lines.join("\n"),
    "/sys/devices/cpu_core/cpus": "0-11\n",
    "/sys/devices/cpu_atom/cpus": "12-19\n",
    "/proc/version": "Linux version 6.8",
  };
  const io: ProbeIo = { platform: "linux", arch: "x64", env: { SHELL: "/bin/zsh" }, read: (p) => files[p] ?? null, run: async () => "", logicalCores: 20 };
  const m = await probeMachine(io);
  assert.equal(m.cpu.physicalCores, 14);
  assert.equal(m.cpu.efficiencyCores, 8);
  assert.equal(m.cpu.performanceCores, 6);
  assert.equal(m.libc, "glibc");
  assert.equal(m.wsl, false);
  assert.match(describeMachine(m), /P6\+E8\/논리 20/);
});
