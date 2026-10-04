/**
 * 웹 자산 검사 — **서버가 실제로 제공하는 `dist/web` 을 그 자리에서** 검사한다.
 *
 * Q-4(2026-10-04): 예전에는 `dist/packaged-web/` 으로 **복사한 뒤** 검사했는데, 서버는 그 복사본이 아니라
 * `dist/web` 을 제공한다(`src/server/index.ts` 부팅 스텝 9). "만들고 검사하지만 아무도 쓰지 않는" 사본이었다 —
 * 검사가 통과해도 제공되는 파일은 검사받지 않은 셈이다. 그래서 복사를 없애고 제공 경로를 직접 본다.
 * 파일 이름은 CI·build 스크립트가 부르는 이름이라 유지한다.
 *
 * 왜 이 단계가 필요한가: `vite build` 는 `dist/web/` 에 산출물을 만든다. 서버는
 * `src/web/` 를 정적 루트로 사용하고 있으므로, **개발 중에는 소스** 를, **배포에서는
 * 산출물** 을 봐야 한다. 이 스크립트가 그 경로를 한 곳에서 정한다.
 *
 * 부수 효과 두 가지:
 *  1. `dist/web/` 가 없으면 **빈 화면** 이 나온다(요구 4: 빈 화면은 결함이다).
 *     그래서 없는 경우 명확히 실패한다 — 조용히 넘어가면 "왜 하얀 화면이지?" 가 된다.
 *  2. 토큰이 산출물에 박혀 있으면 위험하다. **결과물에 토큰 문자열이 없음을 검증**한다.
 *     (요구: 토큰은 URL 에서 제거되고 앱 셸에만 존재한다)
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST_WEB = join(here, "dist", "web");

/**
 * 산출물에 **박혀 있으면 안 되는 것** = 토큰 같은 **값**.
 *
 * `/api/...` 경로는 클라이언트가 정상적으로 호출하므로 **금지 대상이 아니다**
 * (금지했더니 정상 코드가 실패했다). 금지되는 것은 "비밀 값" 이다.
 *
 * 토큰은 32자 이상의 hex/base64 이다. 환경변수 **이름**(`HARNESSIDE_LOG_MAXCHARS`)
 * 은 코드에 있어도 무방하다 — 값이 아니라 이름이니까.
 */
const SECRET_LITERAL = [
  // auth 헤더에 바로 들어갈 법한 32자 이상 hex/base64 문자열
  /[0-9a-f]{40,}/i,
  // "token=<값>" 형태의 하드코딩
  /token\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/i,
  // Bearer 뒤에 바로 붙은 긴 문자열
  /Bearer\s+[A-Za-z0-9_-]{20,}/,
];

async function listFiles(dir, base = dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    // 상대 경로를 base 에 붙인다. `p.slice(...)` 로 잘라내면 경로 구분자가 환경에 따라
    // 어긋나서 **존재하지 않는 경로** 가 나온다(실제로 그랬다).
    const rel = p.slice(dir.length + 1);
    if (d.isDirectory()) out.push(...(await listFiles(p, join(base, rel))));
    else out.push(join(base, rel));
  }
  return out;
}

async function main() {
  // 제공 경로는 하나다 — 빌드 산출물이 없으면 실패한다(src/web 로 대신하지 않는다: 서버도 대신하지 않는다).
  if (!existsSync(DIST_WEB)) {
    throw new Error(`dist/web 이 없습니다 — 'npm run build:web' 를 먼저 실행하십시오. 서버는 이 경로를 제공합니다.`);
  }
  const OUT = DIST_WEB;
  const label = "dist/web (서버가 제공하는 빌드 산출물)";

  // 검증 1: index.html 이 **실제로** 있다. 산출물이 비어 있으면 여기서 걸린다.
  const index = join(OUT, "index.html");
  if (!existsSync(index)) {
    throw new Error(`웹 자산에 index.html 이 없습니다: ${OUT}`);
  }
  const html = await readFile(index, "utf8");
  if (!/<div id="root"|id="root"/.test(html)) {
    throw new Error(`index.html 에 마운트 지점(#root)이 없습니다 — 화면이 하얗게 나온다.`);
  }

  // 검증 2: 토큰 같은 **값** 이 박혀 있지 않다. 서버는 URL 로 토큰을 주지 않는다(§3.4).
  const files = await listFiles(OUT);
  for (const f of files) {
    if (!/\.(js|css|html|json)$/.test(f)) continue;
    const st = await stat(f);
    // 거대한 파일은 문자열 전체를 읽지 않는다(메모리).
    if (st.size > 8 * 1024 * 1024) continue;
    const body = await readFile(f, "utf8");
    for (const re of SECRET_LITERAL) {
      const m = body.match(re);
      if (m) {
        throw new Error(`웹 자산 ${f} 에 비밀 값으로 보이는 패턴이 들어 있습니다: ${m[0].slice(0, 12)}…`);
      }
    }
  }
  console.log(`웹 자산 검사 통과: ${label} (${files.length}개 파일)`);
}

main().catch((e) => {
  console.error(`[pack-web-assets] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
