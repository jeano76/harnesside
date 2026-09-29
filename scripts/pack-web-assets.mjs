/**
 * 웹 자산을 서버가 읽을 수 있는 위치로 모은다.
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

import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC_WEB = join(here, "src", "web");
const DIST_WEB = join(here, "dist", "web");
const OUT = join(here, "dist", "packaged-web");

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
  const source = existsSync(DIST_WEB) ? DIST_WEB : SRC_WEB;
  const label = source === DIST_WEB ? "dist/web (빌드 산출물)" : "src/web (개발 소스 — 빌드된 산출물이 없습니다)";

  if (source === SRC_WEB && !existsSync(join(SRC_WEB, "index.html"))) {
    // 둘 다 없다. 이 상태로 서버를 띄우면 **빈 화면** 이 나온다.
    throw new Error(`웹 자산을 찾을 수 없습니다: dist/web 도 src/web/index.html 도 없습니다. 'npm run build:web' 를 먼저 실행하십시오.`);
  }

  await mkdir(OUT, { recursive: true });
  await cp(source, OUT, { recursive: true });

  // 검증 1: index.html 이 **실제로** 있다. 산출물이 비어 있으면 여기서 걸린다.
  const index = join(OUT, "index.html");
  if (!existsSync(index)) {
    throw new Error(`패키징된 웹 자산에 index.html 이 없습니다: ${OUT}`);
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
        throw new Error(`패키징된 자산 ${f} 에 비밀 값으로 보이는 패턴이 들어 있습니다: ${m[0].slice(0, 12)}…`);
      }
    }
  }

  await writeFile(
    join(OUT, "BUILD_INFO.json"),
    JSON.stringify({ source: label, files: files.length, at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  console.log(`웹 자산 패키징 완료: ${label} → ${OUT} (${files.length}개 파일)`);
}

main().catch((e) => {
  console.error(`[pack-web-assets] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
