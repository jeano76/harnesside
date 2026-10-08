/**
 * 승인 게이트의 결착을 허브(ring/hub)에 연결하는 옵션을 만든다 (§2 todo · S-6).
 *
 * 원래 `index.ts` 에 인라인으로 붙어 있던 glue 를 빼낸 것이다. 동작은 **변경하지
 * 않는다** — `approval.request`(요청이 생길 때)와 `approval.done`(결정될 때)를 같은
 * 순서로, 같은 모양으로 보낸다. 이 주소를 빼낸 이유만 같다:
 *
 * - 게이트가 실제로 루프에 배선되어 **지나는 것**을 유닛으로 고정하고 싶다(§5 todo).
 *   지금 그 배선은 `index.ts` 에 숨어 있어서 브라우저 없이 검사가 닿지 않는다.
 * - 옵션 객체로 빼면 `WsHub`/`LogRing` 의 타입 시그니처에 묶여 **모양**까지 고정된다.
 */

import type { LogRing } from "./logRing.js";
import type { WsHub } from "./wsHub.js";
import type { GateEvents, ApprovalDecision, ApprovalRequest } from "./approval.js";
import type { ServerEvent } from "./wsHub.js";

/** 이 헬퍼가 만들어낸 게이트 콜백 묶음. */
export interface ApprovalGateBindings extends GateEvents {}

/**
 * 게이트에 달 콜백을 만든다. `onRequest`/`onDecision` 이 **무엇을** 보내는지(WS 이벤트
 * 모양 + 링 메시지)를 한 자리에서 확정한다 — 두 가지를 나누면 하나만 고정된 테스트가
 * 생겨도 다른 한쪽이 조용히 바뀔 수 있다.
 */
export function bindApprovalEvents(
  hub: WsHub | null | undefined,
  ring: LogRing,
): ApprovalGateBindings {
  return {
    onRequest: (req: ApprovalRequest) => {
      hub?.publish({ type: "approval.request", request: req } as unknown as ServerEvent);
      ring.warn("approval", `승인 대기: ${req.summary}`, "server");
    },
    onDecision: (req: ApprovalRequest, decision: ApprovalDecision, by?: string) => {
      hub?.publish({ type: "approval.done", id: req.id, tool: req.tool, decision, by } as unknown as ServerEvent);
      ring.info("approval", `승인 결정: ${req.tool} → ${decision}${by ? ` (${by})` : ""}`, "server");
    },
  };
}
