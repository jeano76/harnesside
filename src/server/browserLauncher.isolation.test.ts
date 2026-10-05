/**
 * **인스턴스 간 창 가로채기** — 재현하고 막는다 (Raiser: "새 창으로 웹페이지가 뜬다").
 *
 * ── 실측으로 확인한 결함 ────────────────────────────────────────────────────
 *
 * `/home/jeano/projects/netproxy` 세션(CDP 9222)이 떠 있는 상태에서 두 번째 인스턴스를
 * 띄우면 이렇게 됐다(그대로 재현함):
 *
 *   1. 두 번째 인스턴스가 `--user-data-dir=<같은 경로>` 로 Chrome 을 스폰한다
 *   2. Chrome 은 그 프로필을 이미 쓰는 브라우저가 있으므로 **새 프로세스를 만들지 않고**
 *      거기에 `--app=http://127.0.0.1:7318/` 을 넘긴다
 *   3. 첫 번째 인스턴스의 브라우저에 **새 창이 뜬다**
 *   4. 두 번째 인스턴스는 `waitForCdp(9222)` 에 성공하고 **"기동 성공" 이라고 보고한다**
 *
 * 실측 증거: Chrome 프로세스 **하나**(pid 3718052)에 페이지가 **두 개** —
 * `7317`(원래 창)과 `7318`(새로 생긴 창). 즉 창이 열린 게 아니라 **남의 브라우저를
 * 가로챈** 것이고, 남의 세션이 그 창을 닫으면 이쪽도 함께 죽는다.
 *
 * 두 가지를 함께 막는다:
 *   ① **프로필을 CDP 포트 기준으로 나눈다** — Chrome 이 인계할 대상이 없다.
 *   ② **이미 쓰이는 포트를 자동 분리한다** — 상대편의 CDP 에 붙지 않는다.
 *      사용자가 포트를 명시했다면 조용히 바꾸지 않고 **멈춘다.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CDP_DEFAULT_PORT, profileDir } from "./browserFlags.js";
import { BrowserLauncher } from "./browserLauncher.js";

const HOME = "/home/u";

// ── ① 프로필이 포트마다 달라야 한다 ────────────────────────────────────────

test("**기본 포트는 예전 경로를 유지한다** — 창 위치·쿠키가 사라지면 안 된다", () => {
  assert.equal(profileDir(HOME), "/home/u/.harnesside/chrome-profile");
  assert.equal(profileDir(HOME, CDP_DEFAULT_PORT), "/home/u/.harnesside/chrome-profile");
  assert.equal(profileDir("/home/u/"), "/home/u/.harnesside/chrome-profile");
});

test("**다른 포트는 다른 프로필을 쓴다** — Chrome 이 인계할 대상이 없어야 한다", () => {
  const a = profileDir(HOME, 9222);
  const b = profileDir(HOME, 9223);
  assert.notEqual(a, b, `포트 9222 와 9223 이 같은 프로필을 쓴다: ${a} — Chrome 이 URL 을 기존 브라우저로 넘긴다`);
  assert.equal(b, "/home/u/.harnesside/chrome-profile-9223");
});

test("프로필 경로는 **프로젝트 디렉터리에 두지 않는다** (§6.4)", () => {
  for (const p of [profileDir(HOME), profileDir(HOME, 9223)]) {
    assert.ok(p.includes("/.harnesside/"), `프로젝트 밑이 아니라 홈이어야 한다: ${p}`);
  }
});

// ── ② 이미 쓰이는 포트에는 붙지 않는다 ────────────────────────────────────

/**
 * CDP 가 이미 떠 있는 포트를 흉내 낸다.
 *
 * **스폰한 뒤 그 포트가 응답하기 시작한다** — 실제 흐름을 그대로 본다.
 * `waitForCdp` 는 "스폰 → 붙는다" 를 재므로, 스폰이 일어나지 않으면 붙을 수 없다.
 * 예전 픽스처는 응답 목록을 고정해 두어 **분리 성공 케이스에서 항상 실패**했다
 * (15초 대기 후 `attached:false`). 그건 코드가 아니라 **검사의 오류**였다.
 */
function launcher(opts: { cdpPort?: number; serving: number[] }) {
  const lines: string[] = [];
  const alive = new Set(opts.serving);
  const l = new BrowserLauncher(
    { mode: "off", cdpPort: opts.cdpPort, idePort: 7317, appUrl: "http://127.0.0.1:7317/" },
    {
      home: HOME,
      exists: async () => true,
      // CDP 포트 확인과 GPU 확인에 **모두** 쓰인다.
      fetchImpl: (async (u: string) => {
        const m = /:(\d+)\//.exec(u);
        const port = m ? Number(m[1]) : 0;
        return { ok: alive.has(port), status: alive.has(port) ? 200 : 500, json: async () => ({}) } as never;
      }) as never,
      // 스폰이 성공하면 **그 포트가 응답하기 시작한다** — 실제 Chrome 과 같다.
      spawnImpl: ((_bin: string, args: string[]) => {
        const m = /--remote-debugging-port=(\d+)/.exec(args.join(" "));
        if (m) alive.add(Number(m[1]));
        return { pid: 4242, stdout: null, stderr: null, on: () => {}, stdio: [] };
      }) as never,
      logger: (lvl: string, m: string) => lines.push(`${lvl}:${m}`),
      onLine: () => {},
    }
  );
  return { l, lines };
}

test("**기본 포트가 남의 것** 이면 다음 빈 포트로 분리한다", async () => {
  const { l } = launcher({ serving: [9222] }); // 9222 만 차 있음
  const r = await l.launch();
  assert.equal(r.cdpPort, 9223, `9222 에 그대로 붙었다 — 남의 CDP 다. 고른 값: ${r.cdpPort}`);
  // **분리는 성공이지 실패가 아니다** — flags 가 비면 '바이너리를 못 찾았다' 고 잘못 말한다.
  assert.ok(r.flags.length > 0, "분리에 성공했는데 플래그가 비었다 — 창을 안 띄웠다");
  assert.notEqual(r.attached, false, "분리해서 띄웠는데 붙지 않았다");
});

test("**분리 사실은 로그로 남는다** — 조용히 바꾸지도, 멈추지도 않는다", async () => {
  const { l, lines } = launcher({ serving: [9222] });
  await l.launch();
  assert.ok(lines.some((x) => /9223/.test(x) && /9222/.test(x)), `분리 사실을 로그에 남기지 않는다: ${lines.join(" | ")}`);
});

test("**명시한 포트를 남이 쓰고 있으면 멈춘다** — 조용히 바꾸지 않는다", async () => {
  // 이게 핵심이다: 사용자가 9222 를 명했는데 남이 쓰고 있다.
  // 조용히 9223 으로 가면 "9222 로 지정했는데 왜 창이 안 붙지" 하고 혼란스러워한다.
  const { l } = launcher({ cdpPort: 9222, serving: [9222] });
  const r = await l.launch();
  assert.equal(r.attached, false, "남의 CDP 에 붙었다고 보고한다");
  assert.equal(r.cdpPort, 9222, "조용히 포트를 바꿨다 — 사용자가 명시한 값이다");
  assert.ok(r.rationale.length > 0, "왜 멈췄는지 말하지 않는다");
  assert.match(r.rationale.join(" "), /HARNESSIDE_CDP_PORT/, "조치 방법을 말하지 않는다");
});

test("**아무도 안 쓰고 있으면** 기본 포트를 그대로 쓴다", async () => {
  const { l } = launcher({ serving: [] });
  const r = await l.launch();
  assert.equal(r.cdpPort, CDP_DEFAULT_PORT, `빈 포트인데 기본값을 쓰지 않았다: ${r.cdpPort}`);
});

test("연속으로 몇 개가 차 있으면 **다 지나친다**", async () => {
  const { l } = launcher({ serving: [9222, 9223, 9224] });
  const r = await l.launch();
  assert.equal(r.cdpPort, 9225, `빈 포트를 찾지 못했다: ${r.cdpPort}`);
  assert.ok(r.flags.length > 0, "빈 포트를 찾았는데 창을 띄우지 않았다");
});

test("**전부 차 있으면** 멈춘다 — 엉뚱한 포트를 지어내지 않는다", async () => {
  const busy = Array.from({ length: 40 }, (_, i) => 9222 + i);
  const { l } = launcher({ serving: busy });
  const r = await l.launch();
  assert.equal(r.attached, false, "사용 중인 포트를 골라 붙었다");
  assert.match(r.rationale.join(" "), /빈 CDP 포트를 찾지 못/, `사유가 정확하지 않다: ${r.rationale.join("|")}`);
});