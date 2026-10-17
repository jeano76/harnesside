/** X-5: 로컬 write_file/edit_file/append_file 결과에 붙이는 외과적 변경 경고. 차단하지 않고 알린다. */

export interface ScopeCheck {
  path: string;
  /** 파일이 이미 있었는가. */
  existed: boolean;
  before: string;
  after: string;
}

const squash = (s: string): string => s.replace(/\s+/g, "");

const isImportLine = (l: string): boolean => /^\s*(import\b|from\s+\S+\s+import\b|const\s+.*=\s*require\()/.test(l);

/** 줄 순서만 바뀌고 내용은 같은 import 블록 재정렬인가. */
function onlyImportReorder(before: string, after: string): boolean {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return false;
  const changed = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  if (changed.length < 2) return false;
  if (!changed.every(([x, y]) => isImportLine(x) && isImportLine(y))) return false;
  const sort = (xs: string[]) => [...xs].sort().join("\n");
  return sort(changed.map(([x]) => x)) === sort(changed.map(([, y]) => y));
}

export function scopeWarnings(c: ScopeCheck): string[] {
  const out: string[] = [];
  if (!c.existed) {
    out.push(`새 파일 생성: ${c.path} — 요청에 필요한 파일인지 확인하세요. 필요 없으면 지우세요.`);
    return out;
  }
  if (c.before === c.after) return out;
  if (squash(c.before) === squash(c.after)) {
    out.push(`공백·줄바꿈만 바뀜: ${c.path} — 요청과 무관한 포맷팅이면 되돌리세요.`);
  } else if (onlyImportReorder(c.before, c.after)) {
    out.push(`import 순서만 바뀜: ${c.path} — 요청과 무관한 재정렬이면 되돌리세요.`);
  }
  return out;
}

export function withScopeWarnings(content: string, c: ScopeCheck): string {
  const w = scopeWarnings(c);
  return w.length ? `${content}\n${w.map((x) => `[scope] ${x}`).join("\n")}` : content;
}
