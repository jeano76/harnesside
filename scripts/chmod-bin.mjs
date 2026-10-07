#!/usr/bin/env node
/**
 * package.json 의 `bin` 대상에 실행 권한(+x)을 부여한다.
 *
 * 왜 필요한가: `tsc` 는 산출물을 umask 기본값(0644/0664)으로 쓴다 — 실행 비트가
 * 없다. npm 은 레지스트리/tarball 설치 때 bin 대상을 chmod 해 주지만, 로컬 빌드
 * 결과를 그대로 복사·링크해 쓰면 `bin/harnesside: 허가 거부` 가 난다.
 * 빌드 단계에서 직접 박아 두면 설치 경로와 무관하게 항상 실행 가능하다.
 */
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});

for (const rel of Object.values(bin)) {
  const p = resolve(root, rel);
  if (!existsSync(p)) {
    console.error(`chmod-bin: ${rel} 없음 (빌드 먼저)`);
    process.exit(1);
  }
  chmodSync(p, statSync(p).mode | 0o111);
}
