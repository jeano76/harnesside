/**
 * BrowserLauncher 유닛 테스트 (§10.2).
 *
 * 특히 `resolveBinary` 를 검증한다 — 실제로 이 버그가 있었다: 기본 `exists` 구현이
 * `access()` 의 성공(undefined)을 "없음" 으로 읽어, 설치돼 있는 Chrome 을 못 찾았다.
 * "설치 안 됨" 경로를 테스트하지 않으면 이 유형의 버그는 창이 안 뜨는 것으로만 드러난다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BrowserLauncher, CHROME_CANDIDATES } from "./browserLauncher.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = { mode: "off" as const, appUrl: "http://127.0.0.1:7317/?t=T", userDataDir: "/tmp/p" };

// ── §4.4 S4: CDP 재연결 정책 ────────────────────────────────────────────────

/**
 * 가짜 CDP 소켓. `open`/`close` 를 테스트가 직접 부른다 — 소켓은 저절로 죽지 않으니까.
 *
 * `open` 은 **핸들러가 붙으면 그때** 알린다. 미리 불을 켜 두면(호출자가 소켓을 만든 뒤
 * watchCdp 에 넘기기 전에) 아무도 듣지 못한다 — 실제로 그 버그로 첫 테스트가
 * "Promise 가 안 끝났다" 로 죽었다. 비동기 소켓의 이벤트를 흉내 내려면 그 버퍼링이 필요하다.
 */
class FakeCdp {
  private handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  pendingOpen = false;
  closed = false;
  constructor(readonly url: string) {}
  on(event: string, fn: (arg?: unknown) => void) {
    (this.handlers[event] ??= []).push(fn);
    if (event === "open" && this.pendingOpen) {
      this.pendingOpen = false;
      setTimeout(() => this.fire("open"), 0);
    }
    return this;
  }
  send() {}
  close() {
    this.closed = true;
  }
  fire(event: string, arg?: unknown) {
    for (const fn of [...(this.handlers[event] ?? [])]) fn(arg);
  }
  /** "연결된 상태로 만들겠다" 고 선언한다. */
  autoOpen() {
    this.pendingOpen = true;
    return this;
  }
  /** 곧바로 열리고 곧바로 끊기는 소켓(재연결 실패 재현용). */
  openThenClose() {
    this.pendingOpen = true;
    this.on("open", () => setTimeout(() => this.fire("close"), 0));
    return this;
  }
}

function fakeCdpFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input).includes("/json/version")) {
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/x" }) } as Response;
    }
    throw new Error(`unexpected ${String(input)}`);
  }) as unknown as typeof fetch;
}

test("S4: 소켓이 붙으면 `connected` — 감시 전에는 `none` 이다(판정 대상 아님)", async () => {
  const sock = new FakeCdp("ws://x").autoOpen();
  const l = new BrowserLauncher(base, { fetchImpl: fakeCdpFetch(), wsFactory: () => sock });
  assert.equal(l.cdp, "none", "감시 전부터 connected 로 보이면 안 된다");
  const ok = await l.watchCdp(9222, () => undefined);
  assert.equal(ok, true);
  assert.equal(l.cdp, "connected");
});

test("S4: 한 번 끊겼다가 **재연결되면** lost 가 아니다 — 프로필 잠금일 수 있다", async () => {
  const socks: FakeCdp[] = [];
  const l = new BrowserLauncher(base, {
    fetchImpl: fakeCdpFetch(),
    cdpRetryDelayMs: 1,
    // 첫 소켓은 곧바로 끊기고, 두 번째는 붙는다.
    wsFactory: () => {
      const s = socks.length === 0 ? new FakeCdp("ws://x").openThenClose() : new FakeCdp("ws://x").autoOpen();
      socks.push(s);
      return s;
    },
  });
  let lost = 0;
  await l.watchCdp(9222, () => { lost++; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(lost, 0, "재연결에 성공했는데 lost 로 봤다");
  assert.equal(l.cdp, "connected", "복구 상태여야 한다");
  assert.equal(socks.length, 2, "재연결을 실제로 시도했다");
});

test("S4: **재연결 2회 실패** 가 lost 다 — 한 번의 실패로 죽이지 않는다", async () => {
  let made = 0;
  const l = new BrowserLauncher(base, {
    fetchImpl: fakeCdpFetch(),
    cdpRetryDelayMs: 1,
    cdpRetryAttempts: 2,
    wsFactory: () => {
      made++;
      return new FakeCdp("ws://x").openThenClose();
    },
  });
  const seen: { attempts: number }[] = [];
  await l.watchCdp(9222, (d) => { seen.push(d); });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seen.length, 1, "lost 통지가 없거나 중복됐다");
  assert.equal(seen[0].attempts, 2, "시도 횟수가 §4.4 표(2회)와 다르다");
  assert.equal(made, 3, "최초 1회 + 재연결 2회여야 한다");
  assert.equal(l.cdp, "lost");
});

test("S4: 재연결 횟수를 늘리면 그만큼 더 시도한다 — 기본값이 조용히 0 이 아니다", async () => {
  let made = 0;
  const l = new BrowserLauncher(base, {
    fetchImpl: fakeCdpFetch(),
    cdpRetryDelayMs: 1,
    cdpRetryAttempts: 4,
    wsFactory: () => {
      made++;
      return new FakeCdp("ws://x").openThenClose();
    },
  });
  const seen: number[] = [];
  await l.watchCdp(9222, (d) => { seen.push(d.attempts); });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(seen, [4]);
  assert.equal(made, 5);
});

test("S4: 소켓이 아예 없으면(바이너리 없음) lost 가 아니라 '감시 못 함'", async () => {
  const l = new BrowserLauncher(base, {
    fetchImpl: (async () => ({ ok: false }) as Response) as unknown as typeof fetch,
  });
  const ok = await l.watchCdp(9222, () => undefined);
  assert.equal(ok, false, "붙지 못한 것과 소실된 것을 구분해야 한다");
  assert.equal(l.cdp, "none", "붙기 전인데 lost 로 기록하면 S4 가 조용히 발동한다");
});

test("설치된 브라우저를 찾는다 (기본 exists 구현 — access 성공을 '없음' 으로 읽지 않는다)", async () => {
  // 실제로 이 머신에 /usr/bin/google-chrome 이 있다. 없으면 통과시키지 않는다.
  const found = await new BrowserLauncher(base).resolveBinary();
  assert.ok(found, "브라우저 바이너리를 찾지 못했다 — 기본 exists 구현이 성공을 실패로 보나?");
  assert.ok(found!.endsWith("google-chrome") || found!.endsWith("chromium"), found!);
});

test("탐지 순서가 §4.1 과 같다", () => {
  assert.deepEqual(CHROME_CANDIDATES, [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]);
});

test("CHROME_BIN 이 최우선이다", async () => {
  const prev = process.env.CHROME_BIN;
  process.env.CHROME_BIN = "/custom/chrome";
  try {
    const found = await new BrowserLauncher(base, { exists: async (p) => p === "/custom/chrome" }).resolveBinary();
    assert.equal(found, "/custom/chrome");
  } finally {
    if (prev === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = prev;
  }
});

test("브라우저가 없으면 예외가 아니라 ok:false 결과를 낸다 — 데몬은 사람이 보지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-nobin-"));
  try {
    const l = new BrowserLauncher({ ...base, userDataDir: dir }, { exists: async () => false });
    const res = await l.launch();
    assert.equal(res.flags.length, 0, "플래그가 없는데 스폰된 것처럼 보인다");
    assert.equal(res.attached, false);
    assert.equal(res.verification, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GPU 검증 판정: off 모드는 glRenderer=Disabled 여야 통과", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-gpuver-"));
  try {
    const fakeFetch = (gpu: Record<string, unknown>): typeof fetch =>
      (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes("/json/version")) {
          return {
            ok: true,
            json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/x" }),
          } as Response;
        }
        throw new Error(`unexpected ${u}`);
      }) as unknown as typeof fetch;

    // CDP 소켓은 실제로 연결되지 못하므로 null 이 온다 → '판정 실패' 로 표현되어야 한다
    const l = new BrowserLauncher({ ...base, userDataDir: dir }, { fetchImpl: fakeFetch({}) });
    const v = await l.verifyGpu(9222);
    assert.equal(v.ok, false, "판정 불가가 통과로 나갔다");
    assert.ok(v.detail.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
