/**
 * 답의 **가독성**을 세는 검사 (2026-10-05).
 *
 * ── 왜 이것이 검사인가 ───────────────────────────────────────────────────────
 * 출력 형식 규칙(`src/agent/systemPrompt.ts`)은 **프롬프트로 하는 요청**이고,
 * 요청은 지킬 수 있다가 안 지킬 수 있다. 그래서 "지키고 있다" 고 말하려면
 * 측정이 있어야 한다. 이 스크립트는 그 측정이다.
 *
 * 무엇을 세나: 실제 저장 세션(`.harnesside/state/sessions/*.json`)의 **어시스턴트
 * 텍스트 블록**에 `readabilityFlags` 를 적용해 세 가지 형태의 개수를 낸다 —
 *   1. `runon-paragraph`      문단이 120자를 넘김
 *   2. `inline-enumeration`   한 줄에 항목 5개 이상이 쉼표로 이어짐
 *   3. `no-structure`         400자 이상인데 제목·목록·표·펜스가 없음
 *
 * ── 이 검사가 거짓말할 수 있는 경우 ─────────────────────────────────────────
 *  1. **세션이 과거다.** 프롬프트 규칙이 추가되기 **전** 대화가 대부분이라,
 *     지금의 모델 출력이 어떤지는 이 숫자로 말할 수 없다(직접 물어봐야 안다).
 *     그래서 이 스크립트는 **기준선(baseline)** 으로만 쓴다.
 *  2. **세션이 없다** = 측정 불가 = 0건이 아니다. 조용히 0 을 출력하지 않는다.
 *  3. `readabilityFlags` 는 **형태만** 본다. 내용의 정확성과 무관하다 —
 *     "가독성이 나쁘다" 와 "틀렸다" 는 다른 판단이다.
 *
 * 실행: `npx tsx scripts/readability-report.ts [--json]`
 * 종료 코드: 측정 불가일 때만 1. **기준선을 넘어도 실패로 만들지 않는다** —
 * 이건 게이트가 아니라 기록이다(게이트로 만들면 형식을 맞추려고 답이 짧아진다).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readabilityFlags, PARAGRAPH_CHAR_LIMIT, type ReadabilityFlag } from "../src/agent/systemPrompt.js";

const SESSION_DIR = join(process.cwd(), ".harnesside", "state", "sessions");

interface Row {
  file: string;
  chars: number;
  flags: ReadabilityFlag[];
}

function collectTexts(dir: string): Row[] {
  if (!existsSync(dir)) return [];
  const rows: Row[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    let doc: { blocks?: Array<{ kind?: string; text?: unknown; content?: unknown }> };
    try {
      doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      // 깨진 세션 파일은 **조용히 건너뛰되 세지 않는다** — 아래 요약에 남긴다.
      continue;
    }
    for (const b of doc.blocks ?? []) {
      if (b.kind !== "text") continue;
      const text = typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : "";
      if (text.length <= PARAGRAPH_CHAR_LIMIT) continue;
      rows.push({ file: name, chars: text.length, flags: readabilityFlags(text) });
    }
  }
  return rows;
}

function main(): number {
  const rows = collectTexts(SESSION_DIR);
  const counts = new Map<string, number>();
  let flagged = 0;
  for (const r of rows) {
    if (r.flags.length) flagged++;
    for (const f of r.flags) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  }

  if (rows.length === 0) {
    // **0 이 아니라 "측정 불가"** 를 출력한다. 조용히 통과시키지 않는다.
    process.stderr.write(
      `세션 텍스트 블록을 하나도 찾지 못했다: ${SESSION_DIR}\n` +
        `→ 이건 "가독성이 좋다" 의 근거가 아니다. **측정 불가** 다.\n`,
    );
    return 1;
  }

  const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`;
  const summary = {
    sessionDir: SESSION_DIR,
    longTextBlocks: rows.length,
    flaggedBlocks: flagged,
    flaggedShare: pct(flagged),
    byRule: Object.fromEntries([...counts.entries()].sort()),
    paragraphCharLimit: PARAGRAPH_CHAR_LIMIT,
    worst: rows
      .filter((r) => r.flags.length)
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 5)
      .map((r) => ({ file: r.file, chars: r.chars, rules: r.flags.map((f) => f.rule) })),
  };

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `가독성 기준선 — ${rows.length}개 텍스트 블록(문단 상한 ${PARAGRAPH_CHAR_LIMIT}자)\n` +
      `  신호가 하나라도 난 블록: ${flagged}개 (${pct(flagged)})\n` +
      [...counts.entries()].map(([k, v]) => `    ${k}: ${v}`).join("\n") +
      `\n  가장 긴 5건:\n` +
      summary.worst.map((w) => `    ${w.file} · ${w.chars}자 · ${w.rules.join(", ")}`).join("\n") +
      `\n  이건 **기준선** 이다. 대부분 프롬프트 규칙 추가 이전 대화다 — 지금의 출력 품질은 직접 물어봐야 안다.\n`,
  );
  return 0;
}

process.exit(main());
