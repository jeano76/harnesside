/**
 * i18n 테스트 (M9 · §11.1).
 *
 * 여기서 검사하는 가장 중요한 하나: **빠진 키가 빈 문자열이 되지 않는가.**
 * i18n 을 넣을 때 가장 흔하고 가장 조용한 실패가 그것이다. 사용자는 "번역이 어딘가
 * 어긋났다" 고 읽지 않고, 그 빈 칸을 **원래 있던 문장** 이라고 믿는다.
 *
 * 나머지 셋:
 *  - 기본값이 **한국어** 다. 영어로 떨어지면 "번역 전 화면" 이 영어가 되어 그 이상의 문제가 된다.
 *  - `html[lang]` 이 함께 바뀐다(M8: 스크린 리더가 언어를 읽어야 한다).
 *  - 누락이 **목록** 으로 남는다 — 개수가 아니라 키가 필요하므로.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_LOCALE, I18n, LOCALES } from "./index.js";
import { ko } from "./ko.js";

const catalog = { ko };

test("기본값은 **한국어** — 이 앱의 대상 언어다", () => {
  const i = new I18n({ catalogs: catalog });
  assert.equal(i.current, "ko");
  assert.equal(DEFAULT_LOCALE, "ko");
  assert.equal(i.t("panel.terminal"), "터미널");
});

test("**없는 키는 빈 문자열이 아니라 키 자체** — 빈 화면 조각을 만들지 않는다", () => {
  const i = new I18n({ catalogs: catalog });
  const v = i.t("없는.키.이름");
  assert.notEqual(v, "", "빈 문자열을 돌려주면 화면이 조용히 빈칸이 된다");
  assert.equal(v, "없는.키.이름", "키를 그대로 보여주지 않았다 — 무엇이 빠졌는지 안 보인다");
  // **누락이 기록된다** — 옮기지 않은 키의 목록이 이것이다.
  assert.ok(i.missingKeys().some((m) => m.key === "없는.키.이름"), "누락을 남기지 않았다");
});

test("같은 키를 여러 번 불러도 **누락은 1건** — 개수가 아니라 목록이 필요하다", () => {
  const i = new I18n({ catalogs: catalog });
  for (let n = 0; n < 5; n++) i.t("panel.log");
  assert.equal(i.missingKeys().length, 0);
  i.t("x.y");
  i.t("x.y");
  i.t("x.y");
  assert.equal(i.missingKeys().filter((m) => m.key === "x.y").length, 1, "같은 누락을 여러 번 셌다");
});

test("다른 언어에 **번역이 없으면 한국어로** — 빈 화면이 아니라 원래 문장으로", () => {
  const i = new I18n({ catalogs: { ko, en: {} } });
  i.setLocale("en");
  // 영어 카탈로그가 비어 있으므로 **한국어** 로 떨어져야 한다.
  assert.equal(i.t("panel.terminal"), "터미널", "번역 전 화면이 빈칸이 되었다");
  assert.ok(i.missingKeys().some((m) => m.locale === "en"), "영어 누락이 기록되지 않았다");
});

test("**없는 변수** 는 중괄호로 남는다 — 조용히 지우면 중괄호만 사라진다", () => {
  const i = new I18n({ catalogs: { ko: { "a.x": "저장됨 ({{version}})" } } });
  assert.equal(i.t("a.x", { version: 7 }), "저장됨 (7)");
  // **빈 문자열로 채우지 않는다.** 원래 표기가 남아 있어야 어느 키가 비었는지 안다.
  assert.equal(i.t("a.x"), "저장됨 ({{version}})");
  assert.equal(i.t("a.x", { version: 0 }), "저장됨 (0)", "0 은 값이 있다 — 빈 문자열이 아니다");
});

test("**지원하지 않는 언어** 는 조용히 바꾸지 않는다 — 유지하고 알린다", () => {
  const i = new I18n({ catalogs: catalog });
  const r = i.setLocale("fr");
  assert.equal(r.ok, false);
  assert.equal(i.current, "ko", "모르는 언어로 바뀌었다");
  assert.match(r.detail, /fr/, "어떤 값이 문제였는지 말하지 않는다");
  assert.ok(LOCALES.includes("ko") && LOCALES.includes("en"), "지원 언어 목록이 바뀌었다");
});

test("구독자는 **언어가 바뀔 때만** 통보받는다", () => {
  const i = new I18n({ catalogs: catalog });
  const seen: string[] = [];
  const off = i.subscribe((l) => seen.push(l));
  i.setLocale("en");
  i.setLocale("en"); // 같은 언어 → 통보 없음(불필요한 리렌더 방지)
  off();
  i.setLocale("ko");
  assert.deepEqual(seen, ["en"], `구독 통보가 이상하다: ${seen.join(",")}`);
});

test("번역률 — **넣은 키 수** 기준. 없는 키를 100% 로 세지 않는다", () => {
  const i = new I18n({ catalogs: { ko, en: { "panel.terminal": "Terminal", "panel.log": "Server log" } } });
  const koCov = i.coverage("ko");
  const enCov = i.coverage("en");
  assert.equal(koCov.percent, 100);
  assert.equal(enCov.percent < 100, true, "번역 2건인데 100% 로 나왔다");
  assert.ok(enCov.translated <= enCov.keys, "키 수보다 많이 세었다");
});

test("실행 중에도 번역을 **추가할 수 있다** — 서버가 늦게 와도 반영된다", () => {
  const i = new I18n({ catalogs: catalog });
  i.setLocale("en");
  assert.equal(i.t("panel.terminal"), "터미널", "추가 전에는 한국어 fallback");
  i.add("en", { "panel.terminal": "Terminal" });
  assert.equal(i.t("panel.terminal"), "Terminal", "늦게 온 번역을 반영하지 않았다");
});

test("문서 없이 **DOM 이 없는 환경**(스크립트·테스트)에서도 안전하다", () => {
  // `document` 가 없으면 `html lang` 동기화를 건너뛴다 — 서버 스크립트가 이 모듈을
  // 불러도 죽지 않아야 한다(여기서 죽으면 부팅이 죽는다).
  const i = new I18n({ catalogs: catalog });
  assert.doesNotThrow(() => i.setLocale("en"));
  assert.equal(i.current, "en");
});

test("카탈로그의 키는 **모두 채워져** 있다 — 빈 문자열 항목을 만들지 않는다", () => {
  const empty = Object.entries(ko).filter(([, v]) => typeof v !== "string" || v.trim() === "");
  assert.deepEqual(empty.map(([k]) => k), [], "빈 항목이 있다 — 화면에 빈칸이 생긴다");
});
