/**
 * 데몬 루프 유지 (단계 12, §3.2 [12]).
 *
 * 이 단계는 "아무것도 하지 않는" 것처럼 보이지만 **제일 오래 사는 코드**다.
 * 자기가 직접 띄운 llama-server 와 Chrome 이 죽어도 서버는 남고, 그 사실을
 * 사용자에게 알려야 한다 — 안 알려주면 "창이 저절로 닫혔다"는 설명되지 않는 일이 된다.
 *
 * 감시 대상은 세 가지다(§4.4 신호표와 1:1):
 *  - llama-server 자식: 죽으면 **죽었다고 말한다**(자동 재기동은 하지 않는다 —
 *    VRAM 8 GiB 에서 두 번째 서버는 즉시 OOM 한다.실측됨)
 *  - Chrome 자식: 죽으면 `window` 모드에서는 그대로 종료하고, `daemon` 모드에서는
 *    "창이 닫혔다"만 알린다(서버는 계속)
 *  - WS 클라이언트: 전부 나가면 유휴 정책 평가
 */

import type { LogRing } from "./logRing.js";

export type DaemonMode = "window" | "daemon";

/**
 * 창 상태. **세 가지로 나눈다** — 두 가지로는 부족했다.
 *
 * 예전에는 `isChromeAlive()` 한 개였다. 그래서 창을 **못 띄운** 경우와 창이 **닫힌**
 * 경우가 같아졌다: 못 띄우면 `pid` 가 없으므로 곧바로 "창이 닫혔다" 고 읽고
 * **자기 자신을 종료**했다(실측: DISPLAY 가 없어서 CDP 가 안 붙었을 때).
 * 사용자에게는 서버가 죽은 것처럼 보인다. 요구 9 의 degrade 와 정반대다.
 */
export type ChromeState = "alive" | "dead" | "never-opened";

export interface WatchdogDeps {
  mode: DaemonMode;
  ring: LogRing;
  /** 자식 상태 조회. 없으면 "모름"으로 본다. */
  isLlamaAlive?: () => boolean;
  isChromeAlive?: () => boolean;
  /**
   * Chrome 을 **애초에 띄우기로 했는지**. false 면 "창이 닫혔다" 는 신호가
   * **아예 성립하지 않는다** — 창이 없었으니까.
   *
   * 실제로 겪은 버그: `--no-browser` 로 띄우면 Chrome 을 띄우지 않는데도 mode 는
   * `window` 였다(D3: 기본이 window). 그러면 `isChromeAlive()` 가 **영구히 false** 라
   * 워치독이 첫 tick 에 "창이 닫혔다" 고 판단하고 **자기 자신을 종료**했다. CI 부팅
   * 스모크가 그랬다: llama 를 정상적으로 띄우고 `/v1/models 200` 까지 확인한 뒤
   * 곧바로 종료돼, "스폰한 llama 가 응답하지 않는다" 는 메시지가 남았다.
   *
   * 즉 **창을 띄우지 않기로 한 경우**에.window 모드의 수명 규칙(창이 닫히면 종료)을
   * 적용하면 안 된다. 부재(없음)와 종료(죽음)는 다른 신호다.
   *
   * 기본값은 true — 주지 않은 호출자는 예전처럼 "창이 있었다" 고 본다.
   */
  expectChrome?: boolean;
  /**
   * 창이 **지금 어떤 상태인가** — `alive` / `dead` / `never-opened`.
   *
   * 주면 `isChromeAlive` 보다 우선한다. `never-opened` 는 "닫힘" 이 **아니다** —
   * 한 번도 열린 적이 없으므로 닫힐 수도 없다. 그 상태에서 서버를 죽이면
   * "창이 안 떠서 서버가 죽었다" 라는 잘못된 인과가 로그에 남는다.
   */
  chromeState?: () => ChromeState;
  /**
   * S3 — 마지막 클라이언트가 사라지고 경과한 ms. **한 번도 붙은 적이 없으면 null.**
   * (부팅 직후를 "클라이언트 없음" 으로 읽으면 아직 안 뜬 창을 죽인다 — 실측.)
   */
  msSinceLastClientGone?: () => number | null;
  /** S3 만료 임계값(초). 기본 15초(§4.4 표). */
  clientIdleThresholdSec?: number;
  /**
   * S3 를 **유예**할 사유를 돌려준다. 사유가 있으면 유예하고 로그에 남긴다.
   *
   * §4.4 가 요구하는 두 가지: (a) 진행 중 백그라운드 프로세스가 있는가,
   * (b) `daemon.idleShutdownSec` 이 설정돼 있는가. 큰 파일을 여는 중인데 서버가
   * 죽는 일이 생기면 그것이 실제 손해다.
   */
  deferS3?: () => string | null;
  /**
   * S4 — CDP 연결 상태. `"lost"` 는 **재연결 2회 실패** 다(한 번의 끊김은 아니다:
   * 그 한회는 프로필 잠금 같은 일시적 거부일 수 있다). `"none"` 은 판정 대상이 아니다 —
   * 감시를 켜지 않았다는 뜻이다.
   */
  cdpState?: () => "connected" | "lost" | "none";
  /** 종료 실행(§4.4 shutdown). */
  shutdown: (reason: string) => Promise<void> | void;
  /** 데몬 유휴 종료 정책(초). 0/미지정 = 없음(기본값이 조용히 사라지는 최악의 UX). */
  idleShutdownSec?: number;
  /** 창/클라이언트가 붙어 있는가(하트비트). */
  clientConnected?: () => boolean;
  /** 폴링 주기(기본 5초 — 1초 는 과하고 30초 는 너무 느리다). */
  intervalMs?: number;
  now?: () => number;
}

export interface Watchdog {
  /** 실행을 멈춘다(정상 종료 시 호출). */
  stop: () => void;
  /** 유휴 종료까지 남은 초. 정책이 없으면 null. */
  idleRemaining: () => number | null;
}

export function startWatchdog(deps: WatchdogDeps): Watchdog {
  const interval = deps.intervalMs ?? 5_000;
  const now = deps.now ?? (() => Date.now());
  const idleLimit = deps.idleShutdownSec ?? 0;
  let idleSince: number | null = null;
  let stopped = false;
  let llamaDownNotified = false;
  let chromeDownNotified = false;
  let chromeNeverOpenedNotified = false;
  let s3Fired = false;
  let s3DeferredNotified = false;
  let orphanNotified = false;
  let cdpLostNotified = false;

  const s3ThresholdSec = deps.clientIdleThresholdSec ?? 15;
  const llamaAliveNow = () => (deps.isLlamaAlive ? deps.isLlamaAlive() : true);
  const clientPresent = () => (deps.clientConnected ? deps.clientConnected() : true);
  /** 창 상태. 판정 함수를 **한 곳**에서만 부른다 — 두 곳에서 부르면 서로 다른 답이 나올 수 있다. */
  const chromeState = (): ChromeState => {
    if (deps.chromeState) return deps.chromeState();
    if (deps.expectChrome === false) return "alive";
    return deps.isChromeAlive && !deps.isChromeAlive() ? "dead" : "alive";
  };

  const tick = () => {
    if (stopped) return;

    // 1) llama-server: 죽으면 **알린다**. 자동 재기동하지 않는다.
    if (deps.isLlamaAlive && !deps.isLlamaAlive()) {
      if (!llamaDownNotified) {
        llamaDownNotified = true;
        deps.ring.error(
          "lifecycle",
          "llama-server 가 종료되었습니다. 모델 응답이 없습니다. 창은 계속 사용할 수 있습니다(요구 9).",
          "server",
          { autoRestart: false, why: "VRAM 8 GiB 환경에서 두 번째 서버를 띄우면 즉시 OOM 합니다(측정됨)" }
        );
      }
    } else {
      llamaDownNotified = false;
    }

    // 2) Chrome: 모드에 따라 다르게 처리한다(§3.7.2 의 의도적 예외).
    //
    // 세 상태를 나눈다:
    //  - `expectChrome: false` (창을 아예 띄우지 않음) → 분기를 통째로 건너뛴다.
    //    "죽었나?" 를 묻는데 애초에 없던 것에는 "죽음" 이 없다. 구분하지 않으면
    //    `--no-browser` 데몬이 **자기 첫 tick 에 스스로 죽는다**(실제로 그랬다).
    //  - `never-opened` (띄우려 했으나 못 띄움) → **종료하지 않는다.** 닫힌 게 아니라
    //    열린 적이 없다. 죽이면 "창이 안 떠서 서버가 죽었다" 는 거짓 인과가 남는다.
    //    서버는 살아 있고 주소를 알려 주면 된다(요구 9 의 degrade).
    //  - `dead` → 모드에 따라 종료(S1).
    const chrome = chromeState();
    if (chrome === "never-opened") {
      if (!chromeNeverOpenedNotified) {
        chromeNeverOpenedNotified = true;
        deps.ring.error(
          "lifecycle",
          "창을 띄우지 못했습니다. 서버는 계속 실행 중이니 브라우저에서 주소를 직접 여세요.",
          "server",
          { why: "창이 닫힌 것이 아니다 — 열린 적이 없다. 종료 신호로 쓰면 원인이 사라진다" }
        );
      }
    } else if (deps.expectChrome !== false && chrome === "dead") {
      if (!chromeDownNotified) {
        chromeDownNotified = true;
        if (deps.mode === "window") {
          deps.ring.info("lifecycle", "창이 닫혔습니다 — 요구 9 에 따라 서버를 종료합니다.", "server");
          void deps.shutdown("window-closed");
          return;
        }
        deps.ring.info(
          "lifecycle",
          "창이 닫혔지만 데몬 모드이므로 서버는 계속 실행합니다. `harnesside open` 으로 다시 열 수 있습니다.",
          "server"
        );
      }
    } else {
      chromeDownNotified = false;
    }

    // 2.5) S3 — 웹 클라이언트 하트비트 만료(§4.4).
    //
    // CDP 없이 창이 닫혔거나 페이지가 죽은 경우를 잡는다. 창이 **살아 있는데** 클라이언트만
    // 사라졌다면 그건 사용자가 다른 곳에서 보고 있다는 뜻일 수 있으므로, 그때는
    // **알리기만 하고 죽이지 않는다.** 닫힘으로 볼 근거가 없다.
    const goneMs = deps.msSinceLastClientGone?.() ?? null;
    if (goneMs !== null) {
      const idleSec = goneMs / 1000;
      const defer = deps.deferS3?.() ?? null;
      if (idleSec >= s3ThresholdSec && !defer) {
        if (!s3Fired) {
          s3Fired = true;
          deps.ring.info(
            "lifecycle",
            `웹 클라이언트가 ${Math.floor(idleSec)}초째 없습니다 — 창이 닫힌 것으로 보고 종료합니다(§4.4 S3).`,
            "server",
            { signal: "S3", idleSec: Math.floor(idleSec) }
          );
          if (deps.mode === "window") {
            void deps.shutdown("heartbeat-expired");
            return;
          }
        }
      } else if (defer && !s3DeferredNotified) {
        // 유예 사유를 **말한다**. 조용히 기다리면 "왜 아직 살아 있지" 가 된다.
        s3DeferredNotified = true;
        deps.ring.info(
          "lifecycle",
          `클라이언트가 없지만 S3 를 유예합니다 — ${defer}.`,
          "server",
          { signal: "S3", deferred: true, why: defer }
        );
      }
    } else {
      s3Fired = false;
      s3DeferredNotified = false;
    }

    // 2.6) S4 — CDP 연결 소실(재연결 2회 실패).
    //
    // 창(Chrome)은 살아 있는데 **소켓이** 죽은 상태다. 그래서 S1 이 발동하지 않는다 —
    // pid 를 보면 멀쩡하기 때문이다. window 모드에서는 요구 9 의 창이 더 이상 제어되지
    // 않으므로 종료하고, daemon 모드에서는 계속 둔다(§4.4 의 의도적 예외).
    const cdp = deps.cdpState?.() ?? "none";
    if (cdp === "lost") {
      if (!cdpLostNotified) {
        cdpLostNotified = true;
        deps.ring.error(
          "lifecycle",
          "브라우저(CDP) 연결을 되찾지 못했습니다. 창은 살아 있지만 제어할 수 없습니다.",
          "server",
          { signal: "S4", why: "재연결 2회 실패(§4.4 표)", chromeAlive: chrome === "alive" }
        );
        if (deps.mode === "window") {
          void deps.shutdown("cdp-lost");
          return;
        }
      }
    } else {
      cdpLostNotified = false;
    }

    // 2.7) S6 — 고아 데몬: 창도 모델도 없고 클라이언트도 없다.
    //
    // **알리기만 한다.** `window` 모드에서는 S1/S3 이 이미 종료를 시키고,
    // `daemon` 모드에서는 §4.4 가 "계속 살아 있어야 한다" 고 정해 두었다. 그래서 여기서
    // 종료하면 신호 세 개가 같은 결론에 도달하는 셈이고, 어느 신호가 작동한지
    // 구분할 수 없게 된다 — 로그가 무의미해진다.
    // 창을 **애초에 띄우지 않는 모드**에서는 "창이 죽었다" 가 성립하지 않으므로,
    // 그 경우에도 S6 는 판정한다(모델도 없고 붙어 있는 사람이도 없음 = 고아).
    const noChildrenLeft = !llamaAliveNow() && !clientPresent() && (chrome === "dead" || deps.expectChrome === false);
    if (noChildrenLeft) {
      if (!orphanNotified) {
        orphanNotified = true;
        deps.ring.error(
          "lifecycle",
          "고아 상태입니다: 창도 모델도 없고 연결된 클라이언트도 없습니다.",
          "server",
          { signal: "S6", shutdown: false, why: "daemon 모드에서는 서버가 살아 있어야 한다(§4.4 의 의도적 예외)" }
        );
      }
    } else {
      orphanNotified = false;
    }

    // 3) 유휴 종료 정책 — **기본 0(없음)**. 켠 경우에도 3분 유예를 둔다.
    if (idleLimit > 0) {
      const connected = deps.clientConnected ? deps.clientConnected() : true;
      if (connected) {
        idleSince = null;
      } else {
        if (idleSince === null) idleSince = now();
        const idleSec = Math.floor((now() - idleSince) / 1000);
        // 즉시 종료하지 않는다 — 사용자가 창을 닫은 직후 3분 안에 다시 열 수 있다.
        if (idleSec > 180 && idleSec > idleLimit) {
          deps.ring.info(
            "lifecycle",
            `유휴 ${idleSec}초 — daemon.idleShutdownSec(${idleLimit}) 정책에 따라 종료합니다.`,
            "server"
          );
          void deps.shutdown("idle-timeout");
        }
      }
    }
  };

  const timer = setInterval(tick, interval);
  // 데몬 종료가 타이머에 매달리지 않게 한다.
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    idleRemaining: () => (idleSince === null ? null : Math.max(0, idleLimit - Math.floor((now() - idleSince) / 1000))),
  };
}

/** S3 판정용: 하트비트가 최근에 왔는가(§4.4 — 도구 실행 중에는 유예). */
export function heartbeatFresh(lastPingMs: number, timeoutSec = 15, now = Date.now()): boolean {
  return now - lastPingMs < timeoutSec * 1000;
}
