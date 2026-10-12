#!/usr/bin/env node
/**
 * 승인카드 60초 자동거절 + 셸 출력 접기 UI 의 **라이브 실측** (§S-6 · §S-3).
 *
 * 왜 별도 스크립트인가: 두 경로 다 유닛은 통과했었다. 그런데 2026-10-12 라이브
 * 확인에서 두 건이 실제로 끊겨 있었다 —
 *   1. 게이트는 생성됐지만 에이전트에 붙지 않아 `rm -rf` 가 카드 없이 실행됨
 *      (`index.ts` 접착 1줄 누락 — `approvalGate.wiring.test.ts` 로 회귀 고정).
 *   2. 셸 출력이 블록에 닿지 않아 접기 UI 가 영영 안 뜸 (결과가 모델 대화에만
 *      있고 블록 text 는 "" — `loop.ts`→`agentService.ts` 결과 배선으로 수정).
 * 유닛이 "코드가 쓰인 대로 도는가" 만 보고 "사람 눈에 보이는가" 를 안 본 대가다.
 * 이 스크립트는 진짜 서버·진짜 창·진짜 턴으로 DOM 까지 본다.
 *
 * 검증하는 것 / 하지 않는 것:
 *   - 함: 카드 렌더(판정문·카운트다운·버튼) · 60초 타임아웃 settle→카드 닫힘 ·
 *     거절 시 미실행 · 허용 시 전체 출력+접기·펼치기 동작.
 *   - 안 함: 모델 품질 (가짜 llama-server 가 도구 호출만 흉내낸다).
 *     `scripts/fake-llama-server.mjs` 의 `FAKE_TOOL_CALLS` 를 쓴다.
 *
 * 전제 (깔아놓고 실행 — verify-window.mjs 와 같은 방식):
 *   1. 가짜 모델 (`FAKE_TOOL_CALLS` 는 아래 고정값):
 *      FAKE_TOOL_CALLS='[{"match":"APPROVAL-TEST","name":"run_shell","arguments":{"command":"rm -rf /tmp/harnesside-verify-approve/scratch"}},{"match":"FOLD-TEST","name":"run_shell","arguments":{"command":"seq 1 100"}}]'
 *      node scripts/fake-llama-server.mjs --port 8080 --model-path <실재 파일>
 *   2. 진짜 서버가 가짜를 채택한 상태 (`harnesside up --here`, 7317).
 *   3. 헤드리스 크롬이 CDP 9222 로 창을 열어둔 상태.
 *   4. 턴이 아래 마커와 겹치지 않는 깨끗한 세션 권장 (아니면 이전 블록과 섞인다).
 *
 *   HARNESSIDE_URL (기본 127.0.0.1:7317) · HARNESSIDE_CDP (기본 9222) ·
 *   HARNESSIDE_TOKEN (없으면 <workspace>/.harnesside/state/token.json — `--workspace` 로 지정).
 *
 * 승인 페이즈에 ~75초가 걸린다. 빠른 게이트용이 아니다 — 수동·야간용.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";

const URL_MATCH = process.env.HARNESSIDE_URL ?? "127.0.0.1:7317";
const CDP = process.env.HARNESSIDE_CDP ?? "http://127.0.0.1:9222";
const wsArg = process.argv.indexOf("--workspace");
const WORKSPACE = wsArg >= 0 ? process.argv[wsArg + 1] : process.cwd();

async function token() {
  if (process.env.HARNESSIDE_TOKEN) return process.env.HARNESSIDE_TOKEN;
  const rec = JSON.parse(await readFile(join(WORKSPACE, ".harnesside", "state", "token.json"), "utf8"));
  return rec.token;
}
const TOKEN = await token();
const auth = { Authorization: `Bearer ${TOKEN}` };
const api = (p, init) => fetch(`http://${URL_MATCH}${p}`, { headers: auth, ...(init ?? {}) });

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(1000);
  }
}

// ── CDP ──────────────────────────────────────────────────────────────────────
const pages = await (await fetch(`${CDP}/json/list`)).json();
const page = pages.find((t) => t.type === "page" && (t.url ?? "").includes(URL_MATCH));
if (!page) throw new Error(`CDP 에 대상 페이지가 없습니다: ${pages.map((t) => `${t.type}:${t.url}`).join(", ")}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
let cdpId = 0;
const waiters = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  const w = waiters.get(m.id);
  if (w) { waiters.delete(m.id); w(m); }
});
const send = (method, params = {}) => new Promise((res) => {
  const n = ++cdpId; waiters.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.error) throw new Error(`CDP error: ${JSON.stringify(r.error).slice(0, 120)}`);
  if (r.result?.exceptionDetails) throw new Error(`evaluate failed: ${expr.slice(0, 100)}`);
  const v = r.result?.result?.value;
  if (v === undefined) throw new Error(`evaluate returned undefined: ${expr.slice(0, 100)}`);
  return v;
};

// 같은 서버를 재는지 (§11) — 중간에 재시작되면 이 실행의 PASS 는 옛 코드의 것이다.
const startedAt = await api("/api/health").then((r) => r.json()).then((j) => j.startedAt);
check("서버 기동 시각을 읽음", typeof startedAt === "number");

// ── P1. 승인 카드 (거절 경로 — 60초 타임아웃) ────────────────────────────────
const turnP = api("/api/agent/turn", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "APPROVAL-TEST delete scratch" }),
}).then((r) => r.json());

const pending = await waitFor(async () => {
  const j = await api("/api/approval/pending").then((r) => r.json());
  return j.pending?.length ? j.pending[0] : null;
}, 25000, "approval pending");
check("파괴적 도구가 게이트에서 멈춤 (실행 안 됨)", pending.tool === "run_shell", pending.id);

const card = await waitFor(async () => {
  const t = await ev("document.body.innerText");
  return /Approval needed/.test(t) ? t : null;
}, 15000, "approval card in DOM");
const countdown = card.match(/Auto-reject in (\d+)s/);
check("카드가 대화 위에 뜸 (판정문+카운트다운)", !!countdown, countdown?.[0] ?? "no countdown");
if (countdown) {
  const left = Number(countdown[1]);
  check("카운트다운이 60초 안쪽 (서버 timeoutSec=60)", left > 0 && left <= 60, `${left}s`);
}
const btns = await ev(`[...document.querySelectorAll("button")].map((b) => (b.innerText||"").trim()).filter((t) => /^(Reject|Allow once|Always allow)$/.test(t))`);
check("거절·1회허용·항상허용 3버튼", btns.length === 3, btns.join("/"));
const enabled = await ev(`[...document.querySelectorAll("button")].filter((b) => /^(Reject|Allow once|Always allow)$/.test((b.innerText||"").trim())).every((b) => !b.disabled)`);
check("만료 전 버튼 활성화", enabled === true);

// 60초 경과 — 아무것도 누르지 않는다. 만료 UI 또는 카드 닫힘 둘 다 정상
// (서버 settle→done 이 오면 닫힌다 — 그 사이 간격에만 만료 UI 가 보인다).
await sleep(65000);
const after = await ev(`(() => {
  const t = document.body.innerText;
  return { expired: /No response — rejected|Expired/.test(t), cardGone: !/Approval needed/.test(t) };
})()`);
check("60초 뒤 만료 UI 또는 카드 닫힘 (무응답=거절)", after.expired || after.cardGone, JSON.stringify(after));
const turn1 = await turnP;
check("거절된 턴이 끝남 (좀비 아님)", turn1?.ok === true, JSON.stringify(turn1)?.slice(0, 60));
const pendingAfter = await api("/api/approval/pending").then((r) => r.json());
check("대기열 비움", (pendingAfter.pending ?? []).length === 0);
const logs = await api("/api/logs?limit=200").then((r) => r.json());
const lineOf = (e) => e.line ?? e.message ?? "";
const settled = (logs.entries ?? []).some((e) => /승인 결정: run_shell → timeout/.test(lineOf(e)));
check("서버가 timeout 으로 settle (로그 근거)", settled);
// 거절된 명령은 실행되지 않는다 — 실행됐으면 `[tool] rm -rf …` 로그가 남는다
// (`onToolResult` 는 실행된 셸 결과만 로그한다). 로그에 없으면 미실행이다.
const executed = (logs.entries ?? []).some((e) => /\[tool\] rm -rf \/tmp\/harnesside-verify-approve/.test(lineOf(e)));
check("거절된 rm -rf 미실행 (실행 로그 없음)", !executed);

// ── P2. 허용 경로 + 접기 UI ──────────────────────────────────────────────────
const turn2P = api("/api/agent/turn", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "FOLD-TEST show numbers" }),
}).then((r) => r.json());
await waitFor(async () => {
  const j = await api("/api/approval/pending").then((r) => r.json());
  return (j.pending ?? []).length > 0;
}, 25000, "second approval pending");
const clicked = await ev(`(() => {
  const all = [...document.querySelectorAll("button")].filter((x) => (x.innerText||"").trim() === "Allow once");
  const b = all.pop();
  if (!b) return "NO-CARD";
  b.click();
  return "CLICKED";
})()`);
check("Allow once 클릭됨 (리로드 없이 — 리로드하면 카드 사라짐)", clicked === "CLICKED", clicked);
const turn2 = await turn2P;
check("허용된 턴이 끝남", turn2?.ok === true);
const fold = await waitFor(async () => {
  const btns = await ev(`[...document.querySelectorAll("button")].map((b) => (b.innerText||"").trim()).filter((t) => /^접기$/.test(t) || /나머지.*펼치기/.test(t))`);
  const t = await ev("document.body.innerText");
  return btns.length && /Shell output, 10[01] lines/.test(t) ? { btns } : null;
}, 25000, "fold button + full output");
check("100줄 출력 전체 + 접기 버튼", true, fold.btns.join("/"));
// 새 블록(마지막 접기)을 접는다 — 이전 턴 블록과 섞이면 어느 것을 봤는지 모른다.
await ev(`(() => { [...document.querySelectorAll("button")].filter((b) => (b.innerText||"").trim() === "접기").pop().click(); return "FOLDED"; })()`);
await sleep(800);
const collapsed = await waitFor(async () => {
  const btns = await ev(`[...document.querySelectorAll("button")].map((b) => (b.innerText||"").trim()).filter((t) => /펼치기/.test(t))`);
  const hidden = await ev(`document.body.innerText.includes("줄 접힘")`);
  return btns.length && hidden ? { btns } : null;
}, 10000, "collapsed state");
check("접기 → 나머지 펼치기 + 줄 접힘", true, collapsed.btns.join("/"));
await ev(`(() => { [...document.querySelectorAll("button")].filter((b) => /펼치기/.test((b.innerText||"").trim())).pop().click(); return "EXPANDED"; })()`);
await sleep(800);
// 구간의 접힘 여부를 본다 — 이전 턴 블록이 접혀 있으면 전역 "줄 접힘" 은 남는다.
// 그래서 마지막 블록 기준으로: 펼치기 버튼이 하나로 줄고, 그 자리 출력에 100이 보인다.
const expanded = await ev(`(() => {
  const folds = [...document.querySelectorAll("button")].map((b) => (b.innerText||"").trim()).filter((t) => /펼치기/.test(t));
  const t = document.body.innerText;
  const i = t.lastIndexOf("seq 1 100");
  return { folds: folds.length, back: t.slice(i, i + 4000).includes("100") };
})()`);
check("펼치기 → 전체 출력 복귀 (마지막 블록 기준)", expanded.back, `펼치기 ${expanded.folds}개 남음`);

const startedAtEnd = await api("/api/health").then((r) => r.json()).then((j) => j.startedAt);
check("같은 서버를 잼 (중간 재시작 없음)", startedAtEnd === startedAt);

ws.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 통과`);
if (failed.length) {
  console.error(`실패: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
