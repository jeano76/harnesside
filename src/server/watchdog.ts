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
    if (deps.isChromeAlive && !deps.isChromeAlive()) {
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
