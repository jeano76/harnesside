/**
 * 터미널 화면 — **셸이 "멈춘 것처럼" 보이는** 두 가지 버그 (§5.13 / §11.3).
 *
 * ── 버그 1: xterm 이 매 렌더마다 재생성된다 ─────────────────────────────────
 * `XtermPane` 의 `useEffect` deps 에 `onNotice` 가 들어 있다. 부모(`main.tsx`)는
 * **인라인 화살표**를 넘기므로 그 동일성이 매 렌더마다 바뀐다. 그래서 effect 가 계속
 * 다시 돌고, 그 안에서 `t.dispose()` 후 **새 xterm** 을 만든다.
 *
 * 사용자가 보는 symptom:
 *  - 입력한 줄이 **사라진다**(버퍼가 새로 만들어지므로).
 *  - 스크롤 위치가 리셋된다.
 *  - PTY 출력이 **떠오르다 사라진다**(쓰고 있는 xterm 이 dispose 된다).
 *  - `ResizeObserver` 가 매번 새로 붙어 **resize POST** 를 계속 보낸다
 *    (실측: 10초에 17회 — 이것이 재마운트가 돌아가고 있다는 **증거**다).
 *
 * 서버 PTY 는 멀쩡했다(실측: 셸 생성 200 · `echo` 입력 200 · 탭 `running`). 그래서
 * "셸이 고장났다" 는 오진이고, **화면이 매번 새로 만들어지는 것** 이 원인이다.
 *
 * ── 버그 2: 빈 패널에 아무것도 없다 ─────────────────────────────────────────
 * 터미널 패널은 기본으로 **접혀 있다**(z=1). 그런데 화면을 여는 경로가 없어서
 * 사용자는 "터미널이 없다" 고 읽는다. 여는 버튼은 패널 **안쪽**에 있으므로
 * 접힌 패널에서는 **누를 수 없다** — 자기 자신을 열어야 하는 버튼이 자기 안에 있다.
 *
 * 두 버그의 공통점은 "조용하다" 는 것이다. 로그에도 예외도 없다. 그래서 여기서 고정한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dirname, "TerminalView.tsx"), "utf8");

/** 주석을 지운다. 주석 안 예제가 검사에 걸리면 안 된다. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("`XtermPane` 의 effect deps 에 **재렌더를 유발하는 값** 이 없다", () => {
  const c = code(SRC);
  // deps 에 `onNotice` 가 있으면 매 렌더마다 xterm 이 dispose 후 재생성된다.
  assert.ok(!/\],\s*\[[^\]]*\bonNotice\b[^\]]*\]\s*\)/.test(c), "effect deps 에 onNotice 가 있다 — xterm 이 매 렌더 재생성된다");
});

test("안정적인 `notice` 를 **ref** 로 만든다 — 값은 최신, 동일성은 고정", () => {
  const c = code(SRC);
  assert.ok(/useRef\(onNotice\)/.test(c), "onNotice 를 ref 에 담아 안정적인 래퍼를 만들지 않았다");
  assert.ok(/noticeRef\.current\s*=\s*onNotice/.test(c), "ref 가 매 렌더 갱신되지 않는다");
});

test("`onNotice` 를 **직접 호출하지 않는다**", () => {
  const c = code(SRC);
  const direct = [...c.matchAll(/\bonNotice\s*\(/g)].map((m) => m[0]);
  assert.deepEqual(direct, [], "직접 호출이 남아 있다 — deps 를 다시 오염시킨다");
});

test("`newTab` · `close` 의 deps 도 **안정적** 이어야 한다", () => {
  const c = code(SRC);
  assert.ok(!/\[client,\s*onNotice\]/.test(c), "newTab/close 의 deps 에 onNotice 가 있다");
  assert.ok(!/\[client,\s*onNotice[^\]]*\]/.test(c), "deps 에 onNotice 가 남아 있다");
});

test("`xterm` 을 **한 번만** 만든다 — dispose 후 재생성 경로가 없어야 한다", () => {
  const c = code(SRC);
  // dispose 는 unmount 에서만. 스폰 의존성이 바뀌면 dispose 후 다시 만들어야 하지만,
  // 그건 **PTY id** 가 바뀔 때뿐이다 — 그래서 deps 에 `session.id` 만 둔다.
  assert.ok(/t\.dispose\(\)/.test(c), "dispose 가 없다 — 탭을 옮길 때 터미널이 쌓인다");
  const effect = c.slice(c.indexOf("const unsub = subscribeWs"), c.indexOf("const unsub = subscribeWs") + 1200);
  assert.ok(!/t\.dispose\(\)/.test(effect), "WS 구독 근처에 dispose 가 있다 — 정리 위치가 붕괴했다");
});

test("명령 팔레트가 **실제로 무엇을 하나** — 죽은 메뉴가 아니다", () => {
  // 2026-10-01 실측: 팔레트 항목은 `div` 였고 `onClick` 도 `Enter` 처리도 **없었다**.
  // `Command.run` 은 **문자열**이었고 **아무도 실행하지 않았다**. 화면은 정상처럼
  // 목록을 보여줬다 — 조용히 안 되는 메뉴는 죽었다고 알아채기 가장 어렵다.
  //
  // 셸은 이제 항상 하단에 보이므로 "접힌 셸을 여는 법" 을 검사할 필요는 없다.
  // 대신 **메뉴가 실제로 메뉴** 인지 본다.
  const main = code(readFileSync(join(import.meta.dirname, "..", "main.tsx"), "utf8"));
  assert.ok(!/\{hits\.map\(\(h\) => \(\s*<div/.test(main), "팔레트 항목이 여전히 div 다 — 눌러도 아무 일도 없다");
  assert.ok(/\{hits\.map\(\(h\) => \([\s\S]{0,400}?<button/.test(main), "팔레트 항목이 button 이 아니다");
  assert.ok(/h\.cmd\.run\(\)/.test(main), "고른 항목의 run 을 실행하지 않는다");
});

test("`Command.run` 은 **문자열이 아니라 함수**다", () => {
  // 문자열이었다. `grep '\.run' src/web/` 의 결과는 검색 대상 비교뿐이었다.
  const n = code(readFileSync(join(import.meta.dirname, "notify.ts"), "utf8"));
  assert.ok(/run:\s*\(\)\s*=>\s*(?:void|Promise)/.test(n), "run 의 타입이 함수로 바뀌지 않았다");
  assert.ok(!/run:\s*string/.test(n), "run 이 여전히 문자열이다");
});

test("검사는 **매처가 살아 있다** — 정규식이 틀리면 위 검사가 무의미해진다", () => {
  // **배열 안 어디든** `onNotice` 가 있으면 잡는다. 예전 매처는 `], [` 를
  // 요구했는데 deps 배열은 `}, [` 로 시작하므로 **항상 실패**했다 — 그 상태로
  // "매처가 죽었으니 확인" 이라는 검사 자체가 매번 거짓말을 했다.
  const m = /\[[^\]]*\bonNotice\b[^\]]*\]/;
  assert.ok(m.test("[session.id, client, onNotice]"), "매처가 나쁜 deps 를 못 잡는다");
  assert.ok(!m.test("[session.id, client, notice]"), "매처가 좋은 deps 를 실패시킨다");
  // 이 검사는 **패널 바깥 경로**를 본다 — 정규식이 조용히 안 맞으면 무의미해지므로.
  const main = readFileSync(join(import.meta.dirname, "..", "main.tsx"), "utf8");
  const pal = /\{hits\.map\(\(h\) => \([\s\S]{0,400}?<button/;
  assert.ok(pal.test(main), "팔레트 매처가 현재 코드를 못 찾는다");
  assert.ok(!pal.test('{hits.map((h) => (<div'), "팔레트 매처가 div 를 통과시킨다");
});
