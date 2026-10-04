import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Machine-parseable state written right before compaction runs (PROMPT.md §2.2).
 *  Distinct from the human-readable conversation summary — never merge the two. */
export interface Checkpoint {
  version: 1;
  timestamp: string;
  // "plan-progress": written on every update_plan call, independent of
  // compaction — requested directly, so a plan/todo list survives a hard
  // kill (Ctrl-C at the OS level, crash, power loss) at any point, not
  // only when a compaction happened to have already run. Before this,
  // this file only ever existed after a compaction, so a session killed
  // mid-task with no compaction yet lost its whole plan with nothing to
  // resume from.
  reason: "auto-threshold" | "manual" | "plan-progress";
  /** One-line restatement of what the user originally asked for. */
  goal: string;
  steps: Array<{
    description: string;
    status: "done" | "in_progress" | "todo";
  }>;
  files: Array<{
    path: string;
    status: "modified" | "read";
  }>;
  /** The tool call that was about to run (or had just run) when compaction fired. */
  pendingToolCall: {
    name: string;
    argumentsJson: string;
    reason: string;
  } | null;
  /** Facts/decisions that must survive summarization losslessly. */
  mustPreserve: string[];
  /** The compaction summary, added once it has been generated, so a resume
   *  in a NEW process knows what the previous one did (its conversation is
   *  gone). Absent on checkpoints written before summarizing. */
  summary?: string;
  /** The last tool calls, when no plan was declared (steps is then empty). */
  recentActions?: string[];
}

function checkpointPath(projectRoot: string): string {
  return join(projectRoot, ".harnesside", "state", "checkpoint.json");
}

export async function writeCheckpoint(
  projectRoot: string,
  checkpoint: Checkpoint
): Promise<void> {
  const path = checkpointPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(checkpoint, null, 2), "utf8");
}

/**
 * **지금 재개할 수 있는가** — 화면이 그 질문을 직접 하는 대신 여기를 묻는다.
 *
 * 왜 이 함수가 필요한가: 재개는 다음 턴에서 **자동으로** 일어난다(`loop` 의
 * `injectResumeContextIfPending`). 사용자는 아무 말 없이 그것을 보게 되는데, 화면이
 * "이전 작업이 남아 있습니다" 를 말해 주지 않으면 재개가 **일어난 적이 없는 것처럼**
 * 보인다. "없음" 과 "있으나 아직 안 보임" 을 구분해야 화면이 정직할 수 있다.
 *
 * 반환값은 그대로 노출한다 — 요약하면 사용자가 "뭘 재개한다는 말인가" 를 되묻는다.
 */
export interface ResumeInfo {
  /** 재개할 작업이 있는가. */
  present: boolean;
  /** 무엇을 재개하는가 — 사람이 읽는 한 줄. 없으면 null. */
  goal: string | null;
  reason: Checkpoint["reason"] | null;
  stepsDone: number;
  stepsTotal: number;
  savedAt: string | null;
  /** 남은 작업 미리보기 — 마우스 오버·펼침에 쓴다. 없으면 빈 배열(모름이 아니다). */
  steps: Array<{ description: string; status: "done" | "in_progress" | "todo" }>;
  /** 다음에 바로 뛸 도구 (있으면). */
  pendingToolCall: Checkpoint["pendingToolCall"];
}

export async function resumeInfo(projectRoot: string): Promise<ResumeInfo> {
  const cp = await readCheckpoint(projectRoot).catch(() => null);
  if (!cp) {
    // **없음은 명시한다.** null 로 넘기면 화면이 0 과 모름을 구분하지 못한다.
    return { present: false, goal: null, reason: null, stepsDone: 0, stepsTotal: 0, savedAt: null, steps: [], pendingToolCall: null };
  }
  const steps = Array.isArray(cp.steps)
    ? cp.steps.filter((s) => s && typeof s.description === "string").map((s) => ({
        description: String(s.description).slice(0, 200),
        status: (s.status === "done" || s.status === "in_progress" ? s.status : "todo") as "done" | "in_progress" | "todo",
      }))
    : [];
  return {
    present: true,
    goal: cp.goal || null,
    reason: cp.reason,
    stepsDone: steps.filter((s) => s?.status === "done").length,
    stepsTotal: steps.length,
    savedAt: typeof cp.timestamp === "string" ? cp.timestamp : null,
    steps,
    pendingToolCall: cp.pendingToolCall ?? null,
  };
}

/**
 * 체크포인트를 읽고 **모양을 정규화**한다.
 *
 * 왜 정규화가 필요한가: 이 파일은 디스크에 남아 있으며, 정전으로 **반만** 써질 수
 * 있고(쓰는 중 프로세스가 죽으면), 사람이 손댈 수도 있다. 그런데 소비자들은
 * `checkpoint.files.length` 처럼 배열 필드를 그대로 믿고 있다. 실제로 손으로 만든
 * 파일(배열 필드 없음) 하나가 **턴 전체를 TypeError 로 죽였다**
 * (`Cannot read properties of undefined`) — 내부 오류가 그대로 사용자 화면에
 * 나타나는 최악의 형태였다.
 *
 * 그래서 규칙은 하나: **배열 필드는 항상 배열이고, 없는 필드는 없는 그대로다.**
 * 알 수 없는 형식(`version` 불일치·JSON 아님)은 **조용히 null** 이 아니라
 * `null`(재개할 것 없음)으로 처리한다 — 반쪽짜리 상태로 턴을 시작하는 쪽이 더 위험하다.
 */
export async function readCheckpoint(projectRoot: string): Promise<Checkpoint | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(checkpointPath(projectRoot), "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    // **깨진 파일은 조용히 재개 불가로 본다.** 파싱 예외를 턴에 흘리면 사용자는
    // 재개 버튼을 눌렀을 때 원인을 알 수 없는 내부 오류를 본다.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const cp = parsed as Record<string, unknown>;
  if (cp.version !== 1) return null; // 다른 형식은 **모르는 것** — guesses 하지 않는다
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    ...(cp as unknown as Checkpoint),
    goal: typeof cp.goal === "string" ? cp.goal : "",
    summary: typeof cp.summary === "string" ? cp.summary : "",
    steps: arr(cp.steps) as Checkpoint["steps"],
    files: arr(cp.files) as Checkpoint["files"],
    recentActions: arr(cp.recentActions) as string[],
  };
}

/** Clears the checkpoint once its work has been successfully resumed and verified.
 *  Deletes the file outright (not an empty write) so a subsequent readCheckpoint()
 *  correctly returns null via its ENOENT path instead of failing to parse "". */
export async function clearCheckpoint(projectRoot: string): Promise<void> {
  await rm(checkpointPath(projectRoot), { force: true });
}
