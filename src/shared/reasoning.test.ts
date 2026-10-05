/**
 * 추론 예산 **정본이 하나인지** 확인한다 — 이 테스트가 지키는 결함은 값이 아니라
 * **세 벌로 흩어져 있었다는 것**이다.
 *
 * 실측: `1024` 가 세 곳에 따로 적혀 있었다.
 *   `web/agent/think.ts` · `config/schema.ts` · `server/agentService.ts`
 * 하나를 올려도 나머지 둘은 그대로였고, `agentService.ts` 의 주석은
 * "웹의 상태 머신과 값이 달라지면 안 된다" 고 적어놓고도 손으로 세 번 썼다.
 *
 * 그리고 토큰 추정을 **한 벌만** 쓴다 — `estimateTextTokens`(한글 1.5/글자)가
 * 이미 있는데, `길이 / 3.4` 이라는 두 번째 계산이 추론 예산에 남아 있었다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_REASONING, MAX_REASONING_CEILING, MIN_REASONING_FLOOR } from "./reasoning.js";
// 정본은 `shared/textTokens.ts` — `compactor.ts` 는 **재-export** 다.
// 여기서 컴팩터를 경유하면 서버 전용 모듈(`node:fs` 의존)이 테스트까지 끌어온다.
import { estimateTextTokens } from "./textTokens.js";
import { estimateTextTokens as VIA_COMPACTOR } from "../compaction/compactor.js";
import { DEFAULT_THINK } from "../server/agentService.js";
import { DEFAULT_MAX_REASONING as WEB_DEFAULT } from "../web/agent/think.js";
import { SETTINGS_BY_KEY } from "../config/schema.js";

const here = dirname(fileURLToPath(import.meta.url));

test("정본은 하나 — 서버·웹·스키마가 **같은 값**을 본다", () => {
  assert.equal(WEB_DEFAULT, DEFAULT_MAX_REASONING, "think.ts 가 정본과 다른 기본값을 쓴다");
  assert.equal(DEFAULT_THINK.maxReasoningTokens, DEFAULT_MAX_REASONING, "agentService 가 정본과 다른 기본값을 쓴다");
  const entry = SETTINGS_BY_KEY["agent.maxReasoningTokens"];
  assert.ok(entry, "스키마에 사고 토큰 상한 항목이 없다");
  assert.equal(entry.default, DEFAULT_MAX_REASONING, "스키마 기본값이 정본과 다르다");
  assert.equal(entry.min, MIN_REASONING_FLOOR);
  assert.equal(entry.max, MAX_REASONING_CEILING);
});

test("상한은 **여전히 유한**하다 — 무한 예산은 '생각만 하다가 아무것도 안 하는' 상태다", () => {
  // §5.3 의 420토큰 사건을 방어하되 **작동하는 값**으로 바꾼다.
  assert.ok(Number.isFinite(DEFAULT_MAX_REASONING));
  assert.ok(DEFAULT_MAX_REASONING > 1024, "기본값을 올리지 않았다 — 1,027 토큰에서 잘리는 실측이 그대로 남는다");
  assert.ok(DEFAULT_MAX_REASONING <= MAX_REASONING_CEILING, "상한보다 크다 — 스키마에서 못 고친다");
});

test("**기본값이 세 곳에 적혀 있지 않다** — 한 벌이 추가되면 이게 실패한다", () => {
  // `DEFAULT_MAX_REASONING = <숫자>` 형태의 **리터럴** 선언이 정본 파일 밖에도 있는가?
  const files = ["../web/agent/think.ts", "../server/agentService.ts", "../config/schema.ts"];
  for (const rel of files) {
    const src = readFileSync(join(here, rel), "utf8");
    // 리터럴 선언(대입)이 남아 있으면 두 벌이다. 주석·문서의 언급은 허용한다.
    const assigns = [...src.matchAll(/DEFAULT_MAX_REASONING\s*(?::[^=]*)?=\s*(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(assigns, [], `${rel} 에 기본값 리터럴이 또 있다: ${assigns.join(",")} — 정본은 shared/reasoning.ts`);
    // `maxReasoningTokens: <숫자>` 인라인 리터럴도 같은 중복이다.
    const inline = [...src.matchAll(/maxReasoningTokens:\s*(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(inline, [], `${rel} 에 maxReasoningTokens 숫자가 인라인으로 있다: ${inline.join(",")}`);
  }
});

test("**`길이 / 3.4` 같은 두 번째 추정이 없다** — 추정기는 한 벌", () => {
  // 추론 예산에 예전 계산이 남아 있으면 한글 사고의 절반밖에 못 센다(거짓말).
  for (const rel of ["../web/agent/think.ts", "../server/agentService.ts"]) {
    const src = readFileSync(join(here, rel), "utf8");
    assert.ok(!/3\.4/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${rel} 에 예전 추정(3.4)이 남아 있다`);
    assert.ok(src.includes("estimateTextTokens"), `${rel} 이 정본 추정기를 쓰지 않는다`);
  }
});

test("추정기가 **한글을 실제로 센다** — 영문 기준이면 절반밖에 못 센다", () => {
  const same = 400;
  const en = "a".repeat(same);
  const ko = "가".repeat(same);
  const enTok = estimateTextTokens(en);
  const koTok = estimateTextTokens(ko);
  // 400글자면 영문 100, 한글 600.
  assert.equal(enTok, 100, "영문 4글자/토큰 기준이 깨졌다");
  assert.equal(koTok, 600, "한글 1.5토큰/글자 기준이 깨졌다");
  assert.ok(koTok > enTok * 5, `한글이 영문의 ${(koTok / enTok).toFixed(1)}배뿐이다 — 예전의 /3.4 같은 과소 계정이 살아 있다`);
});

test("**실측 사례** — 1,027 근처 사고는 이제 상한을 넘지 않는다", () => {
  // 사용자가 겪은 것: 사고가 1,027 토큰을 넘겨 화면이 죽었다.
  // 그 분량의 **한글** 사고는 지금 상한(4,096) 안에 들어간다.
  const koreanReasoning = "사용자가 보고한 문제를 단계별로 확인하고 원인을 좁힌다. ".repeat(100);
  const tok = estimateTextTokens(koreanReasoning);
  assert.ok(tok > 1024, `픽스처가 ${tok} 토큰이라 실측 사례를 재현하지 못한다`);
  assert.ok(tok <= DEFAULT_MAX_REASONING, `${tok} 토큰인데 상한(${DEFAULT_MAX_REASONING})을 넘는다 — 같은 일이 다시 난다`);
});

test("빈 델타는 **0** 이다 — 최소 1 토큰을 매번 세지 않는다", () => {
  assert.equal(estimateTextTokens(""), 0);
});

test("**재-export 가 같은 함수다** — 서버가 경유해도 값이 어긋나지 않는다", () => {
  // `compactor.ts` 가 자체 구현을 버리고 재-export 하도록 바꿨다.
  // 두 경로가 다르면 **압축 임계값**과 **추론 예산**이 다른 숫자를 쓰게 된다 —
  // 한 화면에서 "컨텍스트는 충분한데 사고만 잘렸다" 는 설명 불가능한 상태가 된다.
  for (const t of ["hello world", "가나다라마바사아자차카타파하", "", "src/server/index.ts 의 3번째 줄", "\u6df7\u5408 mixed \u65e5\u672c\u8a9e 123"]) {
    assert.equal(estimateTextTokens(t), VIA_COMPACTOR(t), `두 경로가 다른 값을 낸다: ${JSON.stringify(t)}`);
  }
});