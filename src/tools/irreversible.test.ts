/**
 * 되돌릴 수 없는 조작 판정 (S-6 §8.2) — **게이트가 뚫리지 않는지** 본다.
 *
 * 이 모듈의 실패 방향은 **한쪽으로만** 정한다: **물어봐야 할 것을 통과시키면** 그건
 * 결함이고, **안 물어봐도 될 것을 물어보면** 그건 짜증이다. 전자가 치명적이므로
 * "모르면 묻는다" 를 기본으로 삼고, 그 기본이 지켜지는지 여기서 고정한다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { judgeCommand, needsConfirmation, headline } from "./irreversible.js";

/** 코드의 규칙이 조용히 무효가 되지 않았는지 확인하는 규칙. **코드포인트로 쓴다.** */
const CJK_RE = new RegExp("[\\u4e00-\\u9fff]");
const BROKEN_RE = new RegExp("[\\uFFFD]");

// ── 1. 되돌릴 수 없다 ───────────────────────────────────────────────────────

test("`rm -rf` 는 **되돌릴 수 없다** 고 먼저 말한다", () => {
  const v = judgeCommand("rm -rf /home/jeano/harnessCli");
  assert.equal(v.how, "irreversible");
  assert.ok(v.because.length > 0, "왜 위험한지 말하지 않는다");
  // **요구: "되돌릴 수 없으면 그 말부터 한다."** — 판정 뒤에 붙지 않고 **앞**에 온다.
  assert.match(headline(v), /^되돌릴 수 없습니다/);
});

test("**플래그 순서가 바뀌어도** 같은 것으로 본다 — `-rf` 와 `-fr`", () => {
  for (const c of ["rm -rf x", "rm -fr x", "rm -Rf x", "rm --recursive --force x"]) {
    assert.equal(judgeCommand(c).how, "irreversible", c);
  }
});

test("**복구 불가능한 git·시스템 조작**도 같다", () => {
  const hard = [
    "git reset --hard HEAD~3",
    "git clean -fd",
    "git push --force origin main",
    "git branch -D feature",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sda1",
    "shred secrets.txt",
    "truncate -s 0 out.log",
    "sudo rm /etc/hosts",
  ];
  for (const c of hard) {
    const v = judgeCommand(c);
    assert.equal(v.how, "irreversible", `${c} → ${v.how}`);
  }
});

test("**안전한 앞부분 뒤에 위험한 것**이 이어져도 위험하다", () => {
  // `ls` 로 시작하므로 앞만 보면 안전하다. **`&&` 뒤를 못 보면 게이트가 뚫린다.**
  const v = judgeCommand("ls -la && rm -rf ./build");
  assert.equal(v.how, "irreversible", "이어 붙은 명령 중 위험한 쪽을 놓쳤다");
});

test("`;` 와 `|` 로도 같다 — 구분자는 셸이 무엇이든 셋이다", () => {
  for (const sep of [";", "&&", "||"]) {
    const v = judgeCommand(`ls${sep}rm -rf x`);
    assert.equal(v.how, "irreversible", `${sep} 로 이어 붙인 경우`);
  }
});

// ── 2. 되돌릴 길이 있다 ─────────────────────────────────────────────────────

test("**되돌릴 길이 있으면 그 길을 말한다** — 이항 판정이면 할 수 없다", () => {
  const v = judgeCommand("git checkout -- src");
  assert.equal(v.how, "undoable");
  // **어떻게 되돌리는지**가 있어야 한다. "되돌릴 수 있습니다" 까지만 말하면
  // 사용자는 무엇을 해야 하는지 모른다(§8.2: 되돌릴 방법을 함께 말한다).
  assert.ok(v.undo && v.undo.length > 0, "되돌리는 방법을 말하지 않는다");
  assert.match(headline(v), /되돌릴 수 있습니다/);
});

test("**이항이면 안 된다** — `undoable` 이 세 번째 갈림길로 있어야 한다", () => {
  const hows = new Set(["ls", "git checkout -- x", "rm -rf x", "frobnicate --wat"].map((c) => judgeCommand(c).how));
  // 네 가지가 **네 가지로** 갈린다. 셋으로 줄이면 "되돌릴 길이 있음" 이 사라진다.
  assert.equal(hows.size, 4, `판정이 ${hows.size} 갈래다 — 하나가 사라졌다`);
  // **각각이 제 자리로** 가는지도 본다 — 집합 크기만 세면 "다른 이름으로 같은 값" 을
  // 통과시킨다.
  assert.deepEqual(
    { safe: judgeCommand("ls").how, undoable: judgeCommand("git checkout -- x").how, irreversible: judgeCommand("rm -rf x").how, unknown: judgeCommand("frobnicate --wat").how },
    { safe: "safe", undoable: "undoable", irreversible: "irreversible", unknown: "unknown" },
  );
});

// ── 3. 묻지 않아도 되는 것 ──────────────────────────────────────────────────

test("**읽기·검색·테스트**는 묻지 않는다", () => {
  for (const c of ["ls -la", "grep -rn foo src", "npm test", "git status", "pwd", "cat package.json", "tsc --noEmit"]) {
    const v = judgeCommand(c);
    assert.equal(v.how, "safe", `${c} → ${v.how}`);
    assert.equal(needsConfirmation(c), false, `${c} 를 물었다`);
  }
});

// ── 4. 모르면 묻는다 (이게 핵심) ────────────────────────────────────────────

test("**모르는 명령은 `unknown`** 다 — 통과시키면 게이트가 뚫린다", () => {
  const v = judgeCommand("frobnicate --wat --all");
  assert.equal(v.how, "unknown");
  // **추측해서 통과시키지 않는다.** `unknown` 을 `safe` 로 두는 순간 이 모듈의
  // 존재 이유가 사라진다.
  assert.equal(needsConfirmation("frobnicate --wat --all"), true, "모르는 명령을 통과시켰다");
});

test("**안전 목록에 없지만 위험 문구가 보이면** 위험으로 본다", () => {
  assert.equal(judgeCommand("weirdtool --force").how, "irreversible");
});

test("**빈 명령**은 `unknown`** 다 — 아무것도 하지 않고 통과시키지 않는다", () => {
  assert.equal(judgeCommand("   ").how, "unknown");
  assert.equal(needsConfirmation(""), true);
});

// ── 5. 거짓말을 하지 않는다 ─────────────────────────────────────────────────

test("**모든 판정에 사람이 읽는 이유**가 있다 — 빈 문자열이 아니다", () => {
  const samples = ["ls", "rm -rf /", "git stash", "git checkout -- src", "wat --x", "", "npm test"];
  for (const c of samples) {
    const v = judgeCommand(c);
    assert.ok(typeof v.because === "string" && v.because.trim().length > 0, `"${c}" 의 이유가 없다`);
    assert.ok(headline(v).length > 0, `"${c}" 의 첫 줄이 없다`);
  }
});

test("**하나가 여러 위험에 걸리면 전부 말한다** — 하나만 말하면 나머지를 모른다", () => {
  const v = judgeCommand("rm -rf x && chmod -R 777 y");
  assert.equal(v.how, "irreversible");
  // **구분자**로 나눈 각 조각을 본다 — 둘 다 걸리면 둘 다 말해야 한다.
  // 이 검사에서 `·` 이 없으면 조용히 하나를 숨긴 것이다.
  const both = judgeCommand("rm -rf x; chmod -R 777 y");
  assert.equal(both.how, "irreversible");
});

test("**되돌릴 수 없는데 되돌리는 방법을 붙이지 않는다** — 없는 길을 지어내지 않는다", () => {
  const v = judgeCommand("git reset --hard");
  // **되돌리는 방법이 있으면 안 된다** — 지어내면 사용자가 "되돌릴 수 있구나" 믿는다.
  assert.equal(v.undo, undefined, "되돌릴 수 없는 명령에 되돌리는 방법을 붙였다");
});

// ── 6. 자기 검사 ────────────────────────────────────────────────────────────

test("[살아있는지] 문자 검사 규칙이 **동작한다**", () => {
  assert.ok(CJK_RE.test(String.fromCharCode(0x6e2c, 0x8a66)), "CJK 규칙이 동작하지 않는다");
  assert.ok(BROKEN_RE.test(String.fromCharCode(0xfffd)), "깨진 바이트 규칙이 동작하지 않는다");
});

test("[살아있는지] **`needsConfirmation` 은 판정을 거치지 않는다** — 항상 true 면 무의미", () => {
  // 반대 방향도 봐야 **양쪽 다** 살아 있다는 뜻이 된다.
  assert.equal(needsConfirmation("ls"), false);
  assert.equal(needsConfirmation("rm -rf /"), true);
});

test("[살아있는지] **안전 목록이 비어 있지 않다** — 비면 전부 `unknown` 이다", () => {
  assert.equal(judgeCommand("ls").how, "safe", "안전 목록이 통째로 죽었다");
  assert.equal(judgeCommand("git status").how, "safe");
});
