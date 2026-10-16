/**
 * X-3 스킬 로딩 — 본문 전체를 컨텍스트에 넣지 않고 **체크리스트 ≤ 15줄**로 돌려준다.
 *
 * 압축은 결정적 추출이다(제목 + 불릿/번호 줄의 첫 문장). LLM 요약이 아니다 — 외부 에이전트로
 * 압축을 시키는 경로(X-1 `delegate`)가 아직 없다. 캐시 머리말의 `method: extract` 가 그 사실을 말한다.
 *
 * 이 검사가 거짓말할 수 있는 경우: 추출은 문장의 *앞부분*만 남기므로 "단, ~일 때는 예외" 같은
 * 뒤쪽 조건이 빠질 수 있다 — 그래서 결과 끝에 원문 줄 수와 `mode:"full"` 안내를 항상 붙인다.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CHECKLIST_MAX_LINES = 15;
export const CHECKLIST_LINE_MAX_CHARS = 160;
/** 인덱스(시스템 프롬프트 상주)의 스킬당 설명 상한. */
export const INDEX_TRIGGER_MAX_CHARS = 120;

export function clampTrigger(trigger: string): string {
  const one = trigger.replace(/\s+/g, " ").trim();
  return one.length <= INDEX_TRIGGER_MAX_CHARS ? one : `${one.slice(0, INDEX_TRIGGER_MAX_CHARS - 1)}…`;
}

function stripFrontmatter(body: string): string {
  return body.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.。!?])(\s|$)/.exec(t);
  const s = m?.[1] ?? t;
  return s.length <= CHECKLIST_LINE_MAX_CHARS ? s : `${s.slice(0, CHECKLIST_LINE_MAX_CHARS - 1)}…`;
}

/** 목록 항목은 이어지는 들여쓰기 줄까지 한 항목으로 묶는다. */
function collectItems(text: string): { kind: "heading" | "item"; text: string }[] {
  const out: { kind: "heading" | "item"; text: string }[] = [];
  let inFence = false;
  let cur: string | null = null;
  const flush = () => {
    if (cur !== null) out.push({ kind: "item", text: firstSentence(cur) });
    cur = null;
  };
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    const h = /^#{1,4}\s+(.+)$/.exec(raw);
    if (h) {
      flush();
      out.push({ kind: "heading", text: h[1]!.trim() });
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (li) {
      flush();
      cur = li[1]!;
      continue;
    }
    if (cur !== null && /^\s+\S/.test(raw)) cur += ` ${raw.trim()}`;
    else flush();
  }
  flush();
  return out;
}

/** 본문을 ≤ `maxLines` 줄 체크리스트로 줄인다. 이미 짧으면 그대로(압축하지 않는다). */
export function extractChecklist(body: string, maxLines = CHECKLIST_MAX_LINES): { text: string; sourceLines: number; compressed: boolean } {
  const content = stripFrontmatter(body).replace(/\s+$/, "");
  const sourceLines = content.length === 0 ? 0 : content.split("\n").length;
  if (sourceLines <= maxLines) return { text: content, sourceLines, compressed: false };

  const items = collectItems(content);
  const title = items.find((i) => i.kind === "heading");
  // 섹션(소제목 + 그 아래 항목)으로 나눠 **섹션마다 고르게** 뽑는다. 앞에서부터 채우면 뒤쪽 섹션이
  // 통째로 사라진다(실측: 4원칙 스킬에서 4번째 원칙이 빠졌다).
  type Section = { heading: string | null; items: string[] };
  const sections: Section[] = [];
  let curSec: Section = { heading: null, items: [] };
  for (const it of items) {
    if (it === title) continue;
    if (it.kind === "heading") {
      if (curSec.heading !== null || curSec.items.length > 0) sections.push(curSec);
      curSec = { heading: it.text, items: [] };
    } else {
      curSec.items.push(it.text);
    }
  }
  if (curSec.heading !== null || curSec.items.length > 0) sections.push(curSec);

  const keptSections = sections.slice(0, Math.max(1, Math.min(sections.length, maxLines - 1 - 4)));
  let budget = maxLines - (title ? 1 : 0) - keptSections.filter((x) => x.heading !== null).length;
  const take = keptSections.map(() => 0);
  // 라운드 로빈: 한 번에 한 항목씩 모든 섹션에 나눠 준다.
  for (let progressed = true; budget > 0 && progressed; ) {
    progressed = false;
    for (let k = 0; k < keptSections.length && budget > 0; k++) {
      if (take[k]! < keptSections[k]!.items.length) {
        take[k]!++;
        budget--;
        progressed = true;
      }
    }
  }
  const lines: string[] = [];
  if (title) lines.push(`## ${title.text}`);
  keptSections.forEach((sec, k) => {
    if (sec.heading !== null) lines.push(`### ${sec.heading}`);
    for (const it of sec.items.slice(0, take[k]!)) lines.push(`- ${it}`);
  });
  if (lines.length === 0) {
    // 목록·제목이 없는 산문 — 앞 줄만 남긴다.
    const prose = content.split("\n").filter((l) => l.trim()).slice(0, maxLines).map((l) => firstSentence(l));
    return { text: prose.join("\n"), sourceLines, compressed: true };
  }
  return { text: lines.join("\n"), sourceLines, compressed: true };
}

function sha(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}

export function checklistCachePath(projectRoot: string, name: string): string {
  return join(projectRoot, ".harnesside", "state", "skills-cache", `${safeName(name)}.md`);
}

/**
 * `mode:"checklist"` 의 결과. 캐시는 원본 해시가 같을 때만 재사용하고, 다르면 다시 만든다.
 * 캐시를 못 써도(읽기 전용 디렉터리 등) 결과는 돌려준다 — 캐시는 속도일 뿐 정확성이 아니다.
 */
export async function loadSkillChecklist(projectRoot: string, name: string, body: string): Promise<string> {
  const hash = sha(body);
  const path = checklistCachePath(projectRoot, name);
  const footer = (sourceLines: number) =>
    `\n\n(체크리스트 — 원문 ${sourceLines}줄에서 추출. 세부 조건이 필요하면 load_skill 을 mode:"full" 로 다시 호출)`;
  try {
    const cached = await readFile(path, "utf8");
    const m = /^<!-- source-sha256: (\w+) method: extract lines: (\d+) -->\n([\s\S]*)$/.exec(cached);
    if (m && m[1] === hash) return `${m[3]}${footer(Number(m[2]))}`;
  } catch {
    /* 캐시 없음 */
  }
  const r = extractChecklist(body);
  if (!r.compressed) return r.text; // 짧은 스킬은 그대로 — 캐시도 만들지 않는다
  try {
    await mkdir(join(projectRoot, ".harnesside", "state", "skills-cache"), { recursive: true });
    await writeFile(path, `<!-- source-sha256: ${hash} method: extract lines: ${r.sourceLines} -->\n${r.text}`, "utf8");
  } catch {
    /* 캐시 쓰기 실패는 무시 — 결과는 그대로 돌려준다 */
  }
  return `${r.text}${footer(r.sourceLines)}`;
}
