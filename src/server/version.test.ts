import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readVersion } from "./version.js";
import { parseArgs } from "./cli.js";

test("버전 정본은 package.json — 하드코딩 값과 갈라지지 않는다(Q-7)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(readVersion(), pkg.version);
  assert.match(readVersion(), /^\d+\.\d+\.\d+/, "시맨틱 버전이어야 updateService 의 isNewer 비교가 성립한다");
});

test("`version` 과 `--version` 은 부팅이 아니라 버전 출력으로 간다", () => {
  assert.equal(parseArgs(["version"]).command, "version");
  assert.ok(parseArgs(["--version"]).flags.has("--version"));
});

test("소스에 버전 문자열을 하드코딩하지 않는다(서버 라우트)", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.equal(/version:\s*"\d+\.\d+\.\d+"/.test(src), false, "index.ts 에 버전 리터럴이 남아 있다");
});
