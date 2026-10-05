/**
 * 파일 생성 중 실시간 초안 (2026-10-05).
 *
 * 모델이 파일을 쓸 때 도구 호출 인자(JSON)가 조각으로 흘러온다. 이 파일은 그 조각에서
 * **사람이 읽을 본문**만 꺼낸다 — `{"path":"a.py","content":"def f():\n..."}` 에서
 * `content` 값을 이스케이프 풀어서 보여준다. 완성되기 전이라 JSON 이 깨져 있어도
 * 지금까지 도착한 만큼은 보여야 하므로, 끝을 잘라내지 않고 그대로 푼다.
 */

export interface DraftView {
  /** 경로 — 아직 도착하지 않았으면 null. */
  path: string | null;
  /** 지금까지 도착한 본문(이스케이프 해제됨). 본문 키를 아직 못 봤으면 원문 인자. */
  text: string;
  /** 본문 키를 실제로 찾았는가. false 면 `text` 는 JSON 원문이다. */
  hasBody: boolean;
}

const PATH_KEY = /"(?:path|file_path|filePath|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const BODY_KEY = /"(?:content|text|new_text|new_string|body)"\s*:\s*"/;

/** JSON 문자열 이스케이프를 한 글자씩 푼다. 닫는 따옴표에서 멈춘다(뒤의 `}` 등은 버린다). */
function unescapeUntilQuote(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    // 끝에 걸친 `\` 한 글자는 다음 조각이 와야 뜻이 정해진다 — 지금은 버린다.
    if (i + 1 >= raw.length) break;
    const n = raw[++i];
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "";
    else if (n === "u" && i + 4 < raw.length && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += n; // \" \\ \/ 는 그 글자 자체다
  }
  return out;
}

export function draftView(args: string): DraftView {
  const path = PATH_KEY.exec(args)?.[1] ?? null;
  const body = BODY_KEY.exec(args);
  if (!body) return { path, text: args, hasBody: false };
  return { path, text: unescapeUntilQuote(args.slice(body.index + body[0].length)), hasBody: true };
}

/** 인자에서 임의 키의 문자열 값을 꺼낸다 — 아직 도착하지 않았으면 `undefined`. */
export function fieldAfter(args: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(args);
  if (!m) return undefined;
  return unescapeUntilQuote(args.slice(m.index + m[0].length));
}

/**
 * 도구 호출 하나가 파일을 **어떤 모습으로 만들지** 지금까지 본 만큼 계산한다.
 *
 * - `write_file`: 본문이 곧 파일 전체다.
 * - `append_file`: 기존 파일 뒤에 본문이 붙는다.
 * - `edit_file`: 기존 파일에서 `old_text` 한 곳을 `new_text` 로 바꾼다. `new_text` 가
 *   아직 없으면 `predicted` 는 `null` — 아직 아무것도 바뀌지 않았다고 **말하지** 지어내지 않는다.
 *
 * `disk` 는 지금 디스크의 파일 내용이다(없으면 `null`).
 */
export function predictEdit(name: string, args: string, disk: string | null): { path: string | null; predicted: string | null } {
  const path = draftView(args).path;
  if (name === "edit_file") {
    const oldPart = fieldAfter(args, "old_text");
    const newPart = fieldAfter(args, "new_text");
    if (disk === null || oldPart === undefined || newPart === undefined) return { path, predicted: null };
    return { path, predicted: disk.includes(oldPart) ? disk.replace(oldPart, newPart) : disk };
  }
  const view = draftView(args);
  if (!view.hasBody) return { path, predicted: null };
  if (name === "write_file") return { path, predicted: view.text };
  if (name === "append_file") return { path, predicted: (disk ?? "") + view.text };
  return { path, predicted: null };
}
