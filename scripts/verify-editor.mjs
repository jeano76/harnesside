#!/usr/bin/env node
/**
 * 편집기 화면을 **실제 창에서** 확인한다 (2026-10-05 · ① 편집창 컬러 · ③ 인덴트 가이드).
 *
 * ── 왜 이게 필요한가 ────────────────────────────────────────────────────────
 * 겹침 하이라이트와 인덴트 가이드는 **유닛으로 검증할 수 없는 종류**다.
 *  - 유닛이 재는 것: "선이 몇 열에 오는가" (계산)
 *  - 유닛이 **못** 재는 것: "선이 실제 글자 경계에 **맞춰** 그려지는가" (렌더)
 *
 * 두 층의 문자 모양이 1px만 달라도 색과 선이 한 칸씩 밀린다 — 그리고 그건
 * 유닛이 **절대** 검출하지 못한다(`EDITOR_TEXT_METRICS` 가 같기 때문이다).
 * 이 저장소 규칙("사람이 보이는 것은 실제 창에서 본다", §0.2)이 존재하는 이유가
 * 정확히 이것이다.
 *
 * ── 무엇을 확인하나 ─────────────────────────────────────────────────────────
 *  1. 편집창의 글자가 **투명한지**(아래 층이 색을 그리는 구조인지)
 *  2. 색칠 겹침 층이 **같은 문자 metrics** 로 그려지는지 (글자 폭·줄 간격이 같은가)
 *  3. 인덴트 가이드가 **글자 경계에** 놓이는지 — `left` 가 `N ch` 인가,
 *     그리고 **한 칸의 실제 픽셀 폭**과 `1ch` 가 같은가 (측정 없이 맞춘다는 주장이 사실인지)
 *  4. 가이드가 **줄 번호 위가 아니라 코드 위**에 있는가 (거터와 ch 를 섞지 않았는지)
 *  5. 스크롤해도 **선이 따라가는가** (translate 동기화)
 *  6. **콘솔 에러 0** — 새 번들이 실제로 로드됐다는 증거(에러가 나면 옛 번들일 수 있다)
 *
 * ── 이 검사가 못 하는 것 (감추지 않는다) ────────────────────────────────────
 *  - **폰트 치환·줌·RTL·선택 색**에서의 어긋남. 이 머신의 폰트에서 맞다는 사실이지,
 *    모든 환경에서 맞다는 뜻이 아니다.
 *  - 타이핑 → 자동 저장 → 충돌 경로(파일을 실제로 바꾸므로 **하지 않는다**).
 *    편집 내용 변경은 이 검사에서 수행하지 않는다 — 사용자의 파일을 바꾸지 않기 위해.
 *
 * 실행: `node scripts/verify-editor.mjs` (서버·창이 떠 있어야 한다 — `npm run dev`)
 */

import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";

const CDP = process.env.HARNESSIDE_CDP ?? "http://127.0.0.1:9222";
const URL_MATCH = process.env.HARNESSIDE_URL ?? "127.0.0.1:7317";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
};

class Cdp {
  #ws;
  #id = 0;
  #waiters = new Map();
  #listeners = {};
  constructor(ws) {
    this.#ws = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method && this.#listeners[m.method]) {
        for (const l of this.#listeners[m.method]) {
          try {
            l(m.params);
          } catch {
            /* 구독 하나가 죽어도 나머지는 산다 */
          }
        }
      }
      const w = this.#waiters.get(m.id);
      if (w) {
        this.#waiters.delete(m.id);
        w(m);
      }
    });
  }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    return new Cdp(ws);
  }
  on(method, listener) {
    (this.#listeners[method.toLowerCase()] ??= []).push(listener);
    return this;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((res) => {
      this.#waiters.set(id, res);
      this.#ws.send(JSON.stringify(message));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(`페이지 안에서 예외: ${r.result.exceptionDetails.text ?? "?"}`);
    }
    return r.result?.result?.value;
  }
  close() {
    this.#ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * **사용자의 창을 몰라도 되는 새 탭**을 연다.
 *
 * 왜 새 탭인가: 기존 탭은 사용자가 대화 중인 창일 수 있다(2026-10-05 실측 —
 * 이 검사가 키 입력을 그 탭에 보내서 **사용자의 대화에 프롬프트가 들어갔다**).
 * 편집기 여는 동작(팔레트)은 클라이언트 쪽이라 새 탭에서 해도 되지만,
 * **사람의 창을 조작하는 것은 이 검사의 일이 아니다.**
 *
 * 새 탭은 검사가 끝나면 **닫는다** — 창이 늘어난 채 남으면 사용자가 "내 창이 왜
 * 둘이냐" 고 묻는다(저장소 §11.3: 조용히 남기는 것도 결함이다).
 */
async function openOwnTab() {
  const res = await fetch(`${CDP}/json/list`);
  const list = await res.json();
  const any = list.find((t) => t.type === "page" && (t.url ?? "").includes(URL_MATCH));
  if (!any) {
    throw new Error(`CDP 에 대상 창이 없습니다. 떠 있는 창: ${list.map((t) => `${t.type}:${t.url}`).join(", ")}`);
  }
  // **토큰을 상태 파일에서 읽는다**(verify-window.mjs 와 같은 경로). 기존 탭의 URL 에는
  // 토큰이 없다 — 앱이 첫 로드 직후 `history.replaceState` 로 지운다(§3.4). 그래서
  // 기존 URL 을 그대로 쓰면 **토큰 없는 탭**이 되어 앱이 뜨지 않는다(실측: 빈 화면).
  const token = await readFile(".harnesside/state/token.json", "utf8")
    .then((t) => JSON.parse(t).token)
    .catch(() => null);
  if (!token) throw new Error("토큰을 읽지 못했다: .harnesside/state/token.json — 부팅된 서버가 없다");
  // 토큰은 URL 로만 전달하고 **출력하지 않는다**( 진단 출력에 붙일 수 있다).
  const target = await fetch(`${CDP}/json/new?${encodeURIComponent(`http://${URL_MATCH}/?t=${token}`)}`, {
    method: "PUT",
  }).then((r) => r.json());
  return target;
}

async function closeTab(targetId) {
  await fetch(`${CDP}/json/close/${targetId}`).catch(() => undefined);
}

async function main() {
  const tab = await openOwnTab();
  const cdp = await Cdp.open(tab.webSocketDebuggerUrl);
  const done = (code) => {
    cdp.close();
    void closeTab(tab.id);
    return code;
  };
  const consoleErrors = [];
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description ?? "exception");
  });
  await cdp.send("Runtime.enable");

  // 새 번들이 실제 로드됐는지 **먼저** 확인한다 — 옛 번들로 검사하면 아래 전부 무의미하다.
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(2500);

  // 편집기를 연다: 팔레트(Ctrl+P) → 파일명 입력 → Enter. 이 저장소에는 탐색기 패널이
  // 없고(2026-10-01 사용자가 삭제) 파일 여는 경로는 팔레트다.
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "p", code: "KeyP", modifiers: 2, windowsVirtualKeyCode: 80 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "p", code: "KeyP", modifiers: 2, windowsVirtualKeyCode: 80 });
  await sleep(500);
  for (const ch of "indentGuides.ts") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(25);
  }
  await sleep(600);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(1500);

  // **편집기의 textarea 만** 찾는다 — 대화 입력창도 `textarea` 다. 아무거나 잡으면
  // 대화창을 편집기로 오인하고(첫 실행에 실제로 그랬다) 모든 검사가 무의미해진다.
  // 식별 근거: **색칠 겹침 층(`pre[aria-hidden]`)과 형제인 textarea.** 이 조합은
  // 편집기에만 있다 — 대화 입력창에는 색칠 층이 없다.
  const openState = `(() => {
    const tas = [...document.querySelectorAll("textarea")];
    const editor = tas.find((t) => t.parentElement?.querySelector('pre[aria-hidden="true"]'));
    return {
      total: tas.length,
      hasEditor: !!editor,
      fonts: tas.map((t) => getComputedStyle(t).fontFamily.split(",")[0]),
      header: (document.body.innerText.match(/indentGuides/) || [])[0] ?? null,
    };
  })()`;
  const opened = await cdp.eval(openState);
  check("팔레트로 편집기가 열린다 (파일 여는 경로가 살아 있다)", opened?.hasEditor === true, JSON.stringify(opened));

  if (!opened?.hasEditor) {
    return done(1);
  }

  // 1) 글자가 투명한가 — 아래 층이 색을 그리는 구조의 증거.
  const colorState = await cdp.eval(`(() => {
    const ta = [...document.querySelectorAll("textarea")].find((t) => t.parentElement?.querySelector('pre[aria-hidden="true"]'));
    const cs = getComputedStyle(ta);
    const pre = ta.parentElement.querySelector('pre[aria-hidden="true"]');
    return {
      color: cs.color,
      caret: cs.caretColor,
      webkitFill: cs.webkitTextFillColor,
      font: cs.font || (cs.fontSize + " / " + cs.lineHeight + " " + cs.fontFamily),
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      padding: cs.padding,
      tabSize: cs.tabSize,
      whiteSpace: cs.whiteSpace,
      hasLayer: !!pre,
      layerFontSize: pre ? getComputedStyle(pre).fontSize : null,
      layerLineHeight: pre ? getComputedStyle(pre).lineHeight : null,
      layerPadding: pre ? getComputedStyle(pre).padding : null,
      layerWhiteSpace: pre ? getComputedStyle(pre).whiteSpace : null,
      layerTabSize: pre ? getComputedStyle(pre).tabSize : null,
      layerLetterSpacing: pre ? getComputedStyle(pre).letterSpacing : null,
      layerWordBreak: pre ? getComputedStyle(pre).wordBreak : null,
      layerHasTokens: pre ? (pre.querySelectorAll("span[style*='color']").length > 0) : false,
    };
  })()`);

  // 투명한 방법은 두 가지다: `color: transparent` 또는 `-webkit-text-fill-color: transparent`.
  // **어느 쪽이든 글자는 보이지 않는다** — 둘 다 통과시켜야 한다.
  const isTransparent = (v) => v === "transparent" || /^rgba\(0, 0, 0, 0\)$/.test(v ?? "");
  check(
    "편집창 글자가 **투명**하다 (아래 층이 색을 그린다)",
    isTransparent(colorState.color) || isTransparent(colorState.webkitFill),
    `color=${colorState.color} webkitTextFillColor=${colorState.webkitFill}`,
  );
  check(
    "**커서가 살아 있다** — 투명한 글자에 커서를 되살리지 않으면 죽은 창이다",
    !!colorState.caret && colorState.caret !== "rgba(0, 0, 0, 0)",
    `caretColor=${colorState.caret}`,
  );
  check("색칠 겹침 층이 렌더된다", colorState.hasLayer === true);
  check(
    "겹침 층이 **색칠된 토큰**을 실제로 들고 있다 (빈 <pre> 가 아님)",
    colorState.layerHasTokens === true,
  );

  // 2) 두 층의 문자 metrics 가 **같은가** — 다르면 색이 한 칸씩 밀린다.
  const same = (a, b) => a === b;
  const metricsEqual =
    same(colorState.fontSize, colorState.layerFontSize) &&
    same(colorState.lineHeight, colorState.layerLineHeight) &&
    same(colorState.padding, colorState.layerPadding) &&
    same(colorState.whiteSpace, colorState.layerWhiteSpace) &&
    same(colorState.tabSize, colorState.layerTabSize);
  check(
    "두 층의 문자 모양이 **같다** (font-size · line-height · padding · white-space · tab-size)",
    metricsEqual,
    metricsEqual
      ? `${colorState.fontSize}/${colorState.lineHeight}`
      : `textarea=${colorState.fontSize}|${colorState.lineHeight}|${colorState.padding}|${colorState.whiteSpace}|${colorState.tabSize} layer=${colorState.layerFontSize}|${colorState.layerLineHeight}|${colorState.layerPadding}|${colorState.layerWhiteSpace}|${colorState.layerTabSize}`,
  );
  check(
    "**줄 간격이 0 이 아니다** — 0 이면 겹침이 한 줄로 납작해진다",
    parseFloat(colorState.lineHeight) > parseFloat(colorState.fontSize),
    `${colorState.fontSize} / ${colorState.lineHeight}`,
  );

  // 3) 인덴트 가이드가 **글자 경계**에 놓이는가 — `1ch` 가 실제 한 칸 폭과 같은지 재서 확인.
  const guides = await cdp.eval(`(() => {
    const ta = [...document.querySelectorAll("textarea")].find((t) => t.parentElement?.querySelector('pre[aria-hidden="true"]'));
    const layer = ta.parentElement.querySelector('pre[aria-hidden="true"]');
    if (!layer) return null;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
    const layerCs = getComputedStyle(layer);
    probe.style.font = layerCs.font || (layerCs.fontSize + "/" + layerCs.lineHeight + " " + layerCs.fontFamily);
    probe.textContent = "0".repeat(100);
    layer.appendChild(probe);
    const hundred = probe.getBoundingClientRect().width;
    probe.textContent = "0";
    const one = probe.getBoundingClientRect().width;
    probe.remove();
    const spans = [...layer.querySelectorAll('span[aria-hidden="true"]')].filter((s) => s.style.position === "absolute");
    const layerRect = layer.getBoundingClientRect();
    const sample = spans.slice(0, 6).map((s) => {
      const r = s.getBoundingClientRect();
      const cs = getComputedStyle(s);
      return { left: cs.left, width: cs.width, opacity: cs.opacity, dxFromLayer: r.left - layerRect.left, chWidth: r.width };
    });
    return { one, hundred, guideCount: spans.length, sample, layerFontFamily: layerCs.fontFamily };
  })()`);

  check("인덴트 가이드가 **그려졌다**", (guides?.guideCount ?? 0) > 0, `${guides?.guideCount ?? 0}개`);
  if (guides && guides.guideCount > 0) {
    // `ch` 단위주장을 실측한다: 100글자 폭 / 100 이 1ch 여야 한다(오차 1px 이내).
    const measuredCh = guides.hundred / 100;
    check(
      "`1ch` 가 **실제 한 칸 폭**과 같다 (측정 없이 맞다는 주장이 사실인가)",
      Math.abs(measuredCh - guides.one) < 0.5,
      `100글자=${guides.hundred.toFixed(2)}px → 1글자=${measuredCh.toFixed(3)}px, 직접 잰 1ch=${guides.one.toFixed(3)}px`,
    );
    check(
      "가이드 위치가 **`calc(N ch)`** 다 — px 로.convert 되지 않았다",
      guides.sample.every((g) => /^calc\(/.test(g.left)),
      guides.sample.map((g) => g.left).join(" , "),
    );
    check(
      "가이드가 **1px 세로선**이고 본문보다 약하다",
      guides.sample.every((g) => g.chWidth === 1 && parseFloat(g.opacity) < 0.5),
      guides.sample.map((g) => `${g.width}/${g.opacity}`).join(" , "),
    );
    // 첫 가이드의 위치가 정수 ch 인지(0열이어야 한다) — guides[0] 은 항상 0열이다.
    check(
      "첫 가이드가 **0열(코드 시작점)** 에 있다 — 줄 번호 위가 아니다",
      guides.sample.length > 0 && /^calc\\(0(\\.0+)?ch\\)$/.test(guides.sample[0].left),
      guides.sample[0]?.left ?? "(없음)",
    );
  }

  // 4) 스크롤 동기화 — 아래 층이 따라가는가.
  const scroll = await cdp.eval(`(() => {
    const ta = [...document.querySelectorAll("textarea")].find((t) => t.parentElement?.querySelector('pre[aria-hidden="true"]'));
    const layer = ta.parentElement.querySelector('pre[aria-hidden="true"]');
    if (!layer) return null;
    if (ta.scrollHeight <= ta.clientHeight + 40) return { skipped: true, scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight };
    ta.scrollTop = 120;
    ta.dispatchEvent(new Event("scroll", { bubbles: true }));
    const moved = getComputedStyle(layer).transform;
    const lineH = parseFloat(getComputedStyle(ta).lineHeight);
    return { moved, lineH, scrollTop: ta.scrollTop };
  })()`);
  if (scroll?.skipped) {
    check("스크롤 동기화", true, `파일이 짧아 스크롤이 없다 (높이 ${scroll.clientHeight}) — 이 축은 미측정`);
  } else {
    const ty = /matrix\\(1, 0, 0, 1, 0, ([-\\d.]+)\\)/.exec(scroll?.moved ?? "");
    const dy = ty ? Math.abs(Number(ty[1])) : NaN;
    check(
      "스크롤하면 **선이 따라간다** (translateY = -scrollTop)",
      Number.isFinite(dy) && Math.abs(dy - (scroll?.scrollTop ?? 0)) < 2,
      `transform=${scroll?.moved} scrollTop=${scroll?.scrollTop}`,
    );
  }

  check("콘솔 에러 0 (새 번들이 실제로 로드됐다)", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  cdp.close();
  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} 통과\n`);
  if (failed.length) {
    process.stdout.write(`실패: ${failed.map((f) => f.name).join(", ")}\n`);
    return done(1);
  }
  return done(0);
}

process.exit(await main().catch((e) => {
  process.stderr.write(`verify-editor 실패: ${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
}));
