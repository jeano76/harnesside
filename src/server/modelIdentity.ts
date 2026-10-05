/**
 * **"지금 무엇이 서빙 중인가"** 를 한 곳에서 정한다.
 *
 * ── 왜 순수 함수로 분리하나 ──────────────────────────────────────────────────
 *
 * 이 규칙이 라우트 안에 인라인으로 들어 있었고, 그 결과 **화면이 옛 모델 이름을 계속
 * 보여 주는 결함**이 남았다(실측: 9B 로 교체했는데 헤더와 모델 선택이 35B 였다).
 * 규칙을 그대로 둔다면 같은 실수가 다시 들어온다. 그래서 판단과 갱신을 여기서 한다.
 *
 * ── 규칙이 두 개뿐이다 ──────────────────────────────────────────────────────
 *
 * 1. `liveModelPath` — **읽기**: 채택 기록이 있으면 그걸 보고, 없으면 설정 경로를 본다.
 * 2. `applyModelSwitch` — **쓰기**: 교체되면 **두 곳을 함께** 고친다.
 */

/** `/api/system/version` 이 모델을 고를 때 보는 모양. `boot` 에서 필요한 것만. */
export interface ModelIdentityState {
  ports?: { adopted?: { port: number; model: string } | null } | null;
  model?: { path?: string | null } | null;
}

/**
 * 지금 서빙 중인 것으로 **말해야 하는** 경로.
 *
 * 부팅 때 이미 떠 있던 서버를 **채택**했다면 그 기록이 정보다. 그 서버가 지금 무엇을
 * 올렸는지는 서버가 직접 말해야 하고(모델 교체 시 갱신된다), Adopted 는 없을 수 있다.
 */
export function liveModelPath(s: ModelIdentityState | null | undefined): string | null {
  const adopted = s?.ports?.adopted;
  if (adopted && typeof adopted.model === "string" && adopted.model) return adopted.model;
  const path = s?.model?.path;
  return typeof path === "string" && path ? path : null;
}

/**
 * 모델을 교체했을 때 **기록을 어디까지 고쳐야 하는가**.
 *
 * ── 여기서 고쳐야 했던 이유 (실측으로 확인한 결함) ──────────────────────────
 *
 * 예전 훅은 `model.path` 만 고쳤다. 그런데 읽는 쪽은
 * `adopted.model ?? model.path` 순서라 **앞의 것이 뒤를 가렸다.** 그래서 교체가
 * 반영되어도 화면은 계속 옛 이름을 봤다.
 *
 * **둘 중 하나만 고치면 또 한쪽이 남는다.** 하나만 고친 채로 "고쳤다"고 말하면
 * 다음 사람이 같은 함정을 밟는다 — 그래서 갱신을 **한 함수로** 묶었다.
 *
 * 부르는 쪽이 `boot` 를 그대로 쓴다는 전제(부팅 스냅샷)를 여기서
 * 강제하지 않는다 — 순수하게 새 상태를 돌려주고, 호출자가 끼워 넣는다.
 */
export function applyModelSwitch<T extends ModelIdentityState>(s: T | null, modelPath: string, reason = "슬래시 명령으로 교체함"): T | null {
  if (!s) return s;
  const next: T = {
    ...s,
    model: { ...(s.model ?? {}), path: modelPath, reason } as T["model"],
  };
  // **채택 기록이 있으면 그것도 고친다** — 교체 뒤에는 이 서버를 우리가 띄운 것이므로
  // "채택했다" 는 기록이 더 이상 사실을 말하지 않는다. 남겨두면 옛 이름을 가린다.
  if (next.ports?.adopted) {
    next.ports = { ...next.ports, adopted: { ...next.ports.adopted, model: modelPath } };
  }
  return next;
}
/**
 * 프로젝트 설정에서 **사고 토큰 상한**을 읽는다.
 *
 * 왜 여기 있나: 이 값은 **노출만 되고 아무도 읽지 않았다.** 스키마에는
 * `사고 토큰 상한` 이 사용자에게 보이고, 서버 로그도 "설정에서 올리라" 고 안내했는데
 * 실제로는 항상 기본값이었다. 사용자가 지시를 따라도 아무 일도 일어나지 않는 상태였다.
 *
 * 규칙은 하나다. **값이 있으면 좁혀서 쓰고, 없으면 손대지 않는다.** 없는 설정 키를
 * 기본값으로 메워 넣으면 "설정을 안 했다" 와 "설정을 기본값으로 했다" 가 구분이 안 된다.
 *
 * `set: false` 인 이유: 호출자는 이 값이 **사용자의 명시적 선택인지** 알아야 한다.
 * 명시적이면 화면에 "설정에서 온 값" 이라고 말할 수 있다.
 */
export async function loadThinkBudget(projectRoot: string): Promise<{ set: boolean; maxReasoningTokens: number }> {
  const { DEFAULT_MAX_REASONING, clampReasoningBudget } = await import("../shared/reasoning.js");
  let raw: string | null = null;
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    raw = await readFile(join(projectRoot, ".harnesside", "config.yaml"), "utf8");
  } catch {
    // **설정 파일이 없는 것은 정상이다**(새 프로젝트). 없는 것을 오류로 만들지 않는다.
    return { set: false, maxReasoningTokens: DEFAULT_MAX_REASONING };
  }
  try {
    const { parse } = await import("yaml");
    const cfg = parse(raw) as { agent?: { maxReasoningTokens?: unknown } } | null;
    const v = cfg?.agent?.maxReasoningTokens;
    // **명시적으로 적힌 경우만** 사용자로 본다. `null`·빈 값·누락은 "안 했다" 다.
    if (v === undefined || v === null || v === "") return { set: false, maxReasoningTokens: DEFAULT_MAX_REASONING };
    return { set: true, maxReasoningTokens: clampReasoningBudget(v) };
  } catch {
    // 파싱 실패는 조용히 기본값으로 두되, **모른다고 말할 수는 없다.** 기본값을 쓴다.
    return { set: false, maxReasoningTokens: DEFAULT_MAX_REASONING };
  }
}
