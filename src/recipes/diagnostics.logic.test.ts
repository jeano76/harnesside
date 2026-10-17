import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diagnosticsFromFailures,
  diagnosticKey,
  diffDiagnostics,
  shouldSendDiagnosticFeedback,
  formatDiagnosticsBlock,
  formatDiagnosticFeedback,
} from "./diagnostics.js";

const FAILS = [
  { file: "src/a.ts", line: 12, col: 3, severity: "error" as const, rule: "TS2322", message: "bad type" },
  { file: "src/b.ts", line: 5, col: 1, severity: "warning" as const, rule: null, message: "unused" },
];

describe("U-7 diagnostics", () => {
  it("실패 → 진단 (레시피 이름 보존)", () => {
    const ds = diagnosticsFromFailures("typecheck", FAILS);
    assert.equal(ds.length, 2);
    assert.equal(ds[0].source, "typecheck");
  });
  it("키는 레시피와 무관 (같은 문제를 낸 주체가 바뀌어도 같은 문제)", () => {
    const a = diagnosticsFromFailures("r1", FAILS)[0];
    const b = diagnosticsFromFailures("r2", FAILS)[0];
    assert.equal(diagnosticKey(a), diagnosticKey(b));
  });
  it("신규/기존 구분", () => {
    const base = diagnosticsFromFailures("r", [FAILS[1]]);
    const cur = diagnosticsFromFailures("r", FAILS);
    const { newProblems, preExisting } = diffDiagnostics(base, cur);
    assert.equal(newProblems.length, 1);
    assert.equal(newProblems[0].file, "src/a.ts");
    assert.equal(preExisting.length, 1);
  });
  it("피드백 재시도 상한 1", () => {
    assert.equal(shouldSendDiagnosticFeedback(0), true);
    assert.equal(shouldSendDiagnosticFeedback(1), false);
    assert.equal(shouldSendDiagnosticFeedback(5), false);
  });
  it("새 문제 0이면 블록 없음 (빈 블록 금지)", () => {
    assert.equal(formatDiagnosticsBlock([], 12), null);
  });
  it("블록 본문: 새 N · 기존 M (숨김)", () => {
    const ds = diagnosticsFromFailures("r", FAILS);
    const text = formatDiagnosticsBlock(ds, 12);
    assert.ok(text);
    assert.match(text, /만든 문제 2/);
    assert.match(text, /원래 있던 문제 12/);
  });
  it("피드백 본문은 1회성 문구 포함", () => {
    const ds = diagnosticsFromFailures("r", FAILS);
    assert.match(formatDiagnosticFeedback(ds), /한 번만/);
  });
});
