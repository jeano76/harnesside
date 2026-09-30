/**
 * 자동 저장 규칙 테스트 (M6 · §5.1 · §3.4).
 *
 * 여기서 검사하는 세 가지 중 셋째가 가장 중요하다: **충돌을 조용히 덮어쓰지 않는다.**
 * 409 의 서버본문을 버리면 사용자는 "저장됐다" 고 믿은 채 자기 편집을 잃는다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  planSave,
  saveLocalDraft,
  loadLocalDraft,
  clearLocalDraft,
  conflictOptions,
  applyChoice,
  AUTOSAVE_DEBOUNCE_MS,
  type Buffer,
} from "./autosave.js";

const buf = (over: Partial<Buffer> = {}): Buffer => ({
  path: "a.ts",
  content: "내용",
  baseVersion: 100,
  dirtySince: 1_000,
  ...over,
});

test("깨끗하면 **저장하지 않는다** — 안 고친 파일을 쓰면 '외부 변경' 알림이 난다", () => {
  const d = planSave(buf({ dirtySince: null }), 99_999);
  assert.equal(d.action, "skip");
  assert.match(d.action === "skip" ? d.reason : "", /바뀐 것이 없/);
});

test("디바운스 안이면 기다린다 — 타이핑마다 쓰면 입력이 끊긴다", () => {
  const d = planSave(buf({ dirtySince: 1_000 }), 1_000 + AUTOSAVE_DEBOUNCE_MS - 1);
  assert.equal(d.action, "skip");
  assert.match(d.action === "skip" ? d.reason : "", /디바운스/);
});

test("디바운스가 지나면 **경로·내용·버전** 을 함께 보낸다 — 버전이 없으면 충돌을 못 안다", () => {
  const d = planSave(buf({ dirtySince: 1_000 }), 1_000 + AUTOSAVE_DEBOUNCE_MS);
  assert.equal(d.action, "save");
  if (d.action !== "save") return;
  assert.equal(d.body.path, "a.ts");
  assert.equal(d.body.baseVersion, 100, "버전을 안 보내면 서버가 충돌을 판정할 수 없다");
});

test("내용을 전부 지우면 **저장하지 않는다** — 원본이 빈 파일로 남는다", () => {
  const d = planSave(buf({ content: "", dirtySince: 1_000 }), 99_999);
  assert.equal(d.action, "skip", "빈 파일 저장을 조용히 했다");
  assert.match(d.action === "skip" ? d.reason : "", /명시적/);
});

test("새로 만든 빈 파일(버전 0)은 저장한다 — 그건 사용자가 만든 것이니까", () => {
  const d = planSave(buf({ content: "", baseVersion: 0, dirtySince: 1_000 }), 99_999);
  assert.equal(d.action, "save", "빈 새 파일을 못 만들었다");
});

test("창을 닫아도 남는다 — 경로·버전까지 있어야 복원된다", () => {
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  } as unknown as Storage;
  saveLocalDraft({ path: "a.ts", content: "작성 중", baseVersion: 100, at: 1_000 }, store);
  const back = loadLocalDraft(store);
  assert.equal(back?.path, "a.ts");
  assert.equal(back?.content, "작성 중");
  assert.equal(back?.baseVersion, 100);
  clearLocalDraft(store);
  assert.equal(loadLocalDraft(store), null);
});

test("저장소가 없어도 **조용히 아무 일도** 하지 않는다 — 죽지 않는다", () => {
  saveLocalDraft({ path: "a", content: "b", baseVersion: 1, at: 1 }, null);
  assert.equal(loadLocalDraft(null), null);
});

test("충돌은 **선택지** 다 — 덮어쓰기 하나만 두면 사용자가 그걸 옳다고 믿는다", () => {
  const opts = conflictOptions({ content: "서버본문", version: 200 });
  assert.equal(opts.length, 3);
  assert.ok(opts.some((o) => o.choice === "keep-mine"));
  assert.ok(opts.some((o) => o.choice === "take-theirs"));
  assert.ok(opts.some((o) => o.choice === "both"), "둘 다 남기기가 없다 — 하나를 잃는다");
  // **모든 선택지에 무엇을 잃는지가 적혀 있어야** 한다.
  for (const o of opts) assert.ok(o.detail.length > 0, `${o.choice} 의 위험이 설명되지 않았다`);
});

test("선택을 **결론(텍스트)** 으로 바꾼다", () => {
  assert.equal(applyChoice("keep-mine", "내 것", "서버 것"), "내 것");
  assert.equal(applyChoice("take-theirs", "내 것", "서버 것"), "서버 것");
  const both = applyChoice("both", "내 것", "서버 것");
  assert.ok(both.includes("내 것") && both.includes("서버 것"), "하나가 사라졌다");
});
