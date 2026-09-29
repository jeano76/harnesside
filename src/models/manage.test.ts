/**
 * 모델 관리 테스트 (§7 · P11 · 요구 5 · §10.2).
 *
 * 검증 순서 요구사항 그대로: **Ornith 1순위 고정 → 검색 → 추천 → 멀티 다운로드
 * (중단/재개) → 교체 → llama 재기동 → 새 모델 응답 확인**.
 * 마지막 "응답 확인" 이 빠지면 교체 성공을 알 수 없다 — 그게 이 단계의 함정이다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isUsableModel,
  parseModelFile,
  isPinned,
  listModels,
  withActive,
  activeModel,
  activate,
  newDownload,
  startDownload,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  advanceDownload,
  failDownload,
  completeDownload,
  queueView,
  nextToStart,
  planSwap,
  judgeSwap,
  firstRunSteps,
  formatBytes,
  type ModelEntry,
  type DownloadItem,
} from "./manage.js";

const m = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  id: over.file ?? "x",
  repo: "me/Ornith",
  file: "x.gguf",
  path: `/models/${over.file ?? "x.gguf"}`,
  bytes: 8 * 1024 ** 3,
  label: null,
  family: "X",
  quant: null,
  installedAt: 0,
  lastUsedAt: null,
  active: false,
  ...over,
});

test("**Ornith 계열이 1순위 고정** — 점수와 무관하게 (§7 / P11 명시)", () => {
  const list = listModels([
    m({ file: "z-70B-Q8_0.gguf", family: "Zeta-70B", quant: "Q8_0", bytes: 40e9 }),
    m({ file: "ornith-30b-q3_k_xl.gguf", family: "Ornith-30B", quant: "Q3_K_XL", bytes: 12e9 }),
    m({ file: "a-7b-q4_k_m.gguf", family: "Alpha-7B", quant: "Q4_K_M", bytes: 4e9 }),
  ]);
  // **더 작고 더 낮은 양자화여도** 맨 앞이다
  assert.equal(list.ordered[0].family, "Ornith-30B", `1순위가 ${list.ordered[0].family} 다 — 고정 규칙이 깨졌다`);
  assert.equal(list.pinned.length, 1);
  assert.equal(list.others.length, 2);
  // 나머지는 양자화 품질순
  assert.equal(list.others[0].file, "z-70B-Q8_0.gguf");
});

test("대소문자와 하이픈을 가리지 않는다 — 계열 판정이 틀리면 고정이 풀린다", () => {
  assert.equal(isPinned("Ornith-30B"), true);
  assert.equal(isPinned("ornith-30b"), true);
  assert.equal(isPinned("ORNITH"), true);
  assert.equal(isPinned("ornithopter"), true);
  // "Not-Ornith" 은 계열이 "Not-Ornith" 다 — **포함**이 아니라 **접두사** 여야 한다.
  // includes 로 판정하면 다른 프로젝트가 고정 1순위로 올라온다.
  assert.equal(isPinned("Not-Ornith"), false, "중간에 나오는 문자열까지 고정됐다");
  assert.equal(isPinned("Zeta-70B"), false);
});

test("활성 모델은 Ornith 안에서도 **맨 앞** — 지금 쓰는 것이 가장 보인다", () => {
  const list = listModels([
    m({ file: "a.gguf", family: "Ornith-30B", active: true }),
    m({ file: "b.gguf", family: "Ornith-30B" }),
  ]);
  assert.equal(list.ordered[0].active, true);
});

test("쓰이지 않는 파일은 목록에서 빠진다 — mmproj/부분 파일", () => {
  assert.equal(isUsableModel("a.gguf"), true);
  assert.equal(isUsableModel("a-mmproj.gguf"), false);
  assert.equal(isUsableModel("a.gguf.part"), false);
  assert.equal(isUsableModel("a.txt"), false);
  const l = listModels([m({ file: "ok.gguf" }), m({ file: "x.gguf.part" })]);
  assert.equal(l.ordered.length, 1);
});

test("양자화는 **순위** 로 비교된다 — Q8_0 이 Q3 보다 높다", () => {
  const l = listModels([
    m({ file: "low.gguf", family: "Z", quant: "Q3_K_XL" }),
    m({ file: "high.gguf", family: "Z", quant: "Q8_0" }),
  ]);
  assert.equal(l.ordered[0].file, "high.gguf");
});

test("파싱: 파일명 → 계열 + 양자화, **꼬리 구분자 없음**", () => {
  const a = parseModelFile("Ornith-30B-Q5_K_M.gguf");
  assert.equal(a.family, "Ornith-30B", `꼬리가 남았다: ${a.family}`);
  assert.equal(a.quant, "Q5_K_M");
  assert.equal(parseModelFile("x-f16.gguf").quant, "F16");
  assert.equal(parseModelFile("plain.gguf").quant, null);
});

test("활성 모델은 **정확히 하나** — 둘이면 llama 가 무엇을 띄울지 모른다", () => {
  const a = m({ file: "a.gguf" });
  const b = m({ file: "b.gguf" });
  const e = withActive([a, b], b.id);
  assert.equal(e.filter((x) => x.active).length, 1);
  assert.equal(activeModel(e)?.file, "b.gguf");
  assert.equal(activeModel([]), null);
});

test("교체: 없는 모델과 사용 불가 파일은 **거부** — 이유를 말한다", () => {
  const a = m({ file: "a.gguf" });
  const no = activate([a], "없는 모델");
  assert.equal(no.changed, false);
  assert.match(no.reason, /찾을 수 없/);
  const part = m({ file: "x.gguf.part" });
  const bad = activate([a, part], part.id);
  assert.equal(bad.changed, false);
  assert.match(bad.reason, /사용할 수 없/);
  const same = activate([m({ file: "a.gguf", active: true })], "a.gguf");
  assert.equal(same.changed, false);
  assert.match(same.reason, /이미 활성/);
});

// ---------------------------------------------------------------- 다운로드

test("중단 후 **재개**된다 — 삭제가 아니다", () => {
  let d = newDownload("d1", "a.gguf", 1000);
  d = startDownload(d);
  d = advanceDownload(d, 400);
  assert.equal(d.receivedBytes, 400);
  d = pauseDownload(d);
  assert.equal(d.state, "paused");
  assert.equal(d.bytesPerSec, 0, "중단했는데 속도가 남았다");
  d = resumeDownload(d);
  assert.equal(d.state, "downloading");
  // 재개하면 **이어서** 받는다 (0 부터 다시가 아니다)
  d = advanceDownload(d, 100);
  assert.equal(d.receivedBytes, 500, "재개하면 처음부터 다시 받는다");
});

test("완료하면 **검증** 단계로 간다 — 다운로드 ≠ 설치", () => {
  let d = newDownload("d1", "a.gguf", 1000);
  d = startDownload(d);
  d = advanceDownload(d, 1000);
  assert.equal(d.state, "verifying", "검증 없이 완료 처리했다");
  assert.equal(d.progress, 100);
  d = completeDownload(d);
  assert.equal(d.state, "done");
});

test("크기를 모르면 진행률을 **지어내지 않는다**", () => {
  let d = newDownload("d1", "a.gguf", 0);
  d = startDownload(d);
  d = advanceDownload(d, 5000);
  assert.equal(d.progress, 0, `크기 모를 때 진행률 ${d.progress}% — 100% 로 보일 수 있다`);
  assert.equal(d.receivedBytes, 5000, "받은 만큼은 기록된다");
  assert.equal(formatBytes(0), "크기 모름");
});

test("일시 정지된 항목은 진행하지 않는다 — 중간의 덩어리가 새지 않는다", () => {
  let d = newDownload("d1", "a.gguf", 1000);
  d = startDownload(d);
  d = pauseDownload(d);
  const before = d.receivedBytes;
  d = advanceDownload(d, 500);
  assert.equal(d.receivedBytes, before, "일시 정지 중인데 데이터가 늘었다");
});

test("취소된 항목은 **완료로 되돌아가지 않는다**", () => {
  let d = newDownload("d1", "a.gguf", 1000);
  d = startDownload(d);
  d = cancelDownload(d);
  assert.equal(d.state, "canceled");
  d = completeDownload(d);
  assert.equal(d.state, "canceled", "취소한 항목이 완료됐다");
  // 이미 완료된 건 취소가 아니다
  const done = cancelDownload(completeDownload(newDownload("d2", "b.gguf", 10)));
  assert.equal(done.state, "done");
});

test("멀티 다운로드: **동시성** 을 지키고 큰 것부터", () => {
  const items: DownloadItem[] = [
    newDownload("a", "small.gguf", 100),
    newDownload("b", "big.gguf", 900),
    newDownload("c", "mid.gguf", 500),
  ];
  assert.equal(nextToStart(items, 2)?.file, "big.gguf", "큰 것부터 시작하지 않는다");
  const running = [startDownload(items[0]), startDownload(items[1])];
  assert.equal(nextToStart(running, 2), null, "동시성 제한을 넘겼다");
  // 자리가 하나 남으면 **전체 큐**에서 다음을 고른다 (실행 중인 것만 보면 안 된다)
  assert.equal(nextToStart([...running, items[2]], 3)?.file, "mid.gguf");
  // 큐에 남는 게 없으면 null — undefined 가 아니라
  assert.equal(nextToStart(running, 3), null);
});

test("실패한 항목은 **재시도 대상**이 된다 — 곧바로 버리지 않는다", () => {
  const d = failDownload(startDownload(newDownload("d1", "a.gguf", 100)), "네트워크 끊김");
  assert.equal(d.state, "failed");
  assert.match(d.error!, /네트워크/);
  const queued = [newDownload("z", "z.gguf", 10), d];
  assert.equal(nextToStart(queued, 2)?.file, "a.gguf", "실패한 항목이 재시도 대상이 아니다");
});

test("큐 통계: 전체/개별 진행률, 0 이면 0", () => {
  let a = advanceDownload(startDownload(newDownload("a", "a.gguf", 1000)), 250);
  const b = newDownload("b", "b.gguf", 1000);
  const v = queueView([a, b]);
  assert.equal(v.concurrency, 1);
  assert.equal(v.receivedBytes, 250);
  assert.equal(v.totalBytes, 2000);
  assert.equal(v.overallPct, 12.5);
  assert.equal(queueView([]).overallPct, 0);
  assert.equal(queueView([a]).active.length, 1);
  a = pauseDownload(a);
  assert.equal(queueView([a]).paused.length, 1);
});

// ---------------------------------------------------------------- 교체

test("교체 계획이 **응답 확인** 단계를 포함한다", () => {
  const p = planSwap({ from: m({ file: "old.gguf" }), to: m({ file: "new.gguf" }), preserveOld: true, canRestartLlama: true });
  assert.ok(p.steps.includes("verify"), `응답 확인이 없다: ${p.steps.join(" → ")}`);
  assert.equal(p.canRollback, true);
  // 순서: 확인 → 정지 → 교체 → 재기동 → 검증 → 완료
  assert.deepEqual(p.steps, ["check", "stop-llama", "switch", "restart", "verify", "done"]);
});

test("기존 파일을 지우면 **되돌릴 수 없다** — 시도 자체를 막는다", () => {
  const p = planSwap({ from: m({ file: "old.gguf" }), to: m({ file: "new.gguf" }), preserveOld: false, canRestartLlama: true });
  assert.equal(p.canRollback, false);
  assert.ok(p.warnings.some((w) => w.includes("되돌릴 수 없습니다")), p.warnings.join(" / "));
});

test("기존 모델이 없으면(첫 설치) 되돌릴 수는 없지만 **막지는 않는다**", () => {
  const p = planSwap({ from: null, to: m({ file: "new.gguf" }), preserveOld: true, canRestartLlama: true });
  assert.equal(p.canRollback, false);
  assert.ok(p.steps.includes("done"), "첫 설치를 막았다");
});

test("llama 재기동이 불가하면 **검증 단계도 없다** — 가짜 성공을 만들지 않는다", () => {
  const p = planSwap({ from: m(), to: m({ file: "n.gguf" }), preserveOld: true, canRestartLlama: false });
  assert.equal(p.steps.includes("verify"), false);
  assert.ok(p.warnings.some((w) => w.includes("수동")), p.warnings.join(" / "));
});

test("판정: **교체 ≠ 동작** — 응답 확인이 없으면 성공이 아니다", () => {
  const notProbed = judgeSwap({ step: "restart" }, "new");
  assert.equal(notProbed.ok, true, "서버만 떴는데 성공이다");

  const unverified = judgeSwap({ step: "verify", probed: false }, "new");
  assert.equal(unverified.ok, false, "응답 확인 없이 성공이다");
  assert.match(unverified.reason, /동작한다고 볼 수 없/);

  const broken = judgeSwap({ step: "verify", probed: true, responseOk: false }, "new");
  assert.equal(broken.ok, false);
  assert.equal(broken.rolledBack, true, "응답이 없는데 되돌리지 않았다");
});

test("판정: 단계 실패는 **어느 단계에서 왜** 났는지 말한다", () => {
  const r = judgeSwap({ step: "switch", error: "EACCES: 읽기 전용 파일 시스템" }, "new");
  assert.equal(r.ok, false);
  assert.match(r.reason, /모델 교체 실패/);
  assert.match(r.reason, /EACCES/, "원인이 가려졌다");
});

test("크기 0 인 모델은 **경고**한다 — 덜 받은 파일일 수 있다", () => {
  const p = planSwap({ from: m(), to: m({ file: "x.gguf", bytes: 0 }), preserveOld: true, canRestartLlama: true });
  assert.ok(p.warnings.some((w) => w.includes("0")), p.warnings.join(" / "));
});

test("첫 실행 가이드: **3단계** 가 순서대로 보인다 (§11.3)", () => {
  const none = firstRunSteps(false, false);
  assert.equal(none.length, 3);
  assert.equal(none.every((s) => !s.done), true);
  assert.deepEqual(none.map((s) => s.n), [1, 2, 3]);
  const ready = firstRunSteps(true, true);
  assert.equal(ready.every((s) => s.done), true);
  // 반쪽만 준비되면 3단계는 아직이다
  assert.equal(firstRunSteps(true, false)[2].done, false);
});

test("바이트 표기가 0 을 '크기 모름' 으로 말한다", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MiB");
  assert.equal(formatBytes(8 * 1024 ** 3), "8.0 GiB");
  assert.equal(formatBytes(-1), "크기 모름");
});
