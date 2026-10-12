/**
 * 기호 정의·참조 **배선** 고정 (§7.1 2단계).
 *
 * 지난 라운드 교훈: 게이트·셸출력이 "코드는 있는데 화면·루프에 안 붙어" 있었다.
 * 여기서도 같은 실패를 막는다 — 라우트(`index.ts`)와 화면(`FilePreview.tsx`)이
 * 실제로 붙어 있는지 소스 스캔으로 고정한다. 동작 자체는 `symbolsTs.test.ts` 와
 * 브라우저 실측이 본다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

describe("symbols definition wiring", () => {
  it("라우트가 정의·참조 둘 다 있다", () => {
    const src = read("index.ts");
    assert.match(src, /\/api\/fs\/definition/, "definition 라우트가 없다 — 화면이 부를 곳이 없다");
    assert.match(src, /\/api\/fs\/references/, "references 라우트가 없다");
    assert.match(src, /getDefinition/, "라우트가 getDefinition 을 쓰지 않는다");
    assert.match(src, /getReferences/, "라우트가 getReferences 를 쓰지 않는다");
  });
  it("범위 밖 줄·열은 400이다 (빈 목록으로 속이지 않는다)", () => {
    const src = read("index.ts");
    assert.match(src, /line·col 은 1 이상 정수/, "400 검증 문구가 없다 — 조용히 빈 목록을 줄 수 있다");
  });
  it("FilePreview 가 정의 API 를 부르고 available:false 를 말한다", () => {
    const src = readFileSync(join(here, "..", "web", "panels", "FilePreview.tsx"), "utf8");
    assert.match(src, /\/api\/fs\/definition/, "화면이 definition 을 부르지 않는다 — 배선이 끊겼다");
    assert.match(src, /\/api\/fs\/references/, "화면이 references 를 부르지 않는다");
    assert.match(src, /available/, "available:false(typescript 없음)를 처리하지 않는다 — 조용히 빈 화면이 된다");
    assert.match(src, /추측하지 않/, "빈 결과를 지어내지 않는다는 말을 화면이 하지 않는다");
  });
  it("FilePreview 가 키워드·문자열 클릭을 보내지 않는다", () => {
    const src = readFileSync(join(here, "..", "web", "panels", "FilePreview.tsx"), "utf8");
    assert.match(src, /isJumpableKind/, "토큰 가드 없이 전부 요청하면 빈 정의가 돌아온다");
  });
});
