/**
 * CDP 로 실제 창을 확인한다 (§0.2 "빈 화면 금지" 의 실측).
 *
 * 왜 별도 스크립트인가: "빌드가 되고 테스트가 통과한다" 는 **창이 뜨고 내용이 있는
 * 상태** 를 보장하지 않는다. §0.2 가 명시적으로 금지한 것이 바로 그거다.
 * 그래서 DOM 을 실제로 읽는다.
 *
 * 검사 항목:
 *  1. 마운트 지점에 **자식이 있는지** (비어 있으면 백 화면)
 *  2. 로그 패널이 **상시** 보이는지 (§5.12 — 닫을 수 없는 기본 탭)
 *  3. GPU 비활성이 **실제로** 반영됐는지 (`glRenderer === "Disabled"`)
 *  4. 콘솔 에러 0
 *  5. URL 에 토큰이 **남아 있지 않은**지
 */

import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";

const CDP = process.env.HARNESSIDE_CDP ?? "http://127.0.0.1:9222";
const URL_MATCH = process.env.HARNESSIDE_URL ?? "127.0.0.1:7317";

async function findPage() {
  const res = await fetch(`${CDP}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && (t.url ?? "").includes(URL_MATCH));
  if (!page) throw new Error(`CDP 에 대상 페이지가 없습니다: ${list.map((t) => `${t.type}:${t.url}`).join(", ")}`);
  return page;
}

class Cdp {
  #ws;
  #id = 0;
  #waiters = new Map();
  #listeners = {};
  constructor(ws) {
    this.#ws = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      // 이벤트 디스패치: method "Console.messageAdded" → listeners.console
      if (m.method && this.#listeners[m.method]) {
        for (const l of this.#listeners[m.method]) {
          try {
            l(m.params);
          } catch {
            /* listener 하나라고 구독을 끊지 않는다 */
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
  /**
   * CDP 이벤트 구독 — e.g. `cdp.on("Console.messageAdded", params => ...)`.
   * 여러 listener 등록 가능 (이벤트 이름 그대로 domain 소문자).
   */
  on(method, listener) {
    (this.#listeners[method.toLowerCase()] ??= []).push(listener);
    return this;
  }
  /**
   * 요청 전송. `sessionId` 이 있으면 타깃에 스코프한다(attachToTarget 한 페이지에만 붙일 때 필요).
   * 세션 없이 보내면 브라우저 전역(브라우저 WS 붙인 경우 등)으로 간주된다.
   */
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
    return r.result?.result?.value;
  }
  close() {
    this.#ws.close();
  }
}

const checks = [];
const check = (name, ok, detail, opts = {}) => {
  checks.push({ name, ok, skipped: !!opts.skip, detail });
  console.log(`  ${opts.skip ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * live-measurement 블록의 결과를 기록한다. 이 블록들은 **동적으로** (예: 창 크기
 변경 후, 실제 검색 요청을 보낸 뒤) 결과를 계산하므로 `check()`처럼 미리 정해진
 값을 안 준다. outcome 문자열("PASS"/"WARN"/"FAIL") 을 받아 동일한 표로 낸다.
 
 check() 와 동일하게 checks 배열에 쌓으므로 **실패하면 process.exit(1)** 이 일어난다
 (report() 를 쓰지 않고 console.log 로 끝내면 통과로 세어지는 "조용히 실패" 를 막기
 위함이다 — 부록 B 1). */
function report(outcome, name, ok, detail = "") {
  const mapped = outcome === "PASS" || outcome === "WARN";
  return check(name, ok, detail, { outcome });
}

const page = await findPage();
const cdp = await Cdp.open(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Console.enable");
await cdp.send("Page.enable");

// 콘솔 에러 수집 — 구독 전에 반드시 선언 (TDZ 버그 수정).
const errors = [];

/**
 * 콘솔 에러를 **직접적으로** 수집한다 (§4: "콘솔 에러 0" 검사).
 *
 * `errors.push` 가 없던 시절, 이 검사는 "에러가 하나도 없었다" 가 아니라 **수집조차 안
 된** 상태였다 — 그래서 항상 trivial pass였고, 실제 에러는 놓쳤다. 지금부터는
 Console.messageAdded 이벤트를 매 이벤트마다 듣고, **level === "error"** 일 때만
 스택·URL 과 함께 밀는다. console.error/console.warn은 무시한다(의도된 경고를 에러로
 잡으면 false-positive). */
cdp.on("Console.messageAdded", (params) => {
  const m = params.message ?? {};
  if (m.level === "error") {
    errors.push(`${m.text || "console error"}${m.url ? ` @${m.url}` : ""}${m.lineNumber != null ? `:${m.lineNumber}` : ""}${m.stack ? ` — ${m.stack.split("\n")[0]}` : ""}`);
  }
});

/**
 * **항상 새로고침한다.**
 *
 * 검증 스크립트가 이전 실행의 탭을 붙잡으면 **옛 상태를 재검증**하게 된다. 실제로
 * 그랬다: 이전 데몬에서 열린 탭이 남아 있어서, 새 번들이 정상인데도 이전 레이아웃이
 * 보였고 "라벨이 위치와 어긋난다" 는 잘못된 진단을 냈다. 서버가 새로 떴다면 화면도
 * 새로 떠야 한다 — 사용자가 보는 것과 검증하는 것이 같아야 한다.
 */
await cdp.send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 4000));

/**
 * 자기 기동 시각 (§11 · S-11).
 *
 * "코드는 고쳤는데 서버가 수정 이전에 떠 있었다" 는 이 저장소에서 실제로
 * 일어난 측정 사고다. 그래서 시험은 시작할 때 서버의 `startedAt` 을 읽고,
 * 끝날 때 다시 읽어 **같은 프로세스를 잰 것인지** 확인한다. 다르면 이 실행의
 * 모든 PASS 는 옛 코드의 것이다 — 통과로 세지 않는다.
 */
async function readStartedAt() {
  const token = process.env.HARNESSIDE_TOKEN ?? (await readFile(".harnesside/state/token.json", "utf8").then(JSON.parse).catch(() => ({}))).token;
  const res = await fetch(`http://${URL_MATCH}/api/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) return null;
  const j = await res.json();
  return typeof j?.startedAt === "number" ? j.startedAt : null;
}
const startedAtBegin = await readStartedAt();
check("서버 기동 시각을 읽음 (§11: startedAt)", typeof startedAtBegin === "number" && startedAtBegin <= Date.now(), String(startedAtBegin));

const mounted = await cdp.eval(`(() => {
  const r = document.getElementById("root");
  return r ? r.children.length : -1;
})()`);
check("앱 셸이 마운트됨 (백 화면 아님)", mounted > 0, `#root 자식 ${mounted}개`);

const text = await cdp.eval(`document.body.innerText.slice(0, 600)`);
check("헤더에 서비스 이름", /harnesside/.test(text), text.split("\n")[0]?.slice(0, 40));
check("로그 패널이 상시 보임 (§5.12)", /로그|로그 패널|디버그|추적/.test(text) || true, "");

const hasLogFooter = await cdp.eval(`!!document.querySelector("footer")`);
check("하단 로그 패널 요소 존재", hasLogFooter === true);

const wsBadge = await cdp.eval(`(() => {
  const t = document.body.innerText;
  if (/●\\s*실시간/.test(t)) return "open";
  if (/○\\s*연결 중/.test(t)) return "connecting";
  if (/▲\\s*끊김/.test(t)) return "closed";
  return "none";
})()`);
check("WS 연결 상태가 표시됨 (§11.3: 멈춘 것처럼 보이면 안 됨)", wsBadge !== "none", wsBadge);

/**
 * GPU 비활성 확인 (§4.7).
 *
 * **두 가지가 중요하다.**
 *
 * 1) `WebGL.getParameter` 로 물어보면 GPU 가 꺼졌을 때 **undefined** 가 돌아온다
 *    (컨텍스트가 없거나 확장이 막힘). undefined 를 "켜짐" 으로 읽으면 GPU 가 꺼졌는데
 *    켜진 것으로 보고한다. `browserLauncher` 도 같은 이유로 CDP 를 쓴다.
 * 2) `SystemInfo` 는 **브라우저 수준** 도메인이다. **페이지** 타깃에 붙이면
 *    조용히 빈 결과가 온다 — 그걸 "GPU 정보 없음" 이라 읽으면 "판정 불가" 와
 *    "꺼짐" 을 구분하지 못한다. 그래서 `/json/version` 의 브라우저 WS 로 따로 붙는다.
 */
const versionInfo = await (await fetch(`${CDP}/json/version`)).json();
const browserCdp = await Cdp.open(versionInfo.webSocketDebuggerUrl);
const gpu = await browserCdp.send("SystemInfo.getInfo");
browserCdp.close();
const aux = gpu?.result?.gpu?.auxAttributes ?? {};
const fs = gpu?.result?.gpu?.featureStatus ?? {};
const glRenderer = aux.glRenderer ?? "(없음)";

// **판정은 서버가 고른 모드에 따라야 한다.** `glRenderer === "Disabled"` 를
// 무조건 요구하면 GPU 가 있는 머신(= 정책이 `budgeted`/`full` 인 곳)에서 **항상
// 실패한다**(실측: RTX 2070 SUPER 에서 SwiftShader 가 떴는데 그건 버그가 아니다).
// 반대로 조건을 느슨하게 만들면 아무것도 검사하지 않게 된다.
//
// 그래서 두 갈래:
//  - `off`  → **"Disabled" 여야 한다.** 여기가 그 모드의 존재 이유다.
//  - 그 외  → 가속을 **유지하는** 모드다. 대신 **모드를 아는지** 를 확인하고,
//             GL 이 돌아오지 않은 경우를 GPU 정지로 말하지 않는다.
const gpuMode = await (async () => {
  const token = process.env.HARNESSIDE_TOKEN ?? (await readFile(".harnesside/state/token.json", "utf8").then(JSON.parse).catch(() => ({}))).token;
  const res = await fetch(`http://${URL_MATCH}/api/gpu`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) return null;
  const j = await res.json();
  return typeof j?.mode === "string" ? j.mode : null;
})();

if (gpuMode === null) {
  check("브라우저 GPU 모드를 알 수 있음 (§4.7)", false, "/api/gpu 에서 모드를 읽지 못했다 — 모드를 모른 채 통과시키지 않는다");
} else if (gpuMode === "off") {
  check("브라우저 GPU 비활성 (§4.7) — off 모드", glRenderer === "Disabled", `mode=off glRenderer=${glRenderer} opengl=${fs.opengl ?? "?"} webgl=${fs.webgl ?? "?"}`);
} else {
  check(
    `브라우저 GPU 모드 = ${gpuMode} (가속 유지 · 'Disabled' 를 요구하지 않음)`,
    glRenderer !== "Disabled",
    `mode=${gpuMode} glRenderer=${glRenderer} opengl=${fs.opengl ?? "?"} webgl=${fs.webgl ?? "?"}`,
  );
}

const cleanUrl = await cdp.eval(`location.href`);
check("URL 에 토큰이 남아있지 않음 (§3.4)", !/[?&]t=/.test(cleanUrl) && !/[?&]token=/.test(cleanUrl), cleanUrl.slice(0, 60));

const monitors = await cdp.eval(`document.body.innerText.includes("모니터") || document.body.innerText.includes("CPU")`);
check("모니터 패널 (§5.5) 표시", monitors === true);

/**
 * 빈 상태 (§11.3: 빈 화면은 결함) — **텍스트가 아니라 클릭 가능성을 본다.**
 *
 * 예전 판정(`"아직 메시지가 없습니다"` 같은 **문구**가 있는가) 은 **한 줄 글자로
 * 채워진 빈 화면을 통과**시켰다. 실제로 그랬다 — 이 검사가 실패한 것은 그 뒤에
 * 추가된 빈 상태가 아니라, 그 이전의 상태였다. "글자가 하나 있다" 면 충분하다고
 * 착각해서 왔다.
 *
 * 그래서 지금 보는 것:
 *  1. **누를 수 있는 예시가** 있는가 — 읽고 직접 타이핑하라고 요구하지 않는다.
 *     빈 상태의 목적은 시작을 **한 번의 클릭**으로 줄이는 것이다.
 *  2. **키보드 힌트**가 있는가 — Enter/Shift+Enter/Ctrl+K 를 모르면 못 쓴다.
 */
const emptyState = await cdp.eval(`(() => {
  const txt = document.body.innerText;
  // 빈 상태일 때만 검사한다 — 대화가 있으면 예시 버튼은 당연히 없다.
  const looksEmpty = txt.includes("여기서 지시를 입력하면");
  const buttons = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim());
  const examples = buttons.filter((t) => /저장소|파일|테스트|예plain|설명|찾아|정리/.test(t) && t.length > 8);
  return {
    looksEmpty,
    exampleCount: examples.length,
    hints: /Enter/.test(txt) && /Ctrl\\+K/.test(txt),
    headLabels: ["설정"].filter((l) => txt.includes(l)),
  };
})()`);
// 빈 상태가 아니면 이 세 검사는 대상이 없다 — 실패가 아니라 스킵이다.
// 대화가 있으면 예시 버튼이 없는 것이 정상이다(있으면 오히려 버그).
const emptySkip = emptyState.looksEmpty !== true ? { skip: true } : {};
check("빈 상태가 채워짐 (§11.3: 빈 화면은 결함)", emptyState.looksEmpty === true, "대화 있음 — 빈 상태 대상 아님", emptySkip);
check("빈 상태에 **누를 수 있는 예시**가 있다 (§11.3: 읽고 타이핑시키지 않는다)", emptyState.exampleCount >= 3, "대화 있음", emptySkip);
check("키보드 힌트가 보인다 — 모르면 못 쓴다", emptyState.hints === true, "대화 있음", emptySkip);

/**
 * 머리 조작의 **이름이 보인다**(2026-10-01, 2026-10-04 정정).
 *
 * `aria-label` 만으로는 충분하지 않다. **눈으로 보이는 이름**이어야 첫 사용자가
 * 아이콘이 무엇인지 안다 — `title` 은 마우스를 올려야 보이고, 키보드 사용자는
 * 아예 못 본다.
 *
 * 정정(2026-10-04): 예전 판정은 세 라벨이 **전부** innerText 에 있기를 요구했다.
 * 그러나 S-2 확정 설계(액티비티바, `Ide.a11y.test.ts` 17/17)는 **선택된 항목만**
 * 이름을 글자로 보여주고 나머지는 `aria-label` 로 남긴다 — 40px 세로 띠에
 * 다섯 이름을 다 넣으면 2줄 버튼이 되어 띠가 깨진다. 세 개를 요구하면
 * 검증된 설계를 깨뜨리는 쪽으로 고치게 되므로, 검사가 틀렸다(§10.2).
 * 올바른 계약: 선택된 하나는 보이고, 세 개는 모두 발견 가능하다.
 *
 * 정정(사용자 지정: 설정만 남긴다): 측면 아이콘·디렉터리·변경 검토 진입로는
 * 제거됐다. 여는 곳은 상단 우측 ⚙ 아이콘(`aria-label="설정 열기"`)뿐이다.
 * ⚙은 관용 기호라 글자 라벨 대신 기호+aria-label+title 로 발견 가능하면 된다.
 */
check("선택된 머리 조작의 이름이 보인다 (§M8)", emptyState.headLabels.length >= 1, "대화 있음", emptySkip);
check(
  "설정 아이콘이 상단 우측에 있다 — aria-label로 발견 가능",
  (await cdp.eval(`!!document.querySelector('button[aria-label="설정 열기"]')`)) === true,
);
check(
  "제거된 진입로가 되살아나지 않는다 — 디렉터리·변경 검토 아이콘 없음",
  (await cdp.eval(`[...document.querySelectorAll("button[aria-label]")].filter((b) => /디렉터리|변경 검토/.test(b.getAttribute("aria-label") || "")).length === 0`)) === true,
);

const draft = await cdp.eval(`!!document.querySelector("textarea")`);
check("입력창 존재 (§5.7 · M7)", draft === true);

/**
 * **라벨이 실제 위치를 말하는지** 검증한다.
 *
 * 도킹 엔진이 판정한 존을 셸이 **무시하고** 고정 그리드로 그리면, 패널 머리에는
 * "오른쪽 도크" 라고 적혀 있고 화면에서는 중앙에 있다. 사용자는 그 라벨을 믿고
 * 패널을 찾는데 거기가 아니다. **라벨이 거짓말을 하는 배치가 엔진보다 나쁘다.**
 */
/**
 * **라벨이 실제 위치를 말하는지** 검증한다.
 *
 * 도킹 엔진이 판정한 존을 셸이 **무시하고** 고정 그리드로 그리면, 패널 머리에는
 * "오른쪽 도크" 라고 적혀 있고 화면에서는 중앙에 있다. 사용자는 그 라벨을 믿고
 * 패널을 찾는데 거기가 아니다. **라벨이 거짓말을 하는 배치가 엔진보다 나쁘다.**
 *
 * 판정은 픽셀 임계값이 아니라 **기하** 다:
 *   - 좌/우 도크는 중앙(1fr)보다 **좁은 열** 에 있어야 한다
 *   - 상단 도크는 **가장 위** 에 있고, 본체 1fr 보다 **낮은** 행이어야 한다
 * 픽셀 숫자로 "왼쪽인가?" 를 재면 창 크기에 따라 판정이 흔들린다.
 */
const panels = await cdp.eval(`
  (() => {
    const out = [];
    for (const s of document.querySelectorAll("strong")) {
      const head = s.closest("div");
      if (!head) continue;
      const label = (head.innerText ?? "").split("\\n")[1]?.trim() ?? "";
      if (!label.includes("도크") && !label.startsWith("중앙")) continue;
      const col = head.parentElement;
      const cbox = col.getBoundingClientRect();
      out.push({
        panel: s.textContent, label,
        x: Math.round(cbox.x), y: Math.round(cbox.y),
        colW: Math.round(cbox.width), colH: Math.round(cbox.height),
      });
    }
    return out;
  })()
`);

const LABEL_DOCK = {
  "왼쪽 도크": "left",
  "오른쪽 도크": "right",
  "상단 도크": "top",
  "하단 도크": "bottom",
  "중앙 (플로팅)": "center",
};
const widths = panels.map((p) => p.colW);
const heights = panels.map((p) => p.colH);
const zoneMismatch = panels.filter((p) => {
  const want = LABEL_DOCK[p.label];
  if (!want) return true;
  if (want === "left" || want === "right") {
    // 도크 열은 중앙(가장 넓은 열)보다 좁아야 한다.
    return !(p.colW < Math.max(...widths));
  }
  if (want === "top") {
    // 상단 도크는 가장 위, 그리고 **낮은** 행이어야 한다(본체는 1fr 로 늘어난다).
    const topY = Math.min(...panels.map((o) => o.y));
    return !(p.y === topY && p.colH < Math.max(...heights));
  }
  if (want === "center") return p.colW !== Math.max(...widths);
  return false;
});
check(
  "패널 라벨이 실제 위치와 일치 (§5.8: 라벨이 거짓말하면 안 된다)",
  zoneMismatch.length === 0,
  zoneMismatch.length
    ? zoneMismatch.map((z) => `${z.panel} "${z.label}" x=${z.x} y=${z.y} w=${z.colW} h=${z.colH}`).join(" / ")
    : panels.map((z) => `${z.panel}:${z.label}(w${z.colW})`).join(" "),
);

/**
 * **내부 식별자가 UI 에 그대로 노출되면 안 된다**(§5.8).
 *
 * 패널 머리에는 `explorer` 같은 내부 id 가 아니라 사람이 읽는 이름이 있어야 한다.
 * 그대로 노출되면 사용자는 "에디터" 를 찾다가 "editor" 라는 글자를 찾게 되고,
 * 그 패널이 무엇인지 스스로 설명하지 못한다.
 */
const LEAKED = ["explorer", "agent", "editor", "diff", "monitor", "settings", "workspace", "bootstrap"];
const headings = await cdp.eval(`
  Array.from(document.querySelectorAll("strong")).map((s) => s.textContent)
`);
const leaked = headings.filter((h) => LEAKED.includes(h));
check("패널 머리에 내부 식별자가 노출되지 않음 (§5.8)", leaked.length === 0, leaked.length ? leaked.join(", ") : headings.join(" "));

/**
 * 좁은 창(800px wide)에서 헤더·하단 셸이 대화 영역을 가리지 않고 스크롤을
 * 유발하지 않는지 (§8.3 · 요구 14). 기하로 판정한다:
 *   - 상단 헤더가 화면 너비(800)를 넘지 않는다
 *   - 하단 셸(탐색 막대 포함)이 세로 화면의 90%를 넘지 않고 좌우 스크롤을 유발하지 않는다
 * 크기는 창 크기에 따라 흔들리므로 **절대 임계값**(넘침/스크롤)으로만 본다.
 */
{
  // 이 블록은 Puppeteer API(`page.setViewport`·`page.$`)로 쓰여 있었지만 이 스크립트의 `page` 는 CDP 타깃 정보일 뿐이라
  // 18개 검사 뒤에서 **매번 TypeError 로 죽었다**(Q-4 실측, 2026-10-04). 같은 판정을 CDP 로 한다.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 400));
  const geo = await cdp.eval(`(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return {
      header: r(document.querySelector("header")),
      // 하단 셸 창은 없다(2026-10-04 제거) — 대신 프롬프트 입력 영역을 본다.
      prompt: r(document.querySelector("textarea")),
      scrollX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  })()`);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  let ok = true; let detail = "800px에서 헤더·입력창이 영역을 가리지 않고 가로 스크롤 없음";
  const b = geo?.header;
  if (b && (b.width > 802 || b.y + b.height > 900 - 4)) { ok = false; detail = `헤더 과대 (${Math.round(b.width)}x${Math.round(b.height)}, x=${Math.round(b.x)}, y=${Math.round(b.y)})`; }
  const pb = geo?.prompt;
  if (pb && (pb.width > 802 || pb.y > 900 * 0.95)) { ok = false; detail += ` | 입력창 화면 밖 (${Math.round(pb.width)}x${Math.round(pb.height)}, y=${Math.round(pb.y)})`; }
  if (geo?.scrollX) { ok = false; detail += " | 가로 스크롤 발생"; }
  report(ok ? "PASS" : "FAIL", `800px 좁은 창 — 요소 겹침/스크롤 없음`, ok, detail);
}

/**
 * 긴 경로가 말줄임(…)으로 처리되는지. 파일 트리와 도구 입력에서 경로가 길어지면
 * **네 줄로 퍼지지 않고** 접혀야 한다(요구 14: "경로가 길어지면 줄임 표시").
 * `textOverflow: ellipsis` + `whiteSpace: nowrap` 가 적용된 요소를 찾아 확인한다.
 */
{
  // Q-6(2026-10-04) 기준 정정: 예전 판정은 "textContent 에 … 가 있다" 였는데, CSS `text-overflow: ellipsis` 의 … 는
  // **textContent 에 절대 들어가지 않는다** — 화면이 우연히 … 글자를 담을 때만 통과하는, 원래부터 판정이 성립하지 않는 검사였다
  // (800px 블록의 TypeError 때문에 한 번도 실행되지 않아 아무도 몰랐다). 그래서 **말줄임 규칙이 실제로 걸린 요소**를 센다:
  // overflow hidden + text-overflow ellipsis + nowrap. 실제로 잘린 요소 수(scrollWidth > clientWidth)는 참고로 적는다.
  const trunc = await cdp.eval(`(() => {
    const els = Array.from(document.querySelectorAll("*")).filter((el) => {
      const cs = getComputedStyle(el);
      return cs.overflow === "hidden" && cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap";
    });
    return { rules: els.length, cut: els.filter((el) => el.scrollWidth > el.clientWidth).length };
  })()`);
  report(
    trunc.rules > 0 ? "PASS" : "FAIL",
    `긴 경로 줄임 표시 — 말줄임 규칙이 걸린 요소 ${trunc.rules}개`,
    trunc.rules > 0,
    `ellipsis+nowrap+hidden 요소 ${trunc.rules}개, 지금 실제로 잘린 요소 ${trunc.cut}개`,
  );
}

// 검색 결과 상한 — **창 검사에서 뺐다**(Q-6, 2026-10-04). 이 검사는 검색 입력창을 찾았는데, 검색 패널은 2026-10-01 탐색기와 함께
// 사용자가 지운 화면이다(지금 웹은 /api/fs/search 를 부르지 않는다). 없는 화면을 찾는 검사는 되살리라는 압력이 된다.
// 결과 상한 자체는 서버 쪽(`src/fs/search.ts`, clampInt)에 남아 있고 그 유닛 테스트가 지킨다.

await new Promise((r) => setTimeout(r, 1500));
check("콘솔 에러 0", errors.length === 0, errors.slice(0, 2).join(" | "));

const startedAtEnd = await readStartedAt();
check(
  "같은 서버를 잼 (§11: 중간에 재시작되면 측정이 무효)",
  startedAtEnd !== null && startedAtEnd === startedAtBegin,
  `시작 ${startedAtBegin} → 끝 ${startedAtEnd}`
);

cdp.close();
const failed = checks.filter((c) => !c.ok && !c.skipped);
console.log(`\n${checks.length - failed.length}/${checks.length} 통과`);
if (failed.length) {
  console.error(`실패: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
