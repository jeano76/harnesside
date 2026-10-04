/**
 * 버전의 **정본은 `package.json` 의 `version`** 이다 (Q-7, 2026-10-04).
 *
 * 예전엔 세 곳이 따로 말했다: `/api/bootstrap`·`/api/system/version` 은 `"0.1.0"` 을 하드코딩했고, 업데이트는 package.json 을 읽었고,
 * 지워진 TUI 는 dist 파일 mtime 으로 `v<YYYYMMDD>` 를 만들었다. 이제 모든 곳이 이 함수 하나를 읽는다.
 *
 * 형식은 **시맨틱 버전**이다 — 정본 업데이트 경로(`updateService`)가 GitHub Releases 태그(`vX.Y.Z`)를 `isNewer` 로 **숫자 비교**하기 때문이다.
 * 날짜 버전은 같은 날 두 번 내면 구분이 안 되고, 릴리스 태그와도 맞지 않는다.
 *
 * 위치: `src/server/` 와 빌드 결과 `dist/server/` 는 둘 다 패키지 루트에서 두 단계 아래라 같은 상대 경로가 맞다.
 */
import { readFileSync } from "node:fs";

let cached: string | null = null;

export function readVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    cached = typeof pkg.version === "string" && pkg.version ? pkg.version : "확인 못 함";
  } catch {
    // 모르면 지어내지 않는다 — "0.0.0" 같은 그럴듯한 값을 쓰면 업데이트 비교가 조용히 틀린다.
    cached = "확인 못 함";
  }
  return cached;
}
