import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "../backend/types.js";

/**
 * 컴팩션이 버리는 내용의 **무손실 보관소**.
 *
 * 컴팩션은 정의상 대화에서 내용을 뺀다(도구 출력을 자리표시자로, 오래된 구간을 요약으로). 그런데 빼는
 * 것과 **잃는 것** 은 다르다 — 원문을 파일로 남기고 그 경로를 자리표시자·요약에 적어 두면, 모델이 정확한
 * 세부(줄 번호, 오류 전문, 이전에 읽은 파일 내용)가 필요할 때 `read_file` 로 되찾는다. 되찾는 데는 컴팩션 시간도
 * 컨텍스트도 들지 않는다(필요할 때만 읽는다).
 *
 * 형식은 사람과 모델이 모두 `grep`/`read_file` 로 다루기 쉬운 평문이다. 항목 머리글은 `=== entry <id> | <label> ===`.
 * 쓰기 실패는 절대 컴팩션을 막지 않는다(보관은 안전망이지 필수 경로가 아니다).
 */

export const MAX_ARCHIVE_FILES = 40;

export interface ArchiveEntry {
  id: string;
  label: string;
  text: string;
}

export function archiveDir(projectRoot: string): string {
  return join(projectRoot, ".harnesside", "state", "archive");
}

let archiveSeq = 0;

/** 이번 컴팩션의 보관 파일 경로. 쓰기 전에도 알 수 있어야 자리표시자에 적을 수 있다.
 *  같은 밀리초에 둘이 만들어져도 **서로 덮어쓰지 않게** 프로세스 내 순번을 붙인다(이름순 = 시각순 유지). */
export function newArchivePath(projectRoot: string, kind: "masked" | "compaction", now = new Date()): string {
  const seq = String(archiveSeq++ % 1000).padStart(3, "0");
  return join(archiveDir(projectRoot), `${now.toISOString().replace(/[:.]/g, "-")}-${seq}-${kind}.txt`);
}

/** 대화 메시지를 보관 항목으로. 도구 호출 인자도 함께 남긴다. */
export function messagesToEntries(messages: ChatMessage[]): ArchiveEntry[] {
  return messages.map((m, i) => {
    const calls = (m.tool_calls ?? []).map((tc) => `${tc.function.name}(${tc.function.arguments})`).join("\n");
    const text = [typeof m.content === "string" ? m.content : "", calls].filter(Boolean).join("\n");
    const who = m.role === "tool" ? `tool ${m.tool_call_id ?? ""}`.trim() : m.role;
    return { id: `m${i}`, label: who, text };
  });
}

function render(entries: ArchiveEntry[]): string {
  return entries.map((e) => `=== entry ${e.id} | ${e.label.replace(/\s+/g, " ").slice(0, 160)} ===\n${e.text}\n`).join("\n");
}

/** 디렉터리를 만들고 쓸 수 있는지 미리 확인한다 — 자리표시자에 경로를 적기 전에. */
export async function ensureArchiveWritable(projectRoot: string): Promise<boolean> {
  try {
    await mkdir(archiveDir(projectRoot), { recursive: true });
    const probe = join(archiveDir(projectRoot), `.probe-${process.pid}`);
    await writeFile(probe, "", "utf8");
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/** 보관 파일을 쓴다. 실패하면 false(던지지 않는다). 오래된 파일은 MAX_ARCHIVE_FILES 개만 남기고 지운다. */
export async function writeArchive(projectRoot: string, path: string, entries: ArchiveEntry[]): Promise<boolean> {
  if (entries.length === 0) return false;
  try {
    await mkdir(archiveDir(projectRoot), { recursive: true });
    await writeFile(path, render(entries), "utf8");
    await pruneArchive(projectRoot);
    return true;
  } catch {
    return false;
  }
}

export async function pruneArchive(projectRoot: string, keep = MAX_ARCHIVE_FILES): Promise<void> {
  try {
    const dir = archiveDir(projectRoot);
    const names = (await readdir(dir)).filter((n) => n.endsWith(".txt")).sort(); // 이름이 시각 순
    for (const old of names.slice(0, Math.max(0, names.length - keep))) await unlink(join(dir, old)).catch(() => {});
  } catch {
    // best effort
  }
}
