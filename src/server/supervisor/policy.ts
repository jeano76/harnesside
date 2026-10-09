/**
 * 상위 감시기(supervisor) 재시작 정책 — 순수 함수 (P13·M10·M12).
 *
 * 왜 필요한가: 서버는 자기 자신을 재시작할 수 없다. 업데이트 적용 후 새 바이너리가
 * 죽으면 그 사실을 말할 프로세스도 없고(`index.ts` "상위 감시기가 없습니다"),
 * 크래시 후 자동 재시작(M10)도 주체가 없다. 감시기는 자식으로 서버를 띄우고
 * 죽으면 이 정책대로 다시 띄운다.
 *
 * 여기서 정하는 것은 **판정뿐**이다 — 스폰·프로브·슬롯은 다음 단계(주입받는 실행층).
 * 그래서 타이머도 프로세스도 없다: 죽은 시각 목록과 지금 시각을 받아 행동을 돌려준다.
 *
 * 핵심 규칙 두 가지:
 *  1. `code 0` 은 **죽음이 아니라 종료**다 — 사용자가 `/quit` 으로 끈 것을 다시
 *     띄우면 "꺼지지 않는 서버" 가 된다. 재시작하지 않는다.
 *  2. 짧은 시간에 반복해서 죽으면 **멈춘다** — 무한 재시작은 로그만 태우고
 *     디스크를 채운다. 멈출 때는 이유를 말한다(조용히 안 둔다).
 */

export interface SupervisorPolicy {
  /** 윈도우 안에 이 횟수만큼 죽으면 crash-loop 으로 보고 멈춘다. */
  maxRestarts: number;
  /** 재시작 횟수를 세는 윈도우(초). */
  windowSec: number;
  /** 첫 재시작 대기(초). 이후 2배씩 늘어난다. */
  backoffBaseSec: number;
  /** 대기 상한(초). */
  backoffMaxSec: number;
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  maxRestarts: 5,
  windowSec: 300,
  backoffBaseSec: 2,
  backoffMaxSec: 60,
};

/** 자식이 어떻게 끝났는가 — Node `child_process` 의 `exit` 이벤트 그대로. */
export interface ChildExit {
  code: number | null;
  signal: string | null;
}

export type RestartAction = "restart" | "stop";

export interface RestartDecision {
  action: RestartAction;
  /** `restart` 면 기다릴 초. `stop` 이면 0. */
  delaySec: number;
  /** 사람에게 보이는 한 줄 이유. */
  reason: string;
}

/** `code`/`signal` 을 한 줄로 — "왜 죽었는지" 를 말할 때 쓴다. */
export function describeExit(exit: ChildExit): string {
  if (exit.code !== null && exit.code !== undefined) return `code ${exit.code}`;
  if (exit.signal) return `signal ${exit.signal}`;
  return "원인 불명";
}

/**
 * 이번 죽음에 무엇을 할 것인가.
 *
 * @param exit 자식의 종료 상태
 * @param restartsSec 이 자식의 최근 재시작 시각들(epoch 초, 오름차순일 필요 없음)
 * @param nowSec 지금(epoch 초)
 */
export function decideRestart(
  exit: ChildExit,
  restartsSec: number[],
  nowSec: number,
  policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY
): RestartDecision {
  const how = describeExit(exit);
  if (exit.code === 0) {
    return { action: "stop", delaySec: 0, reason: `정상 종료(${how}) — 다시 띄우지 않습니다` };
  }
  const recent = restartsSec.filter((t) => nowSec - t < policy.windowSec).length;
  if (recent >= policy.maxRestarts) {
    return {
      action: "stop",
      delaySec: 0,
      reason: `${policy.windowSec}초 안에 ${recent}번 죽음(${how}) — 무한 재시작하지 않고 멈춥니다`,
    };
  }
  const delaySec = Math.min(policy.backoffBaseSec * 2 ** recent, policy.backoffMaxSec);
  return {
    action: "restart",
    delaySec,
    reason: `비정상 종료(${how}) — ${delaySec}초 뒤 다시 띄웁니다 (최근 ${policy.windowSec}초에 ${recent}번)`,
  };
}
