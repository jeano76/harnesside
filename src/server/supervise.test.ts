/**
 * 감시기 인자 파싱 검사 — `--sv-*` 는 감시기가 먹고 나머지는 자식 몫이다.
 * 섞이면 자식이 오해한다(없는 플래그를 자기가 받았다고 믿는다).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseSupervisorArgs } from "./supervise.js";

test("기본값은 정책 기본값과 같다", () => {
  const a = parseSupervisorArgs([]);
  assert.deepEqual(a.childArgs, []);
  assert.equal(a.bootGraceSec, 90);
  assert.equal(a.maxRestarts, 5);
  assert.equal(a.windowSec, 300);
  assert.equal(a.backoffBaseSec, 2);
  assert.equal(a.backoffMaxSec, 60);
  assert.equal(a.pollMs, 500);
});

test("자식 인자는 그대로 통과한다 — --sv-* 만 가로챈다", () => {
  const a = parseSupervisorArgs(["--daemon", "--no-browser", "--sv-grace", "10", "--install"]);
  assert.deepEqual(a.childArgs, ["--daemon", "--no-browser", "--install"]);
  assert.equal(a.bootGraceSec, 10);
});

test("숫자가 아니면 거부한다 — 0으로 조용히 두지 않는다", () => {
  assert.throws(() => parseSupervisorArgs(["--sv-max", "많이"]), /숫자/);
  assert.throws(() => parseSupervisorArgs(["--sv-grace"]), /뒤에 숫자/);
});

test("main 가드는 소스에 있다 — import 만으로 감시기가 돌면 테스트 러너가 서버를 띄운다", () => {
  // 구조 검사: argv[1] 비교 없이 main() 을 부르면, 이 테스트 파일을 읽는 순간
  // 자식 스폰이 시작된다. 가드가 지워지면 여기서 잡힌다.
  const src = readFileSync(new URL("./supervise.ts", import.meta.url), "utf8");
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(noComments, /process\.argv\[1\]/, "진입점 판정이 없다 — import 가 main 을 실행한다");
  assert.match(noComments, /if \(isMain\)/, "가드 분기가 없다");
});
