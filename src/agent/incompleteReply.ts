/**
 * 모델 응답이 "끝난 것"인지 판정한다 — 순수 함수.
 *
 * 루프는 도구 호출이 없는 응답을 "턴 종료"로 본다. 그런데 로컬 모델은 사고(reasoning)에 출력 예산을
 * 쓰고 보이는 답도 도구 호출도 없이 끝내거나(`empty`), 최대 토큰에서 잘린 채 끝난다(`cut-off`).
 * 그 둘을 "완료"로 처리하면 사용자는 "왜 멈췄지?" 를 묻게 된다(실측: 한 세션에서 네 번 되물음).
 * 여기서는 그 둘만 가려낸다. "말은 했는데 행동이 없는" 경우는 내용을 해석해야 해서 오탐 위험이 크므로
 * 일부러 다루지 않는다.
 */

export type ReplyVerdict = "complete" | "empty" | "cut-off";

export interface JudgeInput {
  content?: unknown;
  tool_calls?: readonly unknown[] | null;
}

export function judgeReply(message: JudgeInput, finishReason?: string | null): ReplyVerdict {
  if (message.tool_calls && message.tool_calls.length > 0) return "complete";
  const text = typeof message.content === "string" ? message.content.trim() : "";
  if (text === "") return "empty";
  if (finishReason === "length") return "cut-off";
  return "complete";
}

/** 연속으로 허용하는 재시도 횟수. 넘으면 사용자에게 사유를 말하고 멈춘다. */
export const MAX_INCOMPLETE_REPLY_RETRIES = 3;

export function incompleteReplyNudge(verdict: Exclude<ReplyVerdict, "complete">): string {
  return verdict === "empty"
    ? "Your last reply was empty: it had internal reasoning but no visible answer and no tool call, so the turn would have ended with the work unfinished. " +
        "Continue the task now — either call the next tool, or if everything is truly done, state the result in plain text."
    : "Your last reply was cut off by the output limit before it finished. " +
        "Continue exactly where you stopped (do not repeat what you already wrote); if the next step is a tool call, make it now.";
}
