/**
 * ModelPanel 의 콜백 안정성 — **무한 요청 루프**를 막는다.
 *
 * 실측(2026-09-30): `ModelPanel` 이 열린 상태에서 `/api/models` 가 5초에 **3303회**
 * 호출됐다. 원인은 부모가 인라인 화살표를 넘겨 `onNotice` 의 동일성이 매 렌더마다
 * 바뀌고, `loadLocal` 이 그것을 의존하므로 `useEffect` 가 계속 다시 돌았기 때문이다.
 *
 *     setState → 렌더 → 새 콜백 → useEffect → 요청 → setState → …
 *
 * 눈에 보이지 않는다. 서버 로그에도 에러가 없다. 그런데 서버를 5초마다 3303회 때린다.
 * §11.3 이 forbid 하는 것은 "멈춘 것처럼 보이는 것" 이지만, 이건 그 반대 — 멈추지
 * 않는 것이고 그것도 이상이다.
 *
 * 그래서 여기서는 **React 를 렌더하지 않고** 의존성 규칙만 고정한다. deps 배열에
 * `onNotice` 가 다시 들어오면 이 테스트가 실패한다 — 렌더 없이도.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dirname, "ModelPanel.tsx"), "utf8");

/** 주석을 지운다 — 주석 안 예제가 검사에 걸리면 안 된다. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("`useEffect` 의 deps 에 **재렌더를 유발하는 값** 이 없다", () => {
  const c = code(SRC);
  // `loadLocal` 이 deps 에 무엇이 들어가는지 본다. `onNotice` 는 부모가 새로 만든다.
  const effect = /useEffect\(\s*\(\)\s*=>\s*\{\s*void loadLocal\(\);?\s*\}\s*,\s*\[loadLocal\]\s*\)/.test(c);
  assert.ok(effect, "loadLocal 을 부르는 useEffect 의 형태가 바뀌었다 — deps 를 다시 확인하십시오");
  // 핵심: `onNotice` 가 deps 에 없어야 한다. 있으면 매 렌더마다 effect 가 다시 돈다.
  assert.ok(!/\[client,\s*onNotice[^\]]*\]/.test(c), "deps 에 onNotice 가 있다 — 매 렌더마다 재실행된다");
  assert.ok(!/\[client,\s*q,\s*onNotice\]/.test(c), "search 의 deps 에 onNotice 가 있다");
  assert.ok(!/\[client,\s*onNotice/.test(c), "download/activate 의 deps 에 onNotice 가 있다");
});

test("안정적인 `notice` 를 **ref** 로 만든다 — 값은 최신, 동일성은 고정", () => {
  const c = code(SRC);
  assert.ok(/useRef\(onNotice\)/.test(c), "onNotice 를 ref 에 담아 안정적인 래퍼를 만들지 않았다");
  assert.ok(/noticeRef\.current\s*=\s*onNotice/.test(c), "ref 가 매 렌더 갱신되지 않는다 — 값이 stale 이 된다");
  // notice 는 deps 가 비어 있어야 한다. deps 가 있으면 ref 를 쓴 의미가 없다.
  // 실코드는 `noticeRef.current(...),\n    [],\n  )` — **쉼표가 하나 있다** 그래서
  // `[]` 뒤에 `,` 가 오도록 매처를 쓴다. 여기서 매처를 잘못 쓰면 검사가 "안전" 이 된다.
  assert.ok(
    /noticeRef\.current\([^)]*\),\s*\[\]\s*,?\s*\)/.test(c),
    "notice 의 deps 가 비어 있지 않다",
  );
});

test("`onNotice` 를 **직접 호출하지 않는다** — 오류 경로도 `notice` 를 쓴다", () => {
  const c = code(SRC);
  // 프로프 타입 선언(`onNotice,` 등)과 `<UpdateSection onNotice=` 만 남아야 한다.
  const direct = [...c.matchAll(/onNotice\s*\(/g)].map((m) => m[0]);
  assert.deepEqual(direct, [], "직접 호출이 남아 있다 — 그 경로는 deps 를 다시 오염시킨다");
});

test("자식(`UpdateSection`)에도 **안정적인** 콜백을 넘긴다", () => {
  const c = code(SRC);
  assert.ok(/<UpdateSection[^>]*onNotice=\{notice\}/.test(c), "UpdateSection 에 원래 onNotice 를 넘긴다 — 그 안에서 같은 순환이 시작된다");
});

test("매처가 **살아 있는지** 확인한다 — 정규식이 틀리면 위 검사가 조용히 무의미해진다", () => {
  // 이 검사는 매처가 **살아 있는지** 확인한다 — 앞의 세 검사가 전부 정규식이므로
  // 매처가 잘못되면 그들은 "패스" 로 떨어진다(검사가 조용히 무의미해진다).
  const m = /noticeRef\.current\([^)]*\),\s*\[\]\s*,?\s*\)/;
  assert.ok(m.test('const x = useCallback((a) => noticeRef.current(a), []);'), "매처가 정상 코드를 못 찾는다");
  assert.ok(!m.test('const x = useCallback((a) => noticeRef.current(a), [onNotice]);'), "deps 가 있는 코드를 통과시킨다");
  assert.ok(!m.test('const x = useCallback((a) => noticeRef.current(a);'), "안 닫힌 형태를 통과시킨다");
});
