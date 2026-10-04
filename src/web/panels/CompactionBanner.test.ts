/** 압축 UI 배선 검사 — 시작·요약이 화면에 있어야 한다. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const panel = readFileSync(join(ROOT, "src/web/panels/AgentPanel.tsx"), "utf8");
const main = readFileSync(join(ROOT, "src/web/main.tsx"), "utf8");

describe("압축 UI 배선", () => {
  it("배너가 시작·완료·실패를 구분한다", () => {
    assert.match(panel, /function CompactionBanner/, "배너 컴포넌트가 없다");
    assert.match(panel, /압축 중/, "진행 표시가 없다 — 멈춘 것처럼 보인다");
    assert.match(panel, /잊혀진 내용/, "잊혀진 목록이 없다");
  });
  it("main이 compaction 이벤트를 블록으로 쌓지 않는다", () => {
    assert.match(main, /agent\.compaction/, "이벤트 분기가 없다");
    assert.match(main, /setCompaction/, "상태가 없다");
  });
  it("요약 본문을 보여준다 — 없으면 블랙박스다", () => {
    assert.match(panel, /info\.summary/, "요약 본문 렌더가 없다");
  });
});
