/**
 * 기동 프로브 검사 — "떴다" 와 "우리 자식이 떴다" 를 구분한다.
 *
 * 구분을 못하면 남의 서버를 우리 자식으로 믿고(adopt 혼동), 낡은 서버를
 * 새 버전으로 믿는다(§④ 21 — 이름이 아니라 리소스로 판정한다).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { supervisedHello, type SupervisedProbeDeps } from "./probe.js";

function deps(over: Partial<SupervisedProbeDeps> = {}): SupervisedProbeDeps {
  return {
    readPortFile: async () => 7317,
    fetchHealth: async () => ({ ok: true, startedAt: 2000 }),
    spawnStartedAt: 1000,
    ...over,
  };
}

test("포트 파일이 없으면 아니다 — 모르는 포트를 두드리지 않는다", async () => {
  assert.equal(await supervisedHello(deps({ readPortFile: async () => null })), false);
});

test("파일 읽기가 던져도 아니다 — 조용히 실패지 조용히 성공이 아니다", async () => {
  assert.equal(
    await supervisedHello(
      deps({
        readPortFile: async () => {
          throw new Error("EACCES");
        },
      })
    ),
    false
  );
});

test("헬스가 안 뜨면 아니다", async () => {
  assert.equal(await supervisedHello(deps({ fetchHealth: async () => null })), false);
  assert.equal(
    await supervisedHello(
      deps({
        fetchHealth: async () => {
          throw new Error("ECONNREFUSED");
        },
      })
    ),
    false
  );
});

test("ok 가 아니면 아니다", async () => {
  assert.equal(await supervisedHello(deps({ fetchHealth: async () => ({ ok: false, startedAt: 2000 }) })), false);
});

test("startedAt 이 없으면 아니다 — 누구 서버인지 모른다", async () => {
  assert.equal(await supervisedHello(deps({ fetchHealth: async () => ({ ok: true }) })), false);
});

test("낡은 startedAt 은 남의 서버다 — 스폰 이전 기동은 인정하지 않는다", async () => {
  assert.equal(await supervisedHello(deps({ spawnStartedAt: 5000 })), false);
});

test("이번 스폰 이후 기동이면 인정한다", async () => {
  assert.equal(await supervisedHello(deps()), true);
});
