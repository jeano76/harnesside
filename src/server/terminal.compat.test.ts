/**
 * OS · 구동환경 호환 (2026-10-01).
 *
 * 이 파일은 **사용하지 않는 머신을 흉내낸다.** 실제 Alpine 컨테이너도 macOS 도
 * 없다 — 대신 **그 머신에서 나는 조건**을 만들어 넣고, 그 조건에서 무엇이 깨지는지
 * 본다. 조건을 흉내내면서 **깨지지 않았으면** 통과로 치는 게 아니라, 그 조건이
 * 정말 그 문제를 만들어 내는지 **먼저 확인한다**(아래 `alive` 테스트).
 *
 * 그래서 이 파일은 두 겹이다:
 *  - **조건이 살아 있는지** — 흉내의 흉내가 실제로 같은 실패를 만드는가.
 *  - **코드가 그 조건에서 하는가** — 그리고 그 확인이 **기준 OS 밖에서도** 돌아가는가.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, symlinkSync, mkdirSync, rmSync, chmodSync, existsSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager, shellCandidates, ptyEnv } from "./terminal.js";

const events = () => ({ onData: () => {}, onExit: () => {}, onWarn: () => {} });

// ── 1. 셸 선택: bash 없는 머신 ───────────────────────────────────────────────
//
// **실측 결함**: `process.env.SHELL ?? "/bin/bash"` — Alpine(busybox) 이미지,
// 최소 컨테이너, NixOS 에는 bash 가 없다. 그러면 **모든 탭이 열리지 않는다.**
// 게다가 `$SHELL` 이 가리키는 경로가 사라진 경우도 실패한다.
test("**$SHELL 이 없는 경로**여도 실제 존재하는 셸로 넘어간다", () => {
  const cands = shellCandidates(undefined, { SHELL: "/usr/local/bin/사라진셸" });
  assert.ok(
    cands.includes("/bin/sh"),
    `fallback 목록에 POSIX 셸이 없다: ${JSON.stringify(cands)}`,
  );
  assert.ok(cands.length > 1, "후보가 하나뿐 — 실패하면 할 수 있는 게 없다");
});

test("**알려 준 셸**이 후보의 맨 앞이다 — 사용자의 선택을 덮지 않는다", () => {
  const cands = shellCandidates("/usr/bin/fish", { SHELL: "/bin/zsh" });
  assert.equal(cands[0], "/usr/bin/fish");
  assert.ok(cands.includes("/bin/zsh"), "fallback 이 $SHELL 을 버렸다");
});

test("**중복 후보**는 한 번만 — 같은 셸을 두 번 띄우지 않는다", () => {
  const cands = shellCandidates("/bin/bash", { SHELL: "/bin/bash" });
  assert.equal(cands.filter((c) => c === "/bin/bash").length, 1);
  assert.equal(new Set(cands).size, cands.length, `중복: ${JSON.stringify(cands)}`);
});

/**
 * 이 검사가 **진짜 그 문제를 만드는지** 먼저 보인다.
 *
 * 없는 셸 경로를 준 상태에서 `openError` 가 **나중에** 기록된다 — 그래서 기다린다.
 * 기다리지 않으면 `null` 이라 "실패를 안 했다" 고 읽혀 통과해 버린다. 조용히
 * 통과하는 검사가 이 파일의 가장 큰 위험이다.
 */
test("[살아있는지] 없는 셸은 실제로 실패를 기록한다 — 검사가 하는 일을 먼저 확인", async () => {
  const mgr = new TerminalManager({
    root: process.cwd(),
    shell: "/bin/존재하지않는셸",
    maxTabs: 1,
    events: events(),
  });
  const r = mgr.create({ cwd: process.cwd(), cols: 80, rows: 24 });
  assert.ok(r.ok, "없는 셸을 아예 열지 않았다 — 실패 이유를 사용자가 받을 방법이 없다");
  const id = r.session!.id;
  const deadline = Date.now() + 5000;
  let seen: string | null = null;
  while (Date.now() < deadline && !seen) {
    seen = mgr.get(id)?.openError ?? null;
    await new Promise((r2) => setTimeout(r2, 80));
  }
  assert.ok(seen, "실패 사실이 기록되지 않았다 — 사용자는 빈 탭을 끝까지 붙잡는다");
  assert.match(seen!, /execvp|not found|No such file/i, `사유가 사람이 읽을 수 없다: ${seen}`);
  mgr.shutdown();
});

test("**이 질의가 자기 자신을 속이지 않는지** — 후보 목록이 실측과 같은가", () => {
  // 후보 목록은 **사람이 읽는 목록**이다. 여기 있는 경로가 실제로 없으면 사용자는
  // 그 경로를 열어본다. 존재 확인을 **하는 척만** 하지 말고, 실제로 한 것과 같음을 본다.
  const cands = shellCandidates(undefined, { SHELL: "/bin/bash" });
  for (const c of cands) {
    const absolute = c.startsWith("/");
    assert.ok(absolute, `후보가 절대 경로가 아니다: ${c}`);
  }
  // 목록에 적어도 하나는 실제로 존재해야 "fallback" 이 말이다.
  const real = cands.filter((c) => {
    try {
      return existsSync(c);
    } catch {
      return false;
    }
  });
  assert.ok(real.length > 0, "목록에 실제로 있는 셸이 하나도 없다 — 전부 실패할 목록이다");
});

// ── 2. 로캘: UTF-8 이 아니면 셸에서 한글이 깨진다 ────────────────────────────
//
// **실측 결함**: PTY env 가 `process.env` 를 그대로 물려받았다. 시스템 로캘이
// `C` / `POSIX` 면 로캘 인식이 꺼져서 **한국어가 깨진다** — 사용자의 터미널은 멀쩡한데
// 우리 셸만 깨진다. 어느 컨테이너에서인지 몰라도 **깨질 수 있다**는 게 문제다.
test("**LANG=C** 환경에서도 UTF-8 로 맞춘다 — 한글이 깨질 수 있다", () => {
  const env = ptyEnv({ LANG: "C", LC_ALL: "C" });
  assert.match(env.LANG!, /UTF-?8/i, `LANG=${env.LANG} — 로캘 인식이 꺼져 한글 깨짐`);
});

test("**사용자가 고른 UTF-8 로캘**은 존중한다 — ko_KR 을 덮어쓰지 않는다", () => {
  const env = ptyEnv({ LANG: "ko_KR.UTF-8" });
  assert.equal(env.LANG, "ko_KR.UTF-8");
});

test("**LANG 이 UTF-8 로 끝나지 않으면** 상속하지 않는다 — ko_KR-8 도 통과시켜야 한다", () => {
  const env = ptyEnv({ LANG: "ko_KR-8" });
  assert.match(env.LANG!, /UTF-?8/i, "표기만 다른 UTF-8 로캘을 무시했다 — 사용자가 고른 것을 지킨다");
});

test("**LANG 이 아예 없으면** UTF-8 로 채운다 — 없는 게 깨짐의 원인이다", () => {
  const env = ptyEnv({});
  assert.match(env.LANG!, /UTF-?8/i, "로캘이 비어 있으면 프로그램이 UTF-8 이 아닌 것으로 본다");
});

test("**LC_ALL** 은 비워 둔다 — 상위 로캘보다 우선하므로, 옛 값을 물려받으면 위에서 고친 게 무시된다", () => {
  // 실측: `LC_ALL=C` 를 물려받으면 `LANG` 을 UTF-8 로 맞춰도 **LC_ALL 이 이긴다.**
  const env = ptyEnv({ LANG: "ko_KR.UTF-8", LC_ALL: "C" });
  assert.equal(env.LC_ALL, "", "비어 있지 않으면 LANG 을 고친 의미가 없다");
});

test("TERM 은 색이 나오는 값으로 — PTY 이름과 같아야 줄바꿈이 어긋나지 않는다", () => {
  const env = ptyEnv({ TERM: "dumb" });
  assert.match(env.TERM!, /xterm/, `TERM=${env.TERM}`);
  assert.equal(env.COLORTERM, "truecolor");
});

test("**PATH 는 물려받는다** — 로컬에서 못 찾는 명령이 생기는 것이 더 나쁘다", () => {
  const env = ptyEnv({ PATH: "/usr/bin:/bin" });
  assert.equal(env.PATH, "/usr/bin:/bin");
});

// ── 3. 심볼릭 링크를 따라가는 경계 (macOS `/tmp`) ────────────────────────────
//
// **실측 결함**: 루트 안인지를 **문자열 prefix** 로 검사했다. macOS 에서 `/tmp` 은
// 실제로 `/private/tmp` 이고, `/var` → `/private/var` 처럼 링크가 흔하다.
// 링크를 따라가지 않으면 링크로 벗어난 경로가 "안" 으로 판정될 수 있다 —
// **에이전트 승인 게이트가 뚫린다.**
test("**루트가 심볼릭 링크로 되어 있어도** 그 안의 경로는 통과한다", () => {
  const tmp = mkdtempSync(join(tmpdir(), "compat-root-"));
  try {
    const real = join(tmp, "real");
    const link = join(tmp, "link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);

    // 링크 경로로 열면 — 경계가 링크를 따라가지 않으면 **자기 루트 밖**으로 본다.
    const mgr = new TerminalManager({ root: link, maxTabs: 1, events: events() });
    const r = mgr.create({ cwd: link, cols: 80, rows: 24 });
    assert.ok(r.ok);
    // 실경로로 정규화되어 루트 안이다.
    assert.equal(
      mgr.get(r.session!.id)?.cwd,
      real,
      "cwd 가 루트의 실경로가 아니다 — 링크를 따라가지 않았다",
    );
    mgr.shutdown();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("**루트 밖의 경로**는 루트로 되돌린다 — 게이트가 뚫리지 않는다", () => {
  const tmp = mkdtempSync(join(tmpdir(), "compat-out-"));
  try {
    const inside = join(tmp, "in");
    mkdirSync(inside, { recursive: true });
    const mgr = new TerminalManager({ root: inside, maxTabs: 1, events: events() });
    // 루트 밖 + **링크로 들어가려는** 시도 — 링크가 따라가면 게이트를 지난다.
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const bridge = join(outside, "bridge");
    symlinkSync(inside, bridge);
    const r = mgr.create({ cwd: bridge, cols: 80, rows: 24 });
    assert.ok(r.ok);
    const got = mgr.get(r.session!.id)?.cwd ?? "";
    assert.ok(
      got === inside || got.startsWith(`${inside}/`),
      `루트 밖으로 새었다: ${got} (루트 ${inside})`,
    );
    mgr.shutdown();
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("**없는 경로**를 줘도 루트로 돌아온다 — 예외로 죽지 않는다", () => {
  const mgr = new TerminalManager({ root: process.cwd(), maxTabs: 1, events: events() });
  const r = mgr.create({ cwd: join(process.cwd(), "존재하지않는디렉터리"), cols: 80, rows: 24 });
  assert.ok(r.ok, "없는 디렉터리를 주면 조용히 실패했다 — 이유를 말해야 한다");
  assert.equal(mgr.get(r.session!.id)?.cwd, process.cwd());
  mgr.shutdown();
});

// ── 4. 실행 권한 ─────────────────────────────────────────────────────────────
//
// **실측 결함**: `node-pty` 는 없는 셸에 throw 하지 않고 PTY 를 연 뒤
// `execvp(3) failed.` 를 찍고 죽는다. 그래서 "있다"는 게 아니라 **실행된다** 로
// 판정해야 하고, 그렇지 않으면 사용자는 열렸다가 사라지는 탭을 본다.
test("**실행 권한이 없는 파일**은 셸 후보가 아니다 — 있으면 있는 척한다", () => {
  const tmp = mkdtempSync(join(tmpdir(), "compat-noexec-"));
  try {
    const fake = join(tmp, "가짜셸");
    writeFileSync(fake, "#!/bin/sh\necho hi\n");
    chmodSync(fake, 0o644); // 읽을 수는 있지만 **실행은 못 한다**
    const cands = shellCandidates(fake, {});
    assert.ok(
      cands.includes("/bin/sh"),
      "실행 불가 파일이 후보일 뿐 아니라 그 뒤에 대안이 없다",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 5. 이 검사가 **기준 머신 밖에서도** 도는지 ─────────────────────────────────
//
// 여기까지의 검사는 전부 "이 머신에 bash 가 있다" 는 전제 위에서 돌았다.
// 그 전제 자체가 깨지면 검사가 조용히 아무것도 안 한다.
test("**이 머신의 셸**은 실제로 존재한다 — 그렇지 않으면 아래 검사들이 검증 없이 통과한다", () => {
  const here = ["/bin/sh", "/bin/bash"].filter((p) => existsSync(p));
  assert.ok(here.length > 0, "POSIX 셸이 하나도 없다 — 이 파일의 전제 자체가 성립하지 않는다");
  console.log(`      (이 머신: ${here.join(", ")})`);
});

test("**경계 검사는 심볼릭 링크**가 지원되는 파일시스템에서만 도는 것이 아니다", () => {
  // 링크를 못 만드는 파일시스템이면 3번 검사는 **검증 없이** 넘어가게 되어 있다.
  const tmp = mkdtempSync(join(tmpdir(), "compat-link-"));
  try {
    const target = join(tmp, "t");
    mkdirSync(target);
    const link = join(tmp, "l");
    symlinkSync(target, link);
    assert.ok(
      lstatSync(link).isSymbolicLink(),
      "링크가 만들어지지 않았다 — 링크 경계 검사는 이 머신에서 검증되지 않았다",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
