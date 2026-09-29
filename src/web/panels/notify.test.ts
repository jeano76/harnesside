/**
 * 알림/드래프트/팔레트 테스트 (§11.1 M4·M5·M7·M8 · §11.3 · §10.2).
 *
 * 전부 "사라지면 안 되는 것" 을 지키는 로직이다. 그래서 반복해서 검증한다:
 * 경과 시간이 지나도 안 사라져야 하는 것, 재시도되어야 하는 것.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  makeToast,
  toastView,
  pushToast,
  dismiss,
  errorCenter,
  humanizeError,
  saveDraft,
  loadDraft,
  clearDraft,
  draftAfterSend,
  fuzzyScore,
  searchCommands,
  CommandRunner,
  describeKeyCoverage,
  ackToast,
  resetAcks,
  REQUIRED_KEYS,
  type Toast,
  type Command,
} from "./notify.js";

const t = (id: string, kind: Toast["kind"], at = 0): Toast => makeToast(id, kind, `제목 ${id}`, "본문", at);

test("오류 토스트는 **자동으로 사라지지 않는다** — 놓치면 원인을 모른다", () => {
  resetAcks();
  const e = makeToast("e1", "error", "저장 실패", "디스크가 가득 찼습니다", 0);
  assert.equal(e.ttlMs, null, "오류가 시간 지나면 사라진다");
  const v = toastView([e], 10_000_000);
  assert.equal(v.live.length, 1, "1억 ms 뒤에 오류가 사라졌다");
  assert.equal(v.unacked, 1, "확인 대기 배지에 숫자가 없다");
  assert.equal(v.nextExpiry, null, "오류에 만료 시각이 있다");
});

test("정보성 토스트는 짧게 사라진다 — 화면을 덮지 않는다", () => {
  const i = makeToast("i1", "info", "저장됨", "", 0);
  assert.ok(i.ttlMs && i.ttlMs > 0);
  assert.equal(toastView([i], 0).live.length, 1);
  assert.equal(toastView([i], 60_000).live.length, 0, "정보 토스트가 영원히 남는다");
  assert.equal(toastView([i], 60_000).unacked, 0);
});

test("확인하면 배지에서 빠진다", () => {
  resetAcks();
  const e = t("e2", "error");
  assert.equal(toastView([e]).unacked, 1);
  ackToast("e2");
  assert.equal(toastView([e]).unacked, 0, "확인했는데 배지에 남는다");
});

test("같은 id 는 **교체**된다 — 같은 작업의 반복이 10개 쌓이면 알 수 없다", () => {
  resetAcks();
  let items: Toast[] = [];
  for (let i = 0; i < 5; i++) items = pushToast(items, makeToast("save", "info", `저장 ${i}`, "", 0));
  assert.equal(items.length, 1, `같은 작업이 ${items.length} 개 토스트로 쌓였다`);
  assert.equal(items[0].title, "저장 4");
});

test("토스트는 상한을 넘으면 **가장 오래된 것부터** 버린다", () => {
  let items: Toast[] = [];
  for (let i = 0; i < 8; i++) items = pushToast(items, makeToast(`t${i}`, "info", `${i}`, "", 0), 5);
  assert.equal(items.length, 5);
  assert.equal(items[0].id, "t7", "최신 것이 밀려났다");
});

test("오류 센터는 **오류를 버리지 않는다** — 아카이브로 옮긴다", () => {
  const errs = Array.from({ length: 14 }, (_, i) => t(`e${i}`, "error"));
  const c = errorCenter(errs, 10);
  assert.equal(c.active.length, 10);
  assert.equal(c.archived.length, 4, "오류 4개가 사라졌다");
  // 정보성 토스트는 오류 센터에 들어가지 않는다
  assert.equal(errorCenter([t("i", "info")]).active.length, 0);
});

test("닫으면 목록에서 빠진다", () => {
  const items = [t("a", "info"), t("b", "error")];
  assert.equal(dismiss(items, "a").length, 1);
  assert.equal(dismiss(items, "zzz").length, 2, "없는 id 를 닫으면 항목이 사라졌다");
});

test("오류를 **사람 문장**으로 바꾼다 — TypeError 를 그대로 띄우지 않는다(§11.3)", () => {
  const net = humanizeError(new TypeError("fetch failed"), "모델 목록 조회");
  assert.equal(/TypeError/.test(net.message), false, `원시 오류를 그대로 띄웠다: ${net.message}`);
  assert.match(net.message, /모델 목록 조회/);
  assert.match(net.message, /연결하지 못/);
  assert.equal(net.retryable, true);

  assert.match(humanizeError(new Error("ENOSPC: no space left on device"), "저장").message, /디스크가 가득/);
  assert.match(humanizeError(new Error("EACCES: permission denied"), "저장").message, /권한/);
  assert.match(humanizeError(new Error("409 Conflict"), "저장").message, /충돌/);
  assert.match(humanizeError(new Error("500 internal server error"), "저장").message, /서버 오류/);
  // 알려지지 않은 오류는 **원인을 남긴다** — 삼키면 버그를 못 찾는다
  const unknown = humanizeError(new Error("weird thing"), "동기화");
  assert.match(unknown.message, /weird thing/);
  assert.match(unknown.message, /^동기화.{0,4}실패/, `문장 형태가 어색하다: ${unknown.message}`);
});

// ------------------------------------------------------------------ 드래프트

function memStorage() {
  const m = new Map<string, string>();
  return {
    setItem: (k: string, v: string) => void m.set(k, v),
    getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

test("M7: 입력창 내용은 **서버가 죽어도** 살아있다 (창 스코프)", () => {
  const s = memStorage();
  saveDraft({ text: "이 프롬프트는 서버가 죽어도 사라지면 안 된다", savedAt: 1000, attachments: [] }, s);
  const got = loadDraft(s);
  assert.equal(got?.text, "이 프롬프트는 서버가 죽어도 사라지면 안 된다");
  assert.equal(got?.savedAt, 1000);
});

test("빈 프롬프트를 저장하지 않는다 — 지운 것이 되살아난다", () => {
  const s = memStorage();
  saveDraft({ text: "   ", savedAt: 1, attachments: [] }, s);
  assert.equal(loadDraft(s), null);
  // 첨부가 있으면 비어 있어도 남긴다
  saveDraft({ text: "", savedAt: 1, attachments: ["a.png"] }, s);
  assert.equal(loadDraft(s)?.attachments.length, 1);
});

test("전송 **성공** 후에만 지운다 — 실패한 프롬프트는 남긴다", () => {
  const d: DraftType = { text: "중요한 프롬프트", savedAt: 1, attachments: [] };
  assert.equal(draftAfterSend(true, d), null, "성공 후에도 남는다");
  assert.equal(draftAfterSend(false, d), d, "실패했는데 지웠다 — 프롬프트가 사라진다");
});
type DraftType = { text: string; savedAt: number; attachments: string[] };

test("깨진 드래프트가 앱을 막지 않는다", () => {
  const s = memStorage();
  s.setItem("harnesside.draft", "{ 깨진 JSON");
  assert.equal(loadDraft(s), null);
  s.setItem("harnesside.draft", '{"text": 123}');
  assert.equal(loadDraft(s), null);
});

test("저장소 용량 초과가 입력을 막지 않는다", () => {
  const s = {
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    getItem: () => null,
    removeItem: () => undefined,
  };
  assert.doesNotThrow(() => saveDraft({ text: "긴 프롬프트", savedAt: 1, attachments: [] }, s));
});

test("지우면 사라진다", () => {
  const s = memStorage();
  saveDraft({ text: "x", savedAt: 1, attachments: [] }, s);
  clearDraft(s);
  assert.equal(loadDraft(s), null);
});

// ------------------------------------------------------------------ 팔레트

const cmds: Command[] = [
  { id: "file.save", title: "파일 저장", category: "파일", keys: ["Ctrl+S"], run: "file.save()" },
  { id: "git.commit", title: "커밋", category: "에이전트", keys: [], run: "git.commit()" },
  { id: "view.toggleTerminal", title: "터미널 열기", category: "보기", keys: ["Ctrl+`"], run: "view.toggleTerminal()" },
  { id: "settings.open", title: "설정 열기", category: "설정", keys: [], run: "settings.open()" },
];

test("퍼지 매칭: 접두사가 가장 높은 점수", () => {
  assert.equal(fuzzyScore("파일", "파일 저장")!.score, 1000, "접두사가 최고 점수가 아니다");
  assert.equal(fuzzyScore("저장", "파일 저장")!.score, 700 - 3, "중간 부분의 점수가 접두사와 같다");
  // 빈 질의는 **모든 항목을 0점보다 높게** 만든다(팔레트를 열면 목록이 보여야 한다)
  const all = fuzzyScore("", "아무것");
  assert.ok(all && all.score > 0, "빈 질의가 0점이라 목록이 비어 보인다");
});

test("부분 문자열과 연속 수열을 **모두** 찾는다", () => {
  assert.ok(fuzzyScore("저장", "파일 저장"));
  assert.ok(fuzzyScore("저장", "저장하기"), "단어가 앞에 있다");
  // 연속 수열(글자가 흩어져 있어도 순서만 맞으면 찾는다) — "gt" → "git" 류
  const spread = fuzzyScore("gt", "git status");
  assert.ok(spread, "연속 수열을 못 찾는다");
  // 앞에 붙은 쪽이 우선이다 — "저장" 이 앞에 오는 항목이 먼저 온다
  assert.ok(spread!.score < fuzzyScore("gt", "gt status")!.score, "접두사가 더 낮게 나왔다");
});

test("안 맞는 질의는 **결과가 없다** — 임의로 0점 항목이 나오면 안 된다", () => {
  assert.deepEqual(searchCommands(cmds, "zxcv"), []);
  assert.deepEqual(searchCommands(cmds, "").length, 4, "빈 질의로도 목록은 볼 수 있다");
});

test("검색 결과는 **상한**을 넘지 않는다", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, title: `명령 ${i}`, category: "기타" as const, keys: [], run: `c${i}` }));
  assert.equal(searchCommands(many, "명령", 10).length, 10);
});

test("명령은 **한 번만** 실행된다 — 두 번 실행되면 파일이 두 번 저장된다", async () => {
  resetAcks();
  const r = new CommandRunner();
  let count = 0;
  let release = () => {};
  const p1 = r.run("a", async () => {
    count++;
    await new Promise<void>((res) => {
      release = res;
    });
  });
  // 실행 중인 동안 재호출
  const dup = await r.run("a", () => {
    count++;
  });
  assert.equal(dup.ran, false, "동일 명령이 두 번 실행됐다");
  assert.match(dup.reason ?? "", /이미 실행 중/);
  assert.equal(r.isRunning("a"), true);
  release();
  await p1;
  assert.equal(count, 1);
  assert.equal(r.isRunning("a"), false);
});

test("실패한 명령은 **사람 문장**으로 이력에 남는다", async () => {
  const r = new CommandRunner();
  const res = await r.run("boom", () => {
    throw new Error("fetch failed");
  });
  assert.equal(res.ran, false);
  assert.match(res.reason ?? "", /서버 오류|연결/);
  const h = r.history_;
  assert.equal(h.length, 1);
  assert.equal(h[0].ok, false);
  assert.ok(h[0].error);
});

test("M8: 필수 키 커버리지를 **검사한다** — 빠진 키를 말해야 한다", () => {
  const full = describeKeyCoverage(REQUIRED_KEYS);
  assert.equal(full.ok, true);
  assert.equal(full.missing.length, 0);
  const partial = describeKeyCoverage(["Ctrl+S", "Ctrl+K"]);
  assert.equal(partial.ok, false, "빠진 키가 있어도 통과했다");
  assert.ok(partial.missing.includes("Ctrl+`"), `터미널 키 누락을 못 찾았다: ${partial.missing.join(", ")}`);
  // 대소문자는 무시한다 (Shift 가 붙으면 문자열이 달라진다)
  assert.equal(describeKeyCoverage(REQUIRED_KEYS.map((k) => k.toUpperCase())).ok, true);
});
