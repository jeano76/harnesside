#!/usr/bin/env node
/**
 * 테스트 파일을 **직접 모아서** `tsx --test` 에 넘긴다 (Q-9, 2026-10-04).
 *
 * 예전 `npm test` 는 `tsx --test "src/**\/*.test.ts"` 였다. 글롭을 펼치는 것은 **Node 21+ 의 테스트 러너**다 —
 * Node 20 에서는 `Could not find '…/src/**\/*.test.ts'` 로 **테스트가 하나도 돌지 않고** 실패했다(실측).
 * `package.json` 의 `engines` 는 ">=18" 이라 Node 20 은 지원 대상인데 테스트 명령이 그 약속을 깨고 있었다.
 * 셸 글롭(`$(find …)`)은 Windows 에서 안 되므로, 파일 목록은 Node 로 만든다.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const roots = ["src", "scripts"];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".test.ts")) files.push(relative(root, p));
  }
};
for (const r of roots) walk(join(root, r));
files.sort();
if (files.length === 0) {
  console.error("테스트 파일을 하나도 찾지 못했습니다 — 조용히 통과시키지 않습니다");
  process.exit(1);
}
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const r = spawnSync(process.execPath, [tsx, "--test", ...process.argv.slice(2), ...files], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
