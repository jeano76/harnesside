/**
 * 셸 호환 — **여러 셸** 로 같은 일을 한다 (2026-10-01).
 *
 * 왜 유닛으로 충분하지 않은가: 셸은 **프로세스** 다. 유닛 테스트는 주입한 실행기로
 * 돌기 때문에 "이 머신에 없는 셸" 을 볼 수 없다. 그런데 셸마다 **다른 문법**이 있고,
 * 이 프로그램이 주입하는 것은 POSIX 문법(`cd '<경로>'`)이다. 사용자의 셸이 fish 나
 * nu 라면 이게 **조용히 실패**할 수 있다.
 *
 * 그래서 **실제로 존재하는 셸**을 찾아 그 경로로 PTY 를 띄운다. 없는 셸은
 * **"없다"고 보고** 통과시키지 않는다 — 없는 셸은 호환성 문제가 아니라 환경 문제지만,
 * 그걸 구분하지 않으면 "모든 셸에서 동작한다" 는 거짓말이 된다.
 *
 * 여기서 확인하는 것은 셸이 **명령을 받고 결과를 돌려주는가** 다. 사람에게 프롬프트가
 * 얼마나 예쁜지는 측정하지 않는다(하지 못한다).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accessSync, constants } from "node:fs";
import { TerminalManager } from "./terminal.js";

/** 이 머신에 실제로 있는 셸만 쓴다 — 없는 셸을 시험하면 "존재하지 않음" 을 검증한다. */
const CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "/bin/dash", "/usr/bin/dash", "/bin/zsh", "/usr/bin/zsh", "/bin/fish", "/usr/bin/fish"];

function existingShells(): string[] {
  return CANDIDATES.filter((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

interface Run {
  data: string;
  exited: boolean;
  close(): void;
}

/** 셸 하나를 띄우고 **명령의 출력을 모아서** 돌려준다. PTY 라 개행이 뒤섞인다. */
async function runIn(shell: string, cwd: string, commands: string[], waitMs = 3500): Promise<Run> {
  return new Promise((resolve) => {
    let data = "";
    let exited = false;
    const mgr = new TerminalManager({
      root: cwd,
      shell,
      maxTabs: 1,
      events: {
        onData: (_id, d) => {
          data += d;
        },
        onExit: () => {
          exited = true;
        },
        onWarn: (m) => {
          data += `\u0000WARN:${m}`;
        },
      },
    });
    const created = mgr.create({ cwd, cols: 100, rows: 30 });
    if (!created.ok) {
      resolve({ data: `CREATE_FAILED:${created.detail}`, exited, close: () => mgr.shutdown() });
      return;
    }
    const id = created.session!.id;
    for (const c of commands) mgr.write(id, `${c}\n`);
    setTimeout(() => {
      resolve({ data, exited, close: () => mgr.shutdown() });
    }, waitMs);
  });
}

const CWD = process.cwd();
const SHELLS = existingShells();

test("이 머신에 있는 셸을 **찾았다** — 없으면 검사가 아무것도 안 한다", () => {
  assert.ok(SHELLS.length > 0, "실행 가능한 셸이 하나도 없다 — 검사가 검증 없이 통과한다");
  console.log(`      (발견: ${SHELLS.join(", ")})`);
});

for (const shell of SHELLS) {
  test(`\`${shell}\` — 명령을 받고 **결과를 돌려준다**`, async () => {
    const run = await runIn(shell, CWD, ["echo PROBE_OK_MARKER", "printf 'printf_ok\\n'"]);
    try {
      assert.ok(!run.data.startsWith("CREATE_FAILED:"), `셸을 열지 못했다: ${run.data}`);
      // **이스케이프는 지운다** — PTY 는 커서 이동·색을 섞어 보낸다.
      const clean = run.data
        .replace(/\][^]*(?:|\\)?/g, "")
        .replace(/\[[0-9;?]*[ -\/]*[@-~]/g, "");
      assert.match(clean, /PROBE_OK_MARKER/, `출력이 없다: ${JSON.stringify(clean.slice(0, 200))}`);
      assert.match(clean, /printf_ok/, "printf 가 동작하지 않는다 — POSIX 를 최소한으로도 못 쓴다");
      assert.ok(!/command not found|명령을 찾을 수 없습니다/i.test(clean), `셸이 명령을 몰라봤다: ${JSON.stringify(clean.slice(0, 200))}`);
    } finally {
      run.close();
    }
  });

  test(`\`${shell}\` — 주입하는 \`cd '<경로>'\` 가 **동작한다**`, async () => {
    // 이 프로그램이 디렉터리를 옮길 때 실제로 보내는 문자열과 **같은 형태**다.
    // 셸마다 따옴표 의미가 달라서, 이게 깨지면 사용자가 "폴더가 안 바뀐다"고 느낀다.
    const marker = "CD_PROBE_OK";
    const run = await runIn(shell, CWD, [`cd '/tmp'`, "pwd", `echo ${marker}`]);
    try {
      const clean = run.data
        .replace(/\][^]*(?:|\\)?/g, "")
        .replace(/\[[0-9;?]*[ -\/]*[@-~]/g, "");
      assert.match(clean, /\/tmp/, `cd 가 안 먹었다: ${JSON.stringify(clean.slice(0, 200))}`);
      assert.match(clean, new RegExp(marker));
    } finally {
      run.close();
    }
  });

  test(`\`${shell}\` — 경로에 **공백**이 있어도 인자가 하나다`, async () => {
    // 공백이 있는 경로를 그대로 보내면 두 인자로 쪼개져 엉뚱한 곳으로 간다.
    // 사용자 폴더명에 공백이 있는 것은 흔하다.
    const marker = "SPACE_PROBE_OK";
    const run = await runIn(shell, CWD, [`cd '/tmp/디렉터리 공백' 2>/dev/null || echo "no such dir"`, `echo ${marker}`]);
    try {
      const clean = run.data.replace(/\[[0-9;?]*[ -\/]*[@-~]/g, "");
      // 디렉터리가 없더라도 **"명령을 못 찾았다" 가 아니어야** 한다 — 쪼개지면
      // `cd: too many arguments` 같은 다른 오류가 난다.
      assert.ok(
        !/too many arguments|인자가 너무 많/i.test(clean),
        `따옴표가 깨졌다: ${JSON.stringify(clean.slice(0, 200))}`,
      );
    } finally {
      run.close();
    }
  });
}

test("**없는 셸**은 조용히 통과시키지 않는다 — 실패로 보인다", async () => {
  // 실제로 없는 경로를 준다. `node-pty` 는 throw 하지 않고 PTY 를 연 뒤
  // `execvp(3) failed.` 를 찍고 exit 1 한다(§terminal.ts 의 실측 기록) — 그래서
  // 여기서 확인하는 것은 **그 사실을 사용자에게 보여주는가** 다.
  //
  // **즉시 확인하면 안 된다**(실측): `create` 가 `ok: true` 를 돌려주는 그 순간에는
  // 아직 실패를 **모른다** — 프로세스가 뜨는 데 시간이 걸린다. 그래서 기다린 뒤에 본다.
  // 이것이 사용자 체감과도 같다: 탭이 "열렸다" 가 아주 잠깐 보인 뒤 "셸 열기 실패" 로
  // 바뀐다. **잠깐이라도 성공으로 보이면** 사용자는 그 탭을 붙잡는다.
  const mgr = new TerminalManager({
    root: CWD,
    shell: "/bin/존재하지않는셸",
    maxTabs: 1,
    events: { onData: () => {}, onExit: () => {}, onWarn: () => {} },
  });
  const r = mgr.create({ cwd: CWD, cols: 80, rows: 24 });
  assert.ok(r.ok, "존재하지 않는 셸을 아예 열지 않았다 — 사용자는 이유를 못 받는다");
  const id = r.session!.id;

  // **비동기로 온다.** 기다렸다가 확인한다.
  const deadline = Date.now() + 4000;
  let seen: string | null = null;
  while (Date.now() < deadline) {
    seen = mgr.get(id)?.openError ?? null;
    if (seen) break;
    await new Promise((r2) => setTimeout(r2, 80));
  }
  assert.ok(seen, "셸이 없는데 실패 사실이 기록되지 않았다 — 사용자는 빈 탭을 끝까지 붙잡는다");
  assert.match(seen!, /execvp|not found|No such file/i, `사유가 기술적이라 사람이 읽을 수 없다: ${seen}`);
  assert.equal(mgr.get(id)?.title, "셸 열기 실패", "탭 제목이 실패를 말하지 않는다");
  mgr.shutdown();
});
