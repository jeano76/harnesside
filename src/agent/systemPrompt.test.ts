/**
 * 시스템 프롬프트와 **답의 가독성 측정** (2026-10-05).
 *
 * 이 테스트가 지키는 것:
 *  1. **출력 형식 규칙이 프롬프트에 실제로 들어간다.** `buildSystemPrompt` 가 그리는
 *     결과를 검사한다 — 함수가 존재한다는 것과 그 함수가 호출된다는 것은 다르다.
 *     호출 여부는 소스에서 확인한다(경계 검사와 같은 방식).
 *  2. **규칙은 하나도 빠지지 않는다.** `id` 로 검사한다 — 몇 번째 줄이 아니라
 *     **어느 규칙이 사라졌는지** 말해야 하기 위해서.
 *  3. **가독성 측정기가 실제로 울린다.** 여기 붙인 벽짜리 문단은 **사용자가 실측으로
 *     신고한 실제 출력**이다(2026-10-05). 이걸 통과시키면 검사가 아무것도 못 하는 것이다.
 *  4. **형태만 본다.** 짧은 평문 답 · 이미 구조가 있는 답에는 울리지 않는다.
 *     "문제 같다" 고 과잉진단하는 검사는 사람이 검사를 끄게 만든다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ANSWER_FORMAT_RULES,
  PARAGRAPH_CHAR_LIMIT,
  answerFormatSection,
  buildSystemPrompt,
  readabilityFlags,
} from "./systemPrompt.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, "..", "server", "index.ts"), "utf8");

/**
 * 실제 신고문(2026-10-05). **문장·줄바꿈을 고치지 않았다.** 원문은 문단 4개짜리
 * 한 덩어리였고, 각 문단이 쉼표로 이어진 300~500자짜리 벽이었다. 줄을 짧게
 * 접어 넣으면(관계를 호소) 검사가 통과해 버리므로 **원문 그대로** 둔다.
 */
const REAL_COMPLAINT = `이 저장소(harnesside, v0.1.0)는 로컬 llama.cpp 기반 코딩 에이전트로, CDP(Chrome DevTools Protocol)로 구동되는 브라우저 IDE를 조종하는 데몬 서버 방식의 애플리케이션입니다. 핵심은 OpenAI 호환 API, 자가 치:self-healing, 메모리 압축(memory-compaction)과 자동 재시작(auto-resume) 기능입니다.

최상위에는 방대한 문서가 눈에 띄는데, README.md(약 200KB), PROMPT.md(약 177KB), 그리고 다양한 영역별 프롬프트(PROMPT_*.md)와 진행/개선 기록 파일(PROGRESS.md, IMPROVEMENTS.md, MIGRATION_CHECKLIST.md, todo.md, dev.log)이 프로젝트의 규모와 반복 개발 역사를 보여줍니다.

코드 구조는 TypeScript(ESM) 기반이며, src/ 아래에 에이전트·인증(auth)·백엔드·압축(compaction)·설정(config)·파일시스템(fs)·GIT·Hermes·인스턴스 보호(instanceGuard)·모델·서버·세션·설치(setup)·공유(shared)·스킬(skills)·툴(tools)·웹(web) 등 역할별 하위 모듈이 나뉘어 있습니다. 빌드는 서버(TypeScript 컴파일)와 웹(Vite + React + Monaco 에디터)로 분리되어 scripts/pack-web-assets.mjs에서 통합되고, 결과물이 dist/에 패키지됩니다.

테스트는 tsx --test로 src/*/*.test.ts를 실행하며 e2e 검증스크립트(verify-window, verify-terminal)와 커버리지 체크 스크립트가 scripts/에 있습니다. CI 설정은 .ci/와 .github/에, 가짜 모델 디렉터리 등 개발 전용 경로가 .gitignore로 제외된 상태입니다.

이런 출력은 문단 또는 출력 양식적용이 필요해 보여 너무 가독성이 떨어져 전체적인 가독성 부분 개선을 해줘`;

// ── 프롬프트 ────────────────────────────────────────────────────────────────

test("출력 형식 규칙이 **하나도 빠지지 않고** 프롬프트에 들어간다", () => {
  const prompt = buildSystemPrompt({ workspaceRoot: "/w", ruleFiles: [] });
  for (const rule of ANSWER_FORMAT_RULES) {
    assert.ok(prompt.includes(rule.text), `규칙 '${rule.id}' 이 프롬프트에 없다 — 사라지면 아무도 모른다`);
  }
  // 규칙이 늘면 프롬프트가 붇는다. 상한은 테스트가 지킨다.
  assert.ok(
    ANSWER_FORMAT_RULES.length <= 8,
    `출력 형식 규칙이 ${ANSWER_FORMAT_RULES.length}개다 — 화면용 프롬프트가 아니다 (8개 상한)`,
  );
  // id 는 중복되면 안 된다 — 중복은 "어느 규칙이 지켯는지"를 못 묻게 만든다.
  const ids = ANSWER_FORMAT_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "중복된 규칙 id 가 있다");
});

test("프롬프트는 **목록으로** 규칙을 보여준다 — 벽짜리 문장으로 규칙을 전달하지 않는다", () => {
  const section = answerFormatSection();
  // 이 테스트 자체가 역설이 된다면 곤란하다: 규칙 문장은 벽이 아니라 **한 줄씩**이어야 한다.
  for (const line of section.split("\n")) {
    assert.ok(line.length <= PARAGRAPH_CHAR_LIMIT, `규칙 한 줄이 ${line.length}자다 — 읽기 규칙이 자기 자신에게 어긋남`);
  }
  assert.match(section, /^1\. /m, "번호가 매겨져 있지 않다 — 우선순위가 안 보인다");
});

test("규칙 파일이 **없으면 없다고 말한다** — 조용히 비면 '적용됐다' 고 오해한다", () => {
  const none = buildSystemPrompt({ workspaceRoot: "/w", ruleFiles: [] });
  assert.match(none, /규칙 파일.*없습니다/);
  const some = buildSystemPrompt({ workspaceRoot: "/w", ruleFiles: ["CLAUDE.md", ".cursor/rules"] });
  assert.match(some, /규칙 파일 2개가 적용 중/);
  assert.match(some, /CLAUDE\.md/);
});

test("프롬프트 조립 순서: 정체 → 루트 → 게이트 → 규칙 파일 → 출력 형식", () => {
  const prompt = buildSystemPrompt({ workspaceRoot: "/w", ruleFiles: ["R.md"], extra: "추가 지시" });
  const at = (needle: string) => prompt.indexOf(needle);
  assert.ok(at("코딩 에이전트") < at("현재 작업 루트"), "루트가 정체보다 뒤에 있다");
  assert.ok(at("현재 작업 루트") < at("승인 게이트"), "게이트가 루트보다 뒤에 있다");
  assert.ok(at("승인 게이트") < at("규칙 파일"), "규칙 파일이 게이트보다 뒤에 있다");
  assert.ok(at("규칙 파일") < at("출력 형식"), "출력 형식이 맨 뒤여야 읽는 순서가 된다");
  assert.ok(prompt.endsWith("추가 지시"), "추가 지시가 맨 뒤가 아니다");
});

test("`server/index.ts` 는 **이 정본을 호출한다** — 프롬프트를 두 곳에 두지 않는다", () => {
  assert.match(serverSrc, /buildSystemPrompt\(/, "index.ts 가 buildSystemPrompt 를 쓰지 않는다");
  assert.match(
    serverSrc,
    /import \{ buildSystemPrompt \} from "\.\.\/agent\/systemPrompt\.js"/,
    "정본을 import 하지 않았다",
  );
  // 형식 규칙 문자열을 index.ts 에 다시 적으면 두 벌이 된다 — 그게 사고다.
  assert.ok(
    !/파괴적인 도구\(삭제·덮어쓰기·셸\)는 승인 게이트/.test(serverSrc),
    "index.ts 에 시스템 프롬프트 문자열이 남아 있다 — 두 벌이 됐다",
  );
});

// ── 가독성 측정기 ───────────────────────────────────────────────────────────

test("**실제 신고문**은 세 형태로 모두 걸린다 — 검사가 울리지 않으면 무의미하다", () => {
  const rules = readabilityFlags(REAL_COMPLAINT).map((f) => f.rule);
  assert.ok(rules.includes("runon-paragraph"), "상한을 넘는 문단을 못 잡았다");
  assert.ok(rules.includes("inline-enumeration"), "한 문장에 항목 5개 이상 이어 붙인 형태를 못 잡았다");
  assert.ok(rules.includes("no-structure"), "긴데 구조가 전혀 없는 형태를 못 잡았다");
});

test("각 신호는 **개수와 이유**를 준다 — '좀 이상하다' 가 아니라 무엇을 고칠지", () => {
  for (const f of readabilityFlags(REAL_COMPLAINT)) {
    assert.ok(f.count >= 1, `${f.rule} 이 개수를 주지 않았다`);
    assert.ok(f.message.length > 10, `${f.rule} 이 이유를 말하지 않는다`);
    assert.match(f.message, /나누|바꾸|만드/, `${f.rule} 이 행동을 말하지 않는다`);
  }
});

test("**이미 구조가 있는 답에는 울리지 않는다** — 과잉진단은 검사를 끄게 한다", () => {
  const good = `## 한 것

- \`src/server/doctorChecks.ts\` 신규 — 판정 7축
- \`doctor\` 출력에 행동 섹션 추가

검증은 \`npm test\` 2022 pass / 0 fail (2026-10-05) 로 했다.

| 축 | 상태 |
| --- | --- |
| Node | ok |
| 포트 | ok |`;
  assert.deepEqual(readabilityFlags(good), [], "구조가 있는 답에 경고가 울렸다");
});

test("**짧은 평문 답은 정상이다** — 짧다고 문제가 아니다", () => {
  assert.deepEqual(readabilityFlags("직접 `dist/server/index.js` 를 실행하십시오."), []);
  assert.deepEqual(readabilityFlags(""), []);
});

test("**목록 안의 긴 줄은 문단으로 세지 않는다** — 목록을 벌점으로 보지 않는다", () => {
  const listHeavy = Array.from({ length: 6 }, (_, i) => `- 항목 ${i}: ${"설명 ".repeat(30)}`).join("\n");
  assert.deepEqual(readabilityFlags(listHeavy), [], "긴 목록 항목을 문단으로 잘못 세었다");
});

test("코드펜스 **안의** 긴 줄과 쉼표 나열은 세지 않는다 — 의도된 형식일 수 있다", () => {
  const withFence = ["긴 설명.".repeat(30), "", "```ts", "const a = 1, b = 2, c = 3, d = 4, e = 5, f = 6;", "```"].join("\n");
  const flags = readabilityFlags(withFence).map((f) => f.rule);
  assert.ok(!flags.includes("inline-enumeration"), "코드펜스 안의 쉼표 나열을 잡았다");
});

test("경계: 문단은 **정확히 상한까지만** 허용한다 (측정값이 규칙의 근거)", () => {
  const at = (n: number) => "가".repeat(n);
  assert.equal(readabilityFlags(at(PARAGRAPH_CHAR_LIMIT)).length, 0, "상한과 같으면 통과해야 한다");
  assert.equal(readabilityFlags(at(PARAGRAPH_CHAR_LIMIT + 1)).length, 1, "상한을 넘으면 잡혀야 한다");
});
