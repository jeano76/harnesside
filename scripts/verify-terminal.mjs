/**
 * 터미널 실측 — HTTP 로 열고, **WS 로 출력을 받고**, 입력하고, 종료한다.
 *
 * 라우트만 통과하는 것으로는 "터미널이 동작한다" 고 말할 수 없다. PTY 출력은 WS 로만
 * 오므로, 이 스크립트는 소켓을 직접 연다. 소켓으로 못 받는 것을 "동작한다" 고 쓰는
 * 순간 사용자는 타이핑이 안 먹히는 터미널을 받게 된다.
 */

import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const PORT = Number(process.env.HARNESSIDE_PORT ?? 7317);
const token = JSON.parse(await readFile(".harnesside/state/token.json", "utf8")).token;
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: H,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
};

let pass = 0;
let fail = 0;
const check = (ok, label, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  ok  ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// WS 를 열고 PTY 데이터를 모은다.
const chunks = new Map();
const exits = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${encodeURIComponent(token)}`);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
ws.on("message", (m) => {
  let ev;
  try {
    ev = JSON.parse(String(m));
  } catch {
    return;
  }
  if (ev.type === "terminal.data" && typeof ev.data === "string") {
    chunks.set(ev.id, (chunks.get(ev.id) ?? "") + ev.data);
  } else if (ev.type === "terminal.exit") {
    exits.push(ev.session);
  }
});
const text = (id) => (chunks.get(id) ?? "").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};

console.log("M1 터미널 실측");

// 1. 셸을 연다
const open = await api("POST", "/api/terminal", { cols: 100, rows: 30 });
check(open.status === 200 && open.json?.state === "running", "셸이 열린다", `state=${open.json?.state}`);
const id = open.json?.id ?? "";

// 2. **cwd 가 워크스페이스 안** — 밖이면 승인 게이트를 우회한다
const ws0 = await api("GET", "/api/workspace");
const rootPath = ws0.json?.current?.root ?? process.cwd();
check(open.json?.cwd === rootPath, "cwd 가 워크스페이스 루트다", `${open.json?.cwd} vs ${rootPath}`);

const escape = await api("POST", "/api/terminal", { cwd: "/etc" });
check(escape.json?.cwd !== "/etc", "루트 밖 cwd 는 새지 않는다", escape.json?.cwd);
await api("POST", `/api/terminal/${escape.json.id}/close`);

// 3. 입력 → **WS 로 출력이 온다**
await api("POST", `/api/terminal/${encodeURIComponent(id)}/input`, { data: "echo M1_PTY_LIVE_OK\n" });
check(await waitFor(() => text(id).includes("M1_PTY_LIVE_OK")), "WS 로 PTY 출력이 온다", JSON.stringify(text(id).slice(-60)));

// 4. 여러 탭
const second = await api("POST", "/api/terminal", {});
check(second.json?.id !== id, "탭이 여러 개 열린다");
await api("POST", `/api/terminal/${encodeURIComponent(second.json.id)}/input`, { data: "echo SECOND_TAB\n" });
check(await waitFor(() => text(second.json.id).includes("SECOND_TAB")), "두 번째 탭이 따로 동작한다");

// 5. resize
const rs = await api("POST", `/api/terminal/${encodeURIComponent(id)}/resize`, { cols: 120, rows: 40 });
check(rs.status === 200, "resize 가 받아들여진다", JSON.stringify(rs.json));

// 6. 죽은 탭에 쓰기 → **409** (조용히 버리지 않는다)
await api("POST", `/api/terminal/${encodeURIComponent(id)}/input`, { data: "exit 7\n" });
check(await waitFor(() => exits.length > 0), "종료 이벤트가 온다");
const dead = await api("POST", `/api/terminal/${encodeURIComponent(id)}/input`, { data: "echo 안 통함\n" });
check(dead.status === 409, "죽은 셸에 쓰면 409 로 말한다", `status=${dead.status}`);

// 7. 목록에 **종료 상태가 남는다** — 탭이 사라지면 안 된다
const list = await api("GET", "/api/terminal");
const deadTab = list.json?.tabs?.find((t) => t.id === id);
check(!!deadTab, "종료한 탭이 목록에 남는다");
check(deadTab?.exitCode === 7, "exit code 가 보존된다", `exitCode=${deadTab?.exitCode}`);
check(deadTab?.exitSignal === null, "signal 0 을 신호로 보지 않는다", `signal=${deadTab?.exitSignal}`);
check(deadTab?.state === "exited" && deadTab?.exitedAt !== null, "종료 시각이 있다");

// 8. 닫기
const closed = await api("POST", `/api/terminal/${encodeURIComponent(id)}/close`);
check(closed.status === 200, "탭을 닫는다");
const after = await api("GET", "/api/terminal");
check(!after.json?.tabs?.some((t) => t.id === id), "닫은 탭이 목록에서 빠진다");

// 9. 셸이 없으면 **왜인지 말하고 열지 않는다**
const badShell = await api("POST", "/api/terminal", { title: "no-shell-check" });
check(badShell.status === 200, "기본 셸은 있다 (이 검사는 환경 의존)");

console.log(`\n${pass} 통과 / ${fail} 실패`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
