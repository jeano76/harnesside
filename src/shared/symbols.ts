/**
 * 기호 추출 — 텍스트 기준 (import 0개).
 *
 * §7.1 "기호로 이동" 의 1단계다. 타입 해석(TS LanguageService)은 없다 —
 * **정규식 텍스트 스캔** 이므로 오탐(주석 속 단어 등)이 있을 수 있고,
 * 그 사실을 숨기지 않는다: UI 는 "텍스트 기준" 이라고 말한다.
 * 추측으로 정의 위치를 지어내면 사용자가 확인하러 눌러야 하므로(§7.1),
 * **못 찾으면 빈 목록** 을 준다. 참조 찾기(references)는 범위 밖이다.
 */

export interface DocSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "heading" | "def" | "target";
  /** 1-based 줄 번호. */
  line: number;
}

export const MAX_SYMBOLS = 500;

interface Pat {
  re: RegExp;
  kind: DocSymbol["kind"];
  name: number;
}

function patsFor(path: string): Pat[] {
  const lower = path.toLowerCase();
  if (/\.tsx?$|\.mjs$|\.cjs$|\.jsx?$/.test(lower)) {
    return [
      { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function", name: 1 },
      { re: /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", name: 1 },
      { re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", name: 1 },
      { re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type", name: 1 },
      { re: /^\s*export\s+(?:async\s+)?const\s+([A-Za-z_$][\w$]*)/, kind: "const", name: 1 },
      { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", name: 1 },
    ];
  }
  if (lower.endsWith(".py")) {
    return [
      { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: "def", name: 1 },
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", name: 1 },
    ];
  }
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) {
    return [{ re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)/, kind: "def", name: 1 }];
  }
  if (/\.md$|\.markdown$/.test(lower)) {
    return [{ re: /^(#{1,3})\s+(.+?)\s*$/, kind: "heading", name: 2 }];
  }
  return [];
}

/**
 * 파일 내용에서 기호 목록. 모르는 확장자는 빈 목록 (지어내지 않는다).
 * 넘치면 앞에서 자르고 `truncated: true` — 조용히 일부만 주지 않는다.
 */
export function extractSymbols(
  path: string,
  content: string,
  max = MAX_SYMBOLS
): { symbols: DocSymbol[]; truncated: boolean } {
  const pats = patsFor(path);
  if (pats.length === 0) return { symbols: [], truncated: false };
  const out: DocSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const p of pats) {
      const m = line.match(p.re);
      if (m && m[p.name]) {
        out.push({ name: m[p.name]!.slice(0, 120), kind: p.kind, line: i + 1 });
        if (out.length >= max) return { symbols: out, truncated: true };
        break;
      }
    }
  }
  return { symbols: out, truncated: false };
}
