/**
 * 가로 diff (§5.2) — 좌/우 2열 비교의 **메타**.
 *
 * 렌더링은 Monaco `DiffEditor` 가 하고(가로 모드), 우리는 "무엇이 왜 바뀌었는가" 의
 * 메타만 제공한다. 그 메타가 틀리면 화면은 그럴듯하게 틀린다 — 사용자는 그것을
 * 믿고 검토하므로, 계산은 순수 함수로 검증되어야 한다.
 *
 * §5.2: **세로가 아닌 가로 비교**가 요구다. 좁은 폭에서만 인라인으로 폴백하고,
 * 그마저도 **사용자 설정을 우선**한다.
 */

export interface DiffLine {
  line: number;
  text: string;
  kind: "context" | "add" | "del" | "modify";
  /** modify 인 경우 반대편 줄 번호(문자 단위 강조에 쓰인다). */
  pairedWith?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffStat {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  hunks: number;
}

export interface DiffResult {
  hunks: DiffHunk[];
  stat: DiffStat;
  /** 전체가 바뀌었는지 — 그러면 지도를 보여줄 이유가 없다. */
  wholeFileChanged: boolean;
}

/** LCS 기반 줄 단위 diff. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;

  // 1) **동일성 빠른 경로.** LCS 는 O(n·m) 이라 2만 줄이면 4억 칸이다.
  //    그런데 큰 파일에서 제일 흔한 경우는 "내용이 같다" 다 — 이걸 먼저 처리하지 않으면
  //    동일한 2만 줄 파일이 **"2만 줄 추가"** 로 보고된다(실제로 그렇게 났다).
  if (n === m && a.every((v, i) => v === b[i])) {
    return a.map((text, i) => ({ line: i + 1, text, kind: "context" as const }));
  }

  // 2) 그래도 크면 정밀 비교를 포기한다. 4만 줄짜리 가짜 add/del 을 만들어
  //    "변경이 없다" 고 말하는 것보다 "전체가 달랐다" 고 말하는 게 정직하다.
  if (n * m > 4_000_000) {
    return [
      ...a.map((text, i) => ({ line: i + 1, text, kind: "del" as const })),
      ...b.map((text, i) => ({ line: i + 1, text, kind: "add" as const })),
    ];
  }

  // LCS 길이표
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ line: i + 1, text: a[i], kind: "context" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ line: i + 1, text: a[i], kind: "del" });
      i++;
    } else {
      raw.push({ line: j + 1, text: b[j], kind: "add" });
      j++;
    }
  }
  while (i < n) raw.push({ line: ++i, text: a[i - 1], kind: "del" });
  while (j < m) raw.push({ line: ++j, text: b[j - 1], kind: "add" });

  // 3) 1:1 교체(삭제 1 + 추가 1)는 **modify** 로 묶는다. 안 묶으면 한 줄 수정이
  //    "삭제 1 + 추가 1" 로 보고되어 통계가 두 배로 부풀고, 문자 단위 강조 대상이 사라진다.
  return pairModifications(raw);
}

/** 연속 변경을 hunk 로 묶는다 — 전체를 보내면 5만 줄이 매 요청마다 다닌다. */
export function buildHunks(lines: DiffLine[], context = 3): DiffResult {
  const changed = lines.map((l) => l.kind !== "context");
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k < Math.min(lines.length, i + context + 1); k++) keep[k] = true;
  }

  const stat: DiffStat = { added: 0, removed: 0, modified: 0, unchanged: 0, hunks: 0 };
  // modify 는 **한 쌍이 한 번의 수정**이다. modify 줄은 2개지만 수정 횟수는 1이다.
  // 줄 수로 세면 "변경 2건" 이 "변경 4건" 으로 부풀고, 합계(+12 −3)가 거짓말한다.
  let pendingModify = false;
  for (const l of lines) {
    if (l.kind === "add") stat.added++;
    else if (l.kind === "del") stat.removed++;
    else if (l.kind === "modify") {
      if (!pendingModify) {
        stat.modified++;
        // git 과 동일하게 수정은 +1/−1 로 합계에도 들어간다(§5.2 "+12 −3").
        stat.added++;
        stat.removed++;
      }
      pendingModify = !pendingModify;
    } else {
      stat.unchanged++;
      pendingModify = false;
    }
  }

  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, header: "", lines: [] };
      hunks.push(cur);
      stat.hunks++;
    }
    cur.lines.push(lines[i]);
    if (lines[i].kind !== "add") cur.oldLines++;
    if (lines[i].kind !== "del") cur.newLines++;
  }
  for (const h of hunks) {
    const oldNo = h.lines.find((l) => l.kind !== "add")?.line ?? 0;
    const newNo = h.lines.find((l) => l.kind !== "del")?.line ?? 0;
    h.oldStart = oldNo;
    h.newStart = newNo;
    h.header = `@@ -${oldNo},${h.oldLines} +${newNo},${h.newLines} @@`;
  }

  const wholeFileChanged = stat.unchanged === 0 && lines.length > 0;
  return { hunks, stat, wholeFileChanged };
}

/** 빈 문자열은 **0줄** 이다. `"".split("\n")` 은 `[""]` 이라 가짜 빈 줄이 생긴다. */
function linesOf(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function diffText(oldText: string, newText: string, context = 3): DiffResult {
  return buildHunks(diffLines(linesOf(oldText), linesOf(newText)), context);
}

/**
 * §5.2: 가로(side-by-side) 기본. **폭이 좁아도 사용자 설정이 우선**이다 —
 * 사용자가 인선을 골랐는데 레이아웃이 대신 고르면 설정이 거짓말을 한다.
 */
export function layoutFor(widthPx: number, pref: "auto" | "side" | "inline" = "auto"): "side" | "inline" {
  if (pref === "side") return "side";
  if (pref === "inline") return "inline";
  // 한 열에 80자가 들어갈 최소 폭. 이보다 좁으면 2열이 읽을 수 없다.
  return widthPx < 900 ? "inline" : "side";
}

/**
 * 인라인 폴백에서 modify 를 한 쌍으로 묶는다(문자 단위 강조에 필요하다).
 * add/del 로 흩어지면 "무엇이 바뀌었나" 를 볼 수 없다.
 */
export function pairModifications(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      out.push(lines[i]);
      i++;
      continue;
    }
    // **연속 del/add 묶음은 한 번에 판단한다.** 한 줄씩 처리하면, 삭제 2 + 추가 1 에서
    // 첫 del 이 "혼자 남은 del" 로 보여 두 번째 del 을 add 와 짝지어 버린다 — 그러면
    // 삭제가 하나 사라져 통계가 실제보다 적게 나간다("무엇이 지워졌나" 를 찾는 사람이 속는다).
    // **1:1 일치할 때만** modify 로 본다.
    let d = i;
    while (d < lines.length && lines[d].kind === "del") d++;
    let e = d;
    while (e < lines.length && lines[e].kind === "add") e++;
    if (d === i + 1 && e === d + 1) {
      out.push({ ...lines[i], kind: "modify", pairedWith: lines[d].line });
      out.push({ ...lines[d], kind: "modify", pairedWith: lines[i].line });
      i = e;
    } else {
      for (let k = i; k < d; k++) out.push(lines[k]);
      i = d;
    }
  }
  return out;
}
