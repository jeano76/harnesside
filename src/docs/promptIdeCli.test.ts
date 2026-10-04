/**
 * `PROMPT_IDE_CLI.md` 는 **명세** 다. 명세가 코드와 어긋나면 방향을 잃는다(부록 C).
 *
 * 그래서 문서의 **주장**을 검사한다. 특히 **"했다" 고 쓴 것** — 실측으로 확인된 것만
 * 적혀 있어야 한다. 확인 못 한 것을 했다고 쓰면 그 문서는 **거짓말**이 되고, 읽는
 * 사람은 그걸 근거로 판단한다.
 *
 * 반대로 **"미측정" 이라고 적은 것**을 검사하는 것도 필요하다. 미측정을 지워버리면
 * 그 항목을 아무도 하지 않게 된다 — 조용한 실패가 가장 나쁘다는 이 프로젝트의
 * 규칙(부록 B 1)이 여기에 적용된다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DOC = "PROMPT_IDE_CLI.md";
const src = existsSync(join(ROOT, DOC)) ? readFileSync(join(ROOT, DOC), "utf8") : "";
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * 자기 검사용 규칙 — **코드포인트로 쓴다.**
 *
 * 왜 이래야 하는지는 아래 마지막 테스트의 주석이 답한다(2026-10-03 실측). 짧게 말하면:
 * 이 파일이 CJK 를 **문자 그대로** 담고 있으면 `ci-checks.mjs` 가 **이 검사를 잡는다.**
 */
const CJK_RE = new RegExp("[\\u4e00-\\u9fff]");
const BROKEN_RE = new RegExp("[\\uFFFD]");

test("[살아있는지] 문서가 **있다** — 없으면 아래가 빈 소리가 된다", () => {
  assert.ok(src.length > 1000, `${DOC} 가 없거나 비어 있다`);
});

test("**기존 요구 번호를 재해석하지 않는다** — `S-n` 체계로 분리했다", () => {
  // `PROMPT.md` 의 요구 1~19 와 겹치면 두 문서가 충돌한다.
  assert.match(src, /`PROMPT\.md` 의 요구 1~19 와 \*\*겹치지 않는\*\*/, "번호 충돌을 인정하지 않는다");
  assert.match(src, /S-1/, "새 번호 체계가 없다");
});

test("**목표가 한 문장**으로 있다 — 목표가 없으면 우선순위가 없다", () => {
  assert.match(src, /### 1\.1 왜 이 문장이 목표인가/, "목표의 이유를 적지 않는다");
  assert.match(src, /창을 떠나지 않아도 되게/, "목표가 화면 배치로 좁혀지지 않았다");
});

test("**하지 않는 것**을 명시한다 — 경계 없으면 되돌아온다", () => {
  // 2026-10-01 에 탐색기를 삭제했다. 명시하지 않으면 다음 사람이 되살린다.
  // **경계 문장**을 본다 — 표에 "없다" 고 적힌 것과 "하지 않는다" 고 단정된 것은 다르다.
  // 뒤에 이유가 없으면 되돌아오기 때문이다.
  assert.match(src, /탐색기를 되살리지 않는다|탐색기 패널을 되살리지 않는다/, "탐색기 경계가 없다");
  // **이유**도 있어야 한다 — "안 쓴다" 와 "왜 안 쓰는가" 는 다르다.
  assert.match(src, /탐색기를 되살리면 2026-10-01 의 삭제가 되돌아간다/, "탐색기를 안 쓰는 이유가 없다");
  assert.match(src, /리본/, "리본을 왜 안 넣는지 없다");
});

// ── 실측 근거가 코드와 맞는지 ─────────────────────────────────────────────

test("**명령 두 번** 규칙이 실제 코드에 있다 — 없는 규칙을 문서에 쓰지 않는다", () => {
  const blocks = read("src/session/blocks.ts");
  // `tool` 이 streamable 이고 `done !== true` 가 경계여야 한다.
  assert.match(blocks, /kind === "tool"/, "도구 블록이 합쳐지지 않는다 — S-1 의 규칙이 코드에 없다");
  assert.match(blocks, /last\.tool\?\.done !== true/, "완료가 경계가 아니다");
  const ws = read("src/web/wsClient.ts");
  assert.match(ws, /msg\.seq <= this\.lastSeq/, "재전송 필터가 없다");
});

test("**강조** 규칙이 실제 렌더와 맞는다 — 화면이 말문이면 안 된다", () => {
  const md = read("src/web/panels/Markdown.tsx");
  assert.match(md, /export function safeHref/, "마크다운에 위험한 스킴 방어가 없다");
  // Pens without language must not be guessed at.
  assert.match(md, /: "text"/, "언어 미지 시 기본값이 없다");
});

test("**측정 불가** 규칙이 계측과 맞는다 — `0` 으로 채우면 안 된다", () => {
  const shared = read("src/shared/metrics.ts");
  assert.match(shared, /utilPct: number \| null;/, "GPU 사용률이 0 으로 채워진다 — S-3 규칙 위반");
  const metrics = read("src/server/metrics.ts");
  assert.doesNotMatch(metrics, /utilPct: num\(util\) \?\? 0/, "계측에서 0 으로 채운다");
});

// ── 미측정을 **지우지 않는다** ───────────────────────────────────────────────

test("**미측정 목록**이 남아 있다 — 지우면 아무도 하지 않게 된다", () => {
  assert.match(src, /### 12\.1 미측정 항목/, "미측정 목록이 없다");
  // **구체적으로** 항목이 있어야 한다. "미측정" 이라는 말만으로는 부족하다.
  for (const item of ["좁은 창", "zsh", "fish", "jinja"]) {
    assert.ok(src.includes(item), `미측정 항목 "${item}" 이 없다 — 무엇을 확인해야 하는지 모른다`);
  }
});

test("**수용 기준**에 검증 방법이 붙어 있다 — 방법 없으면 체크할 수 없다", () => {
  const idx = src.indexOf("## 16. 수용 기준");
  assert.ok(idx > 0, "수용 기준 절이 없다");
  const tail = src.slice(idx);
  // **"검증" 이 함께** 적힌 항목이 있어야 한다.
  assert.match(tail, /-- \*\*\[x\]|검증|확인/i, "수용 기준에 검증 방법이 없다");
});

test("**자기 검사** 항목이 있다 — 이 프로젝트의 제1 규칙이므로", () => {
  assert.match(src, /검사는 자기 자신을 검사한다/, "자기 검사 규칙이 없다");
  assert.match(src, /코드.*먼저 의심|먼저 의심/, "코드를 먼저 의심한다는 규칙이 없다");
});

// ── 문서 구조 ───────────────────────────────────────────────────────────────

test("**부록에 실제 결함 목록**이 있다 — 이론이 아니라 측정에서 왔다", () => {
  assert.match(src, /부록 A\. 실제 겪은 결함 목록/, "결함 목록이 없다");
  // **날짜와 현상이** 있어야 한다. "개선했습니다" 식으로는 안 된다.
  assert.match(src, /\d{2}-\d{2} \|/, "결함에 날짜가 없다");
  const rows = (src.match(/^\| \d{2}-\d{2} \|/gm) ?? []).length;
  assert.ok(rows >= 10, `결함이 ${rows}건뿐이다 — 실측이 덜 들어갔다`);
});

test("**깨진 바이트가 없다** — 본문이 아니라면 그것도 무의미하다", () => {
  assert.ok(!/[\uFFFD]/.test(src), "깨진 바이트(U+FFFD)가 있다 — 이동 중 손상");
  assert.ok(!/[\u4e00-\u9fff]/.test(src), "한국어 문장에 CJK 가 섞여 있다");
});

test("[살아있는지] 이 검사의 규칙이 **자기 자신을** 본다", () => {
  // 규칙이 조용히 무효가 되면 통과만 한다. 그래서 프로브를 직접 친다.
  //
  // **프로브는 코드포인트로 만든다** (2026-10-03 실측·수정).
  //
  // 이 파일에는 **CJK 두 글자가 문자 그대로** 들어 있었다. `ci-checks.mjs` 의 `MIXED_RE` 가
  // `src/**` 를 훑어 한국어 문장에 섞인 CJK 를 잡는데, **이 프로브가 그대로 잡혔다.**
  // 즉 `npm test` 는 초록불인데 `ci-checks` 는 빨간불이었다 — **자기 검사가 자기 자신을
  // 잡아** 이 저장소가 가장 많이 반복해서 기록한 실패 유형을(2026-10-02 부록 A 12행,
  // "소스 스캔이 자기 주석을 잡음 → 판정을 뒤집음") 그대로 재현한 것이었다.
  //
  // **깨진 바이트 프로브는 이미 코드포인트였다.** 한쪽만 고치면 규칙이 조용히
  // 반쪽만 남으므로 **둘 다** 코드포인트로 만든다.
  assert.ok(CJK_RE.test(String.fromCharCode(0x6e2c, 0x8a66)), "CJK 규칙이 동작하지 않는다");
  assert.ok(BROKEN_RE.test(String.fromCharCode(0xfffd)), "깨진 바이트 규칙이 동작하지 않는다");
});
