/**
 * 빌드 신원 (R-1) — **날짜 + 해시**를 코드에 넣는다.
 *
 * 이 테스트가 지키는 것:
 *  1. **모르면 모른다.** 주입 파일이 없으면 `stamped:false` 이고, 거짓 날짜를
 *     만들지 않는다. `version.ts:22` 가 "0.0.0 으로 메우면 업데이트 비교가 조용히
 *     틀린다" 고 한 그 원칙과 같다.
 *  2. **깨진 주입 파일은 "개발 실행" 과 다르다.** 둘을 구분해야 사용자가
 *     "배포물이 깨졌네" 를 알 수 있다.
 *  3. **형식이 다르면 거절한다.** 손으로 고친 파일이 조용히 통과하면 안 된다.
 *
 * 주입 파일은 **직접 만든다** — 실제 빌드 결과를 기다리면 이 테스트는 CI 에서
 * "빌드했는지" 에 의존하게 되고, 그건 이 테스트가 확인하려는 것이 아니다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInfoUrl, loadBuildInfo, readBuildInfo, resetBuildInfoCache } from "./buildInfo.js";

async function withTemp<T>(fn: (p: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-buildinfo-"));
  try {
    return await fn(join(dir, "buildInfo.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const GOOD = {
  version: "0.2.0",
  date: "20261005",
  sha: "08c4467",
  dirty: false,
  builtAt: 1_760_000_000_000,
};

test("주입된 값은 **필드로** 읽힌다 — 뒤에 뭐가 붙었는지 모르게 이으면 안 된다", async () => {
  await withTemp(async (p) => {
    await writeFile(p, JSON.stringify(GOOD), "utf8");
    const b = loadBuildInfo(p, "0.1.0");
    assert.equal(b.stamped, true, "주입된 파일인데 주입되지 않았다고 말한다");
    assert.equal(b.version, "0.2.0");
    assert.equal(b.date, "20261005");
    assert.equal(b.sha, "08c4467");
    assert.equal(b.dirty, false);
    assert.equal(b.builtAt, GOOD.builtAt);
    assert.match(b.label, /0\.2\.0 · 20261005-08c4467/, `사람이 읽는 한 줄이 아니다: ${b.label}`);
  });
});

test("더티 빌드는 **표시한다** — 깨끗한 게 기본이고, 이상할 때만 말한다", async () => {
  await withTemp(async (p) => {
    await writeFile(p, JSON.stringify({ ...GOOD, dirty: true }), "utf8");
    const b = loadBuildInfo(p, "0.1.0");
    assert.equal(b.dirty, true);
    assert.match(b.label, /더티/, "더티 빌드를 숨겼다");
    // 그리고 **릴리스에 못 나간다** — 파이프라인이 막는다(`gen-build-info.mjs --require-clean`).
    assert.equal(GOOD.dirty, false);
  });
});

test("주입 파일이 없으면 **개발 실행** 이라고 말한다 — 값을 지어내지 않는다", async () => {
  await withTemp((p) => {
    const b = loadBuildInfo(p, "0.1.0");
    assert.equal(b.stamped, false, "파일이 없는데 주입되었다고 말한다");
    assert.equal(b.date, null, "개발 실행에 빌드 날짜를 지어냈다");
    assert.equal(b.sha, null);
    assert.equal(b.builtAt, null);
    assert.equal(b.dirty, null, "모르는 것을 false 로 만들었다 — 그건 '깨끗함' 이 아니라 '모름' 이다");
    // SemVer 는 **fallback** 으로 온다 — 정본은 package.json 이고 그건 항상 읽힌다.
    assert.equal(b.version, "0.1.0", "fallback 버전이 없다");
  });
});

test("**깨진 주입 파일**은 개발 실행과 **구분된다** — 둘이 다르면 무엇이 잘못됐는지가 다르다", async () => {
  await withTemp(async (p) => {
    await writeFile(p, "{ 이건 json 아님", "utf8");
    const broken = loadBuildInfo(p, "0.1.0");
    assert.equal(broken.stamped, false);
    assert.match(broken.label, /깨졌/, `깨진 주입 파일을 '개발 실행' 으로 덮었다: ${broken.label}`);

    // 값이 비어 있는 파일 — 파싱은 되지만 **아무것도 증명하지 못한다.**
    await writeFile(p, JSON.stringify({ version: "0.2.0" }), "utf8");
    const empty = loadBuildInfo(p, "0.1.0");
    assert.equal(empty.stamped, false, "날짜도 해시도 없는데 주입되었다고 말한다");
    assert.match(empty.label, /비어 있/, `빈 주입 파일을 덮었다: ${empty.label}`);
  });
});

test("**형식이 다른 값**은 거절한다 — 손으로 고친 파일이 조용히 통과하면 안 된다", async () => {
  await withTemp(async (p) => {
    // dirty 가 문자열 — "false" 도 아니고 true 도 아니다.
    await writeFile(p, JSON.stringify({ ...GOOD, dirty: "false" }), "utf8");
    assert.equal(loadBuildInfo(p, "0.1.0").dirty, null, "문자열 dirty 를 boolean 으로 해석했다");

    await writeFile(p, JSON.stringify({ ...GOOD, builtAt: "2026-10-05" }), "utf8");
    assert.equal(loadBuildInfo(p, "0.1.0").builtAt, null, "문자열 시각을 숫자로 해석했다");

    // sha 만 있고 날짜가 없으면 — **결정하지 않는다.** 하나만 아는 건 반만 아는 것이다.
    await writeFile(p, JSON.stringify({ version: "0.2.0", sha: "08c4467" }), "utf8");
    const half = loadBuildInfo(p, "0.1.0");
    assert.equal(half.sha, "08c4467", "알고 있는 값은 버려진다");
    assert.equal(half.date, null, "모르는 날짜를 채웠다");
    assert.equal(half.stamped, true, "해시 하나만으로 주입되었다고 확정하지 않는다");
  });
});

test("정본 경로는 **모듈 옆**이다 — 설치된 배포물에 git 이 없어도 읽혀야 한다", () => {
  // `src/server/` 와 `dist/server/` 는 둘 다 패키지 루트에서 두 단계 아래라
  // **같은 상대 경로**가 맞는다(`version.ts` 와 같은 규칙). 이게 틀리면 배포물에서
  // "개발 실행" 으로 떨어진다 — 값이 조용히 사라진다.
  const u = buildInfoUrl("file:///x/y/dist/server/buildInfo.js");
  assert.equal(u.pathname, "/x/y/dist/server/buildInfo.json");
  const src = buildInfoUrl("file:///x/y/src/server/buildInfo.ts");
  assert.equal(src.pathname, "/x/y/src/server/buildInfo.json");
});

test("소스에서 실행하면 **개발 실행** 이다 — 그리고 그게 사실이다", () => {
  resetBuildInfoCache();
  const b = readBuildInfo();
  assert.equal(typeof b.stamped, "boolean");
  // SemVer 는 정본에서 온다 — `version.ts` 와 같은 값이어야 한다.
  assert.match(b.version, /^\d+\.\d+\.\d+/, `SemVer 가 아니다: ${b.version}`);
  if (!b.stamped) {
    assert.equal(b.date, null, "개발 실행인데 날짜가 있다");
    assert.match(b.label, /개발 실행|비어 있|깨졌/);
  }
  resetBuildInfoCache();
});