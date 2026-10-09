/**
 * 데몬 명령계 테스트 (§3.7.4 · §10.2).
 *
 * "TTY 가 없어도 같은 결과" 를 검증한다 — 사람이 보든 CI 가 보든 출력이 같아야
 * "되네"를 근거로 판단할 수 있다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPaths,
  collectStatus,
  formatStatus,
  formatBytes,
  writeInstance,
  clearInstance,
  announcePortFile,
  readInstance,
  ensureSingleInstance,
  isAlive,
  parseLogArgs,
  readLogFile,
  initDaemonLogging,
  type Paths,
} from "./daemon.js";
import { parseArgs } from "./cli.js";
import { resetLogRing } from "./logRing.js";

async function sandbox(): Promise<{ paths: Paths; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-daemon-"));
  const paths = defaultPaths(dir, dir);
  await import("node:fs/promises").then((fs) => fs.mkdir(paths.stateDir, { recursive: true }));
  return { paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("기본 경로가 프로젝트/홈 계층을 지킨다 (§6.4)", async () => {
  const s = await sandbox();
  try {
    assert.equal(s.paths.stateDir, join(s.paths.projectRoot, ".harnesside", "state"));
    assert.equal(s.paths.logFile.endsWith("server.ndjson"), true);
    assert.equal(s.paths.instanceLock.endsWith("instance.lock"), true);
  } finally {
    await s.cleanup();
  }
});

test("상태 파일에 실행 정보를 남기고, 읽어올 수 있다", async () => {
  const s = await sandbox();
  try {
    await writeInstance(s.paths, {
      pid: process.pid,
      mode: "daemon",
      startedAt: new Date().toISOString(),
      llamaPort: 8080,
      idePort: 7317,
      gpuMode: "off",
    });
    const rec = await readInstance(s.paths);
    assert.equal(rec?.pid, process.pid);
    assert.equal(rec?.mode, "daemon");
    assert.equal(rec?.llamaPort, 8080);
    assert.equal(rec?.gpuMode, "off");
  } finally {
    await s.cleanup();
  }
});

test("감시기 포트 알림: 경로가 있으면 포트를 적고, 없으면 조용히 false", async () => {
  const s = await sandbox();
  try {
    const p = join(s.paths.stateDir, "sv.port");
    assert.equal(await announcePortFile(p, 7317), true);
    assert.equal(await readFile(p, "utf8"), "7317\n");
    assert.equal(await announcePortFile(undefined, 7317), false, "경로 없이 성공이라 했다");
    assert.equal(
      await announcePortFile(join(s.paths.stateDir, "no-such-dir", "sv.port"), 7317),
      false,
      "쓸 수 없는 경로인데 성공이라 했다"
    );
  } finally {
    await s.cleanup();
  }
});

test("단일 인스턴스: 살아 있으면 거부, 죽었으면 고아 락을 정리하고 통과", async () => {
  const s = await sandbox();
  try {
    await writeInstance(s.paths, { pid: process.pid, mode: "window", startedAt: new Date().toISOString() });
    const r1 = await ensureSingleInstance(s.paths);
    assert.equal(r1.ok, false, "살아 있는 인스턴스가 있는데 통과했다");
    assert.equal(!r1.ok && r1.running.pid, process.pid);

    // 죽은 PID 로 교체 → 고아 락으로 보고 정리해야 한다
    await writeFile(s.paths.instanceLock, "999999\n2026-01-01T00:00:00.000Z\n{}\n");
    const r2 = await ensureSingleInstance(s.paths);
    assert.equal(r2.ok, true, "고아 락을 정리하지 않았다");
  } finally {
    await s.cleanup();
  }
});

test("status 는 서버가 없어도 동작하고, 사람이 읽는 문장을 준다 (§11.3)", async () => {
  const s = await sandbox();
  try {
    const st = await collectStatus(s.paths);
    assert.equal(st.running, false);
    const text = formatStatus(st);
    assert.match(text, /실행 중이 아님/);
    assert.match(text, /500,000자/, "로그 상한이 보인다 — '얼마나 더 쌓이냐' 에 대한 답");
    assert.equal(/Error|undefined|NaN/.test(text), false, `사람이 읽을 수 없는 내용이 있다: ${text}`);
  } finally {
    await s.cleanup();
  }
});

test("status 에 로그 상한이 노출된다 — 사용자가 조정할 수 있어야 한다", async () => {
  const s = await sandbox();
  try {
    const st = await collectStatus(s.paths);
    assert.equal(st.logLimits.maxChars, 500_000);
    assert.equal(st.logLimits.maxLines, 50_000);
    assert.match(formatStatus(st), /500,000자 \/ 50,000줄/);
  } finally {
    await s.cleanup();
  }
});

test("로그 파일이 없으면 0 이 아니라 '없음' — 빈 파일과 구분된다", async () => {
  const s = await sandbox();
  try {
    const st = await collectStatus(s.paths);
    assert.equal(st.logBytes, undefined, "없는 파일을 0 바이트로 말하면 '빈 로그' 와 구분되지 않는다");
  } finally {
    await s.cleanup();
  }
});

test("바이트 표시가 읽기 가능하다", () => {
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(2048), "2.0KiB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0MiB");
});

test("인자 파싱: 명령·플래그·옵션", () => {
  const a = parseArgs(["up", "-d"]);
  assert.equal(a.command, "up");
  assert.equal(a.flags.has("-d"), true);
  const b = parseArgs(["status", "--json"]);
  assert.equal(b.command, "status");
  assert.equal(b.json, true);
  // 알 수 없는 첫 인자도 up 으로 본다(플래그일 수 있으므로)
  const c = parseArgs(["--no-browser"]);
  assert.equal(c.command, "up");
});

test("logs 옵션 파싱", () => {
  const o = parseLogArgs(["-f", "--level=error", "--limit=50", "--since=2026-01-01"]);
  assert.equal(o.follow, true);
  assert.equal(o.level, "error");
  assert.equal(o.limit, 50);
  assert.equal(o.since, "2026-01-01");
});

test("데몬 로깅은 NDJSON 으로 파일에 쌓인다", async () => {
  const s = await sandbox();
  resetLogRing();
  try {
    const { ring, close } = initDaemonLogging(s.paths);
    ring.info("server", "부팅 시작");
    ring.error("llama", "cudaMalloc failed: out of memory", "llama", { mb: 1476 });
    close();
    const lines = await readLogFile(s.paths);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /"source":"llama"/);
    assert.match(lines[1], /out of memory/);
  } finally {
    resetLogRing();
    await s.cleanup();
  }
});

test("isAlive 은 자기 자신에게 참, 존재하지 않는 PID 에 거짓", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0x7fffffff), false);
});

test("clearInstance 는 파일이 없어도 예외를 던지지 않는다", async () => {
  const s = await sandbox();
  try {
    await assert.doesNotReject(() => clearInstance(s.paths));
  } finally {
    await s.cleanup();
  }
});
