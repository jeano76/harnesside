/**
 * 재시작 정책 검사 — 판정이 뒤집히면 감시기가 "꺼지지 않는 서버" 나
 * "무한 재시작" 이 된다. 둘 다 조용히 망가지는 쪽이라 여기서 고정한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decideRestart,
  describeExit,
  DEFAULT_SUPERVISOR_POLICY,
  type SupervisorPolicy,
} from "./policy.js";

const POL: SupervisorPolicy = { maxRestarts: 3, windowSec: 300, backoffBaseSec: 2, backoffMaxSec: 60 };

test("code 0 은 종료지 죽음이 아니다 — 다시 띄우면 꺼지지 않는 서버가 된다", () => {
  const d = decideRestart({ code: 0, signal: null }, [], 1000, POL);
  assert.equal(d.action, "stop");
  assert.equal(d.delaySec, 0);
  assert.match(d.reason, /정상 종료/);
});

test("0이 아닌 코드는 다시 띄운다 — 기본 대기로", () => {
  const d = decideRestart({ code: 1, signal: null }, [], 1000, POL);
  assert.equal(d.action, "restart");
  assert.equal(d.delaySec, 2);
  assert.match(d.reason, /code 1/);
});

test("시그널 죽음도 다시 띄운다 — 이유에 시그널이 남는다", () => {
  const d = decideRestart({ code: null, signal: "SIGTERM" }, [], 1000, POL);
  assert.equal(d.action, "restart");
  assert.match(d.reason, /SIGTERM/);
});

test("죽을수록 더 기다린다 — 2초·4초·8초", () => {
  assert.equal(decideRestart({ code: 1, signal: null }, [999], 1000, POL).delaySec, 4);
  assert.equal(decideRestart({ code: 1, signal: null }, [998, 999], 1000, POL).delaySec, 8);
});

test("대기는 상한을 넘지 않는다", () => {
  const small: SupervisorPolicy = { ...POL, backoffMaxSec: 5 };
  assert.equal(decideRestart({ code: 1, signal: null }, [998, 999], 1000, small).delaySec, 5);
});

test("윈도우 밖의 옛 죽음은 세지 않는다 — 회복한 서버를 벌하지 않는다", () => {
  const d = decideRestart({ code: 1, signal: null }, [100, 200], 1000, POL);
  assert.equal(d.action, "restart");
  assert.equal(d.delaySec, 2, "10분 전 죽음이 대기를 늘렸다");
});

test("윈도우 안에 상한만큼 죽으면 멈춘다 — 무한 재시작 금지", () => {
  const d = decideRestart({ code: 1, signal: null }, [900, 950, 999], 1000, POL);
  assert.equal(d.action, "stop");
  assert.equal(d.delaySec, 0);
  assert.match(d.reason, /멈춥/);
});

test("기본 정책은 5회·5분·2초~60초 — 바꾸면 이 검사가 말한다", () => {
  assert.deepEqual(DEFAULT_SUPERVISOR_POLICY, {
    maxRestarts: 5,
    windowSec: 300,
    backoffBaseSec: 2,
    backoffMaxSec: 60,
  });
});

test("종료 설명은 코드·시그널·불명을 구분한다", () => {
  assert.equal(describeExit({ code: 1, signal: null }), "code 1");
  assert.equal(describeExit({ code: null, signal: "SIGKILL" }), "signal SIGKILL");
  assert.equal(describeExit({ code: null, signal: null }), "원인 불명");
});
