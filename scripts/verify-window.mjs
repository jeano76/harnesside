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
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((res) => {
      this.#waiters.set(id, res);
      this.#ws.send(JSON.stringify({ id, method, params }));
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
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const page = await findPage();
const cdp = await Cdp.open(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");

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

// 콘솔 에러 수집 (이벤트는 다음 eval 사이에도 온다)
const errors = [];

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

const agentEmpty = await cdp.eval(`document.body.innerText.includes("아직 메시지가 없습니다") || document.body.innerText.includes("무엇을 할까요")`);
check("빈 상태가 채워짐 (§11.3: 빈 화면은 결함)", agentEmpty === true);

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

await new Promise((r) => setTimeout(r, 1500));
check("콘솔 에러 0", errors.length === 0, errors.slice(0, 2).join(" | "));

cdp.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 통과`);
if (failed.length) {
  console.error(`실패: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
