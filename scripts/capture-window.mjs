/**
 * 창 스크린샷 (§0.2).
 *
 * **회귀 비교는 하지 않는다.** 기준 이미지가 러너·OS·Chrome 버전에 흔들리는데,
 * 흔들리는 비교는 "경고가 자꾸 나는 테스트" 가 되고 아무도 보지 않게 된다(§0.2).
 * 여기서는 **사람이 볼 수 있는 그림** 한 장만 남긴다. "백 화면 금지" 는 자동
 * 검사로 확인하고(verify-window.mjs), 그림은 그 판단의 **근거** 다.
 *
 * 실패해도 검증 실패로 세지 않는다 — 그림이 없어도 창 검증은 이미 끝났다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";

const CDP = process.env.HARNESSIDE_CDP ?? "http://127.0.0.1:9222";
const URL_MATCH = process.env.HARNESSIDE_URL ?? "127.0.0.1:7317";
const OUT = process.argv[2] ?? "/tmp/window.png";

const token =
  process.env.HARNESSIDE_TOKEN ??
  JSON.parse(await readFile(".harnesside/state/token.json", "utf8").catch(() => "{}")).token;

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === "page" && (t.url ?? "").includes(URL_MATCH));
if (!page) throw new Error(`대상 페이지가 없습니다: ${list.map((t) => `${t.type}:${t.url}`).join(", ")}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.once("open", res);
  ws.once("error", rej);
});
let id = 0;
const call = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id;
    const onMsg = (m) => {
      const d = JSON.parse(String(m));
      if (d.id !== n) return;
      ws.off("message", onMsg);
      if (d.error) rej(new Error(d.error.message));
      else res(d.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const { data } = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(OUT, Buffer.from(data, "base64"));
ws.close();
console.log(`스크린샷 저장: ${OUT}`);
