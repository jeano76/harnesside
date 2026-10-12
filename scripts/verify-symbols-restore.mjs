#!/usr/bin/env node
/**
 * 기호 점프 + 세션 복원 **라이브 실측** (§7.1 2단계 · §5.10).
 *
 * 왜 별도 스크립트인가: 순차 2번에서 같은 실패를 반복할 뻔했다 —
 * 도구 파일 블록 미리보기가 `autoOpen` 없이 헤더만 남아, 토큰 클릭 UI 가
 * 코드에만 있고 화면에 진입로가 없었다 (`31a77c4` 로 수정).
 * 유닛·실코드베이스 실측은 "코드가 쓰인 대로 도는가" 만 본다.
 * 이 스크립트는 진짜 서버·진짜 창으로 DOM 까지 본다.
 *
 * 검증하는 것 / 하지 않는 것:
 *   - 함: 파일 미리보기 자동 로드 · 토큰 클릭→정의 패널(교차파일) ·
 *     참조 찾기 · 새로고침 복원 블록의 인자·완료 모양.
 *   - 안 함: 모델 품질 (가짜 llama-server 가 도구 호출만 흉내낸다).
 *
 * 전제:
 *   1. 가짜 모델:
 *      FAKE_TOOL_CALLS='[{"match":"SYM-TEST","name":"read_file","arguments":{"path":"src/fs/search.ts"}},{"match":"RESTORE-TEST","name":"run_shell","arguments":{"command":"seq 1 5"}}]'
 *      node scripts/fake-llama-server.mjs --port 8080 --model-path <실재 파일>
 *   2. 진짜 서버가 가짜를 채택 (`harnesside up --here --no-browser`, 7317).
 *   3. 헤드리스 크롬이 CDP 9222 로 창을 열어둔 상태 (토큰 URL).
 *
 *   HARNESSIDE_URL (기본 127.0.0.1:7317) · HARNESSIDE_CDP (기본 9222) ·
 *   HARNESSIDE_TOKEN (없으면 <workspace>/.harnesside/state/token.json).
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
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* CDP 평가는 재시도한다 */
    }
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
  if (r.result?.exceptionDetails) throw new Error(`evaluate failed: ${expr.slice(0, 120)}`);
  const v = r.result?.result?.value;
  if (v === undefined) throw new Error(`evaluate returned undefined: ${expr.slice(0, 120)}`);
  return v;
};

const startedAt = await api("/api/health").then((r) => r.json()).then((j) => j.startedAt);
check("서버 기동 시각을 읽음", typeof startedAt === "number");

// 새 빌드를 받는 새로고침 — 이전에 뜬 페이지는 옛 번들일 수 있다.
// (복원이 되면 SYM 턴 블록도 함께 돌아오므로 아래 waitFor 가 곧장 통과할 수 있다.)
await send("Page.reload", { ignoreCache: true });
await sleep(4000);

// ── P1. 파일 미리보기 자동 로드 + 토큰 클릭→정의 ─────────────────────────────
const turnP = api("/api/agent/turn", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "SYM-TEST show search file" }),
}).then((r) => r.json());

// 미리보기 내용이 DOM 에 뜨면 자동 로드된 것이다 (헤더만이 아니다).
const preview = await waitFor(async () => {
  const t = await ev("document.body.innerText");
  return /315줄|줄.*기호| rankFiles/.test(t) ? t : null;
}, 60000, "file preview content in DOM");
check("도구 파일 블록 미리보기 자동 로드", true, "내용+기호 아웃라인 DOM 확인");

const turn1 = await turnP;
check("SYM 턴이 끝남", turn1?.ok === true, JSON.stringify(turn1)?.slice(0, 60));

// rankFiles 토큰 버튼을 눌러 정의로 간다 (315줄 근처 `export { rankFiles }`).
const clicked = await ev(`(() => {
  const all = [...document.querySelectorAll("button")].filter((b) => (b.innerText||"").trim() === "rankFiles" && (b.title||"").startsWith("정의로 이동"));
  const b = all.pop();
  if (!b) return "NO-TOKEN:" + [...document.querySelectorAll("button")].filter((x) => (x.innerText||"").trim() === "rankFiles").length;
  b.click();
  return "CLICKED";
})()`);
check("rankFiles 토큰 클릭됨", clicked === "CLICKED", clicked);

const defPanel = await waitFor(async () => {
  const t = await ev("document.body.innerText");
  return /searchRank\.ts:23/.test(t) ? t : null;
}, 30000, "definition panel with searchRank.ts:23");
check("정의 패널에 교차파일 위치 (searchRank.ts:23)", true);

// ── P2. 참조 찾기 ────────────────────────────────────────────────────────────
const refClicked = await ev(`(() => {
  const all = [...document.querySelectorAll("button")].filter((b) => (b.innerText||"").trim() === "참조 찾기");
  const b = all.pop();
  if (!b) return "NO-REFBTN";
  b.click();
  return "CLICKED";
})()`);
check("참조 찾기 클릭됨", refClicked === "CLICKED", refClicked);
const refPanel = await waitFor(async () => {
  const t = await ev("document.body.innerText");
  return /참조 \d+건/.test(t) ? t : null;
}, 30000, "references panel");
const refCount = (refPanel.match(/참조 (\d+)건/) ?? [])[1] ?? "?";
check("참조 목록 표시", Number(refCount) >= 1, `참조 ${refCount}건`);

// ── P3. 실행 블록 + 새로고침 복원 ────────────────────────────────────────────
const turn2P = api("/api/agent/turn", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "RESTORE-TEST run numbers" }),
}).then((r) => r.json());
await waitFor(async () => {
  const j = await api("/api/approval/pending").then((r) => r.json());
  return (j.pending ?? []).length > 0;
}, 25000, "restore approval pending");
await ev(`(() => { [...document.querySelectorAll("button")].filter((b) => (b.innerText||"").trim() === "Allow once").pop()?.click(); return "OK"; })()`);
const turn2 = await turn2P;
check("RESTORE 턴이 끝남 (Allow once)", turn2?.ok === true);
await waitFor(async () => {
  const t = await ev("document.body.innerText");
  return /seq 1 5/.test(t) ? t : null;
}, 25000, "shell command visible before reload");

// 저장될 시간을 준다 (디바운스 1초 + 여유).
await sleep(3000);
await send("Page.reload", { ignoreCache: true });
await waitFor(async () => {
  const t = await ev("document.body.innerText");
  return /seq 1 5/.test(t) ? t : null;
}, 45000, "restored blocks after reload");
const restoredShape = await ev(`(() => {
  const t = document.body.innerText;
  // 복원 전(결함 상태)이면 명령·파일 경로 없이 이름만 남는다.
  return { hasCmd: t.includes("seq 1 5"), hasFile: t.includes("search.ts") };
})()`);
check("복원 블록에 명령 유지 (인자 상실 아님)", restoredShape.hasCmd === true);
check("복원 블록에 파일 경로 유지", restoredShape.hasFile === true);

const startedAtEnd = await api("/api/health").then((r) => r.json()).then((j) => j.startedAt);
check("같은 서버를 잼 (중간 재시작 없음)", startedAtEnd === startedAt);

ws.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 통과`);
if (failed.length) {
  console.error(`실패: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
