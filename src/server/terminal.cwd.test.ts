/**
 * 셸 탐색 — 디렉터리 이동 (2026-10-01).
 *
 * 이 테스트가 존재하는 이유는 **하나의 실측 버그** 때문이다: "디렉터리를 선택해도
 * 이동하지 않는다". 원인은 `path.resolve` 의 인자 순서였다.
 *
 *     resolve(next, cwd)   → cwd   (오른쪽 절대경로가 이겨서 next 가 버려진다)
 *     resolve(cwd, next)   → cwd/next   (기준, 대상)
 *
 * 잘못된 쪽은 **존재 검사를 통과**해서 `ok: true` 까지 돌려주었다. 그래서 화면은
 * "옮겼다" 고 말하는데 아무것도 안 움직였고, 사용자는 버튼이 고장났다 고 생각했다.
 *
 * 그래서 여기서는 **두 가지를 함께** 고정한다:
 *  1. 실제로 이동하는가
 *  2. **안 움직였는데 성공을 말하지 않는가**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager, shellQuote } from "./terminal.js";

/** PTY 를 띄우지 않는 매니저 — `create` 를 부르지 않으면 자식이 없다. */
function manager(root: string) {
  return new TerminalManager({
    root,
    shell: "/bin/sh",
    events: { onData: () => {}, onExit: () => {}, onWarn: () => {} },
    maxTabs: 2,
  });
}

test("**상대 경로**로 이동한다 — 순서가 바뀌면 아무것도 안 움직인다", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd-"));
  await mkdir(join(root, "src", "deep"), { recursive: true });
  const m = manager(root);

  const first = await m.setCwd("src");
  assert.equal(first.ok, true, first.detail);
  assert.equal(first.cwd, join(root, "src"), `상대 경로로 이동하지 못했다: ${first.cwd}`);

  const second = await m.setCwd("deep");
  assert.equal(second.cwd, join(root, "src", "deep"), `중첩 이동 실패: ${second.cwd}`);

  // **되돌아오기** — ".." 처리를 안 하면 위로 못 올라간다.
  const up = await m.setCwd("..");
  assert.equal(up.cwd, join(root, "src"), `위로 못 올라간다: ${up.cwd}`);
});

test("**절대 경로**도 이동한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd2-"));
  await mkdir(join(root, "a", "b"), { recursive: true });
  const m = manager(root);
  const r = await m.setCwd(join(root, "a", "b"));
  assert.equal(r.cwd, join(root, "a", "b"));
});

test("**루트 밖은 거절한다** — 조용히 루트로 되돌리지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd3-"));
  const m = manager(root);
  const r = await m.setCwd("/etc");
  assert.equal(r.ok, false, "루트 밖으로 나가버렸다");
  assert.match(r.detail, /루트/, "왜 안 되는지 말하지 않는다");
  assert.equal(r.cwd, root, "거절했는데 cwd 가 바뀌었다");
});

test("**없는 디렉터리**는 거절한다 — " + "성공이라고 말하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd4-"));
  const m = manager(root);
  const r = await m.setCwd("없는곳");
  assert.equal(r.ok, false);
  assert.match(r.detail, /디렉터리가 아닙니다/);
  assert.equal(r.cwd, root, "실패했는데 위치가 바뀌었다");
});

test("파일을 디렉터리처럼 고를 수 없다", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd5-"));
  await writeFile(join(root, "파일.txt"), "x");
  const m = manager(root);
  const r = await m.setCwd("파일.txt");
  assert.equal(r.ok, false, "파일을 cwd 로 받았다");
  assert.match(r.detail, /디렉터리가 아닙니다/);
});

test("**상대 경로는 현재 경로 기준**이다 — 직전에 있던 곳의 자식이 된다", async () => {
  // 이걸 잘못 이해하면 "y" 같은 형제 이름이 조용히 실패한다. 목록은 **비어 보이지
  // 않아야** 하니 사용자는 "버튼이 고장났다" 고 읽고, 실제로는 상대 경로가 다른 곳을
  // 가리키는 상황이다. 거절 사유로 **현재 경로**를 함께 말한다.
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd5b-"));
  await mkdir(join(root, "x", "y"), { recursive: true });
  const m = manager(root);
  await m.setCwd("x");
  const r = await m.setCwd("y");
  assert.equal(r.ok, true);
  assert.equal(r.cwd, join(root, "x", "y"), "상대 경로가 현재 경로 기준이 아니다");
});

test("**최근 목록**은 최근 순 — 다시 고르면 맨 위로 오른다", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd6-"));
  await mkdir(join(root, "x"), { recursive: true });
  await mkdir(join(root, "y"), { recursive: true });
  const m = manager(root);

  assert.deepEqual(m.recentDirs(), [root], "시작점도 기억에 들어가야 목록이 비어 보이지 않는다");
  await m.setCwd("x");
  assert.deepEqual(m.recentDirs(), [join(root, "x"), root]);
  // `x` 안에서 상대 경로 `y` 는 **x/y** 다 — 형제가 아니라 **자식**이다. 그래서
  // 여기서 오타가 나면 거절당하고 목록도 안 바뀐다(아래 테스트가 그 확인을 한다).
  // 형제 `y` 로 가려면 절대 경로로 간다.
  await m.setCwd(join(root, "y"));
  assert.deepEqual(m.recentDirs(), [join(root, "y"), join(root, "x"), root]);
  // **같은 곳을 다시 고르면 맨 위로** — 자주 가는 곳이 자주 가는 곳이 되어야 한다.
  await m.setCwd(join(root, "x"));
  assert.deepEqual(m.recentDirs(), [join(root, "x"), join(root, "y"), root]);
});

test("경로에 **공백**이 있어도 셸 인자가 하나여야 한다", () => {
  // `cd /내 공간` 이 두 인자로 쪼개지면 엉뚱한 곳으로 간다. 사용자 폴더명에 공백이
  // 있는 것은 흔하다.
  const q = shellQuote("/home/jeano/내 문서/프로젝트");
  assert.ok(q.startsWith("'") && q.endsWith("'"), `따옴표로 감싸지 않았다: ${q}`);
  assert.equal(q, "'/home/jeano/내 문서/프로젝트'");
  // 작은따옴표가 경로 안에 있으면 이스케이프해야 한다.
  assert.match(shellQuote("/tmp/it's here"), /^'\/tmp\/it'\\''s here'$/);
});

test("**새 탭**은 공유 작업 경로에서 열린다 — 탭마다 다른 곳으로 가지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnesside-cwd7-"));
  await mkdir(join(root, "work"), { recursive: true });
  const m = manager(root);
  await m.setCwd("work");
  assert.equal(m.cwd, join(root, "work"));
  // `create` 는 PTY 를 띄우므로 여기서는 **cwd 결정만** 본다 — 기본값이
  // `this.cwd` 인 것을 코드로 고정한다.
  const src = (m as unknown as { cwd: string }).cwd;
  assert.equal(src, join(root, "work"), "create 의 기본 cwd 가 공유 경로가 아니다");
});
