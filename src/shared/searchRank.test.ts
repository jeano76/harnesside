/** searchRank 순위 검사 — 뒤집으면 실패해야 한다. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankFiles } from "./searchRank.js";

describe("rankFiles 순위", () => {
  it("이름 일치가 경로 일치보다 앞선다", () => {
    const r = rankFiles(["src/web/panels/app.ts", "app.ts"], "app.ts");
    assert.equal(r[0]!.path, "app.ts");
  });
  it("일치하지 않으면 목록에 없다", () => {
    assert.deepEqual(rankFiles(["a.ts", "b.ts"], "zzz"), []);
  });
  it("같은 점수면 짧은 경로가 먼저다", () => {
    const r = rankFiles(["src/web/panels/a.ts", "src/a.ts"], "a.ts");
    assert.equal(r[0]!.path, "src/a.ts");
  });
});
