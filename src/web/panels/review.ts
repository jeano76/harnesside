/**
 * 변경 사항 검토 패널 (M2 · §11.1).
 *
 * 요구 3 의 diff 가 "보기" 만으로는 부족한 이유: 에이전트가 파일을 **썼다**.
 * 그래서 각 항목에 **승인/되돌리기** 가 있어야 한다. 이 로직은 그 판단을 한다.
 *
 * 위험은 "되돌리기" 다. 되돌리기가 잘못되면 **사용자의 작업이 사라진다.**
 * 그래서 세 규칙을 지킨다:
 *  1. 되돌리기는 **항상 현재 내용(디스크)** 을 기준으로 삼는다. 승인 당시 스냅샷이 아니다.
 *  2. 승인/거절 사이의 변경은 **"변경됨" 으로 다시 보여준다** — 승인한 줄이 조용히 바뀌면 안 된다.
 *  3. 되돌리기 직전 **사본을 남긴다**(되돌리기 실패 시 복구 경로).
 */

export type ReviewState = "pending" | "approved" | "rejected" | "reverted" | "stale";

export interface DiffLineLite {
  line: number;
  text: string;
  kind: "context" | "add" | "del" | "modify";
}

export interface ReviewItem {
  id: string;
  path: string;
  state: ReviewState;
  /** 승인/거절로 결정된 순간의 해시. 이후 바뀌면 `stale` 이 된다. */
  decidedHash: string | null;
  /** 현재 디스크 내용의 해시. */
  currentHash: string;
  added: number;
  removed: number;
  /** 되돌리기 전에 남긴 사본 경로. */
  backupPath: string | null;
  at: number;
  note: string | null;
}

/** 간단한 내용 지문. 내용 비교용이므로 충돌 가능성은 감수(원본 설계). */
export function hashOf(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function makeItem(path: string, added: number, removed: number, currentHash: string, at = Date.now()): ReviewItem {
  return { id: `${path}@${currentHash}`, path, state: "pending", decidedHash: null, currentHash, added, removed, backupPath: null, at, note: null };
}

/**
 * 결정. **이미 결정된 항목을 다시 결정할 수 없다** — 이중 실행 방지.
 * 그리고 결정 시점의 해시를 **기록**한다. 이것이 stale 판정의 기준이다.
 */
export function decide(items: ReviewItem[], id: string, state: "approved" | "rejected"): { items: ReviewItem[]; changed: boolean; reason: string } {
  const it = items.find((x) => x.id === id);
  if (!it) return { items, changed: false, reason: "항목을 찾을 수 없습니다" };
  if (it.state === "reverted") return { items, changed: false, reason: "이미 되돌린 항목입니다" };
  if (it.state === state) return { items, changed: false, reason: state === "approved" ? "이미 승인했습니다" : "이미 거절했습니다" };
  const next: ReviewItem = { ...it, state, decidedHash: it.currentHash };
  return {
    items: items.map((x) => (x.id === id ? next : x)),
    changed: true,
    reason: state === "approved" ? `${it.path} 승인` : `${it.path} 거절 — 되돌릴 수 있습니다`,
  };
}

/**
 * 승인 후 내용이 바뀌었는지 확인한다. **바뀌면 승인이 무효화**된다 —
 * 사용자가 승인한 것은 "그 내용" 이지 "그 경로" 가 아니다.
 */
export function refreshHashes(items: ReviewItem[], currentHashByPath: Record<string, string>): ReviewItem[] {
  return items.map((it) => {
    const h = currentHashByPath[it.path];
    if (h === undefined) return it;
    if (h === it.currentHash) return it;
    const wasDecided = it.state === "approved" || it.state === "rejected";
    return {
      ...it,
      currentHash: h,
      // 결정이 있었는데 바뀌었다면 `stale` — 조용히 승인 상태를 유지하면 안 된다.
      state: wasDecided ? "stale" : it.state,
      note: wasDecided ? "결정 이후 내용이 변경되어 다시 검토해야 합니다" : it.note,
    };
  });
}

export interface RevertResult {
  items: ReviewItem[];
  ok: boolean;
  reason: string;
  /** 되돌리기 전에 남긴 사본 경로 — 실패 시 복구 경로. */
  backup: string | null;
}

/**
 * 되돌리기. **사본을 먼저 남긴다.** 디스크에서 되돌리는 순간 되돌릴 수 없게 되므로,
 * 실패하면 사본으로 복구할 수 있어야 한다.
 */
export function revert(items: ReviewItem[], id: string, backupPath: string, original: string): RevertResult {
  const it = items.find((x) => x.id === id);
  if (!it) return { items, ok: false, reason: "항목을 찾을 수 없습니다", backup: null };
  if (it.state === "reverted") return { items, ok: false, reason: "이미 되돌렸습니다", backup: it.backupPath };
  if (it.state === "pending") return { items, ok: false, reason: "아직 결정되지 않은 항목입니다", backup: null };
  if (it.state === "stale") {
    // 결정 이후 변경됨 → 되돌리면 **사용자의 새 편집까지 지운다.** 막는다.
    return { items, ok: false, reason: "결정 이후 변경되었습니다. 되돌리면 지금 내용을 잃습니다. 먼저 내용을 비교하십시오.", backup: null };
  }
  if (!original) return { items, ok: false, reason: "되돌릴 원본 내용이 없습니다", backup: null };
  const next: ReviewItem = { ...it, state: "reverted", backupPath, note: `되돌림 (사본: ${backupPath})` };
  return { items: items.map((x) => (x.id === id ? next : x)), ok: true, reason: `${it.path} 되돌렸습니다 (원본 ${original.length.toLocaleString()}자)`, backup: backupPath };
}

export interface ReviewSummary {
  pending: number;
  approved: number;
  rejected: number;
  stale: number;
  reverted: number;
  total: number;
  added: number;
  removed: number;
  /** 검토가 남았으면 "0" 이 아니다 — "완료" 와 구분되어야 한다. */
  needsReview: boolean;
}

export function summarize(items: ReviewItem[]): ReviewSummary {
  const c = (s: ReviewState) => items.filter((i) => i.state === s).length;
  const pending = c("pending") + c("stale");
  return {
    pending,
    approved: c("approved"),
    rejected: c("rejected"),
    stale: c("stale"),
    reverted: c("reverted"),
    total: items.length,
    added: items.reduce((a, i) => a + i.added, 0),
    removed: items.reduce((a, i) => a + i.removed, 0),
    needsReview: pending > 0,
  };
}

export function summaryLabel(s: ReviewSummary): string {
  if (s.total === 0) return "변경 없음";
  const parts: string[] = [`+${s.added}`, `−${s.removed}`];
  if (s.pending) parts.push(`검토 대기 ${s.pending}`);
  if (s.stale) parts.push(`다시 검토 ${s.stale}`);
  if (s.approved) parts.push(`승인 ${s.approved}`);
  return parts.join(" · ");
}

/** 변경된 파일만 상위로, 경로순으로. 검토 순서는 **안정적**이어야 한다. */
export function sortForReview(items: ReviewItem[]): ReviewItem[] {
  const rank: Record<ReviewState, number> = { stale: 0, pending: 1, rejected: 2, approved: 3, reverted: 4 };
  return [...items].sort((a, b) => rank[a.state] - rank[b.state] || a.path.localeCompare(b.path));
}
