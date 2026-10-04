import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableExists } from "./fsUtil.js";

// Q-1 로 옮겨 온 파일마다 테스트 1개 이상(PROMPT_QUALITY_PRODUCT.md Q-1 검증) — 이 파일은 원본에 테스트가 없었다.
test("executableExists — 실행 권한이 있을 때만 true, 없는 경로·실행 불가는 false", { skip: process.platform === "win32" && "X_OK 의미가 다르다" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hs-fsutil-"));
  const exe = join(dir, "run.sh");
  const plain = join(dir, "data.txt");
  await writeFile(exe, "#!/bin/sh\n");
  await chmod(exe, 0o755);
  await writeFile(plain, "x");
  await chmod(plain, 0o644);
  assert.equal(await executableExists(exe), true);
  assert.equal(await executableExists(plain), false);
  assert.equal(await executableExists(join(dir, "없음")), false);
});
