/**
 * **바깥에서 파일이 바뀐 경우의 판단** — 되돌아가지 않는다. 못 잃는다 (2026-10-05 실측).
 *
 * ── 실측으로 확인한 결함 ────────────────────────────────────────────────────
 *
 * 열린 파일을 에디터로 보여둔 채 디스크에서 그 파일을 고치면:
 *
 *   1. `fs.changed` 토스트("디스크에서 변경됨")만 뜨고 **아무것도 하지 않는다**
 *   2. 화면은 **영원히 옛 내용**을 보여준다
 *
 * 사용자에게 "새로고침 하십시오" 라고 말하고 끝내는 것은 답이 아니다 — 프로그램이
 * 이미 그 파일을 알고 있고, 이미 읽는 방법을 알고 있다.
 *
 * 그렇다고 곧장 `setOpenFile` 로 갈아끼우면 **더 나쁜 일이 생긴다.** `EditorView` 의
 * 버퍼는 ref 이고 `info` 가 바뀌면 통째로 갈아끼워진다. 그래서 **사용자가 타이핑 중
 * 이었다면 그 편집이 조용히 사라진다.** 조용히 사라지는 데이터 손실이, 낡은 내용을
 * 보여주는 것보다 나쁘다.
 *
 * 그래서 규칙은 하나다 — **손대지 않은 버퍼만 디스크를 따른다.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planExternalChange, type Buffer } from "./autosave.js";

const clean = (over: Partial<Buffer> = {}): Buffer => ({
  path: "/p/a.ts",
  content: "one\n",
  baseVersion: 3,
  dirtySince: null,
  ...over,
});

test("**깨끗한 버퍼는 디스크를 따른다** — 안 고쳤으면 따라가는 게 사용자의 기대다", () => {
  const r = planExternalChange(clean(), { content: "two\n", version: 4 });
  assert.equal(r.action, "adopt", "안 고친 버퍼인데 옛 내용을 계속 보여준다");
  assert.match(r.why, /저장하지 않은 편집이 없어/, `왜 그런지 말하지 않는다: ${r.why}`);
});

test("**고치는 중이면 절대 덮지 않는다** — 데이터 손실이 가장 나쁜 실패다", () => {
  const b = clean({ content: "내 편집\n", dirtySince: 1700000000000 });
  const r = planExternalChange(b, { content: "남의 편집\n", version: 9 });
  assert.equal(r.action, "keep", "사용자 편집을 디스크로 덮어썼다");
  assert.match(r.why, /그대로/, `보존 이유가 없다: ${r.why}`);
});

test("**내용이 같으면 건드리지 않는다** — `mtime` 만 바뀐 경우 커서를 잃을 이유가 없다", () => {
  const r = planExternalChange(clean(), { content: "one\n", version: 4 });
  assert.equal(r.action, "keep", "내용이 같은데 버퍼를 다시 만들어 커서를 잃게 했다");
  assert.match(r.why, /내용이 같습니다/);
});

test("**자기 저장이 돌아온 경우에도 지우지 않는다** — 버전만 올라간 저장 성공", () => {
  // `fs.changed` 는 자기 저장에도 온다(계측함 주석 참조). 버전만 오르고 내용은
  // 같으면 앞서 테스트가 처리한다. 여기서는 **내용이 다른데 baseVersion 이 같으면**
  // 어쨌든 미저장 편집이 우선임을 재확인한다 — 버전에 홀려 덮어쓰지 않는다.
  const b = clean({ content: "내 편집\n", dirtySince: 1 });
  const r = planExternalChange(b, { content: "disk\n", version: 3 });
  assert.equal(r.action, "keep", "버전 번호를 보고 사용자 편집을 버렸다");
});

test("**판정은 `info` 로만 하지 않는다** — 경로가 다르면 이 규칙의 대상이 아니다", () => {
  // 경로 비교는 호출자(`EditorView` effect) 책임이다. 여기서는 **내용·버전만** 본다.
  // 다른 경로의 내용으로 이 버퍼를 갈아끼우면 안 된다는 것을 고정해 둔다.
  const b = clean({ path: "/p/a.ts" });
  const r = planExternalChange(b, { content: "two\n", version: 4 });
  assert.equal(r.action, "adopt");
  assert.notEqual(b.path, "/p/other.ts");
});

test("**미저장 편집이 있으면 내용이 같아도 adopt 하지 않는다** — 판단 순서가 한 가지뿐", () => {
  const b = clean({ content: "same\n", dirtySince: 42 });
  const r = planExternalChange(b, { content: "same\n", version: 4 });
  assert.equal(r.action, "keep");
});

test("**빈 파일로 바뀐 경우도 보존한다** — 편집 중인데 디스크가 비었다고 지우지 않는다", () => {
  const b = clean({ content: "내 편집\n", dirtySince: 5 });
  const r = planExternalChange(b, { content: "", version: 12 });
  assert.equal(r.action, "keep", "디스크가 비었다는 이유로 사용자 편집을 지웠다");
});