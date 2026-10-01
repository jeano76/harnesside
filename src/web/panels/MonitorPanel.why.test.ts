/**
 * **모르는 값을 0 으로 두지 않는다** (2026-10-01).
 *
 * 실측 출발점: GPU 사용률이 드라이버 조용 안에서 `[N/A]` 로 왔는데 **0 으로 채워져
 * 들어갔다.** 화면에서 0% 는 "안 쓴다" 로 읽힌다. 실제로는 **몰랐다** 고 말해야 하는
 * 자리였고, 0 은 "알았다" 고 말하는 셈이 된다 — 조용히 실패다.
 *
 * 이상한 것은 이게 **예외**였다는 것이다. 같은 파일의 바로 아래가 이미 이유를 적어
 * 두고 있었다:
 *
 *     // [N/A] 는 계측 불가다 — 0 도로 채우지 않는다(과열이 아니라 미확인).
 *     tempC: num(temp),
 *
 * 규칙은 있었고 **한 필드만 빠졌다.** 그래서 이 검사는 그 필드를 기억하는 대신
 * **규칙을 확인한다** — 다음에 누군가 예외를 추가해도 조용히 안 들어온다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const metrics = read("src/server/metrics.ts");
const shared = read("src/shared/metrics.ts");
const panel = read("src/web/panels/MonitorPanel.tsx");

test("**GPU 사용률**은 `null` 을 받을 수 있다 — 0 은 '안 쓴다' 를 뜻하지 않는다", () => {
  assert.match(shared, /utilPct: number \| null;/, "타입이 아직 number 다 — 0 과 구분 못 한다");
});

test("**계측값을 0 으로 채우지 않는다** — `?? 0` 이 남아 있다", () => {
  // `tempC`·`powerW` 는 이미 `num()` 만 쓴다. `utilPct` 도 같아야 한다.
  assert.match(metrics, /utilPct: num\(util\)/, "utilPct 가 0 으로 채워진다 — 모르는 것이 아는 것처럼 보인다");
  assert.doesNotMatch(metrics, /utilPct: num\(util\) \?\? 0/, "`utilPct` 에 `?? 0` 이 있다");
});

test("이 규칙은 **계측 필드마다** 다르게 적용되지 않는다 — 예외가 다시 생기지 않게", () => {
  // `?? 0` 이 있는 필드를 전부 뽑는다. 다만 **`nvidia-smi` 출력의 문자열 키**는
  // 파싱 대상이 아니라 원본 키(`idle`, `VmRSS`, `Threads`)라 계측치가 아니다 —
  // 그걸 모르면 검사 하나가 **오탐**이 되고, 오탐이 있는 검사는 없는 검사보다 나쁘다.
  const zeroed = [...metrics.matchAll(/(\w+):[^,\n]*\?\?\s*0\b/g)].map((m) => m[1]!);
  const NVSMI_TEXT_KEYS = new Set(["idle", "VmRSS", "Threads", "Processes", "ApplicationsClocks"]);
  // **`0` 이 의미 있는 필드**는 예외다 — 그래야 규칙이 오탐을 안 낸다.
  const ALLOWED = new Set(["memUsedMiB", "memTotalMiB", "cols", "rows", ...NVSMI_TEXT_KEYS]);
  const offenders = zeroed.filter((f) => !ALLOWED.has(f));
  assert.deepEqual(
    offenders,
    [],
    `계측 필드가 0 으로 채워진다 — 미확인(0 과 다름): ${offenders.join(", ")}`,
  );
});

test("**화면**도 `null` 을 0 으로 그리지 않는다 — `toFixed` 가 원인이 된다", () => {
  // `utilPct.toFixed(0)` 을 **가드 없이** 쓰면 null 에서 터진다. 그러면 0 으로 바꿔야
  // 하고, 그러면 **다시** 0 이 보인다.
  //
  // 앞글자로 걸면 **삼항의 참 분기도 걸린다** — 실측: `{utilPct.toFixed(` 의 `}` 가
  // "가드 없는 호출" 로 읽혔다. 그러면 이 검사가 **정상 코드에 실패**하고, 오탐이
  // 있는 검사는 없는 검사보다 나쁘다. 그래서 **삼항의 가드가 앞에 있는지** 로 본다.
  const calls = [...panel.matchAll(/.{0,120}?utilPct\.toFixed\(/g)].map((m) => m[0]);
  assert.ok(calls.length > 0, "GPU 사용률을 그리는 코드가 없다 — 검사가 볼 것이 없다");
  for (const c of calls) {
    assert.match(c, /utilPct === null\s*\?|\?\s*[^:]*\?\s*[^:]*:/, `가드 없이 toFixed — null 을 0 으로 그린다: …${c.slice(-70)}`);
  }
  assert.match(panel, /utilPct === null \? "\?"/, "null 을 `?` 로 그리지 않는다");
});

test("`[N/A]` 를 0 이 아니라 **`null`** 로 읽는다 — 파서가 이미 그렇게 하는데 유지한다", () => {
  const num = /const num = \(v: string \| undefined\) => \{[\s\S]{0,160}?return Number\.isFinite\(n\) \? n : null;/;
  assert.match(metrics, num, "`num()` 이 0 을 돌려준다 — `[N/A]` 가 정상으로 보인다");
});

test("**측정 불가에 사유**를 말한다 — '측정 불가' 만 있으면 무엇을 해야 하는지 모른다", () => {
  assert.match(panel, /why\?: string;/, "Gauge 가 사유를 받지 않는다");
  // "측정 불가" 는 세 가지 다른 상태를 한 문장으로 뭉갠다: 도구 없음 / 아직 첫
  // 표본 없음 / 권한 없음. 사용자는 셋 중 무엇을 해야 하는지 달라서 다르게 대응한다.
  assert.match(panel, /why=\{latest\.gpu \? undefined : "GPU 없음/, "GPU 없음 사유가 없다");
  assert.match(panel, /why=\{latest\.context \? undefined : "작업 중이 아니면/, "컨텍스트 사유가 없다");
  assert.match(panel, /why=\{latest\.gpu\.utilPct === null \? "nvidia-smi/, "GPU 사용률 사유가 없다");
});

test("사유는 **도형만이 아니라** 말로도 전달된다 — `title` 만으로는 부족하다", () => {
  // `aria-label` 에 사유를 넣는다 — 그래야 판독기가 "왜" 를 함께 읽는다.
  assert.match(
    panel,
    /aria-label=\{`\$\{label\}: 측정 불가\$\{why \? ` — \$\{why\}` : ""\}`\}/,
    "aria-label 에 사유가 없다 — 화면은 아는데 판독기는 모른다",
  );
});

test("컨텍스트는 **작업 중에만** 잰다 — 그 밖의 0 은 거짓말이다", () => {
  // 계측은 턴 안에서만 된다. 대화가 멈춘 사이에 0 을 넣으면 "안 쓴다" 고 읽힌다.
  assert.match(
    panel,
    /pct=\{latest\.context\?\.pct \?\? null\}/,
    "컨텍스트가 없는 순간을 0 으로 바꾼다",
  );
});

test("이 검사가 **자기 자신을 속이지 않는다** — 규칙이 조용히 무효가 되면 통과한다", () => {
  // **검사 대상이 아니라 검사 함수다** — 실측에서 `require` 를 테스트 안에서 써서
  // catch 가 조용히 `false` 를 돌려주면 "조건 불만족" 과 "미검사" 가 같아진다.
  // 여기서는 정규식이 **0 을 돌려주는 구현을 실제로 걸러내는지** 로 자기 자신을 본다.
  const re = /const num = \(v: string \| undefined\) => \{[\s\S]{0,160}?return Number\.isFinite\(n\) \? n : null;/;
  const good = "const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : null; };";
  const bad = "const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };";
  assert.equal(re.test(good), true, "자기 규칙이 정당한 구현을 못 잡는다");
  assert.equal(re.test(bad), false, "0 을 돌려주는 구현을 걸러내지 못한다 — 규칙이 무효");
});
