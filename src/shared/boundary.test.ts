/**
 * 모듈 경계 테스트 (§10.2) — **웹 번들에 Node 내장 모듈이 들어가지 않는다.**
 *
 * 실제로 났다: 웹 UI 가 서버 모듈의 순수 함수(`severity`)를 import 했고, 그 모듈이
 * `node:child_process` 를 import 하고 있었다. 결과는 **번들 빌드 실패** —사람이
 * 서버 코드가 하는 일을 웹에서 왜 못 쓰는지 설명하기 어려웠다(UI 코드가 서버 코드를
 * 쓰는데 서버 코드가 브라우저에서 안 돈다).
 *
 * 그래서 경계를 **기계적으로** 지킨다:
 *  - `src/shared/**` 는 `import` 가 **0개**이어야 한다(양쪽에 안전해야 하므로)
 *  - `src/web/**` 은 `node:*` 를 직접 import 하면 안 된다
 *  - `src/web/**` 이 서버 모듈에서 **값(함수/상수)** 을 가져오면 안 된다(타입만 가능)
 *
 * 마지막 규칙이 실제로 깨뜨렸던 것이고, 그리고 사람이 실수하기 가장 쉬운 곳이다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..");

/**
 * **테스트 파일은 제외한다.** 테스트는 Node 에서 도는 것이 맞고 `node:assert` 를
 * 정상적으로 쓴다. 번들에는 포함되지 않는다(번들이 *.test.ts 를트리셰이크 하므로
 * 실제 번들 크기에도 영향이 없다). 검사 대상은 **실행되는 코드** 다.
 */
const isTest = (name: string): boolean => /\.test\.[cm]?tsx?$/.test(name);

async function filesUnder(dir: string, exts = [".ts", ".tsx"]): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name === "node_modules") continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await filesUnder(p, exts)));
    else if (!isTest(d.name) && exts.some((e) => d.name.endsWith(e))) out.push(p);
  }
  return out;
}

/** import 문을 **정적으로** 뽑는다(동적 import 도 포함). */
function importsOf(src: string): { spec: string; dynamic: boolean; line: number }[] {
  const out: { spec: string; dynamic: boolean; line: number }[] = [];
  const lines = src.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    const stat = line.match(/^\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/);
    if (stat) {
      out.push({ spec: stat[1], dynamic: false, line: i + 1 });
      return;
    }
    const bare = line.match(/^\s*import\s+["']([^"']+)["']/);
    if (bare) {
      out.push({ spec: bare[1], dynamic: false, line: i + 1 });
      return;
    }
    const dyn = line.match(/\bimport\(\s*["']([^"']+)["']\s*\)/);
    if (dyn) out.push({ spec: dyn[1], dynamic: true, line: i + 1 });
  });
  return out;
}

/** 값 import 인가(타입 import 가 아닌가). `import type` 와 `type` 키워드가 섞였는지도 본다. */
function isValueImport(stmt: string): boolean {
  return !/^\s*import\s+type\b/.test(stmt) && !/\{\s*type\s/.test(stmt);
}

test("shared 모듈은 **import 가 0개** — 양쪽에 안전해야 한다", async () => {
  const files = await filesUnder(join(SRC, "shared"));
  assert.ok(files.length > 0, "shared 디렉터리가 비어 있다");
  for (const f of files) {
    const src = await readFile(f, "utf8");
    const bad = importsOf(src).filter((i) => !i.spec.startsWith("."));
    assert.deepEqual(bad, [], `${f} 가 외부 모듈(${bad.map((b) => b.spec).join(", ")})을 import 한다 — 브라우저에서 깨진다`);
  }
});

test("웹 코드가 **node: 내장 모듈** 을 직접 import 하지 않는다", async () => {
  for (const f of await filesUnder(join(SRC, "web"))) {
    const src = await readFile(f, "utf8");
    for (const i of importsOf(src)) {
      assert.equal(
        /^node:/.test(i.spec) || i.spec === "fs" || i.spec === "path" || i.spec === "os" || i.spec === "crypto",
        false,
        `${f}:${i.line} 이 Node 전용 모듈(${i.spec})을 import 한다 — 브라우저 번들이 깨진다`,
      );
    }
  }
});

test("웹 코드는 서버 모듈에서 **타입만** 가져온다 — 값을 가져오면 Node 코드가 따라온다", async () => {
  const offenders: string[] = [];
  for (const f of await filesUnder(join(SRC, "web"))) {
    const src = await readFile(f, "utf8");
    for (const stmt of src.split("\n")) {
      const m = stmt.match(/^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']*server\/[^"']*)["']/);
      if (!m) continue;
      if (isValueImport(stmt)) offenders.push(`${f}: ${stmt.trim()}`);
    }
  }
  // 이 규칙이 실제로 한 번을 막았다: MonitorPanel 이 서버 metrics 에서
  // `severity`/`bucket` 을 값으로 가져와서 `node:child_process` 가 번들에 들어갔다.
  assert.deepEqual(offenders, [], `서버 모듈에서 값 import:\n${offenders.join("\n")}`);
});

test("웹 코드가 **shared/** 의 순수 로직을 쓴다 — 중복 정의는 서로 어긋난다", async () => {
  for (const f of await filesUnder(join(SRC, "web"))) {
    const src = await readFile(f, "utf8");
    for (const stmt of src.split("\n")) {
      if (/import\s+[^\n]*\b(bucket|severity|formatBytes|SEVERITY_COLOR)\b[^\n]*from\s+["'][^"']*server\//.test(stmt)) {
        assert.fail(`${f} 가 서버 모듈에서 공유 순수 함수를 가져온다: ${stmt.trim()}`);
      }
    }
  }
});

test("경계 검사가 **자기 자신을 통과**시킨다 — 규칙이 실제로 작동하는가", async () => {
  // detector 가 동작하는지 확인한다. 규칙이 조용히 아무것도 안 찾으면 통과가 무의미하다.
  const sample = [
    'import { stat } from "node:fs";',
    'import type { Metrics } from "../server/metrics.js";',
    'import { severity } from "../server/metrics.js";',
    'const m = await import("node:os");',
  ].join("\n");
  const found = importsOf(sample);
  // 샘플의 node: import 는 2개다(정적 1 + 동적 1). 나머지 2줄은 상대경로다.
  assert.equal(found.filter((i) => i.spec.startsWith("node:")).length, 2, "Node import 를 못 찾는다");
  assert.equal(found.filter((i) => i.dynamic).length, 1, "동적 import 를 못 찾는다");
  assert.equal(isValueImport('import type { Metrics } from "../server/metrics.js";'), false);
  assert.equal(isValueImport('import { severity } from "../server/metrics.js";'), true);
  // 주석 안의 import 는 세지 않는다
  assert.deepEqual(importsOf('// import x from "node:fs";\n/* import y from "node:os"; */'), []);
});
