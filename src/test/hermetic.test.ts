/**
 * **테스트가 머신을 테스트하지 않는지** 확인한다 (§10.2 · §10.6).
 *
 * 실제로 겪은 일: CI 를 붙이고 처음으로 돌렸더니 **로컬에서는 1071개가 전부
 * 통과하는데 러너에서 3개가 깨졌다.** 전부 같은 종류였다 — 테스트가
 * "이 머신에 llama.cpp 가 있다" / "이 머신에 git 정체성이 있다" / "이 머신의
 * 8080 포트가 비어 있다" 를 **암묵적으로 가정**하고 있었다.
 *
 * 그런 테스트는 통과할 때만 유효하다. 개발자는 자기 머신에서만 돌리므로 영원히
 * 못 보고, **CI 에서 처음 드러났을 때는 이미 프로덕션에 나간 뒤**다.
 *
 * 이 검사는 그 재발을 막는다: 특정 환경 변수를 **빈 값/없는 경로** 로 강제로
 * 만든 뒤 같은 테스트가 여전히 통과하는지 본다. 통과하면 그 테스트는 주입된
 * 값만 보고 있다는 뜻이고, 깨지면 머신에 의존하고 있다는 뜻이다.
 *
 * 왜 프로세스를 새로 띄우지 않는가: `tsx --test` 는 파일 단위로 실행되므로
 * 환경 주입을 파일 안에서 할 수 없다. 그래서 **검사 대상 테스트가 스스로**
 * 이 조건에서 돌았는지 파일 안에서 확인한다(hermetic 자가 검사).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 이 파일은 `src/test/` 에 있다 — 저장소 루트로 **두 단계** 올라간다.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** bootstrap 계열 테스트가 주입해야 할 llama 경로 변수. */
const LLAMA_ENV = "HARNESSIDE_LLAMA_SERVER";

async function src(...p: string[]): Promise<string> {
  return readFile(join(ROOT, ...p), "utf8");
}

test("bootstrap 테스트는 llama 바이너리를 **주입**한다", async () => {
  // `findLlamaServer` 는 이 머신의 실제 설치를 찾는다. 주입이 없으면
  // "llama.cpp 가 있는 머신" 에서만 통과한다(CI 러너에서 드러남).
  for (const f of ["src/server/bootstrap.test.ts", "src/setup/bootstrap.config.test.ts"]) {
    const body = await src(f);
    assert.match(body, new RegExp(LLAMA_ENV), `${f} 가 ${LLAMA_ENV} 를 주입하지 않는다 — 이 머신에 llama.cpp 가 있어야만 통과한다`);
    // 주입값이 **존재하지 않는 경로**여서는 안 된다 — 그래야 "찾았다" 가 아니라
    // "주입받았다" 다.
    // `writeFakeExe` 는 `testSupport.ts` 의 같은 일(실행 가능한 가짜를 실제로 쓴다)이다 — Q-1 로 옮겨 온
    // 강한 판본의 테스트가 이 헬퍼를 쓴다(플랫폼별 실행 파일 형식까지 맞춰 준다).
    assert.match(body, /writeFile\(fakeLlama|writeFile\(fakeBin|writeFakeExe\(/, `${f} 가 가짜 바이너리를 만들지 않는다`);
  }
});

test("bootstrap 테스트는 **가짜 서버 탐지**를 주입한다", async () => {
  // 이걸 빠뜨리면 테스트가 8080 을 실제로 두드린다. 로컬엔 아무것도 없어서
  // 조용히 통과하고, 러너에 뭐가 떠 있으면 "기존 서버 채택" 경로로 들어간다.
  //
  // `src/server/bootstrap.test.ts` 는 단계 [6] 이 이제 **탐지부터** 하므로 더 위험하다.
  // 주입 형태는 둘이다 — 매 호출에 `async () => null` 을 직접 넣거나,
  // 파일 안의 별칭(`noServer`)을 쓴다. 어느 쪽이어도 "없음" 이라고 말해야 한다.
  for (const f of [
    "src/setup/bootstrap.config.test.ts",
    "src/setup/bootstrap.order.test.ts",
    "src/server/bootstrap.test.ts",
    "src/server/bootstrap.adopt.test.ts",
  ]) {
    const body = await src(f);
    assert.match(body, /detectServer:/, `${f} 가 detectServer 를 주입하지 않는다 — 진짜 네트워크를 본다`);
  }

  // `src/server/` 쪽은 **"없음"** 을 말해야 한다. 이 파일들이 다루는 대상이 스폰 경로라서,
  // 진짜 8080 에 뭐가 떠 있으면 조용히 채택 경로로 넘어가 **다른 것을** 검증한다.
  // `src/setup/` 쪽은 반대다 — 거기가 바로 "이미 있는 서버" 를 주입하는 대상이다.
  for (const f of ["src/server/bootstrap.test.ts", "src/server/bootstrap.adopt.test.ts"]) {
    const body = await src(f);
    const inline = /detectServer:\s*async \(\)\s*=>\s*null/.test(body);
    const alias = /const\s+noServer\s*=\s*async \(\)\s*=>\s*null/.test(body);
    assert.ok(inline || alias, `${f} 의 detectServer 가 "없음" 을 말하지 않는다 — 진짜 8080 을 채택할 수 있다`);
  }
});

test("git 테스트는 **정체성**을 자식 프로세스에 전달한다", async () => {
  // pull() 은 자식에서 git 을 돌린다. 테스트의 `g()` 만 env 를 가지면
  // pull 은 머신의 전역 설정을 사용한다 — 러너에는 그게 없어서 병합 커밋이
  // "Author identity unknown" 으로 실패하고, 그건 **충돌이 아닌 오류** 다.
  const body = await src("src/git/sync.test.ts");
  assert.match(body, /Object\.assign\(process\.env/, "git 테스트가 process.env 에 정체성을 심지 않는다 — pull 이 머신 설정에 의존한다");
  assert.match(body, /GIT_AUTHOR_EMAIL/, "GIT_AUTHOR_EMAIL 이 없다");
  assert.match(body, /GIT_COMMITTER_EMAIL/, "GIT_COMMITTER_EMAIL 이 없다");
});

test("하드웨어를 주입하지 않은 **실제** 부팅 호출은 없어야 한다", async () => {
  // `detectHardware` 를 그대로 쓰면 CPU 코어 수·RAM·GPU 개수가 테스트 결과에 들어간다.
  // 이 머신은 12코어/GPU 1개, 러너는 4코어/GPU 0개 — 값이 다르면 assertion 이 깨진다.
  //
  // 예외는 `dryRun` 이다. `--dry` 의 계약이 "부수효과 0 · 하드웨어 탐지조차 하지 않음"
  // 이므로, 거기는 하드웨어를 넣어도 넣지 않아도 머신에 의존하지 않는다.
  const body = await src("src/server/bootstrap.test.ts");
  const re = /bootstrap\(\{([\s\S]{0,400}?)\}\)/g;
  const bad: string[] = [];
  let total = 0;
  for (const m of body.matchAll(re)) {
    total++;
    const args = m[1];
    if (args.includes("dryRun: true")) continue;
    if (!args.includes("hardware:")) {
      const head = args.split("\n").slice(0, 4).join(" ").replace(/\s+/g, " ");
      bad.push(`hardware 없이 실제 부팅: ${head.slice(0, 90)}`);
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
  assert.ok(total >= 8, `bootstrap 호출이 ${total}번뿐이다 — 검사가 볼 것이 없다`);
});

test("dryRun 은 하드웨어를 **탐지하지 않는다** — 부수효과 0 (§3.2)", async () => {
  const body = await src("src/server/bootstrap.ts");
  // **호출부** 를 비교해야 한다. `import { detectHardware }` 는 파일 맨 위(16행)에
  // 있어서 import 기준으로 비교하면 항상 "dryRun 이 뒤다" 라는 잘못된 결론이 나온다
  // — 실제로 그랬다.
  const dryIdx = body.indexOf("if (opts.dryRun)");
  const hwCallIdx = body.indexOf("await detectHardware(");
  assert.ok(dryIdx > 0, "dryRun 분기를 찾지 못했다");
  assert.ok(hwCallIdx > 0, "detectHardware 호출부를 찾지 못했다");
  assert.ok(dryIdx < hwCallIdx, "dryRun 분기가 하드웨어 탐지보다 뒤에 있다 — --dry 가 하드웨어를 읽는다");
});

test("직접 네트워크를 두드리는 테스트는 **없어야** 한다", async () => {
  // 127.0.0.1 을 테스트가 직접 fetch 하면 "지금 이 머신에 뭐가 떠 있는가" 를
  // 검증하는 것이 된다. 주입 seam(detectServer, fetchImpl, probe) 을 써야 한다.
  for (const f of ["src/git/sync.test.ts", "src/server/gitDiff.ts", "src/server/gitDiff.test.ts", "src/setup/bootstrap.config.test.ts"]) {
    const body = await src(f);
    assert.equal(
      /fetch\(\s*["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/.test(body),
      false,
      `${f} 가 외부 네트워크를 직접 건드린다`,
    );
  }
});
