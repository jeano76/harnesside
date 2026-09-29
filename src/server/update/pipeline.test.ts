/**
 * 업데이트 파이프라인 테스트 (§5.13.1 · §9.1 · §10.2 · §10.3.1).
 *
 * 여기서 통과한다는 것은 "실패한 업데이트가 사용자의 IDE 를 못 쓰게 만들지 않는다"
 * 는 뜻이다. 그래서 롤백·해시·버전 비교를 **구체적 수치**로 검증한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  isNewer,
  parseVersion,
  verifyHash,
  shortHash,
  releaseMatchesChannel,
  planApply,
  judgeBoot,
  rollbackReason,
  classifyFetchError,
  progressLabel,
  updatesDisabledByEnv,
  createSlotStore,
  VERSION_SLOTS,
  DEFAULT_ROLLBACK,
  DEFAULT_AUTO,
  type ApplyGuard,
} from "./pipeline.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("버전 비교는 **숫자 세그먼트** — 1.10 은 1.9 보다 크다", () => {
  assert.equal(isNewer("1.10.0", "1.9.0"), true, "문자열 비교로 새 버전이 안 뜯는다");
  assert.equal(isNewer("1.9.0", "1.10.0"), false);
  assert.equal(isNewer("2.0.0", "1.99.99"), true);
  assert.equal(isNewer("1.4.3", "1.4.3"), false, "같은 버전을 최신이라고 했다");
  assert.equal(isNewer("1.4.3", "1.4.2"), true);
  assert.equal(isNewer("1.4", "1.4.0"), false, "부족한 세그먼트를 0으로");
});

test("`v` 접두사와 불완전한 버전도 읽는다", () => {
  assert.deepEqual(parseVersion("v1.2.3").nums, [1, 2, 3]);
  assert.deepEqual(parseVersion("1.2").nums, [1, 2, 0]);
  assert.equal(parseVersion("1.2.3-rc1").pre, "rc1");
  // 정식 1.2.3 은 pre-release 1.2.3-rc1 보다 높다
  assert.equal(isNewer("1.2.3", "1.2.3-rc1"), true);
  assert.equal(isNewer("1.2.3-rc2", "1.2.3-rc1"), true);
});

test("해시 검증: 일치/불일치/형식 오류 3가지를 구분한다", () => {
  const data = Buffer.from("바이너리");
  const good = sha("바이너리");
  assert.equal(verifyHash(data, good).ok, true);
  assert.equal(verifyHash(data, good.toUpperCase()).ok, true, "대문자 해시를 못 읽었다");
  assert.equal(verifyHash(data, `sha256:${good}`).ok, true, "sha256: 접두사를 못 벗겼다");
  assert.equal(verifyHash(data, sha("다른 것")).ok, false);
  // **형식이 틀리면 "일치" 가 아니라 "검증 불가" 다 — 그리고 그것은 불일치로 취급한다.**
  assert.equal(verifyHash(data, "짧음").ok, false, "형식이 틀렸는데 통과했다");
  assert.equal(verifyHash(data, "").ok, false);
  assert.equal(verifyHash(data, "z".repeat(64)).ok, false, "hex 가 아닌데 통과했다");
});

test("해시가 다르면 **적용 금지** — 그게 원본 원칙이다", () => {
  const data = Buffer.from("x");
  const r = verifyHash(data, sha("y"));
  assert.equal(r.ok, false);
  assert.equal(r.actual !== r.expected, true, "실제 해시를 알려야 diagnosable 하다");
});

test("짧은 해시는 표시용으로만", () => {
  const h = sha("z");
  assert.equal(shortHash(h).length, 13);
  assert.equal(shortHash("짧다"), "짧다");
});

test("채널 필터: stable 은 nightly 를 받지 않는다", () => {
  assert.equal(releaseMatchesChannel({ channel: "stable" }, "stable"), true);
  assert.equal(releaseMatchesChannel({ channel: "beta" }, "stable"), false);
  assert.equal(releaseMatchesChannel({ channel: "nightly" }, "nightly"), true);
  assert.equal(releaseMatchesChannel({ channel: "beta" }, "nightly"), true);
});

test("롤백 슬롯은 **3개** — 그 이상은 필요 없다", () => {
  assert.equal(VERSION_SLOTS, 3);
});

test("롤백 슬롯 저장이 **실패하면 업데이트를 막아야 한다**", async () => {
  const store = createSlotStore("/tmp/versions", {
    exists: () => false,
    copyDir: async () => undefined,
    rmDir: async () => undefined,
    readDir: async () => [],
    mkdir: async () => {
      throw new Error("read-only filesystem");
    },
    bytes: async () => 0,
  });
  assert.equal(await store.save("1.4.2", 100), null, "슬롯 저장을 실패로 반환하지 않았다");
});

test("슬롯 목록은 **버전 순**, recent 3개만", async () => {
  const dirs = new Set(["1.4.1", "1.4.2", "1.4.3", "1.4.0", "1.3.9"]);
  const store = createSlotStore("/v", {
    exists: (p) => [...dirs].some((d) => p.endsWith(d)),
    copyDir: async () => undefined,
    rmDir: async () => undefined,
    readDir: async () => [...dirs],
    mkdir: async () => undefined,
    bytes: async () => 1,
  });
  const list = await store.read();
  assert.equal(list.length, VERSION_SLOTS, `슬롯 ${list.length}개 — 정리되지 않았다`);
  assert.equal(list[0].version, "1.4.3", "가장 최근 버전이 아니다");
  assert.equal(list[1].version, "1.4.2");
});

test("\"이 버전으로 되돌리기\" 가 **실제로 가능**해야 한다", async () => {
  const dirs = new Set(["1.4.2"]);
  const store = createSlotStore("/v", {
    exists: (p) => [...dirs].some((d) => p.endsWith(d)),
    copyDir: async () => undefined,
    rmDir: async () => undefined,
    readDir: async () => [...dirs],
    mkdir: async () => undefined,
    bytes: async () => 1,
  });
  assert.equal(store.has("1.4.2"), true, "되돌릴 수 있다고 말하지만 슬롯이 없다");
  assert.equal(store.has("1.0.0"), false);
  // 파일 부재 시 UI 가 "설치 파일 없음 — 다시 다운로드" 를 말할 수 있어야 한다
});

test("적용 확인: 진행 중 턴·프로세스·미저장 탭을 **모두** 말한다", () => {
  const g: ApplyGuard = {
    runningTurns: ["t1", "t2"],
    processes: ["npm test"],
    dirtyTabs: 3,
    canRollback: true,
    daemon: false,
    estimatedSeconds: 12.4,
    assetBytes: 50 * 1024 * 1024,
  };
  const d = planApply(g);
  assert.equal(d.ok, true);
  assert.equal(d.items.length >= 5, true, `확인 항목이 ${d.items.length}개뿐 — 위험한 버튼이다`);
  assert.ok(d.items.some((i) => i.includes("턴")), "진행 중 턴을 안 말한다");
  assert.ok(d.items.some((i) => i.includes("프로세스")), "백그라운드 프로세스를 안 말한다");
  assert.ok(d.items.some((i) => i.includes("저장되지 않은")), "미저장 탭을 안 말한다");
  assert.ok(d.items.some((i) => i.includes("12초")), `예상 시간이 없다: ${d.items.join(" / ")}`);
  assert.ok(d.items.some((i) => i.includes("llama-server")), "창 모드에서 llama 종료 위험을 안 말한다");
});

test("데몬 모드와 창 모드의 **결과가 다르다** — §4.4", () => {
  const base: ApplyGuard = { runningTurns: [], processes: [], dirtyTabs: 0, canRollback: true, daemon: true, estimatedSeconds: 1, assetBytes: 1 };
  assert.ok(planApply(base).items.some((i) => i.includes("계속 살아")), "데몬 모드가 창 모드와 같은 설명을 한다");
  assert.ok(planApply({ ...base, daemon: false }).items.some((i) => i.includes("종료됩니다")));
});

test("**롤백 불가면 시도 자체를 막는다** — 되돌릴 수 없는 베팅을 하지 않는다", () => {
  const g: ApplyGuard = { runningTurns: [], processes: [], dirtyTabs: 0, canRollback: false, daemon: true, estimatedSeconds: 1, assetBytes: 1 };
  const d = planApply(g);
  assert.equal(d.ok, false, "롤백 불가한데 진행을 허용했다");
  assert.ok(d.blockers.length > 0, "막는 사유가 없다");
  assert.match(d.blockers[0], /되돌릴 수 없/);
});

test("부팅 판정: **프로세스가 떴다는 것만으로 성공이 아니다**", () => {
  // 10초째, 아직 hello 없음 → 아직 판정 시점이 아니다
  assert.equal(judgeBoot(false, 10), "pending");
  assert.equal(judgeBoot(true, 10), "healthy", "hello 를 보냈는데 실패로 판정했다");
  // 90초를 넘겨도 hello 없음 → 실패(그리고 롤백)
  assert.equal(judgeBoot(false, DEFAULT_ROLLBACK.bootGraceSec + 1), "failed");
  assert.equal(judgeBoot(false, 10000), "failed");
});

test("자동 롤백을 끄면 실패 판정은 그대로지만 사유를 안 준다", () => {
  assert.equal(judgeBoot(false, 100, { enabled: false, bootGraceSec: 90 }), "failed");
  const r = rollbackReason();
  assert.match(r, /90초/);
  assert.match(r, /되돌렸습니다/);
});

test("네트워크 실패는 **오프라인 상태** 다 — 예외가 아니라 분류", () => {
  // `classifyFetchError` 는 항상 실패를 돌려준다(성공 경로가 아님) — narrowing 으로 확인.
  const reason = (e: unknown, status?: number) => {
    const r = classifyFetchError(e, status);
    assert.equal(r.ok, false, "성공으로 분류했다");
    return r.ok ? "" : r.reason;
  };
  assert.equal(reason(new Error("fetch failed")), "offline");
  assert.equal(reason(new Error("getaddrinfo ENOTFOUND github.com")), "offline");
  assert.equal(reason(new Error("x"), 429), "rate-limit");
  assert.equal(reason(new Error("x"), 403), "rate-limit");
  assert.equal(reason(new Error("x"), 502), "http-error");
  // 실패 문구는 "오프라인" 배지로 보여야 한다 (§11.2 O12)
  const r = classifyFetchError(new Error("fetch failed"));
  assert.match(r.ok ? "" : r.detail, /오프라인|계속 실행/);
});

test("진행 단계가 **따로** 보인다 — '다운로드 완료 ≠ 적용 완료'", () => {
  assert.match(progressLabel({ state: "downloading", progress: 42, message: "", at: 0 }), /42%/);
  assert.match(progressLabel({ state: "staged", progress: 100, message: "", at: 0 }), /아직 교체되지 않았습니다/);
  assert.match(progressLabel({ state: "applied", progress: 100, message: "", at: 0 }), /정상 부팅을 확인/);
  // 100% 라고 "적용됨" 이라고 하지 않는다
  assert.equal(progressLabel({ state: "verifying", progress: 100, message: "", at: 0 }).includes("완료"), false);
});

test("자동 설치는 **기본 꺼짐** — 켜려면 명시해야 한다", () => {
  assert.equal(DEFAULT_AUTO.autoInstall, false);
  assert.equal(DEFAULT_AUTO.checkOnStart, false, "부팅 속도를 헤치게 한다");
  assert.equal(DEFAULT_AUTO.autoCheck, true);
  assert.equal(DEFAULT_AUTO.offlineIsQuiet, true, "오프라인에서 재시도 루프에 들어간다");
});

test("자체 개발 중 업데이트를 끌 수 있다", () => {
  assert.equal(updatesDisabledByEnv({ HARNESSIDE_NO_UPDATE: "1" }), true);
  assert.equal(updatesDisabledByEnv({}), false);
  assert.equal(updatesDisabledByEnv({ HARNESSIDE_NO_UPDATE: "0" }), false);
});
