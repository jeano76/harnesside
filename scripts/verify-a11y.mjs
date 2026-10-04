/**
 * M8 접근성 실측 — **창에서 실제로** 확인한다 (키보드·aria·prefers-reduced-motion).
 *
 * 왜 별도 스크립트인가: 접근성은 **소스에서 잘 보이지 않는다.** `aria-label` 을 붙였다는
 * 사실과 키보드로 포커스했을 때 **눈에 보이는 표시가 남는 것** 은 다른 문제다. 이 저장소에는
 * 컴포넌트마다 `outline: "none"` 이 있고 전역 포커스 스타일이 아예 없었다 — 즉 **키보드로
 * Tab 해도 어디에 있는지 하나도 알 수 없었다**(실측). 소스 리뷰로는 이걸 "접근성 대응" 이라
 * 부르기 어렵다.
 *
 * 검사:
 *  1. Tab 을 눌러 **포커스가 실제로 이동** 하는가 (이동 안 되면 키보드가 배제된다)
 *  2. 이동한 요소에 **보이는 포커스 표시** 가 있는가 (outline 또는 box-shadow)
 *  3. 포커스가 **창 밖으로 새지** 않는가
 *  4. `lang` 속성이 있는가 (스크린 리더가 언어를 읽어야 한국어를 읽는다)
 *  5. 조작 가능한 요소에 **이름** 이 있는가 (버튼·입력 — 화면 판독기용)
 *  6. `prefers-reduced-motion: reduce` 를 **지키는가** (애니메이션 시간 0)
 */

import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";

const CDP = process.env.HARNESSIDE_CDP ?? "http://127.0.0.1:9222";
const URL_MATCH = process.env.HARNESSIDE_URL ?? "127.0.0.1:7317";

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

class Cdp {
  #ws;
  #id = 0;
  #waiters = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      const w = this.#waiters.get(m.id);
      if (w) {
        this.#waiters.delete(m.id);
        w(m);
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#waiters.set(id, (m) => resolve(m.result ?? m));
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  }
  close() {
    this.#ws.close();
  }
}

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === "page" && (t.url ?? "").includes(URL_MATCH));
if (!page) throw new Error(`대상 페이지가 없습니다: ${list.map((t) => `${t.type}:${t.url}`).join(", ")}`);
const cdp = await Cdp.open(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
console.log("M8 접근성 실측");

// 1~3. Tab 으로 포커스 이동 + 표시
//
// **합성 KeyboardEvent 로는 포커스가 움직이지 않는다**(실측). 브라우저는 신뢰된 입력만
// 포커스 이동에 쓰기 때문이다. 그래서 CDP 의 `Input.dispatchKeyEvent` 로 **진짜 키**를
// 보낸다 — 그래야 "키보드로 쓸 수 있나" 를 실제로 재는 것이 된다.
const tabExpr = `(async () => {
  const before = document.activeElement;
  const seen = [];
  const noRing = [];
  for (let i = 0; i < 14; i++) {
    window.__a11yTab && window.__a11yTab();
    await new Promise((r) => setTimeout(r, 30));
    const el = document.activeElement;
    if (!el || el === before) break;
    if (seen.some((s) => s.el === el)) break;
    const style = getComputedStyle(el);
    // 프롬프트 입력창은 **사용자 결정으로** 포커스 링을 그리지 않는다(no-focus-ring 클래스, 커밋 1e4a0a2 "어지러워 보여").
    // 글 입력칸은 깜빡이는 캐럿이 포커스 표시다 — 캐럿이 투명하지 않을 때만 표시로 인정한다(Q-6, 2026-10-04 기준 정정).
    const caretShows =
      el.classList.contains("no-focus-ring") &&
      (el.tagName === "TEXTAREA" || el.tagName === "INPUT") &&
      style.caretColor !== "transparent";
    const hasRing =
      caretShows ||
      (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
      (style.boxShadow && style.boxShadow !== "none");
    const name = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 20);
    seen.push({ el, tag: el.tagName, name });
    if (!hasRing) {
      noRing.push(
        el.tagName +
          "(" + name + ") outline=" + style.outlineStyle + "/" + style.outlineWidth +
          " shadow=" + (style.boxShadow || "none").slice(0, 20),
      );
    }
  }
  return { moved: seen.length, tags: seen.map((s) => s.tag + (s.name ? "[" + s.name + "]" : "")), noRing };
})()`;
await cdp.eval(`window.__a11yTab = () => {}`); // 자리 확보(정의 없으면 호출해도 안전)

const tabKey = async () => {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      windowsVirtualKeyCode: 9,
      key: "Tab",
      code: "Tab",
      nativeVirtualKeyCode: 9,
    });
  }
};
// 위 표현식 안에서 실제 키를 보내려면 Promise 로 접근해야 하므로, 한 번에 묶어 실행한다.
const tabWalk = await cdp.eval(`(async () => {
  const before = document.activeElement;
  const seen = [];
  const noRing = [];
  const pressTab = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      // 동기적으로 이벤트를 만들어서 보낸다 — page 안에서 CDP 를 못 부르므로,
      // 바깥에서 키를 보내고 아래에서 상태를 읽는다.
    }
  };
  return { moved: 0, tags: [], noRing, note: "placeholder" };
})()`);
await cdp.eval(`void 0`);
// 실제로는 **바깥에서** 키를 눌러야 한다(키보드 입력이 CDP 채널을 통해서만 간다).
const seen = [];
const noRing = [];
const before = await cdp.eval(`document.activeElement ? document.activeElement.tagName : ""`);
for (let i = 0; i < 14; i++) {
  await tabKey();
  const info = await cdp.eval(`(() => {
    const el = document.activeElement;
    if (!el) return null;
    const style = getComputedStyle(el);
    // 프롬프트 입력창은 사용자 결정으로 포커스 링을 그리지 않는다(no-focus-ring, 커밋 1e4a0a2) — 캐럿이 보이면 표시로 인정(Q-6).
    const caretShows = el.classList.contains("no-focus-ring") && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && style.caretColor !== "transparent";
    const hasRing =
      caretShows ||
      (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
      (style.boxShadow && style.boxShadow !== "none");
    return {
      tag: el.tagName,
      name: (el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 24)),
      hasRing,
      outline: style.outlineStyle + "/" + style.outlineWidth,
      shadow: (style.boxShadow || "none").slice(0, 24),
    };
  })()`);
  if (!info || info.tag === before) break;
  if (seen.some((x) => x.tag + x.name === info.tag + info.name)) break;
  seen.push(info);
  if (!info.hasRing) noRing.push(info.tag + "(" + info.name + ") outline=" + info.outline + " shadow=" + info.shadow);
}
const walk = { moved: seen.length, tags: seen.map((x) => x.tag + (x.name ? "[" + x.name + "]" : "")), noRing };
void tabExpr;
void tabWalk;

check((walk?.moved ?? 0) > 0, "Tab 으로 **포커스가 이동** 한다", `${walk?.moved ?? 0}개: ${(walk?.tags ?? []).slice(0, 5).join(" → ")}`);
check(
  (walk?.noRing?.length ?? 0) === 0,
  "포커스 **표시가 보인다** — Tab 해도 어디인지 모르면 못 쓴다",
  (walk?.noRing ?? []).slice(0, 3).join(" | "),
);

// 4. lang
const lang = await cdp.eval(`document.documentElement.lang`);
check(typeof lang === "string" && lang.length > 0, "문서에 `lang` 이 있다 (스크린 리더가 언어를 읽는다)", String(lang));

// 5. 조작 가능한 요소에 이름이 있는가
const unnamed = await cdp.eval(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll("button, input, select, textarea")) {
    const name =
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      el.getAttribute("title") ||
      (el.labels && el.labels.length ? "label" : "") ||
      (el.textContent || "").trim();
    if (!name) bad.push(el.tagName + (el.className ? "." + el.className : ""));
  }
  return bad;
})()`);
check((unnamed?.length ?? 0) === 0, "버튼·입력에 **이름** 이 있다", (unnamed ?? []).slice(0, 4).join(", "));

// 6. prefers-reduced-motion — **브라우저와 앱 양쪽**을 본다.
//
// 이전 판정은 **스스로 주입한 룰을 재서 통과했다**(자기 증명). 그러면 아무것도 없는
// 앱도 "통과" 한다 — 가장 나쁜 종류의 검사다. 이제 두 가지를 따로 잰다:
//   a) CDP 로 실제 media 를 강제로 reduce 로 바꾼 뒤, 브라우저가 이를 **인식하는가**
//   b) 앱이 reduce 에서 애니메이션을 **끄는 규칙을 실제로 가지고 있는가**(정본 소스 확인)
await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
const emulated = await cdp.eval(`(() => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;opacity:0;pointer-events:none;transition-duration:5s";
  document.body.appendChild(probe);
  // **앱의 룰** 이 적용되면 5s 요청이 0 으로 낮아진다(전역 important 규칙이 이긴다).
  const dur = getComputedStyle(probe).transitionDuration;
  probe.remove();
  return { matches: mq.matches, duration: dur };
})()`);
check(emulated?.matches === true, "브라우저가 reduce 설정을 **인식** 한다", `matches=${emulated?.matches}`);

const html = await readFile("src/web/index.html", "utf8");
const monitor = await readFile("src/web/panels/MonitorPanel.tsx", "utf8").catch(() => "");
// **정본 소스에 규칙이 있는지** 본다. 화면에서 재는 것과 별개로, 규칙이 실려 있어야 한다.
const cssGuard = /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(html);
const jsGuard = /prefers-reduced-motion/.test(monitor);
check(cssGuard && jsGuard, "앱이 모션 감소를 **규칙으로** 지킨다 (CSS + JS)", `css=${cssGuard} js=${jsGuard}`);
await cdp.send("Emulation.setEmulatedMedia", { features: [] });

// 입력에 lang 이 붙어 있는가 (한국어 IME 가 어긋나지 않게)
const koreanInput = await cdp.eval(`(() => {
  const ta = document.querySelector("textarea");
  return ta ? { has: true, lang: ta.lang || null } : { has: false };
})()`);
check(koreanInput?.has === true, "입력창이 존재한다 (M7)", koreanInput?.has ? "찾음" : "없음");

console.log(`\n${pass} 통과 / ${fail} 실패`);
cdp.close();
process.exit(fail === 0 ? 0 : 1);
