/**
 * `harnesside doctor` 의 **읽기 전용**성 — 실제 프로세스로 잰다 (2026-10-04 · Q-13).
 *
 * 왜 이 테스트가 필요한가: 요구(Q-13 검증 1)는 "부팅 전·후 파일시스템과 포트를
 * 비교한다. `doctor` 가 고치는 순간 이 요구는 실패다" 다. 이건 **소스 grep 으로
 * 증명할 수 없다.** 쓰지 않는 라이브러리를 추가해도, 읽기 함수를 부수 있는
 * 경로(`planFirstRun` 등)가 남아도 grep 은 통과한다. 이 저장소 규칙 —
 * "검사는 코드보다 먼저 의심된다", 그리고 "사람이 보는 것은 실제로 확인한다" —
 * 때문에 여기서는 **진짜 `doctor` 를 띄워 전후를 비교한다.**
 *
 * 이 테스트가 실제로 재는 것:
 *  1. 파일시스템: 가짜 프로젝트·가짜 HOME 의 **모든 파일 경로 + mtime + 크기** 가 그대로인가
 *  2. 포트: 이 컴퓨터에서 listening 중인 포트 집합이 그대로인가 (`ss` 가 있을 때만 — 없으면 미측정이라 적는다)
 *  3. 비밀: 설정에 넣어 둔 값이 **출력에 한 번도 안 나오고**, 이름만 나오나
 *  4. 행동: 출력에 "다음에 할 수 있는 것" 이 있고 항목이 1개 이상인가
 *
 * 이 테스트가 **재지 않는 것**(여기 적어야 다른 사람이 여기서 그럴 수 있다):
 *  - 브라우저 창에서의 실제 화면 (미측정 — `docs/VERIFICATION.md` 참조)
 *  - macOS · Windows 에서 `ss`/`netstat` 해석이 맞는가 (미측정)
 *  - GPU 를 실제로 얼마나 먹나 (doctor 는 여유 VRAM 만 읽는다)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const SECRET = "sk-DOCTOR-MUST-NOT-PRINT-THIS-VALUE";

interface Snapshot {
  files: string[];
  ports: string[] | null;
}

async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        out.push(`D ${p}`);
        await walk(p, depth + 1);
      } else {
        const st = await stat(p);
        // mtime·크기까지 — 파일을 **고쳐도** 눈에 띄어야 한다.
        out.push(`F ${p} ${st.mtimeMs} ${st.size}`);
      }
    }
  };
  await walk(dir, 0);
  return out.sort();
}

/**
 * `doctor` 가 **보는 세 포트**의 listening 상태. `ss` 가 없으면 **null** —
 * 빈 배열(미측정)이 아니다.
 *
 * 왜 머신 전체 포트를 비교하지 않는가 — **실측으로 배운 결함** (2026-10-05):
 * 처음엔 `ss -ltnH` 전체를 전후로 비교했다. 그랬더니 이 테스트가 **혼자
 * 흔들렸다.** 비교 창(수 초) 사이에 **doctor 와 무관한 프로세스**가 ephemeral
 * 포트를 열고 닫으면(측치 순간에는 `127.0.0.1:36339` 가 새로 나왔다) red 가 된다.
 * 검사하려는 주장은 "doctor 가 자기 포트를 열고 닫지 않는다" 이므로 **그 세 포트만**
 * 보면 충분하고, 머신 전체를 보는 것은 이 검사 밖의 잡음이다.
 *
 * 조용히 좁히지 않는다 — 좁힌 이유와 그 계기가 여기 적혀 있다. 다음 사람이
 * "왜 전체를 안 보지" 하고 넓히면 같은 흔들림이 돌아온다.
 */
function listeningPorts(ports: number[]): string[] | null {
  for (const [file, args] of [
    ["ss", ["-ltnH"]],
    ["netstat", ["-an"]],
  ] as const) {
    const r = spawnSync(file, [...args], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && ports.some((p) => new RegExp(`[:.]${p}\\s`).test(l)))
        .sort();
    }
  }
  return null;
}

/** `doctor` 가 실제로 보는 세 포트 — `doctorChecks.ts` 의 판정 대상과 같은 숫자다. */
const INSPECTED_PORTS = [7317, 8080, 9222];

/**
 * 비교 대상: **프로젝트 트리** 와 **`~/.harnesside`(우리가 쓰는 상태 디렉터리)**.
 *
 * `$HOME` 전체를 비교하지 않는 이유를 측정으로 기록한다: `doctor` 가 부르는
 * `google-chrome --version` 하나가 **자기 XDG 디렉터리에** `mimeapps.list` 를
 * 만든다(2026-10-04 실측 — HOME 이 비어 있으면 GLib 이 mime 캐시를 새로 적는다).
 * harnesside 의 쓰기가 아니라 **검사 대상 프로세스의** 부수효과이고, 이건
 * "doctor 가 파일을 고친 것" 이 아니다. 그렇다고 조용히 무시하지 않고, 여기에
 * 적어 두는 이유를 남긴다 — 다음 사람이 `$HOME` 전체를 비교하려 했다가
 * 이 때문에 테스트가 흔들리는 걸 보면 모른다.
 */
async function snapshot(project: string, home: string): Promise<Snapshot> {
  return {
    files: [
      ...(await snapshotTree(project)),
      ...(await snapshotTree(join(home, ".harnesside"))),
    ],
    ports: listeningPorts(INSPECTED_PORTS),
  };
}

function runDoctor(project: string, home: string): { stdout: string; status: number | null } {
  const r = spawnSync(
    process.execPath,
    [tsxCli, join(root, "src", "server", "index.ts"), "doctor"],
    {
      cwd: project,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        // 이 프로세스가 **사용자의 터미널 환경을 상속했는지** 여부가 단말 판정의
        // 정확도를 갈린다. CI 는 TTY 가 없으므로 명시적으로 고정해 테스트를
        // 재현 가능하게 만든다(그리고 그것이 데몬 상속 문제의 모양이기도 하다).
        TERM: "xterm-256color",
        NO_COLOR: "1",
        HARNESSIDE_CDP_PORT: "9222",
      },
    },
  );
  return { stdout: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
}

test("doctor 는 **아무것도 바꾸지 않는다** — 파일시스템 전후가 동일하다 (실측)", async () => {
  const project = await mkdtemp(join(tmpdir(), "harnesside-doctor-ro-proj-"));
  const home = await mkdtemp(join(tmpdir(), "harnesside-doctor-ro-home-"));
  // doctor 가 읽을 만한 실제 입력을 하나씩 둔다: 설정(비밀 포함) · src · dist.
  await mkdir(join(project, ".harnesside"), { recursive: true });
  await writeFile(
    join(project, ".harnesside", "config.yaml"),
    `schemaVersion: 2\nllama:\n  port: 8080\napiKey: ${SECRET}\n`,
    "utf8",
  );
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await mkdir(join(project, "dist"), { recursive: true });
  await writeFile(join(project, "dist", "a.js"), "export const a = 1;\n", "utf8");

  const before = await snapshot(project, home);
  const { stdout, status } = runDoctor(project, home);
  const after = await snapshot(project, home);

  assert.equal(status, 0, `doctor 가 실패했다 — 출력을 먼저 봐야 한다:\n${stdout}`);

  const changed = before.files.filter((f, i) => after.files[i] !== f);
  const added = after.files.filter((f) => !before.files.includes(f));
  const removed = before.files.filter((f) => !after.files.includes(f));
  assert.deepEqual(
    { changed, added, removed },
    { changed: [], added: [], removed: [] },
    "doctor 가 파일시스템을 바꿨다 — 이 요구(읽기 전용)가 실패다",
  );

  // 포트는 **비교가 가능할 때만** 한다. `ss`/`netstat` 이 없으면 조용히 통과시키지 않는다.
  // (그리고 `doctor` 가 보는 세 포트만 본다 — 위 주석의 실측 계기를 읽을 것.)
  if (before.ports === null) {
    // 미측정 — 이 저장소 규칙상 "미측정"이라고 말해야 한다.
    assert.match(stdout, /미확인|판단 불가/, "포트 조회 실패를 말하지 않는다");
    return;
  }
  assert.deepEqual(after.ports, before.ports, "doctor 가 포트를 열거나 닫았다");
});

test("doctor 출력에 **비밀 값은 한 번도 안 나온다** — 이름만 나온다", async () => {
  const project = await mkdtemp(join(tmpdir(), "harnesside-doctor-secret-proj-"));
  const home = await mkdtemp(join(tmpdir(), "harnesside-doctor-secret-home-"));
  await mkdir(join(project, ".harnesside"), { recursive: true });
  await writeFile(
    join(project, ".harnesside", "config.yaml"),
    `schemaVersion: 2\nllama:\n  port: 8080\napiKey: ${SECRET}\n`,
    "utf8",
  );
  const { stdout } = runDoctor(project, home);
  assert.ok(!stdout.includes(SECRET), "진단 출력에 비밀 값이 찍혔다 — 스크린샷·이슈에 붙이는 출력이다");
  assert.match(stdout, /apiKey/, "비밀의 **이름**조차 안 보인다 — 무엇이 들어있는지 알 수 없다");
  assert.match(stdout, /값은 출력하지 않음/, "값을 뺀 이유가 출력에 없다");
});

test("doctor 출력에는 **다음에 할 수 있는 행동**이 1개 이상 있다 (요구)", async () => {
  const project = await mkdtemp(join(tmpdir(), "harnesside-doctor-act-proj-"));
  const home = await mkdtemp(join(tmpdir(), "harnesside-doctor-act-home-"));
  const { stdout, status } = runDoctor(project, home);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /다음에 할 수 있는 것/, "행동 섹션이 없다");
  const section = stdout.slice(stdout.indexOf("다음에 할 수 있는 것"));
  const items = section
    .split("\n")
    .slice(1)
    .filter((l) => l.trim().length > 0);
  assert.ok(items.length >= 1, "행동 항목이 0개다 — 요구가 실패한다");
});

test("doctor 출력에 **요구된 7개 판정 축**이 실제로 보인다", async () => {
  const project = await mkdtemp(join(tmpdir(), "harnesside-doctor-axes-proj-"));
  const home = await mkdtemp(join(tmpdir(), "harnesside-doctor-axes-home-"));
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const { stdout } = runDoctor(project, home);
  for (const axis of [
    "Node",                    // engines 대조
    "단말 capability",          // getCapabilities 재사용
    "단말",                    // 알려짐/미지원/판단불가
    "웹 IDE (7317)",           // 포트 3상태
    "llama-server (8080)",
    "Chrome CDP (9222)",
    "dist 최신성",
    "설정",
    "모델 파일",
  ]) {
    assert.ok(stdout.includes(axis), `출력에 "${axis}" 항목이 없다 — 요구 항목이 빠졌다`);
  }
  // 미확인은 **숫자로** 남는다 — "0 인지 1 인지" 가 아니라 "몇 개를 못 잤는지".
  assert.match(stdout, /미확인|판단 불가/, "모르는 것이 설명되지 않고 사라졌다");
});
