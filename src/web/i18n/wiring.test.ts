/**
 * 배선 검사 (M9) — **최대화 지점의 표면만 확인한다.**
 *
 * 왜 이것이 없었나: `src/web/i18n/` 에 훅·사전·테스트가 전부 있었는데 **import 하는 곳이
 * 0건**이었다(2026-09-30 실측). 모듈 테스트는 11개 전부 통과했는데 아무것도 실행되지
 * 않았다 — "로직은 되지만 배선 안 됨" 이 §④ 가 금지한 바로 그 상태.
 *
 * 그래서 이 테스트는 딱 두 가지만 한다:
 *  1. **키가 실제로 쓴다.** `t("…")` 리터럴이 존재하면 그 키가 사전에 있어야 한다.
 *  2. **누락이 조용히 안 된다.** 새 키를 추가하면 여기서 걸린다.
 *
 * 하지 않는 것: 번역률을 올리는 것. 여기서 "100% 다" 고 주장하면 그건 거짓이다 —
 * 패널(`LogPanel` · `ModelPanel` · `CommitBox` …)의 문자열은 아직 하드코딩이 다.
 * 그 사실은 §④ 판정표가 아니라 **여기** 적혀 있어야 한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ko } from "./ko.js";
// 이 import 가 카탈로그를 등록한다(부수효과). 부르지 않으면 "배선이 없어도" 통과한다.
import "./install.js";
import { i18n, I18n } from "./index.js";

const WEB = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 주석을 지운다. 주석 안의 `t("a.b")` 는 **예시** 이다 — 실제 사용이 아니다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * 소스에서 **실제로 화면에 그리는 키** 를 뽑는다.
 *
 * 두 곳만 본다:
 *  1. `t("키")` 리터럴
 *  2. `TITLE_KEY` 처럼 **값이 키인 맵**
 *
 * 모든 `"a.b"` 문자열을 훑으면 오탐이 나온다. 실제로 그랬다: WS 이벤트 타입
 * (`"agent.done"` · `"agent.error"`)도 dotted 문자열이라 사전 키로 잡혔다. 전부 넣으면
 * 검사가 **항상 실패하거나, 고치느라 사전에 쓰지도 않는 키를 넣게 된다.** 그러면 이
 * 검사는 "화면에 무엇이 보이는가" 가 아니라 "내 정규식이 뭐를 잡나" 를 재게 된다.
 */
function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of walk(WEB)) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(/\bt\(\s*"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) keys.add(m[1]);
    // `…_KEY = { …: "키" }` — 키를 값으로 든 맵만 본다.
    for (const block of text.matchAll(/const\s+\w*KEY\w*\s*(?::[^=]+)?=\s*\{([^}]*)\}/g)) {
      for (const m of block[1].matchAll(/"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) keys.add(m[1]);
    }
  }
  return [...keys].sort();
}

test("화면에서 **쓰는 키는 전부 사전에 있다** — 없는 키는 키 자체가 화면에 나온다", () => {
  const missing = usedKeys().filter((k) => !(k in ko));
  assert.deepEqual(missing, [], `사전에 없는 키: ${missing.join(", ")}`);
});

test("**실제로 배선되어 있다** — 훅을 쓰는 파일이 최소 하나는 있다", () => {
  const users = walk(WEB).filter((f) => /useI18n\(/.test(readFileSync(f, "utf8")));
  assert.ok(users.length > 0, "어떤 파일도 useI18n 을 쓰지 않는다 — i18n 이 다시 죽은 코드가 된다");
});

test("카탈로그를 등록하면 **빈 키가 없다** — i18n 인스턴스가 비어 있지 않다", () => {
  // `install.ts` 는 import 만으로 등록한다. 여기서 직접 부르지 않으면 테스트가
  // "배선이 없어도" 통과하는 구조가 된다(2026-09-30 의 상태).
  assert.equal(i18n.t("panel.terminal"), "터미널", "카탈로그가 비어 있다");
  assert.equal(i18n.t("없는.키"), "없는.키", "없는 키는 키 자체여야 한다");
});

test("`lang` 은 **화면에 그려지는** 언어다 — 번역 없는 언어를 골랐다고 영어로 읽히지 않는다", () => {
  // 영어 카탈로그가 비어 있으면 `lang="en"` 이 한국어 문장에 붙으면 안 된다.
  // 그게 바로 M8 이 막으려던 사고다(스크린 리더가 한국어를 영어로 읽는다).
  assert.equal(i18n.effective("en"), "ko", "빈 영어 카탈로그인데 영어로 선언했다");
  assert.equal(i18n.effective("ko"), "ko");
});

test("**전부 번역된 언어만** `lang` 이 된다 — 절반이면 절반은 틀리게 읽힌다", () => {
  // 절반만 옮긴 화면에 `lang="en"` 을 찍으면 **틀린 쪽이 조용하다**(읽히기만 한다).
  // 그래서 100% 를 요구한다.
  const partial = new I18n({ catalogs: { ko, en: { "panel.terminal": "Terminal" } } });
  assert.equal(partial.effective("en"), "ko", "절반만 번역했는데 영어로 선언했다");
  assert.ok(partial.coverage("en").percent < 100);

  const full = new I18n({ catalogs: { ko, en: Object.fromEntries(Object.keys(ko).map((k) => [k, k])) } });
  assert.equal(full.effective("en"), "en", "전부 번역했는데 한국어로 선언했다");
});
