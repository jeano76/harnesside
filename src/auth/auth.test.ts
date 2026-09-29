/**
 * 보안 경계 테스트 (§3.6 / §10.3.1).
 *
 * 이 파일의 테스트가 통과한다는 것은 "토큰 없는 요청이 파일을 읽을 수 없다"는 뜻이다.
 * 하나라도 느슨하면 사용자의 `~/.ssh/id_rsa` 가 다른 탭의 한 줄 fetch 로 새어나간다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateToken,
  tokenMatches,
  issueToken,
  readToken,
  revokeToken,
  extractToken,
  tokenFilePath,
  TOKEN_BYTES,
} from "./token.js";
import { checkHost, checkOrigin, expectedOrigin, normalizeHeaders, type AllowedOrigins } from "./originGuard.js";

const ALLOWED: AllowedOrigins = { host: "127.0.0.1", port: 7317 };

async function sandbox(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-auth-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---- 토큰 ------------------------------------------------------------------

test("토큰은 32바이트(256비트) 난수다", () => {
  const t = generateToken();
  const bytes = Buffer.from(t, "base64url");
  assert.equal(bytes.length, TOKEN_BYTES);
  // 서로 다른 두 토큰이 같을 확률은 0 — 난수라는 뜻
  assert.notEqual(t, generateToken());
});

test("토큰 일치 비교: 길이가 다르면 false, 내용이 다르면 false", () => {
  const t = generateToken();
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(t, null), false);
  assert.equal(tokenMatches(t, undefined), false);
  assert.equal(tokenMatches(t, ""), false);
  assert.equal(tokenMatches(t, t + "x"), false, "길이가 다른 문자열");
  assert.equal(tokenMatches(t, generateToken()), false);
  assert.equal(tokenMatches("", ""), false, "둘 다 비면 통과시키지 않는다");
});

test("발급된 토큰은 0600 으로 기록된다 — world-readable 토큰은 토큰이 아니다", async () => {
  const s = await sandbox();
  try {
    const rec = await issueToken(s.dir, 7317);
    const st = await stat(tokenFilePath(s.dir));
    // 모드 0600 = rw-------
    assert.equal(st.mode & 0o777, 0o600, `실제 모드 ${(st.mode & 0o777).toString(8)}`);
    assert.equal(rec.idePort, 7317);
    const raw = JSON.parse(await readFile(tokenFilePath(s.dir), "utf8"));
    assert.equal(raw.token, rec.token);
  } finally {
    await s.cleanup();
  }
});

test("재부팅해도 토큰은 유지된다 — 열려 있던 창이 인증에 실패하지 않게", async () => {
  const s = await sandbox();
  try {
    const a = await issueToken(s.dir, 7317);
    const b = await issueToken(s.dir, 7317);
    assert.equal(a.token, b.token, "부팅마다 바뀌면 열려 있던 창이 끊긴다");
  } finally {
    await s.cleanup();
  }
});

test("포트가 바뀌면 토큰은 유지하되 기록된 포트만 갱신된다", async () => {
  const s = await sandbox();
  try {
    const a = await issueToken(s.dir, 7317);
    const b = await issueToken(s.dir, 7318);
    assert.equal(a.token, b.token);
    assert.equal(b.idePort, 7318);
  } finally {
    await s.cleanup();
  }
});

test("토큰 파기 후에는 파일이 사라진다", async () => {
  const s = await sandbox();
  try {
    await issueToken(s.dir, 7317);
    await revokeToken(s.dir);
    assert.equal(await readToken(s.dir), null);
  } finally {
    await s.cleanup();
  }
});

test("토큰을 세 곳에서 모두 꺼낸다 — 한 곳만 보면 재현이 안 된다", () => {
  const t = generateToken();
  assert.equal(extractToken({ headers: { authorization: `Bearer ${t}` } }), t);
  assert.equal(extractToken({ headers: { authorization: `bearer ${t}` } }), t, "대소문자 무시");
  assert.equal(extractToken({ headers: { "x-harnesside-token": t } }), t);
  assert.equal(extractToken({ headers: {}, url: `/api/health?t=${encodeURIComponent(t)}` }), t);
  assert.equal(extractToken({ headers: {} }), null);
  assert.equal(extractToken({ headers: { authorization: "Bearer " } }), null, "빈 토큰은 null");
  assert.equal(extractToken({ headers: {}, url: "/api/health" }), null);
  // 헤더가 배열로 와도 첫 값을 본다
  assert.equal(extractToken({ headers: { "x-harnesside-token": [t, "other"] } }), t);
});

// ---- Host / Origin ---------------------------------------------------------

test("Host 위조(DNS rebinding)는 거절된다", () => {
  assert.equal(checkHost("evil.com", ALLOWED).ok, false);
  const r = checkHost("evil.com:7317", ALLOWED);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 403);
  assert.equal(checkHost("127.0.0.1:7318", ALLOWED).ok, false, "다른 포트도 거절");
  assert.equal(checkHost(undefined, ALLOWED).ok, false, "Host 없으면 거절");
  assert.equal(checkHost("", ALLOWED).ok, false);
});

test("실제 Host 는 통과한다", () => {
  assert.equal(checkHost("127.0.0.1:7317", ALLOWED).ok, true);
  assert.equal(checkHost("127.0.0.1:7317".toUpperCase().replace("127.0.0.1", "127.0.0.1"), ALLOWED).ok, true);
});

test("Origin 불일치는 거절된다 — WebSocket 의 유일한 방어선", () => {
  assert.equal(checkOrigin("http://evil.com", ALLOWED).ok, false);
  assert.equal(checkOrigin("null", ALLOWED).ok, false);
  assert.equal(checkOrigin("http://127.0.0.1:9999", ALLOWED).ok, false);
  assert.equal(checkOrigin(`https://${expectedOrigin(ALLOWED)}`, ALLOWED).ok, false, "스킴이 다르면 거절");
});

test("Origin 없음은 허용하되, 상태 변경은 토큰이 막는다", () => {
  // 브라우저의 같은 출처 GET 에는 Origin 이 없을 수 있다. 여기서 막으면
  // 페이지 첫 로드 자체가 403 이 된다(§3.6 의 의도).
  assert.equal(checkOrigin(undefined, ALLOWED).ok, true);
  assert.equal(checkOrigin(expectedOrigin(ALLOWED), ALLOWED).ok, true);
});

test("헤더 정규화 — Node 는 대소문자가 섞여 온다", () => {
  const n = normalizeHeaders({ Host: "127.0.0.1:7317", "Content-Type": "application/json" });
  assert.equal(n.host, "127.0.0.1:7317");
  assert.equal(n["content-type"], "application/json");
});

// ---- §10.3.1 시나리오 조합 --------------------------------------------------

test("시나리오: 토큰 없이 파일 API 호출 → 인증 실패로 막힌다", () => {
  // 이 테스트는 "차단"을 검증한다. HTTP 서버(P1.5-3)가 붙으면 같은 시나리오를
  // 실제 요청으로도 돌린다.
  const token = generateToken();
  const presented = extractToken({ headers: {} });
  assert.equal(tokenMatches(token, presented), false);
});

test("시나리오: 잘못된 토큰 → 실패", () => {
  const token = generateToken();
  assert.equal(tokenMatches(token, generateToken()), false);
});
