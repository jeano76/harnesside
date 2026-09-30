/**
 * 병렬 사용자 시나리오 + 부하 시험 (2026-10-01).
 *
 * ── 이게 "100명의 사용자" 가 아닌 것을 먼저 밝힌다 ──────────────────────────
 * 100명의 사람이 아니다. **병렬 클라이언트 N개 × 실제 사용자 시나리오 M개** 다.
 * 사람이 하는 판단(피로감, 혼란, 실수)은 없지만, **기계가 할 수 있는 실패는 전부**
 * 재현한다 — 병목·경합·누락·증폭·정합성.
 *
 * 왜 시나리오를 나눴나: 부하만 재면 **서버가 살아 있다** 만 나온다. 실제로 사람이
 * "왜 안 되지?" 하고 겪는 일은 (a) 아무 일도 안 일어나는 것, (b) 조용히 다른 것을
 * 보여주는 것, (c) 화면만 반복해서 갱신하는 것이다. 셋 다 **에러로 안 잡힌다.**
 * 그래서 시나리오마다 **기대하는 사실** 을 적고 그 사실이 맞는지 본다.
 *
 * ── 안전 ────────────────────────────────────────────────────────────────────
 * 채택된 llama-server 는 **슬롯 1개**(`-np 1`)다. 에이전트 턴을 100개 넣으면
 * 직렬로 밀려 시간만 쓴다 — 그래서 턴은 **1개만** 돌리고 나머지는 API 계층만
 * 건다. VRAM 이 8GiB 에 6.1GiB 인 상태이므로 **두 번째 모델 인스턴스는 띄우지 않는다**
 * (실측된 OOM 경로). 이 스크립트는 추론을 새로 시작하지 않는다.
 *
 * 사용: `node scripts/soak-users.mjs [--clients 40] [--rounds 3] [--out 경로]`
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && Number.isFinite(Number(argv[i + 1])) ? Number(argv[i + 1]) : dflt;
};
const CLIENTS = num("--clients", 40);
const ROUNDS = num("--rounds", 3);
const OUT = (() => {
  const i = argv.indexOf("--out");
  return i >= 0 ? argv[i + 1] : null;
})();

const BASE = process.env.HARNESSIDE_URL ?? "http://127.0.0.1:7317";
const TOKEN = JSON.parse(await readFile(join(process.cwd(), ".harnesside/state/token.json"), "utf8")).token;

/** 서버가 붙잡는 오류를 그대로 알린다 — 삼키면 통과로 보인다. */
async function call(path, init = {}) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const ms = performance.now() - t0;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, ms, body };
}

const findings = [];
const record = (severity, where, what, evidence) => {
  findings.push({ severity, where, what, evidence });
  const tag = { error: "ERROR", warn: "WARN ", info: "INFO " }[severity] ?? severity;
  console.log(`  ${tag} [${where}] ${what}`);
  if (evidence) console.log(`         ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};

/** 시나리오 하나. 기대하는 사실을 적고, 안 맞으면 찾는다. */
const scenarios = [
  {
    id: "S01",
    persona: "첫 실행 사용자",
    run: async () => {
      const r = await call("/api/bootstrap");
      return { ok: r.status === 200 && Array.isArray(r.body?.steps), got: { status: r.status, steps: r.body?.steps?.length } };
    },
    expect: (g) => (g.got.steps === 12 ? null : `12단계여야 하는데 ${g.got.steps} — 단계가 빠졌다`),
  },
  {
    id: "S02",
    persona: "대화하는 사용자",
    run: async () => {
      // **턴은 1개만.** 슬롯 1개 서버에 40개를 넣으면 시간만 쓴다.
      let r;
      let timedOut = false;
      try {
        r = await call("/api/agent/turn", { method: "POST", body: JSON.stringify({ text: "한 단어로 대답해" }) });
      } catch (e) {
        // **타임아웃은 예외가 아니라 결과다.** 슬롯 1개라 느릴 수 있다.
        timedOut = true;
        r = { status: 0, body: { error: e instanceof Error ? e.message : String(e) }, ms: 20_000 };
      }
      return { ok: true, got: { status: r.status, error: r.body?.error, ms: Math.round(r.ms), timedOut } };
    },
    expect: (g) => {
      // **느린 것과 고장난 것을 구분한다.** 슬롯 1개 서버에서 첫 턴은 모델을 올리느라
      // 수십 초 걸릴 수 있고, 그건 결함이 아니다. 여기서 "느리다" 를 결함으로 세면
      // 매번 거짓말을 하고 — 진짜 결함(사유 없는 실패)이 묻힌다.
      if (g.got.timedOut) return null;
      if (g.got.status === 200) return null;
      if (g.got.status >= 400 && typeof g.got.error === "string" && g.got.error.length > 0) return null;
      return "실패인데 **사유가 없다** — 사용자는 무엇이 잘못됐는지 모른다";
    },
  },
  {
    id: "S03",
    persona: "파일을 여는 사용자",
    run: async () => {
      const r = await call("/api/fs/file?path=package.json");
      return { ok: r.status === 200, got: { status: r.status, len: r.body?.content?.length ?? 0 } };
    },
    expect: (g) => (g.got.len > 0 ? null : "파일을 읽었는데 내용이 비었다 — '없음' 과 '빈 파일' 을 구분 못 한다"),
  },
  {
    id: "S04",
    persona: "셸을 여는 사용자",
    run: async () => {
      const r = await call("/api/terminal", { method: "POST", body: JSON.stringify({ cols: 80, rows: 24 }) });
      const id = r.body?.id;
      if (!id) return { ok: false, got: { status: r.status, error: r.body?.error } };
      const typed = await call(`/api/terminal/${encodeURIComponent(id)}/input`, {
        method: "POST",
        body: JSON.stringify({ data: "pwd\n" }),
      });
      const list = await call("/api/terminal");
      await call(`/api/terminal/${encodeURIComponent(id)}/close`, { method: "POST", body: "{}" });
      return {
        ok: typed.status === 200,
        got: { status: typed.status, tabs: list.body?.tabs?.length, cwd: list.body?.cwd },
      };
    },
    expect: (g) => (g.got.cwd ? null : "셸 목록에 작업 경로(cwd) 가 없다 — 탐색 기능이 못 쓴다"),
  },
  {
    id: "S05",
    persona: "디렉터리를 옮기는 사용자",
    run: async () => {
      // **cwd 는 서버 전역 상태**이므로 시나리오는 **멱등**이어야 한다.
      //
      // 두 번 실패한 이유가 둘이다: (a) 병렬 복제본이 서로를 덮어써 "변경 없음" 이
      // 보였다. (b) **상대 경로** 를 썼다 — 이미 `src` 에 있으면 `cd src` 는
      // `src/src` 가 되어 **정상적으로 거절**된다. 둘 다 코드가 아니라 시험의 문제고,
      // 둘 다 실제 사람과 다르다(사람은 화면에 보이는 경로를 고른다).
      //
      // 그래서 **절대 경로**로 고정한다. 기준점은 실행 시 한 번만 읽는다.
      const target = `${ROOT_ONCE}/src`;
      const r = await call("/api/terminal/cwd", { method: "POST", body: JSON.stringify({ path: target }) });
      const after = await call("/api/terminal");
      // **원복** — 절대 경로라 상태와 무관하게 되돌아간다.
      await call("/api/terminal/cwd", { method: "POST", body: JSON.stringify({ path: ROOT_ONCE }) });
      const to = after.body?.cwd ?? "";
      return {
        ok: r.status === 200,
        got: { said: r.body?.ok, to, landed: to === target, root: ROOT_ONCE, detail: r.body?.detail },
      };
    },
    expect: (g) => {
      // 판정은 **착지** 하나다. `ok` 를 보지 않는 이유: cwd 가 전역이라 병렬 복제본이
      // 서로를 덮어쓴다 — 어떤 복제본은 자기 원복 때문에 400(거절)을 받아 `ok` 가 없다.
      // 그 400 은 **정상 동작**이고, 그것을 결함으로 세면 매 라운드 거짓말을 한다.
      if (!g.got.landed) return `${g.got.root}/src 로 **착지하지 못했다**: 실제 ${g.got.to}`;
      return null;
    },
  },
  {
    id: "S06",
    persona: "모델을 관리하는 사용자",
    run: async () => {
      const r = await call("/api/models");
      return {
        ok: r.status === 200,
        got: { status: r.status, entries: r.body?.entries?.length, served: r.body?.servedModel ?? null },
      };
    },
    expect: (g) =>
      g.got.served || g.got.entries > 0
        ? null
        : "사용 중인 모델도 로컬 파일도 없다 — 화면에 무엇이 도는지 말할 것이 없다",
  },
  {
    id: "S07",
    persona: "설정을 여는 사용자",
    run: async () => {
      const r = await call("/api/llama/status");
      return { ok: r.status === 200, got: { status: r.status, situation: r.body?.situation, remedy: r.body?.remedy } };
    },
    expect: (g) => (g.got.remedy ? null : "판정은 주지만 **방법**이 없다 — 무엇을 해야 하는지 모른다"),
  },
  {
    id: "S08",
    persona: "로그를 보는 사용자",
    run: async () => {
      const r = await call("/api/logs?limit=200");
      return { ok: r.status === 200, got: { status: r.status, lines: r.body?.lines?.length ?? r.body?.entries?.length ?? 0 } };
    },
    expect: (g) => (g.got.lines > 0 ? null : "로그가 비었다 — 데몬이 침묵하고 있다"),
  },
  {
    id: "S09",
    persona: "세션을 복원하는 사용자",
    run: async () => {
      const r = await call("/api/session/current");
      return { ok: r.status === 200, got: { status: r.status, hasId: !!r.body?.id } };
    },
    expect: () => null, // 세션이 비어 있는 것은 결함이 아니다
  },
  {
    id: "S10",
    persona: "지표를 지켜보는 사용자",
    run: async () => {
      const a = await call("/api/metrics");
      await new Promise((r) => setTimeout(r, 1200));
      const b = await call("/api/metrics");
      // **응답은 { latest, series, size } 껍데기다.** 껍데기를 벗겨야 샘플이 보인다 —
      // 검증기가 응답 모양을 틀리게 기억하면 "값이 없다" 고 결론짓는다(오탐).
      const la = a.body?.latest ?? a.body;
      const lb = b.body?.latest ?? b.body;
      return {
        ok: a.status === 200,
        got: {
          status: a.status,
          // **"없음" 과 "미측정" 을 구분한다.**
          context: la?.context == null ? "미측정" : `${Math.round(la.context.pct)}%`,
          advanced: la?.at !== lb?.at,
          cpus: la?.cpu?.cores?.length ?? 0,
        },
      };
    },
    expect: (g) => {
      if (!g.got.advanced) return "2초 뒤에도 계측 시각이 그대로다 — 1Hz 가 멈췄다";
      if (g.got.cpus === 0) return "코어 정보가 없다 — CPU 계측이 죽었다";
      return null;
    },
  },
  {
    id: "S11",
    persona: "권한 밖을 노리는 사용자 (반드시 막혀야 한다)",
    run: async () => {
      const paths = [
        "/api/fs/file?path=../../../../etc/passwd",
        "/api/fs/file?path=/etc/passwd",
        "/api/terminal/cwd",
      ];
      const r1 = await call("/api/fs/file?path=../../../../etc/passwd");
      const r2 = await call("/api/fs/file?path=/etc/passwd");
      const r3 = await call("/api/terminal/cwd", { method: "POST", body: JSON.stringify({ path: "/etc" }) });
      // **루트로 되돌아간 것**과 **거절한 것** 을 구분한다. `ok:false` + 현재 위치
      // 유지 = 올바른 거절. `ok:true` + 루트 바깥 = **게이트가 뚫렸다.**
      const after = await call("/api/terminal");
      const root = after.body?.cwd;
      const got = String(r3.body?.cwd ?? "");
      const escaped = root && got.startsWith("/") && !got.startsWith(root) ? `cwd=${got}` : null;
      return {
        ok: true,
        got: {
          up: r1.status,
          abs: r2.status,
          outStatus: r3.status,
          refused: r3.body?.ok === false || r3.status >= 400,
          escaped,
          detail: r3.body?.error ?? r3.body?.detail ?? null,
        },
      };
    },
    expect: (g) => {
      // **거절했다면 상태는 200 일 수 있다**(ok:false 를 담은 본문). 4xx 만 보면
      // 오탐이 난다 — 실제로 이 시나리오가 처음에 그렇게 오탐했다.
      if (g.got.escaped) return `루트 밖으로 **나갔다**: ${g.got.escaped}`;
      if (!g.got.refused) return "루트 밖 요청을 **거절하지 않았다** — 게이트가 없다";
      return null;
    },
  },
  {
    id: "S12",
    persona: "인증 없이 부르는 사용자 (반대로 막혀야 한다)",
    run: async () => {
      const res = await fetch(`${BASE}/api/models`, { signal: AbortSignal.timeout(8000) });
      return { ok: res.status === 401, got: { status: res.status } };
    },
    expect: (g) => (g.got.status === 401 ? null : `토큰 없이 ${g.got.status} — 보안 경계가 아니다`),
  },
];

// **기준 루트** — 한 번만 읽는다. cwd 는 전역이라 시나리오마다 변하므로 상대 경로를
// 쓰면 자기 상태에 따라 결과가 달라지고, 그 차이는 **정상 동작**이다(거절).
let ROOT_ONCE = "";
{
  const t = await call("/api/terminal");
  // **cwd 가 아니라 root 다.** cwd 는 사용자가 옮긴 현재 위치라 시험이 앞서 움직였으면
  // 틀린다 — 실제로 이 시험이 한 번 `.../src/src` 로 가라앉았다(오탐의 원인).
  ROOT_ONCE = t.body?.root ?? process.cwd();
  console.log(`기준 루트: ${ROOT_ONCE} (cwd=${t.body?.cwd ?? "?"})`);
}

// ── 실행 ──────────────────────────────────────────────────────────────────────
console.log(`\n병렬 사용자 시험 — 클라이언트 ${CLIENTS} · 라운드 ${ROUNDS} · 시나리오 ${scenarios.length}`);
console.log(`대상: ${BASE}\n`);

const results = [];

// ── 낡은 서버 검사 ────────────────────────────────────────────────────────────
//
// **이 시험이 처음에 완전히 거짓말을 했다.** S05(디렉터리 이동)가 "또 안 된다" 고
// 나온 이유는 코드가 아니라 **프로세스**가 낡아서였다 — 수정은 소스에 반영돼 있었고
// 서버는 그 **수정 이전**에 떠 있었다. 아래 모든 결과가 옛 코드의 성능이었다.
//
// 이것이 시험이 할 수 있는 가장 위험한 오류다. **통과한 검사는 통과한 것처럼 보이고,
// 실패한 검사는 진짜 결함처럼 보인다** — 그런데 둘 다 옛 코드에 대한 사실이다.
// 그러니 코드를 고쳤다면 **서버를 다시 띄우고** 시험한다. 이 검사가 그걸 막는다.
console.log("── 코드/프로세스 일치 검사 ──");
{
  const { execSync } = await import("node:child_process");
  let head = "?";
  try {
    head = execSync("git rev-parse --short HEAD", { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    console.log("  INFO  git HEAD 를 읽지 못했다 — 프로세스 기동 시각만 본다");
  }
  const info = await call("/api/health");
  const started = typeof info.body?.startedAt === "number" ? info.body.startedAt : null;
  const ageSec = started ? Math.round((Date.now() - started) / 1000) : null;
  // **판정 기준을 못 얻으면 "통과" 로 두지 않는다.** 시작 시각을 서버가 알려주지
  // 않으면 이 검사는 **아무것도 확인하지 않은 것**이고, 확인하지 못한 것을 확인했다고
  // 적으면 그게 더 나쁘다(거짓 통과).
  const problem =
    ageSec === null ? null : ageSec > 900 ? `서버가 ${Math.round(ageSec / 60)}분 전에 떴다` : null;
  if (problem) {
    record(
      "error",
      "STALE",
      `서버가 현재 코드보다 **낡을 수 있다**: ${problem}`,
      "코드를 고친 뒤 서버를 다시 띄우지 않으면 아래 모든 결과가 옛 코드의 사실이다",
    );
    console.log("         → harnesside down 후 다시 띄우고 이 시험을 돌린다");
  } else if (ageSec === null) {
    record(
      "warn",
      "STALE",
      "서버가 **기동 시각**을 알려주지 않는다 — 이 검사는 아무것도 못 했다",
      "health 응답에 startedAt 가 없다. 이 검사가 통과했다는 건 '확인했다'가 아니다",
    );
  } else {
    console.log(`  PASS  서버 기동 ${ageSec}초 전 · HEAD ${head}`);
  }
  results.push({
    round: 0,
    id: "STALE",
    persona: "코드는 고쳤는데 서버를 안 띄운 사람",
    n: 0,
    failures: 0,
    p50: 0,
    p95: 0,
    max: 0,
    problem,
    sample: { head, ageSec },
  });
}
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`── 라운드 ${round}/${ROUNDS} ──`);
  const out = await Promise.all(
    scenarios.map(async (sc) => {
      // **클라이언트 수만큼 같은 시나리오를 함께 돌린다** — 동시 접근에서만 보이는
      // 경합(공유 상태, 소켓, 락)을 잡는 것이 이 시험의 목적이다.
      const batch = await Promise.all(
        Array.from({ length: Math.max(1, Math.round(CLIENTS / scenarios.length)) }, async (_, i) => {
          const t0 = performance.now();
          try {
            const g = await sc.run();
            return { g, ms: performance.now() - t0, ok: true, i };
          } catch (e) {
            return { g: { got: { err: e instanceof Error ? e.message : String(e) } }, ms: performance.now() - t0, ok: false, i };
          }
        }),
      );
      const problem = batch.find((b) => !b.ok) ?? batch.find((b) => sc.expect?.(b.g));
      const lat = batch.map((b) => b.ms).sort((a, b) => a - b);
      const row = {
        round,
        id: sc.id,
        persona: sc.persona,
        n: batch.length,
        failures: batch.filter((b) => !b.ok).length,
        p50: Math.round(lat[Math.floor(lat.length * 0.5)]),
        p95: Math.round(lat[Math.floor(lat.length * 0.95)]),
        max: Math.round(lat[lat.length - 1]),
        problem: problem ? (sc.expect?.(problem.g) ?? "예외") : null,
        sample: problem?.g?.got ?? null,
      };
      if (row.problem) {
        record(
          "error",
          sc.id,
          `${sc.persona} — ${row.problem}`,
          `${row.failures}/${row.n} 실패 · p95 ${row.p95}ms · ${JSON.stringify(row.sample)}`,
        );
      }
      return row;
    }),
  );
  results.push(...out);
  console.log("");
}

// ── 유휴 증폭 검사 ────────────────────────────────────────────────────────────
// 2026-10-01 실측 두 건(5초 3303회 · 10초 17회)이 **서버 자원이 남는 한** 일어났다.
// 병렬 부하를 다 뗀 뒤에도 계속되면 그것은 부하가 아니라 **증폭** 이다.
console.log("── 유휴 증폭 검사 (부하 없이 6초) ──");
{
  const before = await readCounter();
  await new Promise((r) => setTimeout(r, 6000));
  const after = await readCounter();
  const perSec = (after - before) / 6;
  const line = `유휴 상태 요청 ${perSec.toFixed(1)} 회/초`;
  if (perSec > 5) record("error", "IDLE", `아무것도 하지 않는데 요청이 난다: ${line}`, "무한 루프 증폭 (deps 안정성)");
  else console.log(`  PASS  ${line}`);
  results.push({ round: 0, id: "IDLE", persona: "아무것도 하지 않는 사용자", n: 0, failures: perSec > 5 ? 1 : 0, p50: 0, p95: 0, max: 0, problem: perSec > 5 ? line : null, sample: { perSec } });
}

async function readCounter() {
  const r = await call("/api/logs?limit=1");
  // 로그 줄 수는 요청 수가 아니다. 서버가 스스로 세어 주는 곳이 없으므로
  // **부하가 없을 때의 로그 증가량** 을 대용치로 쓴다 — 정본이 아니므로 여기서 명시.
  return Number(r.body?.totalLines ?? r.body?.lines?.length ?? 0);
}

// ── 리포트 ────────────────────────────────────────────────────────────────────
const errors = results.filter((r) => r.problem);
const worst = [...errors].sort((a, b) => b.p95 - a.p95);
const report = {
  at: new Date().toISOString(),
  target: BASE,
  clients: CLIENTS,
  rounds: ROUNDS,
  scenarios: scenarios.length,
  total: results.length,
  failed: errors.length,
  findings,
  results,
  note: "100명의 사람이 아니다. 병렬 클라이언트 × 실제 사용자 시나리오를 **측정** 한 결과다.",
};

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n리포트: ${OUT}`);
}

console.log(`\n════ 요약 ════`);
console.log(`시나리오 실행 ${results.length}건 · 실패 ${errors.length}건`);
if (errors.length === 0) {
  console.log("발견된 결함 없음 — 단, 이것은 '시나리오 M개가 통과했다'는 뜻이지");
  console.log("사람의 혼란·피로를 재현했다는 뜻이 아니다.");
} else {
  console.log("\n심각도 순:");
  for (const e of worst) console.log(`  ${e.id} ${e.persona} — p95 ${e.p95}ms · ${e.problem}`);
}
process.exit(errors.length ? 1 : 0);
