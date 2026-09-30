/**
 * 웹이 호출하는 API 경로가 **실제로 존재하는가** (2026-10-01).
 *
 * 실측: `FilePreview` 와 `ToolBlock` 이 `/api/fs/read` 를 호출하고 있었다 — 그 경로는
 * 없다. 실제 경로는 `/api/fs/file` 이다. 결과는 **404** 였고, 화면에는 "읽지 못했습니다"
 * 라는 **올바른 문장** 이 떴다. 그래서 사용자는 "파일이 없나" 하고 여기고, 개발자는
 * 자기 코드가 옳다고 믿는다.
 *
 * 왜 이게 조용했나: 404 는 **에러로 잡힌다** — 타이포가 아니라 "서버가 거절했다" 로
 * 읽힌다. 그리고 화면은 **사유를 말했으므로** 그것이 말 없음으로 보이지도 않는다.
 *
 * 그래서 경로 대조를 **기계적으로** 한다. 주석의 예시 문자열은 제외한다 — 경로처럼
 * 보이는 주석 때문에 거짓 실패를 내면 검사가 무의미해진다.
 *
 * **한계(명시)**: 동적 경로(`/api/terminal/:id/input`)는 이 검사가 **모른다** — 그래서
 * 그 경로들은 수동으로 대조했다(§④: 모르는 것을 안다고 하지 않는다).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * 저장소 루트를 **찾아 올라간다**.
 *
 * `import.meta.dirname` 는 이 저장소에서 신뢰할 수 없다 — `tsx --test` 가 TypeScript 를
 * CJS 로 변환할 때 작업 디렉터리를 가리켜서, 두 단계 위로 올라가면 **저장소 밖**으로
 * 나간다(실측: `/home/jeano/src/server` 가 ENOENT). `package.json` 이 있는 첫
 * 디렉터리를 루트로 삼는 이유다 — 경로 산술이 아니라 **증명 가능한 표식**으로 찾는다.
 */
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("저장소 루트를 찾지 못했다 (package.json 없음)");
}

const ROOT = repoRoot(import.meta.dirname);

/** 주석을 지운다 — 주석 안의 예시 경로는 사용되지 않는다. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, filter: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, filter, out);
    else if (filter.test(name)) out.push(p);
  }
  return out;
}

const webDir = join(ROOT, "src", "web");
const serverDir = join(ROOT, "src", "server");

/** 서버가 **선언**한 경로. `/api/terminal/:id/input` 같은 동적 것은 정규화한다. */
function serverRoutes(): Set<string> {
  const out = new Set<string>();
  for (const f of walk(serverDir, /\.tsx?$/)) {
    if (/\.test\.tsx?$/.test(f)) continue;
    for (const m of code(readFileSync(f, "utf8")).matchAll(/\.route\(\s*"[A-Z]+"\s*,\s*"\/api\/([^"]+)"/g)) {
      out.add(`/api/${m[1].replace(/:[A-Za-z]+/g, ":X")}`);
    }
  }
  return out;
}

/** 웹이 호출하는 경로. 템플릿 리터럴 `${…}` 는 `:X` 로 정규화한다. */
function webCalls(): string[] {
  const out = new Set<string>();
  for (const f of walk(webDir, /\.tsx?$/)) {
    if (/\.test\.tsx?$/.test(f)) continue;
    const src = code(readFileSync(f, "utf8"));
    // `client.get("/api/x")` · `client.post("/api/x", …)` · `"/api/x"` 리터럴
    for (const m of src.matchAll(/"(\/api\/[A-Za-z0-9/_.:$-]+)"/g)) out.add(m[1]);
    // 템플릿 리터럴: `/api/terminal/${id}/input`
    for (const m of src.matchAll(/`(\/api\/[^`]*?)`/g)) {
      out.add(m[1].replace(/\$\{[^}]*\}/g, ":X").replace(/\?.*$/, ""));
    }
  }
  return [...out];
}

test("웹이 호출하는 **모든 정적 경로**가 서버에 존재한다", () => {
  const routes = serverRoutes();
  assert.ok(routes.size > 20, `서버 경로를 ${routes.size}개만 찾았다 — 파싱이 잘못됐다`);
  const missing = webCalls()
    .filter((p) => !p.includes(":X")) // 동적 경로는 이 검사가 모른다
    .filter((p) => !routes.has(p))
    .sort();
  assert.deepEqual(missing, [], `존재하지 않는 경로를 호출한다: ${missing.join(", ")}`);
});

test("**매처가 살아 있다** — 경로 대조가 조용히 실패하면 안 된다", () => {
  // 이 검사는 전부 정규식/문자열 비교다. 매처가 틀리면 위 검사는 **항상 통과**한다.
  // 그래서 실제로 없는 경로를 넣었을 때 잡히는지 확인한다.
  const routes = serverRoutes();
  assert.ok(routes.has("/api/models"), "실제 존재하는 경로를 못 찾았다 — 매처가 죽었다");
  assert.ok(!routes.has("/api/nonexistent-xyz"), "없는 경로를 통과시킨다");
  // 그리고 웹 호출 목록에 없는 경로가 실제로 등장하는지 본다.
  assert.ok(webCalls().includes("/api/models"), "웹 호출 목록이 비었다 — 추출이 실패했다");
});

test("**동적 경로**는 대상에서 제외되지만 그 수를 **알고 있다** (모른다고 말하기)", () => {
  const dynamic = webCalls().filter((p) => p.includes(":X"));
  // 제외된 것의 개수를 모른 채 "전부 확인했다" 고 말하면 거짓말이 된다.
  assert.ok(Array.isArray(dynamic), "열거 실패");
  // dynamic.length 는 출력에만 쓴다 — 값이 늘어도 실패시키지 않는다(추출이 달라질 수 있다).
  console.log(`      (이 검사가 모르는 동적 경로 ${dynamic.length}건: ${dynamic.join(", ")})`);
});
