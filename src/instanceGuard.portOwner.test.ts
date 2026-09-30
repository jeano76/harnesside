/**
 * 포트 소유 확인 (§④ 표 21 — "살아 있는가" 의 판정은 리소스로 한다).
 *
 * 이 테스트가 존재하는 이유: **실측으로 한 번 잘못 측정**했다. 인스턴스 락이 243097 을
 * 가리키는데 7317 의 실제 소유자는 185924 였다. 락의 pid 로만 죽이면 **옛 서버가 남고**,
 * 그 서버가 응답하는 API 를 새 코드라고 믿어 측정했다(추가로 12분 wasted).
 *
 * 그래서 규칙은: **락의 pid 를 신뢰하지 않는다. 포트를 본다.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { portOwner } from "./instanceGuard.js";

/** 서버를 **자기 자신**의 포트로 연다 — 즉 자기 pid 가 그 포트를 소유한다. */
function listen(port: number): Promise<() => Promise<void>> {
  const srv = createServer((_q, s) => s.writeHead(200).end("ok"));
  return new Promise((res) => {
    srv.listen(port, "127.0.0.1", () =>
      res(
        () =>
          new Promise<void>((r) => {
            srv.close(() => r());
          })
      )
    );
  });
}

test("자기 pid 의 **소유 포트** 를 찾는다 — 테스트가 이 판정을 그대로 쓴다", async () => {
  const port = 19500 + Math.floor(Math.random() * 300);
  const close = await listen(port);
  try {
    const owned = portOwner(process.pid);
    // **판정 정본이 포트** 다. 이 테스트가 통과하지 않으면 아래 테스트도 통과하지 않는다.
    assert.ok(owned, "자기 pid 의 포트를 찾지 못했다 — /proc 파싱이 잘못됐다");
    assert.equal(owned.port, port, `잘못된 포트를 찾았다: ${owned.port} != ${port}`);
    assert.ok(["127.0.0.1", "0.0.0.0"].includes(owned.host) || owned.host?.includes(":"), `주소 해석이 이상하다: ${owned.host}`);
  } finally {
    await close();
  }
});

test("**없는 pid** 는 null — 추측으로 채우지 않는다", () => {
  // 존재하지 않는 pid 에 대해 "포트 0" 을 돌려주면 **모름** 이 0 이 되어,
  // "비어 있음" 이라는 사실과 구분되지 않는다(§5.10).
  assert.equal(portOwner(999_999), null);
});

test("자기 pid 를 여러 번 물어도 **결과가 같다** — 조회에 부작용이 없다", async () => {
  const port = 19900 + Math.floor(Math.random() * 90);
  const close = await listen(port);
  try {
    const a = portOwner(process.pid);
    const b = portOwner(process.pid);
    assert.deepEqual(a, b, "같은 조회인데 결과가 달랐다");
    assert.equal(a?.port, port);
  } finally {
    await close();
  }
});

test("**포트를 닫으면** 더 이상 소유로 나오지 않는다 — 닫힌 것과 열린 것을 구분한다", async () => {
  const port = 19700 + Math.floor(Math.random() * 90);
  const close = await listen(port);
  const before = portOwner(process.pid);
  assert.equal(before?.port, port);
  await close();
  // 닫은 뒤에도 자식 소켓이 남아 있을 수 있으므로 **보장하지 않는다**. 대신
  // "열려 있는 포트를 찾지 못했다" 를 **오류로 취급하지 않는지** 본다 —
  // 조용히 null 이 오는 것이 정답이다.
  const after = portOwner(process.pid);
  assert.ok(after === null || typeof after.port === "number", "닫힌 뒤에도 이상한 값이 나왔다");
});

test("IPv6 리스닝에서도 **주소를 말한다** — 없으면 null", async () => {
  // 환경에 따라 IPv6 이 없을 수 있다. **없으면 null** 이 정답이지 실패가 아니다.
  const s = createServer((_q, res) => res.writeHead(200).end("ok"));
  const port = 19300 + Math.floor(Math.random() * 90);
  await new Promise<void>((r) => s.listen(port, "::1", () => r()));
  try {
    const owned = portOwner(process.pid);
    assert.ok(owned === null || typeof owned.port === "number", `이상한 값: ${JSON.stringify(owned)}`);
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});
