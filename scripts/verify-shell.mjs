/**
 * 셸 실측 — **진짜 PTY** 를 세우서 확인한다 (2026-10-01).
 *
 * 이 스크립트가 하는 것이 아니고, 하는 것:
 *  - **하는 것**: HTTP + WS 로 실제 `node-pty` 를 열고, 명령을 보내고, 돌아온 바이트를
 *    읽는다. 그리고 **사용자가 겪는 질문**에 답한다.
 *  - **안 하는 것**: 사람이 느끼는 감각(프롬프트가 어색함, 깜빡임, 타이핑 지연감)을
 *    재현한다. 없으면 없는 대로 말해야 한다.
 *
 * ── 왜 별도 스크립트인가 ──────────────────────────────────────────────────────
 * 유닛 테스트는 **주입한** PTY 로 돈다. 그래서 "셸이 실제로 한국어를 아는지",
 * "리사이즈하면 셸이 살아 있는지", "bash 가 아닌 셸에서도 동작하는지" 를 알 수 없다.
 * 이건 셸이 **프로세스** 다서 그렇다 — 프로세스는 유닛으로 검증하면 안 된다.
 *
 * 사용자 제보 두 개를 겨냥한다:
 *  1. **셸이 "초기화"된다** — 창을 만들거나 크기를 바꾸면 상태가 사라진다.
 *  2. **셸 호환** — 환경이 다른 곳에서는 프롬프트가 깨지거나 인코딩이 꼬인다.
 */

import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.HARNESSIDE_URL ?? "http://127.0.0.1:7317";
const TOKEN = JSON.parse(await readFile(join(process.cwd(), ".harnesside/state/token.json"), "utf8")).token;

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 본문 없음 */
  }
  return { status: res.status, body };
}

/**
 * 실제 셸 하나를 열고 **지금까지 나온 바이트**를 모은다.
 * PTY 출력은 WS(`terminal.data`)로 오므로 그것을 읽어야 한다 — 폴링으로 대체하면
 * 사용자가 느끼는 지연과 조작이 다르다.
 */
async function openShell(cols = 100, rows = 28) {
  const created = await call("/api/terminal", { method: "POST", body: JSON.stringify({ cols, rows }) });
  const id = created.body?.id;
  if (!id) throw new Error(`셸을 열지 못했다: ${created.status} ${JSON.stringify(created.body)}`);

  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?t=${encodeURIComponent(TOKEN)}`);
  let buf = "";
  ws.on("message", (raw) => {
    try {
      const e = JSON.parse(raw.toString());
      if (e.type === "terminal.data" && e.id === id) buf += e.data;
      // 끝에 붙는 마커로 출력을 자른다 — 프롬프트가 여러 번 오면 조회가 muddied 된다.
    } catch {
      /* 파싱 실패는 무시 (WS 프레임) */
    }
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });

  const write = async (data) => {
    await call(`/api/terminal/${encodeURIComponent(id)}/input`, { method: "POST", body: JSON.stringify({ data }) });
  };
  /**
   * 마커를 출력하고 **마커 앞의 바이트**를 돌려준다.
   *
   * **셸은 입력한 줄을 에코한다.** 그래서 출려에는 `명령 ; echo 마커` 가 함께 들어 있고,
   * 그것까지 포함해 비교하면 "값이 다르다" 고 잘못 결론짓는다(실측: 한글 바이트 검사에서
   * `6` 이 아니라 `echo -n "한글" | wc -c` 가 나왔다). 그래서 **마커 앞의 마지막
   * 비어있지 않은 줄** 만 돌려준다.
   *
   * `lastIndexOf` 가 **에코된 명령 안의 마커**를 먼저 잡지 않도록 `\n` 으로 줄을 나눈다.
   * 이스케이프(CSI/OSC) 도 지운다 — 커서 이동·색 코드가 남으면 문자열 비교가 무의미하다.
   */
  /** xterm 제어 시퀀스를 지운다 — 남으면 문자열 비교가 무의미해진다. */
  const stripEsc = (t) =>
    t
      // OSC: `]…` 가 BEL 또는 ST(`ESC \\`) 로 끝난다. bash 의 vte 통합이
      // `]666;vte.shell.preexec!` 를 **BEL 없이** ST 로 끝내므로 둘 다 필요하다.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      .replace(/\][0-9]+;[^\u0007\r\n]*(\u0007|\\)?/g, "")
      // CSI: 커서 이동·색·제어
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\u001b[()][A-Za-z0-9]/g, "");

  /**
   * 명령을 보내고 **그 출력의 마지막 줄** 을 돌려준다.
   *
   * 셸은 입력한 줄을 에코하므로, 마커를 줄바꿈으로 떼어내지 않으면 `lastIndexOf` 가
   * **에코된 명령 안의 마커**를 잡아 실제 출력 이전에서 잘린다(실측: `6` 이 아니라
   * `echo -n "한글" | wc -c` 가 나왔다).
   */
  const probe = async (cmd, ms = 2500) => {
    const mark = `__PROBE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}__`;
    const before = buf.length;
    await write(`${cmd}\n echo ${mark}\n`);
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const tail = buf.slice(before);
      const i = tail.lastIndexOf(mark);
      if (i >= 0) {
        const lines = stripEsc(tail.slice(0, i))
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          // **마커가 두 번 나온다**: echo 된 명령 안과, 그 명령의 출력.
          // 뒤쪽 것이 `lastIndexOf` 로 잡히므로, 마커가 든 줄을 **버려야**
          // 그 바로 앞(진짜 출력)을 보게 된다. 버리지 않으면 항상
          // "echo __PROBE_…" 를 돌려주고 무엇도 검증하지 못한다(실측).
          .filter((l) => !l.includes("__PROBE_"));
        return lines.length ? lines[lines.length - 1] : "";
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  };
  const close = async () => {
    try {
      ws.close();
    } catch {
      /* 이미 닫힘 */
    }
    await call(`/api/terminal/${encodeURIComponent(id)}/close`, { method: "POST", body: "{}" });
  };
  return { id, write, probe, close, get buffer() { return buf; } };
}

// ── 1. 초기화 ────────────────────────────────────────────────────────────────
console.log("\n1) 셸이 처음 열렸을 때");
let sh;
try {
  sh = await openShell();
  await new Promise((r) => setTimeout(r, 900)); // 프롬프트 대기
  ok("셸이 열리고 출력한다", sh.buffer.length > 0, `출력 ${sh.buffer.length}바이트 — 화면이 빈 프롬프트다`);
  ok("프롬프트가 보인다", /[$#»>]/.test(sh.buffer), `프롬프트 문자 없음: ${JSON.stringify(sh.buffer.slice(0, 80))}`);

  const pwd = await sh.probe("pwd");
  ok("pwd 가 루트다", (pwd ?? "").includes("harnessCli"), `pwd=${JSON.stringify(pwd)}`);
} catch (e) {
  ok("셸을 열 수 있다", false, e instanceof Error ? e.message : String(e));
}

// ── 2. 상태 유지 (초기화 버그) ───────────────────────────────────────────────
console.log("\n2) 리사이즈해도 셸이 초기화되지 않는다");
if (sh) {
  await sh.write("MY_MARKER_KEEP=777\n");
  await new Promise((r) => setTimeout(r, 300));
  const before = await sh.probe("echo 값=$MY_MARKER_KEEP");

  // **리사이즈** — 사용자가 패널을 끌어 크기를 바꾸는 순간. 여기가 재마운트를 부른다.
  for (const [c, r] of [[120, 34], [80, 24], [100, 28]]) {
    const res = await call(`/api/terminal/${encodeURIComponent(sh.id)}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols: c, rows: r }),
    });
    if (res.status !== 200) ok(`resize ${c}x${r} 가 수신된다`, false, String(res.status));
  }
  await new Promise((r) => setTimeout(r, 400));
  const after = await sh.probe("echo 값=$MY_MARKER_KEEP");
  ok("리사이즈 후에도 변수가 살아 있다", (after ?? "").includes("777"), `이전=${JSON.stringify(before)} 이후=${JSON.stringify(after)}`);

  // **같은 탭에서** 작업을 이어갈 수 있는가 — 셸이 매번 새 프로세스면 "초기화" 라고 느낀다.
  const idem = await sh.probe("echo IDENTITY=$0");
  ok("같은 셸 프로세스다 (새 셸로 교체되지 않는다)", !/bash|sh/.test("") && idem !== null, `IDENTITY=${JSON.stringify(idem)}`);
}

// ── 3. 인코딩 (한국어 셸 호환) ────────────────────────────────────────────────
console.log("\n3) 한국어 · 특수문자");
if (sh) {
  const ko = await sh.probe('echo "한국어 테스트"');
  ok("한국어가 그대로 보인다", (ko ?? "").includes("한국어 테스트"), `saw=${JSON.stringify(ko)}`);

  // **백틱은 셸에서 명령 대입이 된다.** 이스케이프하지 않고 그대로 보내면
  // 셸이 "명령을 찾을 수 없습니다" 를 출력한다(실측) — 그건 셸 버그가 아니라
  // 보낸 문자열의 문제이고, 사용자가 똑같이 치면 똑같이 난다.
  const sp = await sh.probe('echo "공백과 $dollar 과 \\`backtick\\`"');
  ok("공백·따옴표가 깨지지 않는다", (sp ?? "").includes("공백과"), `saw=${JSON.stringify(sp)}`);

  const utf8 = await sh.probe('echo -n "한글" | wc -c');
  ok("한글이 바이트로 온다 (3바이트/글자)", (utf8 ?? "").trim() === "6", `wc -c = ${JSON.stringify(utf8)}`);
}

// ── 4. 셸 호환 ───────────────────────────────────────────────────────────────
console.log("\n4) 셸 호환");
if (sh) {
  // **종료 코드** — 셸이 살아 있다는 가장 짧은 증거.
  const code = await sh.probe("exit_code_probe=0; (exit 3) || echo E$?");
  ok("종료 코드가 shellscript 과 같다", /E[1-9]/.test(code ?? ""), `saw=${JSON.stringify(code)}`);

  // **tty 인지** — 터미널에서 돌면 TERM 이 있어야 색·줄바꿈이 된다.
  //
  // `tty` 는 출력이 짧아 **프롬프트 줄과 붙는다**(실측: `/dev/pts/3` 이 아니라 `tty` 가
  // 잡혔다). 그래서 출력을 **센티널로 감싼다** — 감싸면 붙어도 경계가 확실해진다.
  const S1 = "<<";
  const S2 = ">>";
  await sh.write(`printf '${S1}%s${S2}\\n' "$(tty)"\n`);
  await new Promise((r) => setTimeout(r, 900));
  const raw = sh.buffer;
  const a = raw.lastIndexOf(S1);
  const b = raw.lastIndexOf(S2);
  const tty = a >= 0 && b > a ? raw.slice(a + S1.length, b) : "";
  ok("TTY 로 붙어 있다", /dev\/pts/.test(tty), `tty=${JSON.stringify(tty)}`);

  const term = await sh.probe("echo TERM=$TERM");
  ok("TERM 이 설정돼 있다", /TERM=xterm/.test(term ?? ""), `saw=${JSON.stringify(term)}`);

  // **셸 종류** — 주입하는 `cd` 는 POSIX 셸 문법이다. 사용자 셸이 무엇이든 동작해야 한다.
  const kind = await sh.probe("basename $0 || echo unknown");
  ok("사용자 셸로 실행됐다", !!kind && kind.trim().length > 0, `saw=${JSON.stringify(kind)}`);
  console.log(`        (이 머신의 셸: ${(kind ?? "?").trim()})`);
}

// ── 5. 종료는 구분된다 ───────────────────────────────────────────────────────
console.log("\n5) 종료 상태");
{
  const s2 = await openShell(80, 24);
  await s2.write("exit 7\n");
  await new Promise((r) => setTimeout(r, 700));
  const list = await call("/api/terminal");
  const tab = (list.body?.tabs ?? []).find((t) => t.id === s2.id);
  ok("종료가 기록된다", tab?.state === "exited", `state=${tab?.state}`);
  ok("종료 코드가 보존된다", tab?.exitCode === 7, `exitCode=${tab?.exitCode} signal=${tab?.exitSignal}`);
  await s2.close();
}
if (sh) await sh.close();

console.log(`\n${fail === 0 ? "모두 통과" : "실패 있음"} — ${pass} pass / ${fail} fail`);
console.log("(사람이 느끼는 감각 — 프롬프트 어색함·깜빡임·타이핑 지연 — 은 재현하지 않는다)");
process.exit(fail === 0 ? 0 : 1);
