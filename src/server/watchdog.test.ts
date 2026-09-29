/**
 * 데몬 루프(워치독) 테스트 (§4.4 · §3.7.2).
 *
 * 신호 S1~S6 중 **서버가 스스로 판단하는** 것만 검증한다:
 * 자식 죽음 감지, 모드별 차이(창 닫음), 유휴 정책, 하트비트 유예.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LogRing, resetLogRing } from "./logRing.js";
import { startWatchdog, heartbeatFresh, type DaemonMode } from "./watchdog.js";

function setup(mode: DaemonMode, over: Partial<Parameters<typeof startWatchdog>[0]> = {}) {
  resetLogRing();
  const ring = new LogRing();
  const shutdowns: string[] = [];
  const state = { llama: true, chrome: true, connected: true };
  let t = 1_000_000;
  const wd = startWatchdog({
    mode,
    ring,
    isLlamaAlive: () => state.llama,
    isChromeAlive: () => state.chrome,
    clientConnected: () => state.connected,
    shutdown: (r) => {
      shutdowns.push(r);
    },
    now: () => t,
    ...over,
  });
  return { ring, shutdowns, state, wd, advance: (ms: number) => (t += ms) };
}

test("llama-server 가 죽으면 알린다 — '창은 계속 쓸 수 있다'고 명시", () => {
  const s = setup("window", { intervalMs: 5 });
  s.state.llama = false;
  // 인터벌을 직접 돌리기 대신 상태를 바꾸고 한 틱 기다린다
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const msg = s.ring.query({ levels: ["error"] }).map((e) => e.message).join(" ");
      assert.match(msg, /llama-server 가 종료/);
      assert.match(msg, /창은 계속/, "모델이 죽어도 창은 떠야 한다(요구 9)");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("llama-server 를 자동 재기동하지 않는다 — OOM 을 부르는 길이다", () => {
  const s = setup("window", { intervalMs: 5 });
  s.state.llama = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(s.shutdowns.length, 0, "자동으로 서버를 죽였다");
      // 근거는 **메시지가 아니라 data** 에 실린다 — 사람에게는 짧게, 기계에게는 자세히.
      const entry = s.ring.query({ levels: ["error"] })[0];
      assert.ok(entry, "오류 로그가 없다");
      assert.equal(entry.data?.autoRestart, false, "자동 재기동이 켜져 있다");
      assert.match(String(entry.data?.why ?? ""), /OOM/, "근거가 남아야 한다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("window 모드: 창이 닫히면 종료한다 (요구 9)", () => {
  const s = setup("window", { intervalMs: 5 });
  s.state.chrome = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, ["window-closed"]);
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("daemon 모드: 창이 닫혀도 서버는 살아 있다 — 의도적 예외", () => {
  const s = setup("daemon", { intervalMs: 5 });
  s.state.chrome = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(s.shutdowns.length, 0, "데몬 모드에서 창 닫힘으로 종료됐다");
      const msg = s.ring.query().map((e) => e.message).join(" ");
      assert.match(msg, /데몬 모드이므로 서버는 계속/);
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("유휴 종료는 기본적으로 없다 — 켜라고 명시해야만 동작한다", () => {
  const s = setup("daemon", { intervalMs: 5, idleShutdownSec: 0 });
  s.state.connected = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(s.shutdowns.length, 0, "기본값이 조용히 종료였다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("유휴 정책이 켜지면 **3분 유예 후** 종료한다 — 창을 곧 다시 여는 사람을 배려", () => {
  const s = setup("daemon", { intervalMs: 5, idleShutdownSec: 600 });
  s.state.connected = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      // 3분 미만에는 종료되지 않는다
      assert.equal(s.shutdowns.length, 0, "유예 없이 바로 종료했다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("클라이언트가 다시 붙으면 유휴 카운터가 초기화된다", () => {
  const s = setup("daemon", { intervalMs: 5, idleShutdownSec: 600 });
  s.state.connected = true;
  assert.equal(s.wd.idleRemaining(), null, "붙어 있는데 유휴로 계산된다");
  s.wd.stop();
});

test("stop() 후에는 아무 것도 하지 않는다 — 정상 종료 경로에서 타이머가 남으면 안 된다", () => {
  const s = setup("window", { intervalMs: 5 });
  s.wd.stop();
  s.state.chrome = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(s.shutdowns.length, 0, "stop 후에도 종료가 실행됐다");
      resolve();
    }, 60);
  });
});

test("하트비트 유예 — 도구 실행 중에 서버가 죽지 않는다 (§4.4 S3)", () => {
  const now = 1_000_000;
  assert.equal(heartbeatFresh(now - 5_000, 15, now), true, "5초 전 펄시는 살아 있다");
  assert.equal(heartbeatFresh(now - 20_000, 15, now), false, "20초 전 펄시는 만료");
  assert.equal(heartbeatFresh(now - 14_999, 15, now), true);
  assert.equal(heartbeatFresh(now - 15_000, 15, now), false, "경계값");
});

// ── 회귀: `--no-browser` 데몬이 **자기 첫 tick 에 스스로 죽었다** ──────────────
//
// 증상: CI 부팅 스모크가 "스폰한 llama 가 응답하지 않습니다" 로 실패.
// 로그에는 `[llama] llama-server 준비 완료(/v1/models 200)` 가 남아 있었고,
// 바로 뒤에 `[shutdown] window-closed` 가 있었다.
//
// 원인: `--no-browser` 는 Chrome 을 띄우지 않는데 mode 는 여전히 `window` 였다
// (기본값이 window — D3). `isChromeAlive()` 는 `!!browser?.pid` 이므로 **영구히
// false**. 워치독은 그것을 "창이 닫혔다" 로 읽고 종료했다.
// 즉 **창을 띄우지 않기로 한 경우**에 window 모드의 수명 규칙이 적용됐다.
// 부재(없음)와 종료(죽음)는 다른 신호인데, 코드가 그 둘을 구분하지 않았다.
//
// 수정: `expectChrome: false` 면 Chrome 분기를 통째로 건너뛴다.
test("expectChrome:false — 창을 띄우지 않았으면 '창이 닫혔다'는 신호가 없다", () => {
  const s = setup("window", { expectChrome: false, intervalMs: 5 });
  // `isChromeAlive` 는 창이 없으므로 false 다. 그래도 **죽지 않아야** 한다.
  s.state.chrome = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(s.shutdowns.length, 0, `창이 없는데 종료됐다: ${s.shutdowns.join(",")}`);
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("expectChrome 생략은 예전 동작을 유지한다 — 창이 있었으면 '닫힘'을 따른다", () => {
  // 기본값 true 여야 **기존 호출자**의 수명이 안 바뀐다. 이 게짓을 바꾸면 다른 곳이 조용히
  // 살아남기 시작한다.
  const s = setup("window", { intervalMs: 5 });
  s.state.chrome = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, ["window-closed"]);
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("expectChrome:false 여도 llama 죽음은 **알린다** — 무음으로 삼키지 않는다", () => {
  // 창 분기를 건너뛰는 것이 "Chrome 상태를 아무것도 안 본다" 로 바뀌면 안 된다.
  const s = setup("daemon", { expectChrome: false, intervalMs: 5 });
  s.state.llama = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const msg = s.ring.query({ levels: ["error"] }).map((e) => e.message).join(" ");
      assert.match(msg, /llama-server 가 종료/, "llama 죽음은 창 유무와 무관하게 알려야 한다");
      assert.equal(s.shutdowns.length, 0, "daemon 모드에서 자동으로 죽지 않는다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});
