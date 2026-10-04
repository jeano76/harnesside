/**
 * 빠른 이동 순위 — 순수 로직 (import 0개).
 *
 * `src/fs/search.ts` 에 있었으나 웹(`SearchBlock`)이 값으로 가져오면
 * `node:fs` 가 브라우저 번들에 따라와 빌드가 깨진다(§D12, bug #9와 같은 종류).
 * 정본은 여기다. 서버·웹 둘 다 여기서 읽는다.
 */

/** 빠른 이동 후보 — **경로 조각을 순서대로** 보고 점수를 매긴다. */
export interface FileHit {
  path: string;
  name: string;
  /** 선택하기 좋게 매긴 순위. 낮을수록 위다. */
  score: number;
}

/**
 * 파일 이름/경로로 빠르게 찾는다 (`Ctrl+P` 대응).
 *
 * 순위는 **사람의 순서**를 따른다: 파일 이름이 먼저 맞아야 앞선다, 그다음 경로 접두사.
 * 알파벳순으로 두면 "자주 가는 파일" 이 맨 아래로 밀린다.
 */
export function rankFiles(paths: string[], query: string): FileHit[] {
  const q = query.trim().toLowerCase();
  const hits: FileHit[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (!q) score = 3;
    else if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (lower.includes(q)) score = 4;
    // **일치하지 않으면 목록에 없다** — "이름이 비슷한 것" 을 지어내지 않는다.
    else continue;
    hits.push({ path: p, name: p.slice(p.lastIndexOf("/") + 1), score });
  }
  // 같은 점수면 **짧은 경로가 먼저** — `src/a.ts` 와 `src/web/panels/a.ts` 중
  // 어느 쪽이 더 가까울지는 경로 길이가 더 잘 말해 준다.
  hits.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.path.length - b.path.length || a.path.localeCompare(b.path)));
  return hits;
}
