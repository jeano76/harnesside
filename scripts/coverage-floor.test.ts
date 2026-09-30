/**
 * 하한선 스크립트 자체의 테스트 (§10.6 의 하한선은 **검사기** 가 틀려도 통과한다).
 *
 * 파이저의 입력은 **실제 출력 스냅샷**(`fixtures/coverage-report.txt`) 이다.
 *
 * 손으로 쓴 가짜 표를 쓰면 안 되는 이유가 실제로 있었다: 처음에 손으로 만든 픽스처는
 * Node 의 들여쓰기 규칙(`#  src` — `#` 뒤 공백 둘)과 달랐고, 그래서 **픽스처는
 * 통과하는데 스크립트는 첫 줄에서 죽었다.** 파이저가 검사할 대상은 정본이어야 한다.
 *
 * 검사하는 것:
 *  1. 경로 재구성 (디렉터리 들여쓰기, 구분선·요약행·헤더 제외)
 *  2. 집합(line) 평균 — 파일 평균이면 파일 수로 수치를 오른다
 *  3. 제외 규칙 — 원문에 적힌 것만, 그리고 `.ts` 로직은 **쌓아서** 센다
 *  4. 값이 빈 행은 "측정 안 됨" 이지 0% 가 아니다
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseReport, isExcluded, aggregate, evaluate, FLOOR_BY_PHASE, EXCLUDES } from "./coverage-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** 실제 Node 표를 그대로 붙인 스냅샷. 손으로 고치지 않는다 — 바뀌면 리뷰한다. */
const REAL = readFileSync(join(here, "fixtures", "coverage-report.txt"), "utf8");

test("**실제 출력** 을 파싱한다 — 손으로 만든 표가 아니라", () => {
  const files = parseReport(REAL);
  assert.ok(files.length > 50, `파일 수가 비정상이다: ${files.length}`);
  // 구분선(`----|----`)도 `|` 를 포함한다. 디렉터리로 오인하면 경로가 뒤집힌다.
  assert.ok(!files.some((f) => f.path.includes("-")), `구분선이 경로에 들어갔다`);
  // 요약행과 헤더는 **파일이 아니다**. 세면 하한선이 전체 평균으로 내려간다.
  assert.ok(!files.some((f) => f.path.includes("all files")), `요약행을 셌다`);
  assert.ok(!files.some((f) => f.path.includes("coverage report")), "헤더를 셌다");
});

test("경로를 **디렉터리 계보로 재구성** 한다", () => {
  const paths = parseReport(REAL).map((f) => f.path);
  assert.ok(paths.includes("src/server/watchdog.ts"), `서버 경로 재구성 실패: ${paths.slice(0, 5).join(", ")}`);
  assert.ok(paths.includes("src/compaction/checkpoint.ts"), "중첩 디렉터리 실패");
  // 웹 로직은 **경로로 구분되어야** 한다 — 여기서 섞이면 아래 제외 규칙이 무의미해진다.
  assert.ok(paths.includes("src/web/wsClient.ts"), `웹 로직 경로 실패: ${paths.filter((p) => p.includes("web")).slice(0, 4).join(", ")}`);
});

test("수치 열을 정확히 읽는다", () => {
  const f = parseReport(REAL);
  const wd = f.find((x) => x.path === "src/server/watchdog.ts");
  assert.ok(wd, "watchdog.ts 를 못 찾았다");
  assert.ok(wd!.line !== null && wd!.line >= 0 && wd!.line <= 100, `line 이 백분율이 아니다: ${wd!.line}`);
  assert.ok(wd!.branch !== null, "branch 열을 못 읽었다");
});

test("**집합 평균** — 파일 평균이면 파일 수로 수치를 오른다", () => {
  const agg = aggregate([
    { path: "a.ts", line: 100, branch: 0, funcs: 0 },
    { path: "b.ts", line: 10, branch: 0, funcs: 0 },
  ]);
  assert.equal(agg.line, 55);
  const padded = aggregate([
    { path: "a.ts", line: 100, branch: 0, funcs: 0 },
    { path: "b.ts", line: 10, branch: 0, funcs: 0 },
    { path: "c.ts", line: 10, branch: 0, funcs: 0 },
  ]);
  assert.ok(padded.line < agg.line, `파일 추가로 커버리지가 올랐다: ${padded.line}`);
});

test("제외는 **순수 스타일만** — 웹 로직과 레거시·테스트를 뺀다", () => {
  assert.equal(isExcluded("src/web/main.tsx"), true, "렌더 컴포넌트를 서버로 셌다");
  assert.equal(isExcluded("src/legacy-tui/App.tsx"), true, "레거시 TUI 를 셌다");
  assert.equal(isExcluded("src/server/watchdog.test.ts"), true, "테스트 파일을 셌다");
  // **웹 로직은 반드시 센다.** 통째로 빼면 `api.ts` 가 "오류 body 를 버리는 버그" 를
  // 아무도 못 보는 상태로 돌아간다 — 실제로 그 버그가 있었다.
  assert.equal(isExcluded("src/web/api.ts"), false, "웹 로직을 제외했다 (은폐)");
  assert.equal(isExcluded("src/web/wsClient.ts"), false, "재연결 로직을 제외했다");
  assert.equal(isExcluded("src/server/watchdog.ts"), false);
  // 기본 목록은 **다섯 칸** — 늘리지 않는다.
  assert.equal(EXCLUDES.length, 5, `제외가 늘었다: ${EXCLUDES.join(", ")}`);
});

test("실제 표로 판정한다 — 하한선을 **지키고 있으면** 통과해야 한다", () => {
  const r = evaluate(parseReport(REAL), 80);
  assert.ok(r.line !== null, "집합 평균을 못 냈다");
  assert.equal(r.ok, r.line >= 80, `line=${r.line} 인데 ok=${r.ok}`);
  assert.ok(r.kept.every((f) => !f.path.endsWith(".tsx")), "tsx 가 포함됐다");
  assert.ok(r.kept.some((f) => f.path.startsWith("src/server/")), "서버 파일이 없다");
});

test("개별 파일이 낮아도 **집합으로** 판정한다", () => {
  // 원문은 "서버 계층 80%" 라고 했다. "모든 파일 80%" 이 아니다 — 개별 저하를
  // 가짜로 실패로 만들면 개발자가 **제외를 늘리는** 쪽으로 나간다.
  const r = evaluate(parseReport(REAL), 80);
  const low = r.below.filter((f) => (f.line ?? 0) < 50).map((f) => f.path);
  assert.ok(low.length > 0, "저조한 파일이 없다 — 측정 결과가 바뀌었다");
  assert.equal(r.ok, true, `집합이 80 위인데 실패했다: ${r.line}`);
  // 하한선을 올리면 실제로 실패해야 한다(판정이 살아 있다는 증거).
  assert.equal(evaluate(parseReport(REAL), 99).ok, false, "99% 에서도 통과했다 — 판정이 죽었다");
});

test("**Phase 별 하한선** 은 원문 수치 그대로 — 자동으로 따라올라가지 않는다", () => {
  assert.equal(FLOOR_BY_PHASE.P0, 60);
  assert.equal(FLOOR_BY_PHASE.P11, 70);
  assert.equal(FLOOR_BY_PHASE.P17, 80);
  assert.equal(Object.keys(FLOOR_BY_PHASE).length, 3, "새 Phase 를 임의로 추가했다");
});

test("실행되지 않은 파일(값 없음)은 **세지 않는다** — 0% 와 '측정 안 됨' 은 다르다", () => {
  const r = parseReport(`
#  src           |        |          |         |
#   server       |        |          |         |
#    measured.ts |   90.00 |    90.00 |  90.00 |
#    untested.ts |        |          |         |
`);
  assert.deepEqual(
    r.map((f) => f.path),
    ["src/server/measured.ts"],
    `측정 안 된 파일을 포함했다: ${r.map((f) => f.path).join(", ")}`,
  );
  const e = evaluate(r, 80);
  assert.equal(e.line, 90);
  assert.equal(e.ok, true);
});
