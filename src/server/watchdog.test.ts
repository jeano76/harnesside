/**
 * 데몬 루프(워치독) 테스트 (§4.4 · §3.7.2).
 *
 * 신호 S1~S6 중 **서버가 스스로 판단하는** 것만 검증한다:
 * 자식 죽음 감지, 모드별 차이(창 닫음), 유휴 정책, 하트비트 유예.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LogRing, resetLogRing } from "./logRing.js";
import { startWatchdog, heartbeatFresh, windowStateOf, type DaemonMode } from "./watchdog.js";

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

// ── S3: 웹 클라이언트 하트비트 만료(§4.4) ───────────────────────────────────

test("S3: 클라이언트가 사라진 지 임계값을 넘으면 window 모드에서 종료한다", () => {
  const s = setup("window", { intervalMs: 5, clientIdleThresholdSec: 15, msSinceLastClientGone: () => 20_000 });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, ["heartbeat-expired"], "S3 가 종료 사유를 말한다");
      const msg = s.ring.query().map((e) => e.message).join(" ");
      assert.match(msg, /클라이언트/, "왜인지 로그에 남는다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S3: **한 번도 붙은 적 없으면** 판정하지 않는다 — 아직 안 뜬 창을 죽이면 안 된다", () => {
  // `null` 과 `0ms` 는 다른 사실이다. 부팅 직후에는 0 이고, 여기서 0 을 "만료" 로
  // 읽으면 서버가 **자기 첫 tick 에** 죽는다(부재와 종료는 다른 신호다 — §④ 표 25).
  const s = setup("window", { intervalMs: 5, clientIdleThresholdSec: 15, msSinceLastClientGone: () => null });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "아직 클라이언트가 붙은 적도 없다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S3: 임계값 미만이면 조용히 기다린다 — 재접속(새로고침)을 죽이지 않는다", () => {
  const s = setup("window", { intervalMs: 5, clientIdleThresholdSec: 15, msSinceLastClientGone: () => 3_000 });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "3초는 15초가 아니다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S3: 유예 사유가 있으면 종료하지 않고 **사유를 말한다**", () => {
  // §4.4: 진행 중 백그라운드 프로세스나 idleShutdownSec 이 있으면 유예한다.
  // 조용히 기다리면 사용자는 "왜 아직 살아 있지" 라고 읽는다.
  const s = setup("window", {
    intervalMs: 5,
    clientIdleThresholdSec: 15,
    msSinceLastClientGone: () => 60_000,
    deferS3: () => "진행 중인 턴이 있습니다",
  });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "유예 중인데 종료했다");
      const entry = s.ring.query().find((e) => /유예/.test(e.message));
      assert.ok(entry, "유예 사실을 로그에 남긴다");
      assert.match(String(entry?.data?.why ?? ""), /턴/, "사유가 data 에 실린다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S3: daemon 모드에서는 클라이언트가 없어도 서버가 살아 있다 (§4.4 의 의도적 예외)", () => {
  const s = setup("daemon", { intervalMs: 5, clientIdleThresholdSec: 15, msSinceLastClientGone: () => 99_000 });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "데몬 모드에서 S3 로 종료됐다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S3 판정 함수가 없으면 아무 일도 없다 — 규칙이 없는데 결과만 있으면 그것도 거짓말이다", () => {
  const s = setup("window", { intervalMs: 5 });
  s.state.chrome = true;
  s.state.connected = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "판정값 없이 종료됐다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

// ── S6: 고아 데몬 ───────────────────────────────────────────────────────────

test("S6: 창도 모델도 없고 클라이언트도 없으면 알린다 — 종료는 하지 않는다", () => {
  const s = setup("daemon", { intervalMs: 5 });
  s.state.llama = false;
  s.state.chrome = false;
  s.state.connected = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "S6 로 종료하면 S1/S3 과 구분할 수 없다 — 어느 신호가 먹었나");
      const entry = s.ring.query({ levels: ["error"] }).find((e) => /고아/.test(e.message));
      assert.ok(entry, "고아 상태를 말해야 한다");
      assert.equal(entry?.data?.signal, "S6");
      assert.equal(entry?.data?.shutdown, false, "왜 안 죽는지 data 에 있다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S6: 하나라도 살아 있으면 고아 아니다", () => {
  const s = setup("daemon", { intervalMs: 5 });
  s.state.llama = false;
  s.state.chrome = false;
  s.state.connected = true; // 클라이언트가 붙어 있다
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(
        s.ring.query({ levels: ["error"] }).some((e) => /고아/.test(e.message)),
        false,
        "클라이언트가 붙어 있는데 고아라고 했다"
      );
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S6: 창을 띄우지 않는 모드에서도 판정한다 — '창이 죽었다'는 말이 안 되는 곳", () => {
  // `--no-browser` 에서 "창이 죽음" 은 성립하지 않는다. 그 조건을 그대로 쓰면
  // **창 없는 데몬은 영원히 고아가 되지 않는다** — 실제 첫 실행이 그렇게 조용히
  // 실패했다(모델도 없고 사람도 없는데 아무 말도 안 함).
  const s = setup("daemon", { intervalMs: 5, expectChrome: false, chromeState: () => "alive" });
  s.state.llama = false;
  s.state.connected = false;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const entry = s.ring.query({ levels: ["error"] }).find((e) => /고아/.test(e.message));
      assert.ok(entry, "창 없는 모드에서 고아를 말해야 한다");
      assert.deepEqual(s.shutdowns, [], "그래도 죽이지 않는다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

// ── "못 띄움" 과 "닫힘" 의 구분(창 기동 실패가 서버를 죽이면 안 된다) ──────────

test("창을 띄우지 못한 것은 닫힌 것이 아니다 — 서버를 죽이지 않는다", () => {
  // 실제로 이 구분이 없을 때: DISPLAY 가 없어 CDP 가 안 붙으면 `pid` 가 없거나 죽어서
  // 곧바로 "창이 닫혔다" 로 읽혔고, llama 는 정상 응답 중인데 데몬이 스스로 죽었다.
  const s = setup("window", { intervalMs: 5, chromeState: () => "never-opened" });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "띄우지 못한 것을 종료로 읽었다");
      const msg = s.ring.query().map((e) => e.message).join(" ");
      assert.match(msg, /창을 띄우지 못했습니다/, "원인을 말한다");
      assert.doesNotMatch(msg, /창이 닫혔습니다/, "닫힘으로 기록하면 원인이 사라진다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("chromeState 가 dead 면 종료한다 — 판정 함수를 한 곳에 모은 이유", () => {
  const s = setup("window", { intervalMs: 5, chromeState: () => "dead" });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, ["window-closed"]);
      s.wd.stop();
      resolve();
    }, 80);
  });
});

// ── S4: CDP 연결 소실(재연결 2회 실패) ───────────────────────────────────────

test("S4: CDP 를 되찾지 못하면 window 모드에서 종료한다", () => {
  const s = setup("window", { intervalMs: 5, cdpState: () => "lost" });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, ["cdp-lost"], "S4 가 자기 사유로 종료한다");
      const entry = s.ring.query({ levels: ["error"] }).find((e) => /CDP|연결/.test(e.message));
      assert.ok(entry, "왜인지 말한다");
      assert.equal(entry?.data?.signal, "S4");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S4: 창이 살아 있어도 발동한다 — pid 는 멀쩡하므로 S1 이 못 잡는다", () => {
  const s = setup("window", { intervalMs: 5, cdpState: () => "lost", chromeState: () => "alive" });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, ["cdp-lost"], "Chrome 이 살아 있다는 이유로 S4 를 건너뛰면 신호를 놓친다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S4: daemon 모드에서는 알리기만 한다", () => {
  const s = setup("daemon", { intervalMs: 5, cdpState: () => "lost" });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "데몬 모드에서 CDP 소실로 죽으면 안 된다");
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S4: `none` 은 판정 대상이 아니다 — 감시를 안 켰다고 CDP 가 죽은 게 아니다", () => {
  const s = setup("window", { intervalMs: 5, cdpState: () => "none" });
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, []);
      s.wd.stop();
      resolve();
    }, 80);
  });
});

test("S4: 재연결에 성공하면 다시 `connected` — 한 번의 끊김은 신호가 아니다", () => {
  let state: "connected" | "lost" | "none" = "lost";
  const s = setup("window", { intervalMs: 5, cdpState: () => state });
  state = "connected";
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(s.shutdowns, [], "복구됐는데 종료했다");
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

// ── 창 상태 판정: "떠 있다가 닫힘" 은 "못 띄움" 이 아니다 ─────────────────────────

test("windowStateOf: 떠 있던 창이 사라지면 dead — 닫힘으로 읽어 S1 이 발동하게 한다", () => {
  const closedByUser = { noBrowser: false, pidAlive: false, wasAlive: true, launchAttempted: true };
  assert.equal(windowStateOf(closedByUser), "dead", "닫은 창을 못 띄움으로 읽으면 S1 이 막힌다");
});

test("windowStateOf: 한 번도 뜨지 않았으면 never-opened", () => {
  const failed = { noBrowser: false, pidAlive: false, wasAlive: false, launchAttempted: true };
  assert.equal(windowStateOf(failed), "never-opened");
});

test("windowStateOf: 띄우지 않는 모드(--no-browser)와 살아 있는 창은 alive", () => {
  assert.equal(windowStateOf({ noBrowser: true, pidAlive: false, wasAlive: true, launchAttempted: true }), "alive");
  assert.equal(windowStateOf({ noBrowser: false, pidAlive: true, wasAlive: true, launchAttempted: true }), "alive");
  assert.equal(windowStateOf({ noBrowser: false, pidAlive: false, wasAlive: false, launchAttempted: false }), "alive");
});
