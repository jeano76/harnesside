/**
 * 답변 언어 규칙 (LANGUAGE_RULE) — **규칙과 그 짝인 측정**.
 *
 * 실측 사건: 한국어 질문에 **일본어** 답이 왔다. 답이 한국어 첫 문장 → 일본어 나머지로
 * **한 답변 안에서 언어가 바뀌었다.** 규칙이 아예 없어서 모델이 알아서 골랐다.
 *
 * 여기서 고정하는 것 두 가지:
 *  1. 규칙이 **프롬프트에 들어간다** — 사라지면 아무도 모른다.
 *  2. 규칙을 **어겼을 때 보이게** 한다 — 규칙은 요청이지 보장이 아니다.
 *
 * 그리고 더 중요한 것 하나:
 *  3. **정상 답변이 걸리지 않는다.** 한국어 답변에는 영어 식별자가 정상적으로 섞인다
 *     (`src/`, `read_file`, `Node`). 영어가 많다는 이유로 "한국어가 아니다" 고 하면
 *     정상 답변이 전부 걸린다 — 그 검사는 **쓰지 않는다.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ANSWER_FORMAT_RULES, buildSystemPrompt, languageFlags, LANGUAGE_RULE, PARAGRAPH_CHAR_LIMIT } from "./systemPrompt.js";

test("언어 규칙이 **프롬프트에 들어간다** — 형식 규칙과 별개로", () => {
  const prompt = buildSystemPrompt({ workspaceRoot: "/w", ruleFiles: [] });
  assert.ok(prompt.includes(LANGUAGE_RULE.text), "언어 규칙이 프롬프트에 없다");
  // 형식 규칙 상한(8줄)이 깨지지 않아야 한다 — 언어 규칙은 **형식 규칙이 아니다**.
  assert.ok(ANSWER_FORMAT_RULES.length <= 8, `형식 규칙이 ${ANSWER_FORMAT_RULES.length}개 — 상한 8 초과`);
  assert.ok(!ANSWER_FORMAT_RULES.some((r) => r.id === LANGUAGE_RULE.id), "언어 규칙을 형식 목록에 섞었다 — 8줄 예산을 깬다");
  assert.ok(LANGUAGE_RULE.text.length <= PARAGRAPH_CHAR_LIMIT, `규칙 한 줄이 ${LANGUAGE_RULE.text.length}자 — 읽기 규칙에 어긋남`);
});

test("**실측된 사건** — 한국어 질문에 일본어로 답하면 잡힌다", () => {
  const actual = `입\u529b\u304c\u300c1,2\u300d\u3060\u3051\u3067\u306f\u4f5c\u696d\u5185\u5bb9\u3092\u7279\u5b9a\u3067\u304d\u306a\u3044\u305f\u3081\u3001\u73fe\u72b6\u3068\u78ba\u8a8d\u8cea\u554f\u3092\u6295\u3052\u3066\u3044\u307e\u3059\u3002
\u73fe\u72b6（netproxy \u30d7\u30ed\u30b8\u30a7\u30af\u30c8）\u30ed\u30fc\u30ab\u30eb\u306e Git \u72b6\u6cc1\u3067\u3059\u3002브랜치는 main이며 origin/main보다1\u30b3\u30df\u30c3\u30c8\u5148입니다\u3002
\u672a\u30b3\u30df\u30c3\u30c8\u5909\u66f4\u306f README.md, src/workers/proxy.js \u3067\u4fee\u6b63\u6e08\u307f\u3067\u3059\u3002`;
  const flags = languageFlags(actual);
  assert.equal(flags.length, 1, `일본어 답을 못 잡았다: ${JSON.stringify(flags)}`);
  assert.equal(flags[0].rule, LANGUAGE_RULE.id);
  assert.ok(flags[0].count > 0, "몇 글자인지 말하지 않는다");
});

test("**한글 없이 중국어만** 있어도 잡힌다", () => {
  const zh = "\u8fd9\u662f\u672c\u5730\u4ee3\u7406\u670d\u52a1\u5668\u7684\u914d\u7f6e\u8bf4\u660e\u3002\u7aef\u53e3\u8ba1\u5212\u662f llama 8080 \u4e0e IDE 7317 \u4e24\u4e2a\u7aef\u53e3，\u9700\u8981\u786e\u8ba4\u662f\u5426\u53ef\u4ee5\u542f\u52a8\u3002";
  assert.equal(languageFlags(zh).length, 1, "중국어 답을 못 잡았다");
});

test("**정상 한국어 답변은 걸리지 않는다** — 영어 식별자가 섞여도", () => {
  // 이게 가장 중요한 검사다. `src/`·`read_file`·`Node` 는 정상 한국어 답변에 항상 있다.
  const good = `결론: 웹 자산 경로가 프로젝트 기준이라 전역 설치에서 IDE 가 404 였다.

- \`webDir\` 는 \`join(projectRoot, "dist", "web")\` 였다
- \`verify-window.mjs\` 로 확인했다 — 22/22 통과
- Chrome 과 harnesside 는 따로 띄웠고, llama-server 는 채택 경로라 그대로 뒀다`;
  assert.deepEqual(languageFlags(good), [], "정상 한국어 답변이 걸렸다 — 영어 식별자가 섞였다고 잡으면 이 검사는 쓸모가 없다");
});

test("**짧은 답은 판정하지 않는다** — 근거가 없다", () => {
  // "ok" 같은 짧은 답을 "다른 언어" 로 오진하면 안 된다. 단언할 수 없으면 말하지 않는다.
  for (const short of ["ok", "네", "그렇습니다", "\u4e86\u89e3\u3057\u307e\u3057\u305f", "\u597d\u7684"]) {
    assert.deepEqual(languageFlags(short), [], `짧은 답을 걸었다: ${JSON.stringify(short)}`);
  }
});

test("**코드 안의 일본어**는 판정에서 뺀다 — 식별자는 언어를 옮기지 않는다", () => {
  const withCode = `설명: 이 파일은 소스맵을 만든다.

\`\`\`js
const \u65e5\u672c\u8a9e = "입력";
\`\`\`

본문은 한국어로 계속 이어진다. 식별자에 다른 언어가 있어도 답변이 한국어라면 통과해야 한다.`;
  assert.deepEqual(languageFlags(withCode), [], "코드 안의 문자 때문에 한국어 답변이 걸렸다");
});

test("한글이 **조금** 섞여 있어도 대부분 일본어면 잡는다", () => {
  // 실측 사건처럼 한국어 한 문장 + 일본어 나머지.
  const mixed = `입력이 불명확합니다\u3002
\u73b0\u72b6（netproxy \u30d7\u30ed\u30b8\u30a7\u30af\u30c8）\u30ed\u30fc\u30ab\u30eb\u306e Git \u72b6\u6cc1\u3067\u3059\u3002\u30d6\u30e9\u30f3\u30c1\u306f main \u3067\u3001origin/main \u3088\u308a 1 \u30b3\u30df\u30c3\u30c8\u5148\u3067\u3059\u3002\u672a\u30b3\u30df\u30c3\u30c8\u5909\u66f4\u306f README.md \u3068 proxy.js \u3067\u3059\u3002`;
  const flags = languageFlags(mixed);
  assert.equal(flags.length, 1, "한 문장만 한국어인 답을 못 잡았다");
  assert.match(flags[0].message, /한글 비율|한글/, `사유가 뭔지 말하지 않는다: ${flags[0].message}`);
});

test("**사람이 읽을 수 있는** 사유가 있다 — 무엇을 해야 하는지", () => {
  const flags = languageFlags("\u3053\u308c\u306f\u65e5\u672c\u8a9e\u306e\u56de\u7b54\u3067\u3059\u3002\u30dd\u30fc\u30c8\u8a08\u753b\u306f llama 8080 \u3068 IDE 7317 \u3067\u3042\u308a\u3001\u78ba\u8a8d\u304c\u5fc5\u8981\u3067\u3059\u3002\u8a2d\u5b9a\u30d5\u30a1\u30a4\u30eb\u3092\u76f4\u63a5\u7de8\u96c6\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  assert.equal(flags.length, 1);
  assert.ok(flags[0].message.length > 10, "사유가 짧다");
  assert.match(flags[0].message, /한국어/, "어떻게 해야 하는지가 없다");
});

test("**빈 입력**은 조용히 아무것도 안 낸다 — 조용한 실패를 만들지 않는다", () => {
  for (const empty of ["", "   ", "\n\n", undefined as unknown as string]) {
    assert.deepEqual(languageFlags(empty), [], "빈 입력에서 플래그가 나왔다");
  }
});