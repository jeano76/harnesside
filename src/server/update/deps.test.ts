/**
 * 의존성 사전 설치 검사 (Raiser R-1 · 대안 나).
 *
 * **큰 위험을 짚는 테스트**다: `package.json` 의 `files` 는 `dist` 뿐이다. 즉
 * 배포물은 `node_modules` 를 담지 않는다. 이 검사가 막지 않으면 새 버전은
 * **`node-pty` 없이 부팅하지 못하고**, 사용자는 **한 번 죽는다.**
 *
 * 그래서 이 검사는 "있으면 좋겠다" 가 아니라 **게이트**다. 여기서 막히지 않으면
 * UI 의 "적용 가능" 이 **거짓말**이 된다.
 *
 * 주입 이유: 실제 디렉터리를 만들어 **재현**한다. `resolveName` 을 주입한다는 건
 * "실제 노드 해석" 을 대체한다는 뜻이 아니다 — 기본 경로로도 **진짜 해석**을 쓴다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDependencies, makeResolver, runtimeDeps } from "./deps.js";

async function root(): Promise<{ dir: string; root: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-deps-"));
  return { dir, root: dir, done: async () => rm(dir, { recursive: true, force: true }) };
}

test("선언된 의존을 **모두** 모은다 — dev 는 배포물에 필요 없다", () => {
  assert.deepEqual(runtimeDeps({ dependencies: { a: "1", b: "2" }, optionalDependencies: { c: "3" } }), ["a", "b", "c"]);
  assert.deepEqual(runtimeDeps({ dependencies: { a: "1" } }), ["a"]);
  assert.deepEqual(runtimeDeps({}), []);
  // 배열이나 이상한 값은 **조용히 무시한다** — package.json 을 못 읽으면
  // "의존성 없다" 가 되어 게이트가 조용히 통과한다. 그래서 호출자가
  // pkg=null 을 별도로 구분해 전달한다.
  assert.deepEqual(runtimeDeps({ dependencies: ["a"] as unknown as Record<string, unknown> }), []);
});

test("**없는 의존을 있는 것처럼 통과시키지 않는다** — 게이트가 무의미해지는 지점", async () => {
  const r = await root();
  try {
    const pkg = { dependencies: { "node-pty": "^1.1.0", ws: "^8" } };
    // 해석기를 `null` 로 고정한다 — 실제 해석기는 **상위 디렉터리와 시스템 패키지를
    // 뒤진다**(아래 테스트가 그 사실을 고정한다). 여기서는 "아무것도 해석되지 않는"
    // 상태를 정확히 만들어야 판정의 이유를 볼 수 있다.
    const missing = checkDependencies(r.root, pkg, () => null);
    assert.equal(missing.ready, false, "빈 폴더인데 의존이 있다고 말했다");
    assert.deepEqual(missing.missing, ["node-pty", "ws"]);
    assert.match(missing.detail, /의존성 2개가 없습니다/);
  } finally {
    await r.done();
  }
});

test("**설치 루트 밖에서 해석된 의존은 드러낸다** — 시스템 패키지는 버전이 다르다", async () => {
  // 실측(배포 준비 중 발견): 이 머신에는 시스템 `ws` 가 있고 노드가 그걸 찾아 **"설치돼 있다"**
  // 고 답한다. 그래서 실제 해석기는 빈 폴더에서도 `ws` 를 통과시킨다.
  //
  // 게이트가 노드보다 낙관적이면 안 되므로 판정은 그대로 따른다(프로그램도 그걸 로드한다).
  // 하지만 **조용히 두면 안 된다** — 사용자는 시스템 패키지 버전을 모르게 실행한다.
  //
  // 이 테스트는 **머신 상태에 기대지 않는다.** 예전엔 `tmpdir()`(/tmp) 바로 아래를 설치 루트로 써서,
  // 그 부모의 `node_modules`(/tmp/node_modules — npm 이 남긴 찌꺼기)가 "설치본 소유" 로 잡혀 external 이
  // 비었다. 이제 `<dir>/node_modules/ws` 를 **설치본 밖의 조상**으로 직접 만든다:
  //   <dir>/node_modules/ws        ← 외부(시스템) 패키지 역할
  //   <dir>/a/b/dist               ← 설치 루트 (소유 목록: <dir>/a/b/node_modules, <dir>/a/node_modules)
  const dir = await mkdtemp(join(tmpdir(), "harnesside-deps-"));
  const root0 = join(dir, "a", "b", "dist");
  await mkdir(root0, { recursive: true });
  await mkdir(join(dir, "node_modules", "ws"), { recursive: true });
  await writeFile(join(dir, "node_modules", "ws", "package.json"), JSON.stringify({ name: "ws", version: "7.0.0" }), "utf8");
  const r = { root: root0, done: () => rm(dir, { recursive: true, force: true }) };
  try {
    const external = checkDependencies(r.root, { dependencies: { "definitely-not-installed-xyzzy": "^1" } }, makeResolver(r.root));
    assert.equal(external.ready, false, `없는 의존을 통과시켰다: ${external.detail}`);

    // 이 머신에 실제로 있는 이름을 쓴다 — "없다" 고 말하면 이 테스트는 아무것도 검증 못 한다.
    const systemWide = checkDependencies(r.root, { dependencies: { ws: "^8", "definitely-not-installed-xyzzy": "^1" } }, makeResolver(r.root));
    assert.equal(systemWide.ready, false, "설치 루트 밖의 ws 때문에 통과했다");
    assert.ok(
      systemWide.external.includes("ws") || systemWide.missing.includes("ws"),
      `ws 의 출처를 밝히지 않았다: ${JSON.stringify(systemWide)}`
    );
    if (systemWide.external.includes("ws")) {
      assert.match(systemWide.detail, /설치 폴더 밖/, `버전이 다를 수 있다는 사실을 말하지 않는다: ${systemWide.detail}`);
    }
  } finally {
    await r.done();
  }
});

test("**거짓 경보를 내지 않는다** — `node_modules` 가 `dist/` 옆에 있어도 정상이다", async () => {
  // 실측 사고: 처음엔 "설치 루트(dist/) 안인가" 로만 판정했다. 그랬더니 이 저장소에서
  // **13개 의존 전부** "설치 폴더 밖" 으로 나왔다 — `node_modules` 가 `dist/` 의 형제라서.
  // **거짓 경보는 없는 것보다 나쁘다.** 사용자가 경보를 무시하는 법을 배운다.
  //
  // 실제 기본 배치를 재현한다: `<root>/dist` 가 설치본, `<root>/node_modules` 가 의존성.
  const dir = await mkdtemp(join(tmpdir(), "harnesside-deps-"));
  try {
    const root = join(dir, "dist");
    mkdirSync(root, { recursive: true });
    const nm = join(dir, "node_modules");
    await mkdir(join(nm, "ws"), { recursive: true });
    await writeFile(join(nm, "ws", "package.json"), JSON.stringify({ name: "ws", version: "8.21.3" }), "utf8");

    const d = checkDependencies(root, { dependencies: { ws: "^8" } }, makeResolver(root));
    assert.equal(d.ready, true, `설치된 의존을 없다고 말했다: ${d.detail}`);
    assert.deepEqual(d.external, [], `형제 node_modules 를 '설치 폴더 밖' 으로 불렀다 — 거짓 경보: ${d.detail}`);
    assert.doesNotMatch(d.detail, /시스템 패키지/, "거짓 경보를 사용자에게 보여준다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("**설치돼 있으면 통과**한다 — 진짜 파일시스템을 만든다", async () => {
  const r = await root();
  try {
    // 실제로 만들어 넣는다. 가짜 판정 함수를 쓰면 "있으면 통과" 를 검증 못 한다.
    await mkdir(join(r.root, "node_modules", "node-pty"), { recursive: true });
    await writeFile(join(r.root, "node_modules", "node-pty", "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }), "utf8");
    const d = checkDependencies(r.root, { dependencies: { "node-pty": "^1.1.0" } }, makeResolver(r.root));
    assert.equal(d.ready, true, `설치된 의존을 없다고 말했다: ${d.detail}`);
    assert.deepEqual(d.missing, []);
    assert.match(d.detail, /모두 설치됨/);
  } finally {
    await r.done();
  }
});

test("**하나만 없으면** 막는다 — 부분 설치는 부분적으로 죽는 프로그램이다", async () => {
  const r = await root();
  try {
    await mkdir(join(r.root, "node_modules", "ws"), { recursive: true });
    await writeFile(join(r.root, "node_modules", "ws", "package.json"), JSON.stringify({ name: "ws", version: "8.21.3" }), "utf8");
    const d = checkDependencies(r.root, { dependencies: { ws: "^8", "node-pty": "^1" } }, makeResolver(r.root));
    assert.equal(d.ready, false, "절반만 있는데 통과했다");
    assert.deepEqual(d.missing, ["node-pty"]);
  } finally {
    await r.done();
  }
});

test("`package.json` 을 못 읽으면 **'없다' 가 아니라 '모른다'** — 조용히 통과시키는 순간 게이트가 죽는다", async () => {
  const r = await root();
  try {
    const d = checkDependencies(r.root, null, makeResolver(r.root));
    assert.equal(d.ready, null, "모르는 것을 통과로 보고했다");
    assert.match(d.detail, /읽지 못해/);
    // 그리고 `missing` 는 비어 있어야 한다 — 없는 게 아니라 **모르는** 것이다.
    assert.deepEqual(d.missing, []);
  } finally {
    await r.done();
  }
});

test("선언된 의존이 **하나도 없으면** 통과한다 — 막을 이유가 없다", async () => {
  const r = await root();
  try {
    const d = checkDependencies(r.root, { devDependencies: { typescript: "^5" } } as { dependencies?: unknown }, makeResolver(r.root));
    assert.equal(d.ready, true);
    assert.match(d.detail, /선언된 외부 의존성이 없습니다/);
  } finally {
    await r.done();
  }
});

test("`node_modules/<이름>` 을 직접 **훑으면 거짓말한다** — npm 은 의존을 올린다", async () => {
  // 여기 있는 이유: `resolveName` 을 빈 값을 주면 **`node_modules/<이름>/package.json`
  // 직접 찾기**로 넘어간다. 그 경로가 실제로 쓰는 코드라는 것을 고정한다.
  const r = await root();
  try {
    await mkdir(join(r.root, "node_modules", "@scope", "pkg"), { recursive: true });
    await writeFile(join(r.root, "node_modules", "@scope", "pkg", "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }), "utf8");
    const d = checkDependencies(r.root, { dependencies: { "@scope/pkg": "^1" } }, () => null);
    assert.equal(d.ready, true, "깊은 경로의 스코프 패키지를 못 찾았다");
  } finally {
    await r.done();
  }
});