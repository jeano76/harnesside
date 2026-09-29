/**
 * 토큰 URL 제거 테스트 (§3.6 수용 기준: "토큰이 URL 주소창에 남지 않는다").
 *
 * 스크린샷·복사·셸 히스토리에 토큰이 남으면 그건 사실상 공개다. 이 테스트는
 * "제거한다"가 아니라 "제거한 뒤에도 앱이 동작할 수 있는 상태를 남긴다" 를 본다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveToken, consumeTokenFromUrl, authHeaders, wsUrl, readStoredToken } from "./session.js";

function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

test("URL 쿼리의 토큰을 뽑고 URL 에서 지운다", () => {
  const s = memStorage();
  const { token, cleanHref } = consumeTokenFromUrl("http://127.0.0.1:7317/?t=SEKRIT", s);
  assert.equal(token, "SEKRIT");
  assert.equal(cleanHref.includes("SEKRIT"), false, "정리된 URL 에 토큰이 남아 있다");
  assert.equal(cleanHref, "/");
});

test("빈 쿼리 문자열까지 지운다 — 스크린샷에 '?' 만 남는 것도 흔적이다", () => {
  const { cleanHref } = consumeTokenFromUrl("http://127.0.0.1:7317/?t=ABC&debug=1", memStorage());
  assert.equal(cleanHref, "/?debug=1", cleanHref);
  assert.equal(cleanHref.endsWith("?"), false);
});

test("해시(#)는 보존된다", () => {
  const { cleanHref } = consumeTokenFromUrl("http://127.0.0.1:7317/?t=ABC#panel", memStorage());
  assert.equal(cleanHref, "/#panel", cleanHref);
});

test("토큰을 스토리지에 저장한다 — WS 는 헤더를 못 넣으므로 필요", () => {
  const s = memStorage();
  consumeTokenFromUrl("http://127.0.0.1:7317/?t=ABC", s);
  assert.equal(readStoredToken(s), "ABC");
});

test("재접속은 저장된 토큰을 쓴다(URL 은 이미 깨끗하다)", () => {
  const s = memStorage();
  s.setItem("harnesside.token", "STORED");
  const { token, cleanHref } = resolveToken("http://127.0.0.1:7317/", s);
  assert.equal(token, "STORED");
  assert.equal(cleanHref, "/");
});

test("저장된 값이 없고 URL 에도 없으면 null — 조용히 빈 문자열을 쓰지 않는다", () => {
  const { token } = resolveToken("http://127.0.0.1:7317/", memStorage());
  assert.equal(token, null);
});

test("이전 버전이 URL 에 남긴 토큰 흔적도 치운다", () => {
  const s = memStorage();
  s.setItem("harnesside.token", "STORED");
  const { token, cleanHref } = resolveToken("http://127.0.0.1:7317/?t=STALE", s);
  assert.equal(token, "STORED", "저장된 값이 우선");
  assert.equal(cleanHref.includes("STALE"), false, "URL 의 낡은 토큰이 남아 있다");
});

test("해석 불가능한 URL 은 예외 없이 통과시킨다", () => {
  // base 를 붙였으므로 "not-a-url" 같은 상대 경로는 정상적으로 해석된다(경로로 취급).
  const rel = consumeTokenFromUrl("not-a-url", memStorage());
  assert.equal(rel.token, null);
  assert.equal(rel.cleanHref, "/not-a-url");

  // 파싱 자체가 불가능한 입력은 원본을 그대로 돌려준다(화면이 죽지 않아야 한다).
  const bad = consumeTokenFromUrl("http://[", memStorage());
  assert.equal(bad.token, null);
  assert.equal(bad.cleanHref, "http://[");
});

test("인증 헤더와 WS URL", () => {
  assert.deepEqual(authHeaders("T"), { Authorization: "Bearer T" });
  assert.deepEqual(authHeaders(null), {}, "토큰이 없으면 헤더를 아예 보내지 않는다");
  const u = wsUrl("T", 7317);
  assert.ok(u.startsWith("ws://127.0.0.1:7317/ws"), u);
  assert.ok(u.includes("t=T"), "WS 는 쿼리로만 전달할 수 있다");
});
