/**
 * 실제 다운로드 테스트 (§7.4) — **진짜 HTTP 서버** 를 세워서 받는다.
 *
 * 가짜 fetch 로만 검사하면 "중단 후 재개" 를 검증할 수 없다. 재개는 파일에 이미
 * 얼마나 썼는지가 **서버에 전달되어야** 성립하기 때문이다. 그래서 127.0.0.1 에 작은
 * HTTP 서버를 띄우고 실제로 받는다(외부 네트워크 없음).
 *
 * 검사하는 것:
 *  1. 전체를 받고 완료 처리된다
 *  2. **중간에 끊으면 `.part` 가 남고**, 이어받으면 **같은 내용** 이 된다
 *  3. Range 를 무시하는 서버(200 + 전체) 에서는 **이어붙이지 않고 새로 쓴다**
 *  4. 크기를 모르면 진행률을 지어내지 않는다
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelDownloader, progressText, modelPathFor } from "./download.js";
import { newDownload, startDownload } from "./manage.js";

const BODY = Buffer.from("가".repeat(64 * 1024)); // 64 KiB

/** Range 를 지원하는 작은 서버. `ignoreRange` 로 200-전체 응답을 흉내 낸다. */
async function serve(opts: { ignoreRange?: boolean; cutAfter?: number } = {}): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.headers.range ?? "-");
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": String(BODY.length) });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (range && !opts.ignoreRange) {
      const m = /bytes=(\d+)-/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const chunk = BODY.subarray(start);
      res.writeHead(206, { "content-length": String(chunk.length), "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
      if (opts.cutAfter !== undefined) {
        // 일부만 보내고 끝낸다 = 실제 중단. 연결을 `destroy()` 로 죽이면 **클라이언트가 한
        // 바이트도 못 받을 수 있다**(실측: 파일이 아예 안 생겼다). content-length 를 크게
        // 선언하고 짧게 끝내야 "전송 중 끊김" 이 재현된다.
        res.writeHead(206, { "content-length": String(chunk.length), "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
        res.end(chunk.subarray(0, opts.cutAfter));
        return;
      }
      res.end(chunk);
      return;
    }
    res.writeHead(200, { "content-length": String(BODY.length) });
    if (opts.cutAfter !== undefined) {
      res.end(BODY.subarray(0, opts.cutAfter));
      return;
    }
    res.end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/model.gguf`, server, hits };
}

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "harnesside-dl-"));
  return { dir, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

test("전체를 받고 **완료** 처리된다 — 파일 내용도 일치", async () => {
  const s = await sandbox();
  const { url, server } = await serve();
  try {
    const d = new ModelDownloader();
    const dest = join(s.dir, "model.gguf");
    const item = await d.download({ id: "a", url, destPath: dest });
    assert.equal(item.state, "done", `상태가 ${item.state} — 실패: ${item.error}`);
    assert.equal(item.progress, 100);
    assert.equal((await readFile(dest)).length, BODY.length);
    assert.deepEqual((await readFile(dest)).subarray(0, 8), BODY.subarray(0, 8));
  } finally {
    server.close();
    await s.cleanup();
  }
});

test("중단되면 **`.part` 가 남고**, 이어받으면 같은 내용이 된다", async () => {
  const s = await sandbox();
  // 첫 요청은 8KiB 만 보내고 끊는다.
  const first = await serve({ cutAfter: 8192 });
  const dest = join(s.dir, "model.gguf");
  try {
    const d1 = new ModelDownloader();
    const failed = await d1.download({ id: "b", url: first.url, destPath: dest });
    assert.equal(failed.state, "failed", "중단인데 성공으로 기록됐다");
    const part = `${dest}.part`;
    const st = await stat(part);
    assert.ok(st.size > 0, "`.part` 가 없다 — 재개할 지점이 사라졌다");
    assert.ok(st.size < BODY.length, "전부 받아졌다면 중단이 아니다");
  } finally {
    first.server.close();
  }

  // 두 번째 서버는 Range 를 정상 처리한다. **같은 URL 이어야** 재개가 의미를 가진다.
  const second = await serve();
  try {
    const d2 = new ModelDownloader();
    const done = await d2.download({ id: "b", url: second.url, destPath: dest });
    assert.equal(done.state, "done", `재개 실패: ${done.error}`);
    const got = await readFile(dest);
    assert.equal(got.length, BODY.length, `길이 ${got.length} — 이어붙이기가 잘못됐다`);
    assert.ok(got.equals(BODY), "이어붙인 내용이 원본과 다르다 — 경계가 어긋났다");
    assert.ok(second.hits.some((h) => h.startsWith("bytes=")), `Range 요청이 없었다: ${second.hits.join(",")}`);
  } finally {
    second.server.close();
    await s.cleanup();
  }
});

test("Range 를 **무시하는 서버**에서는 이어붙이지 않고 새로 쓴다 — 뒤섞이면 파일이 깨진다", async () => {
  const s = await sandbox();
  const { url, server } = await serve({ ignoreRange: true });
  const dest = join(s.dir, "model.gguf");
  try {
    await writeFile(`${dest}.part`, "이전 절반".repeat(100));
    const d = new ModelDownloader();
    const item = await d.download({ id: "c", url, destPath: dest });
    assert.equal(item.state, "done", item.error ?? "");
    const got = await readFile(dest);
    assert.ok(got.equals(BODY), "옛 조각이 앞에 붙었다 — 파일이 깨진다");
  } finally {
    server.close();
    await s.cleanup();
  }
});

test("크기를 모르면 **진행률을 지어내지 않는다**", () => {
  const d = new ModelDownloader();
  const item = startDownload(newDownload("x", "f", 0, Date.now()));
  assert.equal(item.progress, 0, "모르는 크기에 퍼센트를 만들었다");
  assert.match(progressText(item), /크기 미상|진행률 계산 불가/, "모른다고 말하지 않는다");
  assert.equal(d.get("x"), undefined, "없는 항목을 지어냈다");
});

test("HTTP 실패는 **오류로** 남는다 — 조용히 성공하면 없는 파일이 생긴다", async () => {
  const s = await sandbox();
  try {
    const d = new ModelDownloader({
      fetchImpl: (async () => ({ ok: false, status: 404, statusText: "Not Found" }) as unknown as Response) as unknown as typeof fetch,
    });
    const item = await d.download({ id: "d", url: "http://127.0.0.1:1/x.gguf", destPath: join(s.dir, "x.gguf") });
    assert.equal(item.state, "failed");
    assert.match(String(item.error), /404/);
  } finally {
    await s.cleanup();
  }
});

test("경로는 `join` 으로 만든다 — 파일명만 떼어 쓰면 경로가 조각난다", () => {
  assert.equal(modelPathFor("/models", "repo/Model-Q4_K_M.gguf"), "/models/Model-Q4_K_M.gguf");
});
