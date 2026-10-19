import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** Working notes: findings the model records with the `note` tool so they
 *  survive context compaction. Kept in a file (not only in the
 *  conversation) and re-injected after every compaction and on resume.
 *
 *  Seen live: a session chasing one syntax error compacted ~25 times in 40
 *  minutes, and each compaction reduced what it had just worked out ("the
 *  page script is a single line", "the error is reported at the end") to a
 *  lossy summary, so it rewrote the same analysis ~60 times. */
export const NOTES_HEADER = "[Working notes — kept across compaction]";

/** Newest notes kept when the file grows past this. */
export const MAX_NOTES_CHARS = 3000;

function notesPath(projectRoot: string): string {
  return join(projectRoot, ".harnesside", "state", "notes.md");
}

/** 스타일 메커서: `년-월-일 시:분` — 시·분만으로는 세션을 건넌 노트(어제 기록이
 *  오늘 재주입)의 신선도를 판정할 수 없어, MemTrace(arXiv 2610.04838)의
 *  저비용 적용으로 전체 날짜를 남긴다. */
export function formatStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}]`;
}

/** 노트 한 줄의 시각 접두사(있으면)를 파싱한다. 구버전 [HH:MM] 형식은 null. */
export function parseStamp(line: string): Date | null {
  const m = line.match(/^-\s*\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

export async function readNotes(projectRoot: string): Promise<string> {
  try {
    return (await readFile(notesPath(projectRoot), "utf8")).trim();
  } catch {
    return "";
  }
}

/** Appends one note as a timestamped line, dropping the oldest lines once
 *  the total passes MAX_NOTES_CHARS. */
export async function appendNote(projectRoot: string, text: string, now: Date = new Date()): Promise<void> {
  const line = `- ${formatStamp(now)} ${text.replace(/\s+/g, " ").trim()}`;
  const lines = [...(await readNotes(projectRoot)).split("\n").filter(Boolean), line];
  while (lines.length > 1 && lines.join("\n").length > MAX_NOTES_CHARS) lines.shift();
  const path = notesPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}

export async function clearNotes(projectRoot: string): Promise<void> {
  await rm(notesPath(projectRoot), { force: true });
}

/** Removes a notes block from summary text, so notes appended to the system
 *  message aren't fed back into the next summary and duplicated. */
export function stripNotesBlock(text: string): string {
  const idx = text.indexOf(NOTES_HEADER);
  return idx === -1 ? text : text.slice(0, idx).trimEnd();
}

/** 재주입 시 노트 한 줄에 붙는 신선도 경고 접두사. */
export const STALE_MARKER = "⚠ stale:";
/** 노트 기록과 같은 분 내의 수정은 신선한 것으로 간주한다(기록이 분 단위라). */
const STALE_TOLERANCE_MS = 60_000;

/** 파일 경로처럼 보이는 토큰. URL의 `//` 는 클래스에 안 들어와 자연히 배제된다. */
const PATH_LIKE = /[\w@][\w@./\\-]*\.[A-Za-z][A-Za-z0-9_-]{0,7}/g;

export interface StaleNotesOptions {
  /** mtime(ms) 공급자 — 저장소 밖 경로·죽은 심볼릭 링크는 null 로 스킵. 테스트에서 주입. */
  fileMtime?: (absolutePath: string) => Promise<number | null>;
}

/**
 * 재주입 직전의 노트에 신선도를 표시한다 — MemTrace(arXiv 2610.04838)가 진단한
 * "state-memory misalignment" 의 저비용 방어: 근본 원인이 "이 오류는 src/x.ts 42행" 이라
 * 기록된 노트가, 그 파일이 나중에 수정된 뒤에도 사실처럼 재주입되면 모델은 오래된
 * 관찰을 현재 상태로 신뢰해 결론이 어긋난다. 노트 기록 이후 수정된 파일 경로를
 * 그 줄에 표시해 "다시 읽어라" 고 만든다.
 *
 * 날짜 없는 구버전([HH:MM]) 줄은 비교 근거가 없어 그대로 둔다 — 낡으면 상한(MAX_NOTES_CHARS)
 * 에 의해 자연히 밀려난다. 파일이 없어지면 스킵한다(삭제는 수정보다 안전 — 존재하지 않는
 * 경로에 경고를 붙이는 건 노트 예산만 쓴다).
 */
export async function annotateStaleNotes(
  notesText: string,
  projectRoot: string,
  opts: StaleNotesOptions = {}
): Promise<string> {
  if (!notesText.trim()) return notesText;
  const fileMtime = opts.fileMtime ?? (async (p: string) => {
    try {
      return (await stat(p)).mtimeMs;
    } catch {
      return null;
    }
  });
  const lines = notesText.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const stamp = parseStamp(line);
    let annotated = line;
    if (stamp) {
      const noteTime = stamp.getTime() + STALE_TOLERANCE_MS;
      for (const match of line.matchAll(PATH_LIKE)) {
        const candidate = match[0];
        const abs = isAbsolute(candidate) ? candidate : join(projectRoot, candidate);
        const mtime = await fileMtime(abs);
        // 같은 줄에 같은 경로가 두 번 나오면 한 번만 붙인다.
        if (mtime !== null && !annotated.includes(`${STALE_MARKER} ${candidate}`) && mtime > noteTime) {
          annotated = `${annotated} ${STALE_MARKER} ${candidate} was modified after this note — re-read the file before trusting it`;
        }
      }
    }
    out.push(annotated);
  }
  return out.join("\n");
}
