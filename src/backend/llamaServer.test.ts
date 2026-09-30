/**
 * `LlamaServerManager` 테스트 — **레거시 TUI 가 실제로 쓰는** 스포너.
 *
 * 이 클래스는 새 `LlamaLauncher` 로 대체됐지만 `src/legacy-tui/` 가 아직 쓴다. 그래서
 * "옛 코드" 라고 테스트를 빼면 **실제로 돌아가는 경로** 가 검사 밖에 남는다.
 *
 * 커버리지 표가 35% 라고 지적한 대로, 테스트가 없던 동안 실제로 버그가 있었다:
 * `'error'` 리스너가 없어서 **바이너리 경로가 틀리면 프로세스 전체가 죽었다**(실측).
 * Node 는 ENOENT 를 동기 throw 가 아니라 비동기 이벤트로 보낸다 — 그래서 "spawn 이
 * 예외를 던지지 않았다" 는 사실이 **성공의 증거처럼 보이지만** 1초 뒤에 터진다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_8GB_PROFILE, LlamaServerManager, type LlamaServerConfig } from "./llamaServer.js";

/** 기본 프로파일 위에 **일부만** 덮는다. 빠진 필드를 직접 적으면 정본과 어긋난다. */
const cfg = (over: Partial<LlamaServerConfig> = {}): LlamaServerConfig => ({
  binPath: "/bin/true",
  modelPath: "/m.gguf",
  ...DEFAULT_8GB_PROFILE,
  ...over,
});

test("8GB 프로파일은 **보수적** 다 — 과도한 ctx 는 OOM 의 원인이다", () => {
  assert.equal(DEFAULT_8GB_PROFILE.contextSize, 8192);
  assert.equal(DEFAULT_8GB_PROFILE.gpuLayers, 0, "GPU 를 모르는 상태에서 GPU 레이어를 잡으면 안 된다");
  assert.equal(DEFAULT_8GB_PROFILE.host, "127.0.0.1", "바깥에 열면 다른 기기가 붙는다");
});

test("baseUrl 은 **설정 그대로** — 추측으로 포트를 바꾸지 않는다", () => {
  const m = new LlamaServerManager(cfg({ host: "127.0.0.1", port: 8123 }));
  assert.equal(m.baseUrl, "http://127.0.0.1:8123");
});

test("**바이너리가 없으면 예외가 아니라 원인** — 그리고 사람이 읽는 문장으로 말한다", async () => {
  const m = new LlamaServerManager(cfg({ binPath: "/nonexistent/llama-server" }));
  // spawn 자체는 동기적으로 던지지 않는다(그래서 이 테스트가 필요하다).
  await assert.rejects(
    () => m.start(),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      // **내부 영어 문자열이 아니라 원인이 보이는 문장** 이어야 한다(§11.3).
      assert.match(e.message, /llama-server 실행에 실패했습니다/);
      assert.match(e.message, /ENOENT/, `원인이 남지 않았다: ${e.message}`);
      return true;
    }
  );
  assert.ok(m.error, "원인을 보존하지 않았다");
  assert.equal(m.error!.message.includes("ENOENT"), true);
});

test("**프로세스가 죽지 않는다** — uncaughtException 이 나면 TUI 가 함께 사라진다", async () => {
  // 실측 핵심: 리스너가 없으면 `start()` 이 정상 반환된 뒤 약 1초 뒤 uncaughtException.
  // 여기서 터지지 않는지 확인하는 게 이 테스트의 존재 이유다.
  let uncaught: Error | null = null;
  const onUncaught = (e: Error) => {
    uncaught = e;
  };
  process.on("uncaughtException", onUncaught);
  try {
    const m = new LlamaServerManager(cfg({ binPath: "/nonexistent/llama-server" }));
    await m.start().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(uncaught, null, `프로세스가 죽었다: ${(uncaught as Error | null)?.message}`);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("준비되면 **그대로 지나간다** — 살아 있는 서버를 세지 않는다", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/v1/models") return void res.writeHead(200).end(JSON.stringify({ data: [] }));
    res.writeHead(404).end();
  });
  const port = 19000 + Math.floor(Math.random() * 500);
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  const m = new LlamaServerManager(cfg({ port }));
  try {
    // binPath 는 진짜 서버를 쓰지 않는다(헬스체크는 HTTP 이므로).
    await m.start();
    assert.equal(m.error, null, "성공했는데 실패 원인이 남았다");
    // client() 가 같은 주소를 쓴다 — 별도 클라이언트를 만들지 않는다.
    assert.ok(m.client());
  } finally {
    m.stop();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("**기다리다 포기하면** 사람이 읽는 문장 — 내부 영어 문자열이 아니라", async () => {
  // 아무것도 안 뜨는 포트에서 기다리면 시간 초과가 난다. 기본 30초는 테스트에
  // 너무 길기 때문에 **타이머를 건드리지 않고** 문장만 확인한다.
  const m = new LlamaServerManager(cfg({ port: 9 }));
  const started = Date.now();
  await assert.rejects(
    () => m.start(),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /llama-server|준비되지 않았습니다/);
      // **내부 영어 문구를 그대로 노출하지 않는다.**
      assert.doesNotMatch(e.message, /did not become ready within timeout/);
      return true;
    }
  );
  assert.ok(Date.now() - started < 40_000, "시간 초과가 지나치게 길다");
});

test("stop() 은 **스폰하지 않았어도** 안전하다", () => {
  const m = new LlamaServerManager(cfg());
  assert.doesNotThrow(() => m.stop(), "스폰하지 않았는데 stop 이 던졌다");
});

test("`attachExisting` 은 **주소만** 쓴다 — 프로세스를 만들지 않는다", () => {
  const c = LlamaServerManager.attachExisting("http://127.0.0.1:8080");
  assert.ok(c, "클라이언트가 없다");
});
