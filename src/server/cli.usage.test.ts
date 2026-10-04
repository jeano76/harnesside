/**
 * USAGE 에 적힌 옵션은 **실제로 처리된다** (Q-8, 2026-10-04).
 *
 * 실측: USAGE 에 `--keep-alive`(창을 닫아도 종료하지 않음)가 있었지만 어디서도 읽지 않았다 — 믿고 쓴 사람은
 * 창을 닫는 순간 서버가 꺼진다. 도움말은 사용자가 가장 먼저 믿는 문서라 거짓이면 안 된다.
 * 이 검사가 거짓말할 수 있는 경우: 옵션 문자열이 USAGE 밖 **어딘가에** 있기만 하면 통과한다(처리 여부까지는 못 본다).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE } from "./cli.js";

const here = dirname(fileURLToPath(import.meta.url));

test("USAGE 의 --옵션마다 USAGE 밖 소스에서 그 문자열을 읽는 곳이 있다", () => {
  const flags = [...new Set([...USAGE.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/gm)].map((m) => m[1]!))];
  assert.ok(flags.length >= 5, `옵션을 못 뽑았다: ${flags.join(" ")}`);
  const sources = readdirSync(here)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => {
      const body = readFileSync(join(here, f), "utf8");
      // USAGE 문자열 자체는 빼고 본다 — 도움말이 자기 자신을 근거로 삼으면 검사가 무효다.
      return f === "cli.ts" ? body.replace(/export const USAGE = `[\s\S]*?`;/, "") : body;
    })
    .join("\n");
  const missing = flags.filter((f) => !sources.includes(f));
  assert.deepEqual(missing, [], `USAGE 에만 있고 처리하는 곳이 없는 옵션: ${missing.join(", ")}`);
});
