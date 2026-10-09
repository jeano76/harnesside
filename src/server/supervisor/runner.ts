/**
 * 상위 감시기 실행층 — 자식 스폰·부팅 확인·재시작 연결 (P13·M10·M12).
 *
 * `policy.ts` 가 **판정**이면 여기는 **손발**이다. 실제 프로세스·타이머·HTTP 는
 * 전부 주입받는다(`RunnerDeps`) — 테스트가 진짜 서버를 띄우면 안 되므로.
 * 기본값은 상수뿐이라, 실제 스폰·프로브를 꽂는 진입점은 다음 단계다.
 *
 * 흐름 한 번:
 *   1. 자식을 띄운다 (`started`).
 *   2. `probeHello` 가 true 를 보낼 때까지 기다린다 — 프로세스가 떴다는 것만으로는
 *      안 된다(판정은 `judgeBoot` 에 맡긴다).
 *   3. 기동 성공이면(`boot-healthy`) 끝날 때까지 기다렸다가 정책대로 처리,
 *      기동 실패면(`boot-failed`) 죽이고 정책대로 처리.
 *   4. 정책이 `restart` 면 대기 후 처음부터, `stop` 이면 이유와 함께 끝난다.
 *   5. `code 0` 종료·외부 `stopToken` 은 재시작하지 않는다.
 */

import { judgeBoot } from "../update/pipeline.js";
import {
  decideRestart,
  describeExit,
  DEFAULT_SUPERVISOR_POLICY,
  type ChildExit,
  type SupervisorPolicy,
} from "./policy.js";

export interface SupervisorChild {
  pid?: number;
  waitExit: () => Promise<ChildExit>;
  kill: () => void;
}

export type SupervisorEvent =
  | { type: "started"; attempt: number; pid?: number }
  | { type: "boot-healthy"; attempt: number }
  | { type: "boot-failed"; attempt: number; reason: string }
  | { type: "exited"; attempt: number; exit: string; delaySec: number }
  | { type: "stopped"; reason: string };

export interface RunnerDeps {
  /** 자식을 띄운다. 시도 번호를 받는다(로그·프로브 구분용). */
  spawn: (attempt: number) => SupervisorChild | Promise<SupervisorChild>;
  /** 기동 신호 — 성공해야 부팅으로 인정한다. */
  probeHello: () => Promise<boolean>;
  /** 이 시간(초) 안에 hello 가 없으면 기동 실패. */
  bootGraceSec: number;
  /** 프로브 간격(밀리초). 주입 없으면 500. */
  pollMs?: number;
  policy?: SupervisorPolicy;
  nowSec?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  emit?: (e: SupervisorEvent) => void;
  /** 외부에서 `token.stop = true` 로 두면 자식을 죽이고 끝낸다. */
  stopToken?: { stop: boolean };
}

export interface SuperviseResult {
  reason: string;
  /** 재시작한 시각들(epoch 초) — crash-loop 판단의 근거. */
  restarts: number[];
  attempts: number;
}

export async function supervise(deps: RunnerDeps): Promise<SuperviseResult> {
  const policy = deps.policy ?? DEFAULT_SUPERVISOR_POLICY;
  const pollMs = deps.pollMs ?? 500;
  const nowSec = deps.nowSec ?? (() => Date.now() / 1000);
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const emit = deps.emit ?? (() => undefined);
  const restarts: number[] = [];
  let attempt = 0;

  for (;;) {
    attempt++;
    const child = await deps.spawn(attempt);
    emit({ type: "started", attempt, pid: child.pid });

    // 자식 종료를 먼저 걸어 둔다 — 프로브 대기 중에 죽으면 바로 안다.
    let exited: ChildExit | null = null;
    const exitP = child.waitExit().then((e) => {
      exited = e;
    });

    // 부팅 대기: hello 가 오거나, 자식이 죽거나, 외부 정지 중 하나까지.
    const bootStart = nowSec();
    let sawHello = false;
    while (!exited && !(deps.stopToken?.stop ?? false)) {
      await sleep(pollMs);
      if (exited || (deps.stopToken?.stop ?? false)) break;
      let hello = false;
      try {
        hello = await deps.probeHello();
      } catch {
        hello = false;
      }
      if (hello) {
        sawHello = true;
        break;
      }
      const verdict = judgeBoot(false, nowSec() - bootStart, { enabled: true, bootGraceSec: deps.bootGraceSec });
      if (verdict === "failed") break;
    }

    if (deps.stopToken?.stop ?? false) {
      try {
        child.kill();
      } catch {
        /* 이미 죽었으면 할 일 없음 */
      }
      await exitP;
      const reason = "외부 정지 요청 — 자식을 종료하고 끝냅니다";
      emit({ type: "stopped", reason });
      return { reason, restarts, attempts: attempt };
    }

    if (sawHello) {
      emit({ type: "boot-healthy", attempt });
    } else {
      // hello 없이 끝났다 — 기동 실패로 기록한다(죽었든, 시간 다 돼 죽였든).
      // code 0 으로 조용히 끝난 경우도 "떴다" 로 세지 않는다 — 고장난 서버를
      // 정상으로 보고하는 쪽이 더 나쁘다. 재시작 여부는 아래 정책이 정한다.
      if (!exited) {
        try {
          child.kill();
        } catch {
          /* 기동 실패한 자식이 먼저 죽어 있으면 무시 */
        }
        await exitP;
      }
      const reason = exited
        ? `기동 신호 전에 종료됨(${describeExit(exited)})`
        : `${deps.bootGraceSec}초 안에 기동 신호 없음 — 기동 실패로 처리합니다`;
      emit({ type: "boot-failed", attempt, reason });
    }

    // 여기 오면 자식의 종료 상태가 확정돼 있다(죽었거나, 죽였다).
    if (!exited) await exitP;
    const finalExit: ChildExit = exited ?? { code: null, signal: null };
    const d = decideRestart(finalExit, restarts, nowSec(), policy);
    if (d.action === "stop") {
      emit({ type: "stopped", reason: d.reason });
      return { reason: d.reason, restarts, attempts: attempt };
    }
    restarts.push(nowSec());
    emit({ type: "exited", attempt, exit: describeExit(finalExit), delaySec: d.delaySec });
    await sleep(d.delaySec * 1000);
  }
}
