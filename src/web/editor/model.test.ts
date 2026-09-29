/**
 * 에디터 도메인 로직 테스트 (§8.2 · §5.1).
 *
 * 특히 저장 충돌을 검증한다 — **무음 덮어쓰기**가 이 프로그램에서 가장 값싸게 잃히는
 * 데이터(사용자의 편집, 혹은 외부 편집)다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  languageOf,
  planOpen,
  decideSave,
  openTab,
  closeTab,
  dirtyTabs,
  formatBytes,
  type Tab,
  type LayoutState,
} from "./model.js";

test("확장자 → 언어 매핑", () => {
  assert.equal(languageOf("src/a.ts"), "typescript");
  assert.equal(languageOf("src/a.tsx"), "typescript");
  assert.equal(languageOf("scripts/run.sh"), "shell");
  assert.equal(languageOf("Dockerfile"), "dockerfile");
  assert.equal(languageOf("Makefile"), "makefile");
  assert.equal(languageOf("a.unknown"), "plaintext");
  assert.equal(languageOf("noext"), "plaintext");
});

test("읽기 전용 경로(예: 빌드 산출물)는 열되 편집하지 않는다", () => {
  const p = planOpen({ path: "secrets/a.txt", name: "a.txt", size: 10 }, "hello", { readOnlyPaths: ["secrets/"] });
  assert.equal(p.readOnly, true, "읽기 전용 경로가 편집 가능하다");
  assert.match(p.reason, /읽기 전용/);
  // 접두사 밖은 편집 가능해야 한다(오탐 방지)
  const q = planOpen({ path: "src/a.txt", name: "a.txt", size: 10 }, "hello", { readOnlyPaths: ["secrets/"] });
  assert.equal(q.readOnly, false);
  // .harnesside/ 안쪽은 기본 읽기 전용(§8.2)
  const r = planOpen({ path: ".harnesside/state/x.json", name: "x.json", size: 3 }, "{}", { inHarnessDir: true });
  assert.equal(r.readOnly, true);
});

test("바이너리는 이유를 말한다 — 빈 화면이 되면 안 된다", () => {
  const p = planOpen({ path: "a.bin", name: "a.bin", size: 10 }, "ab\u0000cd");
  assert.equal(p.kind, "binary");
  assert.equal(p.readOnly, true);
  assert.match(p.reason, /바이너리/);
});

test("이미지는 이미지 뷰로", () => {
  const p = planOpen({ path: "a.png", name: "a.png", size: 100 }, "");
  assert.equal(p.kind, "image");
  assert.equal(p.readOnly, true);
});

test("매우 큰 파일은 앞부분만 읽기 전용으로 — 통째로 넣지 않는다", () => {
  const big = Array.from({ length: 60_000 }, (_, i) => `줄 ${i}`).join("\n");
  const p = planOpen({ path: "big.ts", name: "big.ts", size: big.length }, big);
  assert.equal(p.truncate, true);
  assert.equal(p.readOnly, true);
  assert.ok(p.omittedLines > 9000, "생략량을 세지 않았다");
  assert.match(p.reason, /줄만 표시/);
});

test("보통 파일은 그대로 열리고 편집 가능하다", () => {
  const p = planOpen({ path: "a.ts", name: "a.ts", size: 5 }, "const x");
  assert.equal(p.kind, "code");
  assert.equal(p.readOnly, false);
  assert.equal(p.truncate, false);
});

test("저장: 버전이 같으면 되고, 새 버전을 돌려준다", () => {
  const tab: Tab = { path: "a.ts", name: "a.ts", dirty: true, baseVersion: 3, readOnly: false, kind: "code" };
  const r = decideSave({ tab, content: "x", serverVersion: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.version, 4);
});

test("저장 충돌: 409 성격의 결과를 내고 서버 버전을 알린다 — 무음 덮어쓰기 금지", () => {
  const tab: Tab = { path: "a.ts", name: "a.ts", dirty: true, baseVersion: 3, readOnly: false, kind: "code" };
  const r = decideSave({ tab, content: "x", serverVersion: 5 });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "conflict");
  assert.equal(!r.ok && r.reason === "conflict" && r.server.version, 5, "서버 버전을 알려야 비교가 된다");
});

test("읽기 전용 탭은 저장이 되지 않는다", () => {
  const tab: Tab = { path: "a.bin", name: "a.bin", dirty: false, baseVersion: 1, readOnly: true, kind: "binary" };
  const r = decideSave({ tab, content: "x" });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "read-only");
});

test("워크스페이스 밖 저장은 거부된다", () => {
  const tab: Tab = { path: "/etc/passwd", name: "passwd", dirty: true, baseVersion: 1, readOnly: false, kind: "code" };
  const r = decideSave({ tab, content: "x", outsideWorkspace: true });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "outside-workspace");
});

test("이미 열려 있는 파일은 중복 탭을 만들지 않는다", () => {
  const tab: Tab = { path: "a.ts", name: "a.ts", dirty: true, baseVersion: 1, readOnly: false, kind: "code" };
  let s: LayoutState = { tabs: [], order: [] };
  s = openTab(s, tab);
  s = openTab(s, { ...tab, dirty: false });
  assert.equal(s.tabs.length, 1, "같은 파일이 두 탭으로 열렸다");
  assert.equal(s.tabs[0].dirty, true, "열기만 했다고 변경 표시가 사라졌다");
});

test("탭을 닫으면 인접한 탭으로 포커스가 간다", () => {
  const mk = (p: string): Tab => ({ path: p, name: p, dirty: false, baseVersion: 1, readOnly: false, kind: "code" });
  let s: LayoutState = { tabs: [], order: [] };
  s = openTab(s, mk("a"));
  s = openTab(s, mk("b"));
  s = openTab(s, mk("c"));
  assert.equal(s.active, "c");
  s = closeTab(s, "b");
  assert.equal(s.active, "c");
  s = closeTab(s, "c");
  assert.equal(s.active, "a", "닫힌 자리에 인접한 탭이 없다");
  s = closeTab(s, "a");
  assert.equal(s.tabs.length, 0);
});

test("저장하지 않은 탭을 찾아낸다 — 종료 전에 반드시 확인한다", () => {
  const mk = (p: string, d: boolean): Tab => ({ path: p, name: p, dirty: d, baseVersion: 1, readOnly: false, kind: "code" });
  let s: LayoutState = { tabs: [], order: [] };
  s = openTab(s, mk("a", true));
  s = openTab(s, mk("b", false));
  s = openTab(s, mk("c", true));
  assert.deepEqual(dirtyTabs(s).map((t) => t.path), ["a", "c"]);
});

test("바이트 표시", () => {
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10.0 MiB");
});
