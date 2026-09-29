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
    // `expectChrome: false` (창을 아예 띄우지 않음) 면 이 분기를 **통째로 건너뛴다**.
    // `isChromeAlive()` 는 "죽었나?" 를 묻는데, 애초에 없던 것에는 "죽음" 이 없다.
    // 여기서 구분하지 않으면 `--no-browser` 데몬이 **자기 첫 tick 에 스스로 죽는다.**
    if (deps.expectChrome !== false && deps.isChromeAlive && !deps.isChromeAlive()) {
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
