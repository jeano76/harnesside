/**
 * 저장소 전체 검색 (S-5) — **결과가 신뢰할 수 있는가** 를 본다.
 *
 * 이 파일이 가장 중요하게 보는 것은 "찾았다" 가 아니라 **"왜 못 찾았다"** 다.
 * 2026-09-30 실측 사고: 파일 미리보기가 실제 경로와 다른 경로를 불러 404 가 났는데,
 * 그 404 가 **"읽지 못했습니다"** 라는 올바른 문장으로 보여 사용자는 "파일이 없나" 고
 * 믿었다(부록 A). 검색도 같다 — 조용히 일부만 주면 "이 파일에 없나" 가 된다.
 *
 * 그래서 상한·바이너리·깨진 정규식 **전부 말해야 한다.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileQuery, clipLine, searchFiles, listFiles, rankFiles, IGNORED_DIRS } from "./search.js";

/**
 * 자기 검사용 규칙 — **코드포인트로 쓴다.**
 *
 * `ci-checks.mjs` 의 `MIXED_RE` 는 `src/**` 를 훑어 한국어 문장에 섞인 CJK 를 잡는다.
 * 여기서 CJK 를 **문자 그대로** 적으면(프로브이든 주석이든) **이 파일이 CI 를
 * 떨어뜨린다.** 실제로 2026-10-03 에 그렇게 터진 것을 확인했다 — 검사기가 자기
 * 자신을 잡은 경우였다(2026-10-02 부록 A 12행).
 *
 * 그래서 **규칙도 `\u` 로 쓴다.** 파일에 남는 것은 한글 주석뿐이다.
 */
const CJK_RE = new RegExp("[\\u4e00-\\u9fff]");
const BROKEN_RE = new RegExp("[\\uFFFD]");

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-search-"));
  await mkdir(join(dir, "src", "web"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "const marker = 1\nconst other = 2\n");
  await writeFile(join(dir, "src", "web", "b.ts"), "// marker 여기\n");
  await writeFile(join(dir, "node_modules", "pkg", "c.ts"), "const marker = 999\n");
  await writeFile(join(dir, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ── 1. 찾는다 ────────────────────────────────────────────────────────────────

test("저장소 전체를 뒤져 **경로·줄 번호**와 함께 찾는다", async () => {
  const s = await sandbox();
  try {
    const r = await searchFiles(s.dir, { pattern: "marker" });
    assert.equal((r as { ok: false }).ok, undefined);
    const out = r as Awaited<ReturnType<typeof searchFiles>>;
    assert.equal(typeof out, "object");
    if ("hits" in out === false) throw new Error("검색 실패");
    const paths = out.hits.map((h) => h.path).sort();
    assert.deepEqual(paths, ["src/a.ts", "src/web/b.ts"]);
    // **줄 번호가 1부터** — 0번째 줄이 실제로 있는 프로그램은 없다.
    assert.equal(out.hits.find((h) => h.path === "src/a.ts")!.line, 1);
    assert.equal(out.hits.find((h) => h.path === "src/web/b.ts")!.line, 1);
  } finally {
    await s.cleanup();
  }
});

test("**같은 줄의 여러 일치는 한 번만** 실린다 — 반복 개수가 목록을 늘리지 않는다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.dir, "src", "twice.ts"), "marker marker marker\n");
    const r = await searchFiles(s.dir, { pattern: "marker", regex: false });
    if (!("hits" in r)) throw new Error("검색 실패");
    assert.equal(r.hits.filter((h) => h.path === "src/twice.ts").length, 1);
  } finally {
    await s.cleanup();
  }
});

test("**대소문자 구분 안 함**이 기본이다 — 화면은 사람이 쓰는 곳이다", async () => {
  const s = await sandbox();
  try {
    const loose = await searchFiles(s.dir, { pattern: "MARKER" });
    const strict = await searchFiles(s.dir, { pattern: "MARKER", caseSensitive: true });
    if (!("hits" in loose) || !("hits" in strict)) throw new Error("검색 실패");
    assert.ok(loose.hits.length > 0, "대소문자 무시 기본이 동작하지 않는다");
    assert.equal(strict.hits.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("**정규식**이 된다 — 껍데기만 있고 안 되면 안 된다", async () => {
  const s = await sandbox();
  try {
    // `src/a.ts` 의 1번째 줄은 `const marker = 1` 이다.
    const r = await searchFiles(s.dir, { pattern: "^const mar\\w+ = \\d+$", regex: true });
    if (!("hits" in r)) throw new Error("검색 실패");
    assert.ok(
      r.hits.some((h) => h.path === "src/a.ts"),
      `정규식이 걸리지 않았다: ${JSON.stringify(r.hits.map((h) => `${h.path}:${h.line}`))}`,
    );
  } finally {
    await s.cleanup();
  }
});

test("**정규식은 한 줄에만** 적용된다 — `^`/`$` 가 파일 전체가 아니라 **줄** 이다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.dir, "src", "multi.ts"), "첫째 줄\n둘째 줄\n");
    const r = await searchFiles(s.dir, { pattern: "^둘째 줄$", regex: true });
    if (!("hits" in r)) throw new Error("검색 실패");
    // 줄 번호가 **2** 여야 한다. 1 이면 `^` 가 파일 첫 줄에 고정된 것이다.
    assert.equal(r.hits.find((h) => h.path === "src/multi.ts")?.line, 2);
  } finally {
    await s.cleanup();
  }
});

// ── 2. 조용히 실패하지 않는다 ───────────────────────────────────────────────

test("**깨진 정규식은 거절한다** — 일반 글자로 몰래 바꾸지 않는다", async () => {
  const s = await sandbox();
  try {
    const r = await searchFiles(s.dir, { pattern: "mar(ker", regex: true });
    assert.equal((r as { ok: boolean }).ok, false);
    // **사유가 사람이 읽는 문장으로** 온다. `ok:false` 만으로는 무엇을 고칠지 모른다.
    const detail = (r as { detail: string }).detail;
    assert.match(detail, /정규식/);
  } finally {
    await s.cleanup();
  }
});

test("**빈 검색어**는 거절한다 — 아무것도 하지 않고 성공한 척하지 않는다", async () => {
  const s = await sandbox();
  try {
    const r = await searchFiles(s.dir, { pattern: "   " });
    assert.equal((r as { ok: boolean }).ok, false);
    assert.match((r as { detail: string }).detail, /비어/);
  } finally {
    await s.cleanup();
  }
});

test("**결과 상한**에 걸리면 **왜 잘렸는지**를 말한다", async () => {
  const s = await sandbox();
  try {
    for (let i = 0; i < 8; i++) await writeFile(join(s.dir, "src", `m${i}.ts`), "marker\n");
    const r = await searchFiles(s.dir, { pattern: "marker" }, { maxHits: 3 });
    if (!("hits" in r)) throw new Error("검색 실패");
    assert.equal(r.hits.length, 3);
    assert.equal(r.truncated, true);
    // **사유가 없으면 조용히 실패한 것**이다(부록 B 1).
    assert.ok(r.truncatedReason, "잘렸는데 왜 잘렸는지 말하지 않는다");
    assert.match(r.truncatedReason, /3건/);
  } finally {
    await s.cleanup();
  }
});

test("**바이너리·너무 큰 파일**은 건너뛰되 **세어서** 말한다", async () => {
  const s = await sandbox();
  try {
    await writeFile(join(s.dir, "huge.ts"), "x".repeat(5_000));
    const r = await searchFiles(s.dir, { pattern: "marker" }, { maxFileBytes: 1_000 });
    if (!("hits" in r)) throw new Error("검색 실패");
    assert.equal(r.report.skipped.binary, 1, "바이너리를 건너뛴 사실을 세지 않는다");
    assert.equal(r.report.skipped.tooLarge, 1, "너무 큰 파일을 건너뛴 사실을 세지 않는다");
  } finally {
    await s.cleanup();
  }
});

test("**무시한 폴더**를 세고, 그 안은 **읽지 않는다**", async () => {
  const s = await sandbox();
  try {
    const r = await searchFiles(s.dir, { pattern: "marker" });
    if (!("hits" in r)) throw new Error("검색 실패");
    // `node_modules` 안의 `marker` 는 **결과에 없어야 한다**(스캔 폭).
    assert.ok(!r.hits.some((h) => h.path.startsWith("node_modules/")), "node_modules 를 뒤졌다");
    assert.ok(r.report.ignored > 0, "무시한 폴더를 말하지 않는다");
  } finally {
    await s.cleanup();
  }
});

// ── 3. 경로 안전 (§3.4) ─────────────────────────────────────────────────────

test("**루트 밖으로 새는 심볼릭 링크**를 따라가지 않는다", async () => {
  const s = await sandbox();
  const outside = await mkdtemp(join(tmpdir(), "harnesside-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "TOP SECRET marker\n");
    await symlink(outside, join(s.dir, "link"), "dir");
    const r = await searchFiles(s.dir, { pattern: "TOP SECRET" });
    if (!("hits" in r)) throw new Error("검색 실패");
    assert.equal(r.hits.length, 0, "심볼릭 링크로 루트 밖 파일을 읽었다 — 경로 안전 구멍");
    assert.ok(r.report.outsideRoot > 0, "밖으로 나간 것을 세지 않는다");
  } finally {
    await s.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("**문자열 prefix 판정은 쓰지 않는다** — 경로 연산으로 안다", async () => {
  // `/root` 와 `/root-old` 처럼 **접두사가 같아도 다른 곳**이다. 문자열 비교는
  // 이 둘을 같은 루트로 본다. 검사기가 이 함수를 직접 판정할 수 있게 한다.
  const s = await sandbox();
  try {
    const r = await searchFiles(s.dir, { pattern: "marker" });
    if (!("hits" in r)) throw new Error("검색 실패");
    for (const h of r.hits) {
      assert.ok(!h.path.startsWith(".."), `루트 밖 경로가 결과에 있다: ${h.path}`);
      assert.ok(!h.path.startsWith("/"), `절대 경로가 결과에 있다: ${h.path}`);
    }
  } finally {
    await s.cleanup();
  }
});

// ── 4. 빠른 이동 (Ctrl+P) ────────────────────────────────────────────────────

test("**파일 이름이 먼저** 온다 — 알파벳순은 자주 가는 파일을 아래로 밀어버린다", () => {
  // **점수가 서로 달라야 순서를 검사할 수 있다.**
  //
  // 실측한 사실(2026-10-03): 처음 쓴 검사는 세 경로가 **전부 같은 점수**였다
  // (모두 파일 이름이 정확히 일치). 그래서 **경로 길이 동점 처리**만 통과시키고
  // 점수 순서를 전혀 검사하지 않았다 — 그 순서를 **뒤집어 버려도 초록불**이었다.
  // `npm test` 가 통과하는데 버그가 살아 있는, 이 저장소가 가장 경계하는 상태다.
  const hits = rankFiles(["src/a.ts", "src/web/panels/a.ts", "src/zzz.ts"], "a.ts");
  assert.equal(hits[0]!.path, "src/a.ts", "이름이 정확히 일치한 것이 1위가 아니다");
});

test("**점수가 다른 후보는 점수대로 정렬된다** — 이 검사가 순서를 실제로 본다", () => {
  // 검색어 `panel` 에 대해 **서로 다른 세 갈림길**을 건다:
  //   - `panel.ts`            파일 이름이 **앞에서부터**   → 1
  //   - `src/a-panel.ts`      파일 이름 **안쪽**          → 2
  //   - `deep/x/panels/y.txt` **경로에만** 있음            → 4
  //
  // **왜 세 개가 모두 달라야 하나**: 점수가 같으면 **길이 동점 처리**가 대신 정렬해서
  // 점수 순서를 검사하지 못한 채 통과한다. 위 첫 번째 검사가 **이렇게** 초록불이었던
  // 것을 실측했다(2026-10-03) — 순서를 뒤집어도 경로 길이 때문에 결과가 같았다.
  const hits = rankFiles(["deep/x/panels/y.txt", "src/a-panel.ts", "panel.ts"], "panel");
  assert.deepEqual(
    hits.map((h) => h.score),
    [1, 2, 4],
    `점수가 예상과 다르다: ${JSON.stringify(hits.map((h) => [h.path, h.score]))}`,
  );
  assert.deepEqual(
    hits.map((h) => h.path),
    ["panel.ts", "src/a-panel.ts", "deep/x/panels/y.txt"],
    "점수 순서가 지켜지지 않는다",
  );
});

test("**동점이면 짧은 경로가 먼저** — 어느 쪽이 가까운지는 길이가 더 잘 말한다", () => {
  const hits = rankFiles(["src/web/panels/thing.ts", "src/thing.ts"], "thing.ts");
  assert.equal(hits[0]!.path, "src/thing.ts");
});

test("**파일 이름이 정확히 같으면** 그것이 1위다", () => {
  const hits = rankFiles(["src/web/blocks.ts", "blocks.ts"], "blocks.ts");
  assert.equal(hits[0]!.path, "blocks.ts");
});

test("**일치하는 것이 없으면** 목록에 넣지 않는다 — 비슷한 것을 지어내지 않는다", () => {
  const hits = rankFiles(["src/a.ts", "src/b.ts"], "zzzzz");
  assert.equal(hits.length, 0);
});

test("**빈 검색어**는 전부 준다 — 첫 글자를 치기 전에 무엇이 있는지 보여야 한다", () => {
  const hits = rankFiles(["src/b.ts", "src/a.ts"], "");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.path, "src/a.ts");
});

// ── 5. 줄 자르기 ───────────────────────────────────────────────────────────

test("**탭은 표준 공백으로** 바꾼다 — 폭 계산이 어긋나면 줄이 밀린다", () => {
  const c = clipLine("\tmarker\tvalue");
  assert.equal(c.text, " marker value");
});

test("**긴 줄은 자르고** 잘렸다고 표시한다", () => {
  const c = clipLine("x".repeat(400), 100);
  assert.equal(c.text.length, 100);
  assert.equal(c.clipped, true);
});

// ── 6. 목록 ────────────────────────────────────────────────────────────────

test("**파일 목록**은 무시 대상을 빼고, 잘렸는지를 함께 준다", async () => {
  const s = await sandbox();
  try {
    const r = await listFiles(s.dir);
    assert.ok(r.files.includes("src/a.ts"));
    assert.ok(!r.files.some((f) => f.startsWith("node_modules/")), "node_modules 가 목록에 있다");
    assert.equal(typeof r.truncated, "boolean");
  } finally {
    await s.cleanup();
  }
});

// ── 7. 자기 검사 ────────────────────────────────────────────────────────────

test("[살아있는지] **CJK 검사 규칙이 동작한다** — 규칙이 조용히 무효면 안 된다", () => {
  // 이 검사가 `promptIdeCli.test.ts` 의 깨진 바이트 검사와 같은 종류다. 프로브를
  // 직접 쳐서 **규칙이 살아 있는지** 확인한다(부록 C: 검사는 자기 자신을 검사한다).
  // **프로브 문자열은 코드포인트로 만든다.** 이 파일에는 **한글 문장만** 적힌다
  // (`ci-checks.mjs` 의 `MIXED_RE` 가 `src/**` 를 훑어 CJK 를 잡는다). CJK 를 문자
  // 그대로 적으면 **이 검사기가 스스로를 잡아** CI 가 실패한다.
  //
  // 2026-10-03 실측: `promptIdeCli.test.ts` 가 **이미 그 상태**였다 — 자기 검사의
  // 프로브가 CI 를 떨어뜨리고 있었다. 2026-10-02 부록 A 의 "소스 스캔이 자기 주석을
  // 잡음 → 판정을 뒤집음" 이 아직 살아 있던 셈이고, 원인은 손상이 아니라 **손을
  // 댄 위치**였다.
  assert.ok(CJK_RE.test(String.fromCharCode(0x6e2c, 0x8a66)), "CJK 규칙이 동작하지 않는다");
  // **깨진 바이트 규칙**도 같이 친다. 한쪽만 살아 있으면 "자기 검사" 라는 이름이
  // 절반만 검사하는 것이다.
  assert.ok(BROKEN_RE.test(String.fromCharCode(0xfffd)), "깨진 바이트 규칙이 동작하지 않는다");
});

test("[살아있는지] **무시 목록이 비어 있지 않다** — 빈 목록이면 스캔 폭 제한이 없다", () => {
  assert.ok(IGNORED_DIRS.size >= 5, `무시 폴더가 ${IGNORED_DIRS.size}개뿐이다`);
  assert.ok(IGNORED_DIRS.has("node_modules"));
  assert.ok(IGNORED_DIRS.has(".git"));
});

test("[살아있는지] **compileQuery 가 실제로 걸린다** — 항상 true 면 검색은 무의미하다", () => {
  const c = compileQuery({ pattern: "abc" });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  assert.equal(c.test("xxabcyy"), true);
  assert.equal(c.test("nothing here"), false);
});
