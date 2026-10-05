/**
 * **"지금 무엇이 서빙 중인가"** — 교체 뒤에도 화면이 옛 이름을 말하면 안 된다.
 *
 * 이 테스트가 없으면 같은 결함이 그대로 돌아온다. 실제로 돌아왔었다:
 * `/models <n> confirm` 으로 9B 로 바꿨는데 헤더와 모델 선택이 **35B** 를 계속
 * 가리켰다(실측 — 서버 API 와 llama-server 의 `/v1/models` 를 직접 비교해 확인).
 *
 * 원인은 **읽는 순서**였다. `adopted.model ?? model.path` 에서 앞의 것이 뒤를 가렸고,
 * 교체 훅은 `model.path` 만 고쳤다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { liveModelPath, applyModelSwitch, type ModelIdentityState } from "./modelIdentity.js";

const OLD = "/models/Old-35B-A3B-Q4_K_M.gguf";
const NEW = "/models/New-9B-Q4_K_M.gguf";

// ── 읽기 ──────────────────────────────────────────────────────────────────

test("**채택 기록이 있으면 그걸 말한다** — 그 서버가 진짜 정보다", () => {
  assert.equal(liveModelPath({ ports: { adopted: { port: 8080, model: OLD } }, model: { path: OLD } }), OLD);
});

test("**채택 기록이 없으면 설정 경로를 말한다**", () => {
  assert.equal(liveModelPath({ model: { path: NEW } }), NEW);
});

test("**아무것도 없으면 모른다** — 지어내지 않는다", () => {
  assert.equal(liveModelPath({}), null);
  assert.equal(liveModelPath(null), null);
  assert.equal(liveModelPath({ ports: { adopted: null }, model: { path: null } }), null);
});

test("**빈 문자열은 없는 것으로 본다** — 빈 값이 있으면 다음 값을 가린다", () => {
  assert.equal(liveModelPath({ ports: { adopted: { port: 8080, model: "" } }, model: { path: NEW } }), NEW);
});

// ── 쓰기 (이게 실제로 고쳐진 것) ────────────────────────────────────────────

test("**교체하면 읽는 값이 새 모델로 바뀐다** — 이것이 핵심 회귀 방지", () => {
  const boot = { ports: { adopted: { port: 8080, model: OLD } }, model: { path: OLD, reason: "부팅 시 채택" } };
  const next = applyModelSwitch(boot, NEW)!;
  assert.equal(liveModelPath(next), NEW, `교체 후에도 옛 모델을 말한다: ${liveModelPath(next)}`);
});

test("**읽는 쪽이 앞을 가리므로 `adopted` 도 함께 고친다**", () => {
  const boot = { ports: { adopted: { port: 8080, model: OLD } }, model: { path: OLD } };
  const next = applyModelSwitch(boot, NEW)!;
  assert.equal(next.ports!.adopted!.model, NEW, "채택 기록이 옛 이름을 그대로 가리고 있다");
  assert.equal(next.model!.path, NEW);
});

test("**`model.path` 만 고치면 다시 옛 이름이 보인다** — 왜 둘 다 필요한지 고정", () => {
  const boot = { ports: { adopted: { port: 8080, model: OLD } }, model: { path: OLD } };
  const 반만고친 = { ...boot, model: { ...boot.model, path: NEW } };
  assert.equal(liveModelPath(반만고친), OLD, "이 상태가 실제 버그였다 — 한쪽만 고치면 옛 이름이 살아남는다");
});

test("**포트를 바꾸지 않는다** — 교체가 포트를 옮기는 것은 별개의 일이다", () => {
  const boot = { ports: { adopted: { port: 8080, model: OLD } }, model: { path: OLD } };
  const next = applyModelSwitch(boot, NEW)!;
  assert.equal(next.ports!.adopted!.port, 8080);
});

test("**채택 기록이 없으면** 그것을 지어내지 않는다", () => {
  const boot: ModelIdentityState = { model: { path: OLD } };
  const next = applyModelSwitch(boot, NEW)!;
  assert.equal(next.ports, undefined, "없던 채택 기록을 만들어냈다");
  assert.equal(liveModelPath(next), NEW);
});

test("**`boot` 이 없으면 아무것도 하지 않는다** — 부팅 전에는 말할 것이 없다", () => {
  assert.equal(applyModelSwitch(null, NEW), null);
});

test("**원본을 고치지 않는다** — 새 상태를 돌려준다(부팅 스냅샷은 공유된다)", () => {
  const boot = { ports: { adopted: { port: 8080, model: OLD } }, model: { path: OLD } };
  const next = applyModelSwitch(boot, NEW)!;
  assert.equal(boot.ports.adopted.model, OLD, "원본이 바뀌었다 — 이전 값이 증거로 사라진다");
  assert.notEqual(next, boot);
});

test("**교체 사유를 함께 남긴다** — 왜 이 이름이 됐는지", () => {
  const next = applyModelSwitch({ model: { path: OLD } }, NEW, "/models 2 confirm")!;
  assert.equal((next.model as { reason?: string }).reason, "/models 2 confirm");
});

test("**두 번 교체해도 마지막 것이 보인다** — 이전 교체가 되돌아오지 않는다", () => {
  let boot = { ports: { adopted: { port: 8080, model: OLD } }, model: { path: OLD } };
  boot = applyModelSwitch(boot, NEW)!;
  const third = "/models/Ormith-1.5-35B-Q4_K_M.gguf";
  boot = applyModelSwitch(boot, third)!;
  assert.equal(liveModelPath(boot), third);
});
// ── 설정에서 사고 토큰 상한 읽기 (2026-10-05) ─────────────────────────────
//
// 이 설정은 **노출만 되고 아무도 읽지 않았다.** 스키마에는 사용자에게 보이고,
// 서버 로그도 "설정에서 올리라" 고 안내했는데 실제로는 항상 기본값이었다.
// 그래서 "지시를 따라도 아무 일도 일어나지 않는" 상태였다.

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadThinkBudget } from "./modelIdentity.js";
import { DEFAULT_MAX_REASONING, MIN_REASONING_FLOOR, MAX_REASONING_CEILING, clampReasoningBudget } from "../shared/reasoning.js";

async function proj(yaml: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thinkcfg-"));
  if (yaml !== null) {
    await mkdir(join(dir, ".harnesside"), { recursive: true });
    await writeFile(join(dir, ".harnesside", "config.yaml"), yaml, "utf8");
  }
  return dir;
}

test("**설정 파일이 없으면** 손대지 않는다 — 없는 것은 오류가 아니다", async () => {
  const r = await loadThinkBudget(await proj(null));
  assert.equal(r.set, false);
  assert.equal(r.maxReasoningTokens, DEFAULT_MAX_REASONING);
});

test("**값을 명시하면 그 값을 쓴다** — 이제 지시를 따라하면 실제로 바뀐다", async () => {
  const r = await loadThinkBudget(await proj("agent:\n  maxReasoningTokens: 2048\n"));
  assert.equal(r.set, true, "설정에 있는데 적용하지 않았다 — 그게 원래 결함이다");
  assert.equal(r.maxReasoningTokens, 2048);
});

test("**값이 적혀 있지 않으면** 손대지 않는다 — 기본값으로 메우지 않는다", async () => {
  for (const y of ["agent:\n  enableThinking: true\n", "llama:\n  port: 8080\n", "agent: {}\n"]) {
    const r = await loadThinkBudget(await proj(y));
    assert.equal(r.set, false, `값이 없는데 설정된 것으로 봤다: ${y}`);
  }
});

test("**빈 값은** 설정한 것이 아니다 — null 과 빈 문자열을 구분 못 하면 거짓말이다", async () => {
  for (const y of ["agent:\n  maxReasoningTokens:\n", 'agent:\n  maxReasoningTokens: ""\n']) {
    const r = await loadThinkBudget(await proj(y));
    assert.equal(r.set, false, `빈 값을 설정으로 봤다: ${y}`);
  }
});

test("**범위를 벗어난 값은** 좁혀서 쓴다 — 스키마의 min/max 와 같은 규칙", async () => {
  const hi = await loadThinkBudget(await proj(`agent:\n  maxReasoningTokens: 999999\n`));
  assert.equal(hi.maxReasoningTokens, MAX_REASONING_CEILING);
  const lo = await loadThinkBudget(await proj("agent:\n  maxReasoningTokens: 1\n"));
  assert.equal(lo.maxReasoningTokens, MIN_REASONING_FLOOR);
});

test("**깨진 YAML** 은 기본값으로 두되 설정한 것으로 보지 않는다", async () => {
  const r = await loadThinkBudget(await proj("agent:\n\tmaxReasoningTokens: [ unbalanced\n"));
  assert.equal(r.set, false);
  assert.equal(r.maxReasoningTokens, DEFAULT_MAX_REASONING);
});

test("**문자열로 적힌 숫자도** 읽는다 — YAML 에서 `2048` 은 사람이 문자로 쓴다", async () => {
  const r = await loadThinkBudget(await proj('agent:\n  maxReasoningTokens: "2048"\n'));
  assert.equal(r.set, true);
  assert.equal(r.maxReasoningTokens, 2048);
});

// ── clamp 자체 ────────────────────────────────────────────────────────────

test("**숫자가 아니면** 기본값으로 돌린다 — NaN 예산은 조용한 결함이 된다", () => {
  for (const v of [undefined, null, "전부", NaN, Infinity, {}]) {
    assert.equal(clampReasoningBudget(v), DEFAULT_MAX_REASONING, `${String(v)} 를 예산으로 삼았다`);
  }
});

test("**정수로 반올림한다** — 2048.7 을 예산으로 삼으면 매번 다른 값처럼 보인다", () => {
  assert.equal(clampReasoningBudget(2048.7), 2049);
});
