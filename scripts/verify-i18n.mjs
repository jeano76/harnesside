/**
 * i18n 배선 실측 (M9) — **창에서 실제로** 확인한다.
 *
 * 왜 별도 스크립트인가: 유닛 테스트는 "사전에 키가 있다" 만 볼 수 있다. 그것으로
 * "화면에 한국어가 나온다" 는 결론이 나오지 않는다 — 2026-09-30 까지 정확히 그 상태였다.
 * 훅·사전·테스트 11개가 전부 통과했는데 **import 하는 곳이 0건**이라 아무것도 실행되지
 * 않았다. 유닛이 통과하는데 기능이 없는 경우는 "키가 있다" 와 "키가 쓰인다" 를
 * 구분하지 못해서 생긴다. 그러니 창을 열어 **텍스트 노드**를 읽는다.
 *
 * 검사:
 *  1. `html[lang]` 이 **ko** 다 — 스크린 리더가 읽을 언어(M8 과 같은 근거)
 *  2. 화면 텍스트에 **사전 값이 실제로 보인다** (패널 제목)
 *  3. **내부 키가 새지 않는다** — `panel.` · `zone.` 같은 키 문자열이 화면에 남으면
 *     "사전이 비었다" 는 뜻이다. 조용히 빈칸이 되면 더 나쁘다.
 *  4. **빈 화면 조각이 없다** — `t()` 는 없는 키를 빈 문자열이 아니라 키로 돌려주는데,
 *     그 보장만 믿지 말고 실제로 빈 요소가 없는지 본다.
 *
 * ── 이 스크립트가 스스로를 증명하지 않는지 확인했다 ──────────────────────────
 * 카탈로그를 **의도적으로 비우고** 다시 빌드해서 돌렸더니 4/3 으로 **실패**했다:
 * `panel.editor` · `zone.left` · `empty.treeFailed` 가 그대로 노출됐다. 그 다음
 * 사전을 복구하고 다시 7/7. 즉 "키가 새면 잡는다" 는 **측정된** 사실이고, 통과만
 * 해놓고 믿을 만한 검사가 아니다.
 *
 * 주의: 창이 **캐시한** 번들을 계속 쓰면 위와 같은 실패가 안 보인다(실제로 그랬다 —
 * 두 번째 실행이 7/7 이었다). 그래서 시작할 때 캐시를 끄고 `ignoreCache` 로 새로고침한다.
 * 이건 §④ 표 12(검증기가 이전 실행을 붙잡음)와 같은 종류다.
 */

import { WebSocket } from "ws";

const CDP = process.env.HARNESSIDE_CDP ?? "http://127.0.0.1:9222";
const HOST = process.env.HARNESSIDE_URL ?? "127.0.0.1:7317";

let pass = 0;
let fail = 0;

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function connect() {
  for (let n = 0; n < 40; n++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes(HOST));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 아직 안 뜬 것 같다 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`CDP(${CDP}) 에 창이 없습니다 — 서버와 창을 먼저 띄우십시오`);
}

/** CDP 요청 1회. 응답을 기다린다. */
function makeCdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.rej(new Error(msg.error.message));
    else slot.res(msg.result);
  });
  const call = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const timer = setTimeout(() => {
        pending.delete(myId);
        rej(new Error(`${method} 타임아웃`));
      }, 10_000);
      pending.set(myId, { res, rej, timer });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  /** 창에서 식을 돌려 JSON 으로 받는다(값 복사). */
  const evaluate = (expression) => call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return { call, evaluate };
}

const ws = new WebSocket(await connect());
await new Promise((r, j) => {
  ws.once("open", r);
  ws.once("error", j);
});
const { call: send, evaluate } = makeCdp(ws);

async function run(expr) {
  const r = await evaluate(expr);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "평가 실패");
  return r.result.value;
}

// ── 캐시를 끄고 새로고침 ──────────────────────────────────────────────────────
// 이걸 안 하면 **지난번 빌드의 번들**을 재고, 고쳐도 실패가 안 보인다(실측).
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Page.reload", { ignoreCache: true });
// 새로고침은 응답이 오기 전에 끝난다(문서 자체가 교체되므로). 창이 다시 그려질 때까지
// **텍스트가 실제로 존재하는지** 로 기다린다 — 시간으로 재지 않는다.
for (let n = 0; n < 40; n++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    if ((await run("document.body?.innerText?.length ?? 0")) > 50) break;
  } catch {
    /* 교체 중 */
  }
}
await new Promise((r) => setTimeout(r, 500));

console.log(`i18n 실측 — ${HOST}\n`);

// ── 1. html[lang] ────────────────────────────────────────────────────────────
const lang = await run("document.documentElement.lang");
ok('html[lang] = "ko" (스크린 리더가 읽을 언어)', lang === "ko", `실제: ${JSON.stringify(lang)}`);

// ── 2. 사전 값이 화면에 보인다 ────────────────────────────────────────────────
const bodyText = await run("document.body.innerText ?? ''");
ok("화면 텍스트가 존재한다", bodyText.length > 0, `길이 ${bodyText.length}`);
for (const needle of ["에디터", "터미널"]) {
  ok(`사전 값 "${needle}" 가 화면에 보인다`, bodyText.includes(needle));
}

// ── 3. 내부 키가 새지 않는다 ─────────────────────────────────────────────────
// M9 의 핵심 실패 모드. 사전이 비면 `t()` 는 키 자체를 돌려주고 화면에 `panel.editor`
// 가 찍힌다. 빈칸보다 눈에 보이므로 나쁘지는 않지만, 조용하면 아무도 모른다.
const leaked = [
  ...new Set(
    [...bodyText.matchAll(/\b(?:panel|zone|empty|action|app|file|git|error|lang)\.[a-z][A-Za-z0-9]*/gi)].map((m) => m[0]),
  ),
];
ok("사전 키가 화면에 노출되지 않는다", leaked.length === 0, `노출됨: ${leaked.join(", ")}`);

// ── 4. 빈 화면 조각이 없다 ────────────────────────────────────────────────────
// `t()` 는 없는 키를 **빈 문자열이 아니라 키** 로 돌려준다. 그 보장은 모듈 테스트가
// 한다. 여기서 보는 것은 그 결과 화면에 **아무것도 빈 요소**로 남지 않는가 다.
const blanks = await run(`(() => {
  const out = [];
  for (const el of document.querySelectorAll("strong, span, div")) {
    const kids = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "");
    if (kids.length && kids.every((s) => s.trim() === "")) out.push(el.className || el.tagName);
    const un = kids.find((s) => /\\{\\{\\s*[\\w.]+\\s*\\}\\}/.test(s));
    if (un !== undefined) out.push("미치환 변수: " + un);
  }
  return out;
})()`);
ok("빈 텍스트 조각이 없다", (blanks?.length ?? 0) === 0, `${(blanks ?? []).slice(0, 3).join(" | ")}`);

// ── 5. 키보드만으로 도킹 라벨에 닿는다 ────────────────────────────────────────
// 존 라벨은 i18n 을 **React 밖**에서 읽는다(레이아웃 엔진). 그 결과가 실제로 나오는가.
ok("존 라벨이 보인다", /왼쪽 도크|오른쪽 도크|중앙/.test(bodyText));

ws.close();
console.log(`\n${fail === 0 ? "모두 통과" : "실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
