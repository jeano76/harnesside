/**
 * BrowserLauncher 유닛 테스트 (§10.2).
 *
 * 특히 `resolveBinary` 를 검증한다 — 실제로 이 버그가 있었다: 기본 `exists` 구현이
 * `access()` 의 성공(undefined)을 "없음" 으로 읽어, 설치돼 있는 Chrome 을 못 찾았다.
 * "설치 안 됨" 경로를 테스트하지 않으면 이 类의 버그는 창이 안 뜨는 것으로만 드러난다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BrowserLauncher, CHROME_CANDIDATES } from "./browserLauncher.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = { mode: "off" as const, appUrl: "http://127.0.0.1:7317/?t=T", userDataDir: "/tmp/p" };

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
