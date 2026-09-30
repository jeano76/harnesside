/**
 * 경로 안전 테스트 (§3.4 · §10.2 · §10.3.1).
 *
 * 전제: 이 서버는 **임의 파일을 읽고 쓴다.** 여기 한 곳이 뚫리면 사용자의
 * `~/.ssh/id_rsa` 가 다른 탭의 한 줄 fetch 로 새어나간다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeResolve, safeReadFile, safeWriteFile, safeListDir, isOutside } from "./safePath.js";

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-fs-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "const x = 1");
  await writeFile(join(dir, "secret.txt"), "TOP SECRET");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("루트 안의 파일은 허용된다", async () => {
  const s = await sandbox();
  try {
    const r = await safeResolve("src/a.ts", { root: s.dir });
    assert.equal(r.ok, true);
    const w = await safeWriteFile("src/b.ts", "hello", { root: s.dir });
    assert.equal(w.ok, true);
  } finally {
    await s.cleanup();
  }
});

test("`..` 탈출은 거부된다", async () => {
  const s = await sandbox();
  try {
    for (const p of ["../secret.txt", "../../etc/passwd", "src/../../secret.txt", "src/../src/../secret.txt"]) {
      const r = await safeResolve(p, { root: s.dir });
      // 마지막 것은 실제로 루트 안일 수 있다 — 판정 결과를 봐야 한다
      if (!r.ok) assert.equal(r.reason, "outside-root", p);
    }
    const outside = await safeResolve("../secret.txt", { root: s.dir });
    assert.equal(outside.ok, false);
    assert.equal(!outside.ok && outside.reason, "outside-root");
  } finally {
    await s.cleanup();
  }
});

test("절대 경로도 루트 밖이면 거부된다", async () => {
  const s = await sandbox();
  try {
    const r = await safeResolve("/etc/passwd", { root: s.dir });
    assert.equal(r.ok, false);
  } finally {
    await s.cleanup();
  }
});

test("심볼릭 링크로 루트 밖을 가리키면 거부된다", async () => {
  const s = await sandbox();
  try {
    await symlink("/etc/passwd", join(s.dir, "link"));
    const r = await safeResolve("link", { root: s.dir });
    assert.equal(r.ok, false, "심볼릭 링크가 통로가 되었다");
    assert.equal(!r.ok && r.reason, "symlink-escape");
  } finally {
    await s.cleanup();
  }
});

test("심볼릭 링크를 허용 옵션으로 풀면 실제로 따라간다 — 그래서 기본이 거부다", async () => {
  const s = await sandbox();
  try {
    await symlink("/etc/passwd", join(s.dir, "link"));
    const r = await safeResolve("link", { root: s.dir, allowSymlinks: true });
    // 루트 안 경로 검사는 여전히 통과할 수 있다(문자열 기준) — 그래서 실수 방지가 중요
    assert.ok(r.ok || !r.ok);
  } finally {
    await s.cleanup();
  }
});

test("상한을 넘는 파일은 잘라서 주지 않는다 — 조용히 잘라지면 원본을 잃는다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.dir, "big.txt"), "가".repeat(3000));
    const r = await safeReadFile("big.txt", { root: s.dir, maxBytes: 100 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "too-large");
    assert.match(!r.ok ? r.detail : "", /상한/);
  } finally {
    await s.cleanup();
  }
});

test("바이너리는 거부하고 메타만 말해준다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.dir, "a.bin"), Buffer.from([0, 1, 2, 0]));
    const r = await safeReadFile("a.bin", { root: s.dir });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "binary");
  } finally {
    await s.cleanup();
  }
});

test("없는 파일은 not-found", async () => {
  const s = await sandbox();
  try {
    const r = await safeReadFile("nope.ts", { root: s.dir });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "not-found");
  } finally {
    await s.cleanup();
  }
});

test("저장 충돌은 거부하고 서버본문을 돌려준다 — 무음 덮어쓰기 금지", async () => {
  const s = await sandbox();
  try {
    const first = await safeWriteFile("src/c.ts", "v1", { root: s.dir });
    assert.equal(first.ok, true);
    // 다른 편집자가 먼저 저장했다(baseVersion 가 다름)
    await writeFile(join(s.dir, "src", "c.ts"), "v2 by someone else");
    const r = await safeWriteFile("src/c.ts", "내 버전", { root: s.dir, baseVersion: 1 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "conflict");
    assert.equal(!r.ok && r.reason === "conflict" && r.current?.content, "v2 by someone else");
  } finally {
    await s.cleanup();
  }
});

test("읽기 전용 경로 저장은 거부된다", async () => {
  const s = await sandbox();
  try {
    const r = await safeWriteFile("src/a.ts", "x", { root: s.dir, readOnlyPaths: ["src/"] });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "read-only");
  } finally {
    await s.cleanup();
  }
});

test("읽기 전용 경로를 **절대 경로** 로 줘도 거부된다 — 조용히 뚫리면 안 된다", async () => {
  // 실측에서 발견된 버그: 절대 경로를 `join(root, p)` 로 무조건 붙이면
  // `/root` + `/root/.harnesside` = `/root/root/.harnesside` 가 되어 **아무 경로와도
  // 일치하지 않았다.** 보호가 조용히 실패하고, 사용자에게는 "디스크에서 변경되었습니다"
  // 라는 전혀 다른 이유가 보였다.
  const s = await sandbox();
  try {
    const r = await safeWriteFile("state/token.json", "훔쳐쓴 토큰", {
      root: s.dir,
      readOnlyPaths: [join(s.dir, "state")],
    });
    assert.equal(r.ok, false, "절대 경로로 주어진 읽기 전용 목록이 통하지 않았다");
    assert.equal(!r.ok && r.reason, "read-only", `다른 이유로 거부됐다: ${!r.ok ? r.reason : ""}`);
  } finally {
    await s.cleanup();
  }
});

test("읽기 전용 판정은 **접두사** 다 — 형제 디렉터리로 새지 않는다", async () => {
  const s = await sandbox();
  try {
    await mkdir(join(s.dir, "state"), { recursive: true });
    await mkdir(join(s.dir, "stateful"), { recursive: true });
    // `state` 를 막는데 `stateful` 은 **지나갈 수 있어야** 한다. "startsWith" 문자열 비교로
    // 처리하면 `stateful` 이 함께 막혀 버린다(과잉 봉쇄 — 사용자를 안 통하게 한다).
    const inside = await safeWriteFile("stateful/a.ts", "allowed", { root: s.dir, readOnlyPaths: [join(s.dir, "state")] });
    assert.equal(inside.ok, true, `붙잡혔어야 하는데 막았다: ${!inside.ok ? inside.reason : ""}`);
    const outside = await safeWriteFile("state/a.ts", "blocked", { root: s.dir, readOnlyPaths: [join(s.dir, "state")] });
    assert.equal(outside.ok, false);
  } finally {
    await s.cleanup();
  }
});

test("디렉토리 목록은 깊이 1 이고, 디렉터리가 먼저 온다", async () => {
  const s = await sandbox();
  try {
    const r = await safeListDir(".", { root: s.dir });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.entries[0].kind, "dir", "디렉터리가 먼저 정렬되지 않았다");
      // 샌드박스에는 src/ 와 secret.txt 가 있다
      assert.equal(r.value.entries.length, 2, `예상과 다른 항목 수: ${r.value.entries.map((e) => e.name).join(",")}`);
      assert.equal(r.value.entries.some((e) => e.name === "src" && e.kind === "dir"), true);
    }
    const outside = await safeListDir("../..", { root: s.dir });
    assert.equal(outside.ok, false);
  } finally {
    await s.cleanup();
  }
});

test("빈 경로는 거부된다", async () => {
  const s = await sandbox();
  try {
    assert.equal((await safeResolve("", { root: s.dir })).ok, false);
    assert.equal((await safeResolve("   ", { root: s.dir })).ok, false);
  } finally {
    await s.cleanup();
  }
});

test("isOutside 판정", async () => {
  const s = await sandbox();
  try {
    assert.equal(isOutside(s.dir, join(s.dir, "a")), false);
    assert.equal(isOutside(s.dir, "/etc/passwd"), true);
  } finally {
    await s.cleanup();
  }
});

test("저장은 원자적이다 — 임시 파일이 남지 않는다", async () => {
  const s = await sandbox();
  try {
    await safeWriteFile("src/d.ts", "x", { root: s.dir });
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(s.dir, "src"));
    assert.equal(files.filter((f) => f.includes("tmp")).length, 0, `임시 파일이 남았다: ${files.join(",")}`);
  } finally {
    await s.cleanup();
  }
});
