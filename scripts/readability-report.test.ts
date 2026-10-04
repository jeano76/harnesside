/**
 * `readability-report` 의 **정직성** (2026-10-05).
 *
 * 이 스크립트는 게이트가 아니라 기록이다. 그래서 위험한 실패는 "빨간불" 이 아니라
 * **"측정 불가" 를 0 으로 말하는 것**이다 — 세션이 없는데 "가독성 문제 0건" 을
 * 출력하면 누군가 그걸 "개선됐다" 는 증거로 인용한다. 그래서 이 테스트는
 *  · 세션이 없으면 **exit 1 + 측정 불가**
 *  · 세션이 있으면 **숫자가 나온다**
 * 를 확인한다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const script = join(root, "scripts", "readability-report.ts");

function run(cwd: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("세션이 없으면 **'측정 불가'** 라고 말한다 — 0건이 아니다", async () => {
  const empty = await mkdtemp(join(tmpdir(), "harnesside-readability-empty-"));
  const r = run(empty, ["--json"]);
  assert.equal(r.status, 1, "측정 불가를 성공(0)으로 보고했다");
  assert.match(r.out, /측정 불가/, "측정 불가임을 말하지 않는다");
  assert.ok(!/"flaggedBlocks":\s*0/.test(r.out), "0 을 숫자로 내보냈다 — measurements 가 아니라 숫자만 남겼다");
});

test("세션이 있으면 **기준선 숫자**가 나온다 (과거 대화이므로 기준선이라고 밝힌다)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-readability-sessions-"));
  const sessions = join(dir, ".harnesside", "state", "sessions");
  await mkdir(sessions, { recursive: true });
  // (1) 벽짜리 문단 — 신호가 나야 한다. (2) 이미 정리된 답 — 신호가 없어야 한다.
  await writeFile(
    join(sessions, "s-1.json"),
    JSON.stringify({
      blocks: [
        { kind: "text", text: "가".repeat(300) },
        { kind: "text", text: "짧은 답입니다." },
        { kind: "tool", text: "셸 출력은 대상이 아니다" },
      ],
    }),
    "utf8",
  );
  const r = run(dir, ["--json"]);
  assert.equal(r.status, 0, r.out);
  const summary = JSON.parse(r.out) as {
    longTextBlocks: number;
    flaggedBlocks: number;
    byRule: Record<string, number>;
    worst: Array<{ chars: number }>;
  };
  assert.equal(summary.longTextBlocks, 1, "120자 이하 블록까지 세었다");
  assert.equal(summary.flaggedBlocks, 1);
  assert.equal(summary.byRule["runon-paragraph"], 1);
  assert.equal(summary.worst[0]?.chars, 300);

  const human = run(dir);
  assert.match(human.out, /기준선/, "사람용 출력에 '기준선' 이 없다 — 과거 대화를 현재로 오해한다");
});
