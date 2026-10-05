/**
 * 매니페스트 검증 (R-5) — **검증 대상과 교체 대상이 같은 것**인지 본다.
 *
 * 이 테스트가 지킨다:
 *  1. 느슨하면 위험하다 — 필드가 빠진 매니페스트는 **검증 없는 검증**이 되고,
 *     그건 검증하는 것보다 나쁘다(§R-2 규칙).
 *  2. 해시만 보면 **빠진 파일**을 못 잡는다. 목록으로 잡는다.
 *  3. 해시만 보면 **목록에 없는 파일**(옛 버전 잔재)을 못 잡는다. 목록으로 잡는다.
 *  4. 손으로 고친 매니페스트는 **자기 검증**에서 떨어진다.
 *
 * 순수 계산만 쓴다 — 네트워크도 파일시스템도 없다. 그래야 "왜 이게 실패했나" 를
 * 문장으로 말할 수 있다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeTreeSha, isSafeRelPath, MANIFEST_VERSION, normRel, parseManifest, sha256, verifyDetail, verifyTree, type ManifestFile, type ReleaseManifest, type VerifyIo } from "./manifest.js";

function file(path: string, body: string): ManifestFile {
  const buf = Buffer.from(body, "utf8");
  return { path, sha256: sha256(buf), bytes: buf.byteLength, mode: 0o644 };
}

/** 매니페스트를 문자열로 — 파싱 경로를 그대로 통과해야 하므로. */
function manifestText(files: ManifestFile[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifestVersion: MANIFEST_VERSION,
    build: { version: "0.1.0", date: "20261005", sha: "08c4467", dirty: false, builtAt: 1 },
    asset: { name: "harnesside-dist.tar.gz", sha256: sha256("archive"), bytes: 10 },
    files,
    treeSha256: computeTreeSha(files),
    ...over,
  });
}

/** 메모리 위의 트리. 진짜 파일시스템을 쓰면 "왜 실패했나" 를 볼 수 없다. */
function ioOf(files: Record<string, string>, ignore: string[] = []): VerifyIo {
  const skip = new Set(ignore);
  return {
    read: (rel) => (rel in files ? Buffer.from(files[rel], "utf8") : null),
    list: () => Object.keys(files).filter((p) => !skip.has(p)),
  };
}

test("정상 트리는 **파일 수만큼** 확인되고 통과한다", () => {
  const files = [file("server/index.js", "v1"), file("agent/loop.js", "loop")];
  const p = parseManifest(manifestText(files));
  assert.equal(p.ok, true, p.ok ? "" : p.error);
  const v = verifyTree(p.manifest, ioOf({ "server/index.js": "v1", "agent/loop.js": "loop" }));
  assert.equal(v.ok, true, verifyDetail(v));
  assert.equal(v.checked, 2);
});

test("**해시가 다른 파일**을 잡는다 — 조용히 통과시키지 않는다", () => {
  const files = [file("server/index.js", "v2")];
  const p = parseManifest(manifestText(files));
  assert.equal(p.ok, true);
  const v = verifyTree(p.manifest, ioOf({ "server/index.js": "옛 내용" }));
  assert.equal(v.ok, false, "옛 내용을 통과시켰다");
  assert.equal(v.mismatched.length, 1);
  assert.match(verifyDetail(v), /불일치: server\/index\.js/, "어느 파일인지 말하지 않는다");
});

test("**없는 파일**을 잡는다 — 해시만으로는 이 실패를 못 본다", () => {
  const files = [file("server/index.js", "v1"), file("agent/loop.js", "loop")];
  const p = parseManifest(manifestText(files));
  assert.equal(p.ok, true);
  // `agent/loop.js` 가 없다 — **부팅할 때 import 가 죽는다.**
  const v = verifyTree(p.manifest, ioOf({ "server/index.js": "v1" }));
  assert.equal(v.ok, false, "빠진 파일을 통과시켰다 — 그 실패는 부팅에서만 나타난다");
  assert.deepEqual(v.missing, ["agent/loop.js"]);
  assert.match(verifyDetail(v), /없음: agent\/loop\.js/);
});

test("**목록에 없는 파일**을 잡는다 — 옛 버전 잔재가 그 예마다(R-5 실측)", () => {
  const files = [file("server/index.js", "v2")];
  const p = parseManifest(manifestText(files));
  assert.equal(p.ok, true);
  // `agent/loop.js` 는 해시가 맞는데 **새 버전의 목록에 없다.** = 옛 버전이 남았다.
  const v = verifyTree(p.manifest, ioOf({ "server/index.js": "v2", "agent/loop.js": "옛 루프" }));
  assert.equal(v.ok, false, "옛 버전 잔재를 통과시켰다 — 해시는 맞으므로 해시 검사만으로는 못 잡는다");
  assert.deepEqual(v.extra, ["agent/loop.js"]);
  assert.match(verifyDetail(v), /목록에 없음: agent\/loop\.js/);
});

test("**진입 파일만 갱신되고 나머지가 옛 버전**인 상태를 잡는다 (아orea 상태)", () => {
  // 이게 §R-5 의 핵심 시나리오다: `index.js` 만 새 버전, `loop.js` 는 옛 버전.
  // **둘 다 해시는 맞는다.** 파일 하나만 검사하는 구현은 이걸 통과시킨다.
  const files = [file("server/index.js", "새 진입점"), file("agent/loop.js", "새 루프")];
  const p = parseManifest(manifestText(files));
  assert.equal(p.ok, true);
  const mixed = ioOf({ "server/index.js": "새 진입점", "agent/loop.js": "옛 루프" });
  const v = verifyTree(p.manifest, mixed);
  assert.equal(v.ok, false, "절반만 갱신된 트리를 통과시켰다 — 부팅은 성공하고 옛 로직으로 돈다");
  assert.equal(v.mismatched.length, 1);
  assert.equal(v.mismatched[0].path, "agent/loop.js");
});

test("매니페스트 자신은 **비교에서 빠진다** — 자기 해시를 자기 안에 쓸 수는 없다", () => {
  const files = [file("server/index.js", "v1")];
  const p = parseManifest(manifestText(files));
  assert.equal(p.ok, true);
  // 배포물엔 `manifest.json` 이 함께 실린다. 이를 "목록에 없는 파일"로 보면
  // **정상 배포물이 항상 실패**하고, 그걸 고치려면 검증을 느슨하게 만들어야 한다.
  const withManifest = ioOf({ "server/index.js": "v1", "manifest.json": "{}" });
  assert.equal(verifyTree(p.manifest, withManifest, "", { ignore: ["manifest.json"] }).ok, true, "매니페스트를 무시하지 않았다");
  assert.equal(verifyTree(p.manifest, withManifest).ok, false, "무시하지 않으면 실패해야 한다 — 그래야 ignore 가 실제로 하는 일을 알 수 있다");
});

// ── 파싱: 느슨하면 위험하다 ─────────────────────────────────────────────────

test("**손으로 고친 매니페스트**는 자기 검증에서 떨어진다", () => {
  const files = [file("server/index.js", "v1")];
  const json = JSON.parse(manifestText(files)) as { files: ManifestFile[]; treeSha256: string };
  // 손으로 편집하면 저게 된다: 목록에 한 줄을 넣고 트리 해시는 **그대로** 둔다.
  json.files.push({ path: "x.js", sha256: "0".repeat(64), bytes: 1, mode: 0o644 });
  const p = parseManifest(JSON.stringify(json));
  assert.equal(p.ok, false, "변조된 매니페스트를 통과시켰다");
  assert.match((p as { error: string }).error, /트리 해시/);
});

test("**목록을 한 줄 지워도** 떨어진다 — 파일이 빠져 있는데 아무도 모르면 안 된다", () => {
  const files = [file("a.js", "1"), file("b.js", "2")];
  const json = JSON.parse(manifestText(files)) as { files: ManifestFile[]; treeSha256: string };
  json.files.pop(); // 목록에서만 뺀다 — 해시는 그대로
  const p = parseManifest(JSON.stringify(json));
  assert.equal(p.ok, false, "잘린 목록을 통과시켰다 — 그 파일은 배포물에 없고 아무도 모른다");
});

test("**안전하지 않은 경로**를 거부한다 — 풀기 전에 멈춰야 한다", () => {
  for (const bad of ["../escape.js", "/etc/passwd", "a/../../b.js", "C:/win.js", "a//b.js", ""]) {
    const files = [{ path: bad, sha256: sha256("x"), bytes: 1, mode: 0o644 }];
    const p = parseManifest(manifestText(files));
    assert.equal(p.ok, false, `안전하지 않은 경로를 통과시켰다: ${bad}`);
  }
  assert.equal(isSafeRelPath("server/index.js"), true);
  assert.equal(isSafeRelPath("./a.js"), false, "앞의 ./ 는 정규화되지 않은 표기다");
  assert.equal(normRel("./a/b.js"), "a/b.js");
});

test("형식이 다르면 **조용히 통과시키지 않는다** — 형식이 틀린 것은 같지 않은 것이 아니라 검증 불가다", () => {
  assert.equal(parseManifest("이건 JSON 이 아니다").ok, false);
  assert.equal(parseManifest(manifestText([file("a.js", "x")], { manifestVersion: 99 })).ok, false);
  assert.equal(parseManifest(JSON.stringify({ manifestVersion: 1 })).ok, false, "파일 목록이 없는데 통과");
  const noHash = [file("a.js", "x")];
  noHash[0].sha256 = "짧음";
  assert.equal(parseManifest(manifestText(noHash)).ok, false, "해시 형식이 틀렸는데 통과");
});

test("**트리 해시는 순서와 무관**하다 — 나열 순서만 달라도 같은 배포물이다", () => {
  const a = [file("b.js", "2"), file("a.js", "1")];
  const b = [file("a.js", "1"), file("b.js", "2")];
  assert.equal(computeTreeSha(a), computeTreeSha(b));
  const c = [file("a.js", "1"), file("b.js", "옛")];
  assert.notEqual(computeTreeSha(a), computeTreeSha(c), "내용이 다른데 같은 해시");
});

test("매니페스트의 `files` 는 **중복 경로**를 받지 않는다 — 하나만 증명하고 나머지는 숨기는 구멍", () => {
  const one = file("a.js", "x");
  const p = parseManifest(manifestText([one, { ...one }]));
  assert.equal(p.ok, false, "중복 경로를 통과시켰다");
  assert.match((p as { error: string }).error, /중복/);
});

test("빌드 신원이 비어 있어도 **매니페스트는 유효**하다 — 그건 별개의 사실이다", () => {
  // 매니페스트는 **파일 목록**을 증명한다. 빌드 신원은 `buildInfo.ts` 가 담당한다.
  // 섞으면, 신원을 못 읽는 사람이 "배포물이 깨졌다" 고 잘못 진단한다.
  const files = [file("a.js", "x")];
  const p = parseManifest(manifestText(files, { build: {} }));
  assert.equal(p.ok, true, p.ok ? "" : p.error);
  assert.equal((p as { manifest: ReleaseManifest }).manifest.build.sha, null);
  assert.equal((p as { manifest: ReleaseManifest }).manifest.build.date, null);
});