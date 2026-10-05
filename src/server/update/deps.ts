/**
 * 의존성 사전 설치 검사 — **Raiser R-1 · 대안 (나)**.
 *
 * ── 왜 이것이 R-3 보다 앞서는가 ─────────────────────────────────────────────
 *
 * `package.json` 의 `files` 는 **`dist` 뿐**이다. 즉 배포물은 `node_modules` 를
 * 담지 않는다. 셀프업데이트는 **코드만** 갈아끼운다.
 *
 * 그러면 이 상태가 된다:
 *
 *     dist/server/index.js   ← 새 버전 (갱신됨)
 *     node_modules/node-pty  ← 설치된 옛 것, 또는 **아예 없음**
 *
 * `node-pty` 가 없으면 이 프로그램은 **부팅하지 못한다.** 부팅 확인이 있으면
 * 롤백된다 — 그래도 사용자는 **한 번 죽는다.**
 *
 * 선택지 (가) 의존성을 배포물에 넣기 / (나) 사전 설치를 **검증하고 없으면 막기** /
 * (다) npm 배포로 전환. 세 번째는 0-1 의 결정을 재검토하는 것이므로 여기 없다.
 * **`조용히 깨뜨리는 경로` 만 금지**하므로 (나) 를 택한다.
 *
 * ── 왜 `resolve` 인가 — 직접 `node_modules/<이름>` 을 보면 거짓말한다 ────────
 *
 * npm 은 의존을 올릴 수 있다. 그래서 어떤 패키지는 `node_modules/표준화/` 에만
 * 존재한다. 디렉터리만 훑으면 **있는데 막힌다고** 말하고, 그건 사용자가 볼 때
 * 완전히 거짓이다. 그래서 **노드의 실제 해석**에 맡긴다.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface DepsResult {
  /** 준비돼 있는가. `null` = 확인할 방법이 없다(그래서 막지 않는다). */
  ready: boolean | null;
  /** 없는 의존 이름. */
  missing: string[];
  /**
   * **설치 루트 밖에서** 해석된 의존 이름.
   *
   * 이게 왜 있는가 (실측, 배포 준비 중 발견): 이 머신에는 `/usr/share/nodejs/ws` 가
   * 있고 노드가 그걸 찾아서 **"설치돼 있다"** 고 답한다. 배포물이 `node-pty` 하나만
   * 없어도 `ws` 는 통과한다.
   *
   * **`require.resolve` 가 성공하면 프로그램도 그걸 로드할 수 있다** — 게이트가
   * 노드보다 낙관적이면 안 되므로 판정 기준은 그대로 따른다. 하지만 시스템
   * 패키지는 **버전이 다르다.** 사용자가 모르는 버전을 실행하게 되는 것이므로
   * 조용히 두지 않고 여기에 이름을 **드러낸다.**
   */
  external: string[];
  /** 왜 확인 못 했는지 — `ready:null` 이면 사람이 읽는다. */
  detail: string;
}

const EMPTY: DepsResult = { ready: true, missing: [], external: [], detail: "선언된 외부 의존성이 없습니다" };

/** `dependencies` + `optionalDependencies`. dev 는 배포물에 필요 없다. */
export function runtimeDeps(pkg: { dependencies?: unknown; optionalDependencies?: unknown }): string[] {
  const out = new Set<string>();
  for (const key of ["dependencies", "optionalDependencies"] as const) {
    const v = pkg[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const name of Object.keys(v as Record<string, unknown>)) if (name) out.add(name);
    }
  }
  return [...out].sort();
}

/**
 * 설치 루트의 의존을 확인한다.
 *
 * 주입 이유: 이 검사는 **파일시스템과 모듈 해석**에 의존하므로, 테스트가
 * 진짜로 디렉터리를 만들어 재현해야 한다 — 그래야 "없으면 막는다" 가 문장이
 * 아니라 동작이다. 그래서 `resolve` 을 받는다.
 *
 * ── `external` 판정 기준이 **두 곳**인 이유 (실측) ─────────────────────────
 *
 * 처음엔 "설치 루트(`dist/`) 안에서 해석됐는가" 로 판정했다. 그 결과 **13개 전부**
 * "설치 폴더 밖" 으로 나왔다 — `node_modules` 가 `dist/` **옆**에 있기 때문이다
 * (`/repo/node_modules` vs `/repo/dist`). 즉 **거짓 경보였다.**
 *
 * 경보가 거짓이면 더 나쁘다 — 사용자가 경보를 **무시하는 법**을 배운다.
 * 그래서 기준은 **"이 설치본이 소유한 node_modules"** 다:
 *   ① `dist/node_modules` (배포물이 의존성을 함께 담는 배치)
 *   ② `<패키지 루트>/node_modules` (npm 이 여기를 쓴다 — 실제 기본 배치)
 * 둘 다 아니면 **진짜 외부**(예: `/usr/share/nodejs`).
 */
export function checkDependencies(
  installRoot: string,
  pkg: { dependencies?: unknown; optionalDependencies?: unknown } | null,
  resolveName: (name: string) => string | null
): DepsResult {
  if (pkg === null) {
    // package.json 을 못 읽으면 **"있다" 고 말하지 않는다.** 다만 이 판정은
    // **차단 사유가 아니다** — 배포물에 package.json 이 없을 수도 있기 때문이다.
    return { ready: null, missing: [], external: [], detail: "package.json 을 읽지 못해 의존성을 확인하지 않았습니다" };
  }
  const deps = runtimeDeps(pkg);
  if (deps.length === 0) return EMPTY;

  // 이 설치본이 **소유한** node_modules 목록 (위 주석의 ①②).
  const owned = [resolve(installRoot, "node_modules"), resolve(installRoot, "..", "node_modules")].map((p) => p + sep);
  const missing: string[] = [];
  const external: string[] = [];
  for (const name of deps) {
    const resolved = resolveName(name);
    let found = resolved !== null;
    // **해석 실패(null)면 안쪽으로 본다** — 실제로는 아래의 직접 찾기가 답을 정한다.
    let insideOwned = !found || owned.some((d) => resolve(resolved as string).startsWith(d));
    if (!found) {
      // native addon 은 `require.resolve` 로 안 잡힐 수 있다(빌드 전). 그래서
      // package.json 을 직접 찾아 **두 방법** 중 하나라도 되면 있는 것으로 본다.
      try {
        readFileSync(join(installRoot, "node_modules", ...name.split("/"), "package.json"));
        found = true;
        insideOwned = true;
      } catch {
        found = false;
      }
    }
    if (!found) missing.push(name);
    // **이 설치본 소유 밖에서 해석된 것** — 조용히 두지 않는다(위 주석의 실측 참조).
    else if (!insideOwned) external.push(name);
  }

  // **둘 다 있으면 둘 다 말한다.** 하나만 말하면 잃는다 — 없는 의존으로 막히면
  // 화면이 그 사실만 보여주고, "설치 폴더 밖에서 왔다" 는 사실은 사라진다.
  // 사용자는 그것을 모르고 다음 머신에서 다른 버전을 실행한다(실측 참조).
  const externalNote =
    external.length === 0
      ? ""
      : ` · 단 ${external.length}개는 설치 폴더 밖에서 왔습니다(${external.slice(0, 4).join(", ")} — 시스템 패키지이므로 버전이 다를 수 있습니다)`;

  if (missing.length) {
    return {
      ready: false,
      missing,
      external,
      detail: `의존성 ${missing.length}개가 없습니다: ${missing.slice(0, 4).join(", ")}${externalNote}`,
    };
  }
  return {
    ready: true,
    missing: [],
    external,
    detail: `의존성 ${deps.length}개 모두 설치됨${externalNote}`,
  };
}

/** `installRoot` 기준의 실제 해석기. `createRequire` 는 경로를 정확히 따른다. */
export function makeResolver(installRoot: string): (name: string) => string | null {
  let req: NodeRequire | null = null;
  try {
    // 설치 루트 아래의 가짜 진입점을 기준점으로 삼는다 — 배포물이 실행되는 자리.
    req = createRequire(join(installRoot, "package.json"));
  } catch {
    req = null;
  }
  return (name) => {
    if (!req) return null;
    try {
      return req.resolve(`${name}/package.json`);
    } catch {
      try {
        return req.resolve(name);
      } catch {
        return null;
      }
    }
  };
}