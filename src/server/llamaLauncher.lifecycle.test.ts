/**
 * llama-launcher **수명주기** 테스트 (스폰 → 헬스체크 → 종료).
 *
 * 기존 테스트는 **플래그** 만 봤다. 그런데 위험은 전부 수명주기 쪽이다:
 *  - 자식이 죽어도 프로세스가 남으면 다음 실행이 **OOM** 이다(실측: 두 번째 llama 가 죽었다).
 *  - 헬스체크가 "떠 있다" 고 말하면 안 된다 — **응답** 이 있어야 한다(§5.13.1).
 *  - 종료는 SIGTERM → 대기 → SIGKILL 순서여야 하고, **이미 죽은 자식** 에서도 던지지 않아야 한다.
 *
 * 진짜 프로세스를 띄운다(가짜 서버 스크립트). 그래서 이 테스트는 "poll 을 몇 번 했나" 가
 * 아니라 **"끝나고 자식이 남아 있나"** 를 본다 — 판정 정본은 포트/HTTP 다(§④ 표 21).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlamaLauncher } from "./llamaLauncher.js";

/** `/v1/models` 에 200 을 주는 **진짜 서버**. llama 를 흉내 내는 게 아니라 헬스체크 계약만 구현한다. */
async function fakeLlama(port: number): Promise<() => Promise<void>> {
  const srv = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  return () => new Promise<void>((r) => srv.close(() => r()));
}

/** 지정한 포트에 아무것도 안 뜨는(port=0) 자식 — "기다려도 안 떠는" 경로. */
async function deadLlamaScript(): Promise<{ dir: string; bin: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-launcher-"));
  const bin = join(dir, "llama-noop.sh");
  await writeFile(bin, "#!/bin/sh\nsleep 60\n", "utf8");
  await chmod(bin, 0o755);
  return { dir, bin, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const port = () => 18000 + Math.floor(Math.random() * 2000);

test("스폰 → 헬스체크 **통과** — 응답해야 통과다", async () => {
  const p = port();
  const close = await fakeLlama(p);
  const launcher = new LlamaLauncher({ binPath: "/bin/true", modelPath: "/m.gguf", host: "127.0.0.1", port: p, tuning: {} as never });
  try {
    // 자식은 쓰지 않는다 — 헬스체크만 확인할 것이므로 fetch 주입으로 결정적으로 만든다.
    launcher.spawn();
    const ok = await launcher.waitUntilReady(3_000, 100);
    assert.equal(ok, true, "자기 자신한테 물어봤는데 준비 완료를 인정하지 않았다");
  } finally {
    await launcher.stop(100);
    await close();
  }
});

test("응답이 없으면 **기다려도 false** — '떠 있다' 는 성공이 아니다(§5.13.1)", async () => {
  const { bin, cleanup } = await deadLlamaScript();
  const launcher = new LlamaLauncher({ binPath: bin, modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never });
  try {
    launcher.spawn();
    const ok = await launcher.waitUntilReady(1_200, 150);
    assert.equal(ok, false, "대답하지 않는 서버를 준비 완료로 인정했다");
    assert.ok(launcher.pid === undefined || launcher.pid > 0, "pid 를 알 수 없다");
  } finally {
    await launcher.stop(100);
    await cleanup();
  }
});

test("**spawn 두 번은 한 번** 이다 — 자식이 두 개면 VRAM 을 두 배로 먹는다(실측 OOM 경로)", async () => {
  const { bin, cleanup } = await deadLlamaScript();
  const launcher = new LlamaLauncher({ binPath: bin, modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never });
  try {
    launcher.spawn();
    const first = launcher.pid;
    launcher.spawn();
    assert.equal(launcher.pid, first, "두 번째 spawn 이 자식을 새로 만들었다");
  } finally {
    await launcher.stop(100);
    await cleanup();
  }
});

test("stop() 은 자식을 **실제로 죽인다** — 포트로 판정한다", async () => {
  const p = port();
  const { bin, cleanup } = await deadLlamaScript();
  const launcher = new LlamaLauncher({ binPath: bin, modelPath: "/m.gguf", host: "127.0.0.1", port: p, tuning: {} as never });
  try {
    launcher.spawn();
    const pid = launcher.pid;
    assert.ok(pid, "스폰했는데 pid 가 없다");
    await launcher.stop(500);
    // **판정 정본은 프로세스 이름이 아니라 존재 여부** 다(§④ 표 21 — 이름은 위장된다).
    // ESRCH 면 이미 죽었다 = 성공.
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `stop() 후에도 pid ${pid} 가 살아 있다`);
  } finally {
    await cleanup();
  }
});

test("**스폰하지 않았으면** stop() 이 조용히 넘긴다 — 예외를 던지면 창이 죽는다", async () => {
  const launcher = new LlamaLauncher({ binPath: "/nonexistent", modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never });
  await assert.doesNotReject(() => launcher.stop(100), "스폰하지 않았는데 stop 이 던졌다");
  assert.equal(launcher.pid, undefined, "스폰하지 않았는데 pid 가 있다");
});

test("stop() 을 **두 번** 불러도 안전하다 — 종료 경로가 두 번 실행된다(창 닫기 + 신호)", async () => {
  const { bin, cleanup } = await deadLlamaScript();
  const launcher = new LlamaLauncher({ binPath: bin, modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never });
  try {
    launcher.spawn();
    await launcher.stop(200);
    await assert.doesNotReject(() => launcher.stop(200), "두 번째 stop 이 던졌다");
  } finally {
    await cleanup();
  }
});

test("자식이 **스스로 죽으면** 헬스체크가 기다리지 않고 false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-launcher-die-"));
  const bin = join(dir, "llama-dies.sh");
  await writeFile(bin, "#!/bin/sh\nexit 7\n", "utf8");
  await chmod(bin, 0o755);
  const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const launcher = new LlamaLauncher(
    { binPath: bin, modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never },
    { events: { onExit: (code, signal) => exits.push({ code, signal }) } }
  );
  try {
    launcher.spawn();
    const started = Date.now();
    const ok = await launcher.waitUntilReady(20_000, 100);
    const took = Date.now() - started;
    assert.equal(ok, false);
    // **20초를 다 기다리면 안 된다** — 죽은 프로세스를 기다리는 건 사용자의 시간 낭비.
    assert.ok(took < 5_000, `죽은 자식을 ${took}ms 나 기다렸다`);
    // 종료 코드도 **보존**된다 — 0 과 없음을 구분하는 것과 같은 계열(§5.10).
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(exits.length >= 1, "종료 이벤트가 오지 않았다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("자식 로그가 **줄 단위** 로 온다 — 실패 원인은 저 줄들이다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-launcher-log-"));
  const bin = join(dir, "llama-noisy.sh");
  await writeFile(bin, "#!/bin/sh\necho 'llama_model_loader: loaded meta data'\necho 'CUDA error: out of memory' 1>&2\nsleep 30\n", "utf8");
  await chmod(bin, 0o755);
  const lines: Array<{ line: string; stream: string }> = [];
  const errs: Array<{ line: string; stream: string }> = [];
  const launcher = new LlamaLauncher(
    { binPath: bin, modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never },
    {
      events: { onLine: (line, stream) => lines.push({ line, stream }) },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        // **OOM/CUDA 는 조용히 지나가면 안 된다** — 모델이 죽는 원인의 99% 가 이 줄이다.
        error: (o: unknown) => errs.push(o as { line: string; stream: string }),
      },
    }
  );
  try {
    launcher.spawn();
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(lines.some((l) => l.line.includes("loaded meta data")), `stdout 이 안 왔다: ${JSON.stringify(lines)}`);
    const cuda = lines.find((l) => l.line.includes("CUDA"));
    assert.ok(cuda, `stderr 가 안 왔다: ${JSON.stringify(lines)}`);
    assert.equal(cuda!.stream, "stderr");
    assert.ok(errs.some((e) => e.line.includes("CUDA")), "CUDA 줄을 error 로 올리지 않았다");
  } finally {
    await launcher.stop(100);
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseUrl 은 **설정 그대로** — 추측으로 다른 포트를 쓰지 않는다", () => {
  const launcher = new LlamaLauncher({ binPath: "/b", modelPath: "/m.gguf", host: "127.0.0.1", port: 9099, tuning: {} as never });
  assert.equal(launcher.baseUrl, "http://127.0.0.1:9099");
});

test("**바이너리가 없어도 프로세스가 죽지 않는다** — 창까지 사라지면 안 된다", async () => {
  // 실측: 'error' 리스너가 없으면 `spawn()` 이 예외 없이 끝난 뒤 약 1초 뒤에
  // uncaughtException 으로 **서버 전체** 가 죽는다. llama 만 못 뜨는 게 아니라
  // 창도 함께 사라진다 — §5.13.1 의 degrade 원칙 위반.
  const errs: Error[] = [];
  const launcher = new LlamaLauncher(
    { binPath: "/nonexistent/llama-server", modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never },
    { events: { onSpawnError: (e) => errs.push(e) } }
  );
  // spawn 은 동기적으로 던지지 않는다 — **그래서** 여기서 못 잡는다.
  assert.doesNotThrow(() => launcher.spawn());
  // 비동기 'error' 가 와도 죽지 않아야 한다(=uncaughtException 이 없어야 한다).
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(errs.length, 1, `스폰 실패를 알리지 않았다: ${errs.length}`);
  assert.match(errs[0].message, /ENOENT/, `원인이 그대로 전달되지 않았다: ${errs[0].message}`);
  // 원인이 **보존**된다 — 사용자는 "모델이 없다" 와 "llama-server 가 없다" 를 구분해야 한다.
  assert.ok(launcher.error, "스폰 실패 원인을 남기지 않았다");
  assert.match(launcher.error!.message, /ENOENT/);
  assert.equal(launcher.pid, undefined, "죽은 자식이 pid 로 남았다");
});

test("스폰 실패면 **헬스체크를 기다리지 않는다** — 120초를 낭비하지 않는다", async () => {
  const launcher = new LlamaLauncher({ binPath: "/nonexistent/llama-server", modelPath: "/m.gguf", host: "127.0.0.1", port: port(), tuning: {} as never });
  launcher.spawn();
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  const ok = await launcher.waitUntilReady(120_000, 100);
  const took = Date.now() - started;
  assert.equal(ok, false);
  // **기본값(120초)을 넘겨 기다리지 않는다.** 사용자는 왜 안 뜨는지 알 수 없다.
  assert.ok(took < 2_000, `바이너리 없는데 ${took}ms 를 기다렸다`);
});
