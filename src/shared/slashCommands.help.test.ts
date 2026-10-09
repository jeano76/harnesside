/**
 * `/help` — 이 프로그램의 명령 목록 (2026-10-04 · Q-12 뒤 UX 수정)
 *
 * 왜 이 테스트가 있나: `/help` 와 `/keys` 는 `where: "tui"` 였다. 구 Ink TUI 가
 * 삭제되고(Q-2) **이 명령을 실행할 곳이 하나도 남지 않았다.** 사용자가 `/help` 를
 * 치면 "웹에서 지원하지 않는 명령입니다" 가 답이었다 — 이미 웹 창에 있는 사람이
 * 웹이 명령을 모른다고 들었다. 목록은 화면 어디에도 없었다.
 *
 * 그래서 세 가지를 함께 지킨다:
 *  1. `/help` 가 **웹에서 실제로 실행 가능**하다(`where: "both"`).
 *  2. 목록을 그리는 규칙이 **순수 함수**(`renderHelpText`)로 떨어져 있어 브라우저
 *     없이 출력물을 검사할 수 있다.
 *  3. 그 함수가 **정본을 읽는다** — 본문에 명령을 다시 적지 않는다.
 *
 * ②가 없으면 "출력이 맞는지"를 유닛으로 볼 방법이 없고, ③가 깨지면 목록이
 * 조용히 뒤처진다. 화면에 보이는 목록이라 어긋나면 사용자가 없는 명령을 찾게 되고,
 * 그게 이 저장소에서 가장 많이 기록된 실패 유형이다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SLASH_COMMANDS,
  webSlashCommands,
  parseSlash,
  renderHelpText,
  type SlashCommandDef,
} from "./slashCommands.js";
import { ko } from "../web/i18n/ko.js";

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, "..", "web", "main.tsx"), "utf8");

/** 테스트용 해석기 — 화면과 같은 카탈로그로 푼다. 없는 키는 키 자체(화면과 같은 규칙). */
const tr = (key: string): string => ko[key] ?? key;
const textOf = (all = SLASH_COMMANDS, web = webSlashCommands()): string => renderHelpText(all, web, tr);

test("`/help` 는 웹에서 실행 가능하다 — 실행되는 곳이 없는 명령이면 안 된다", () => {
  const help = SLASH_COMMANDS.find((c) => c.key === "help");
  assert.ok(help, "help 명령이 정본에 없다");
  // `tui` 였던 것을 `both` 로 올리지 않으면, TUI 삭제 후 실행할 곳이 0이 된다.
  assert.notEqual(help.where, "tui", "`/help` 가 아직 TUI 전용이다 — 실행할 곳이 없다");
  assert.ok(
    webSlashCommands().some((c) => c.key === "help"),
    "웹 메뉴에 `/help` 가 뜨지 않는다 — 발견할 방법이 없다",
  );
});

test("`/help` 를 치면 실제로 도는지 — 미지원 문장이 뜨면 안 된다", () => {
  assert.deepEqual(parseSlash("/help"), { key: "help", arg: "" });
  // 실행 경로가 존재한다: runSlash 안에 `help` 분기가 있다.
  assert.match(mainSrc, /key === "help"/, "runSlash 에 help 분기가 없다");
  // 미지원으로 떨어지는 마지막 분기("웹에서 지원하지 않는 명령입니다")에
  // help 가 흘러가지 않는지 — help 분기가 그 **보다 앞에** 있어야 한다.
  const helpAt = mainSrc.indexOf('key === "help"');
  const unsupportedAt = mainSrc.indexOf("웹에서 지원하지 않는 명령입니다");
  assert.ok(helpAt !== -1 && unsupportedAt !== -1, "두 지점 모두 있어야 한다");
  assert.ok(helpAt < unsupportedAt, "help 분기가 미지원 분기보다 뒤에 있다 — 실제로는 거부된다");
});

test("목록을 그리는 규칙은 **한 곳에만** 있다 — 화면에 복제본이 있으면 조용히 뒤처진다", () => {
  // help 분기는 순수 함수를 **호출만** 한다 — 카탈로그 해석기(t)를 넘겨 풀어 그린다.
  assert.match(mainSrc, /done\(renderHelpText\(SLASH_COMMANDS, webSlashCommands\(\), t\)\)/, "help 분기가 renderHelpText(정본, 웹목록, t) 를 쓰지 않는다");
  // 목록 그리기(라벨 정렬·그룹)는 순수 함수 쪽에 있다. 화면에 같은 코드가 있으면
  // 두 벌이 되고 어느 쪽이 진짜인지 아무도 모른다(저장소 규칙 4).
  const helpBranch = mainSrc.slice(mainSrc.indexOf('key === "help"'), mainSrc.indexOf('key === "term"'));
  assert.ok(
    !/padEnd\(/.test(helpBranch),
    "help 분기에 padEnd 가 있다 — 목록 그리기 규칙이 화면에 복제되었다",
  );
  assert.ok(
    !/HELP_GROUPS|\["대화 · 컨텍스트"/.test(helpBranch),
    "help 분기에 그룹 표가 있다 — 목록 그리기 규칙이 화면에 복제되었다",
  );
});

test("**모든 웹 명령의 이름과 설명이 도움말에 나온다** — 없는 명령을 찾지 않게", () => {
  const text = textOf();
  // 정본이 비어 있으면 검사도 통과하므로, 최소 한 개는 있어야 한다.
  assert.ok(webSlashCommands().length > 0, "웹 명령 목록이 비었다");
  for (const c of webSlashCommands()) {
    assert.ok(text.includes(c.label), `도움말에 ${c.label} 이 없다 — 사용자가 있는 줄을 못 찾는다`);
    assert.ok(text.includes(ko[c.descriptionKey] ?? ""), `${c.label} 의 설명(${c.descriptionKey})이 없다`);
  }
});

test("TUI 전용 명령은 **숨기지 않고 왜 안 되는지 말한다**", () => {
  // 조용히 없는 척 하지 않는다(저장소 규칙). 목록에서 빠진 명령이 있으면
  // 그 사실과 이유를 한 줄로 말한다.
  const text = textOf();
  assert.match(text, /이 창에서는 쓸 수 없는 명령/, "TUI 전용 명령의 존재를 사용자에게 말하지 않는다");
  for (const c of SLASH_COMMANDS.filter((c) => c.where === "tui")) {
    assert.ok(text.includes(c.label), `${c.label}(웹에서 못 쓰는 명령)이 도움말에 이름조차 없다`);
  }
});

test("그룹에 못 넣은 명령이 생겨도 **'기타' 로 반드시 보인다** — 조용히 빠지지 않는다", () => {
  const fake: SlashCommandDef[] = [{ key: "brand-new", label: "/brand-new", descriptionKey: "test.brandNew", where: "both" }];
  const fakeTr = (key: string): string => (key === "test.brandNew" ? "새 명령" : tr(key));
  const text = renderHelpText(fake, fake, fakeTr);
  assert.match(text, /기타/, "그룹에 없는 명령이 '기타' 로도, 본문에라도 나타나야 한다");
  assert.ok(text.includes("/brand-new"), "새 명령이 도움말에서 사라졌다");
});

test("`/keys` 는 **여전히 `tui`** — 키바인딩 정본이 없으면 지어내지 않는다", () => {
  const keys = SLASH_COMMANDS.find((c) => c.key === "keys");
  assert.ok(keys, "keys 명령이 정본에 없다");
  // 이걸 `both` 로 올리면 웹에서 실행할 수 없는 명령을 노출하게 된다.
  assert.equal(keys.where, "tui", "`/keys` 가 웹에 노출됐다 — 정본이 아닌 데이터를 보여주게 된다");
  // 키바인딩 정본이 실제로 삭제됐는지 확인한다(있으면 오히려 `both` 가 맞다).
  const gone = !readFileSync(join(here, "slashCommands.ts"), "utf8").includes("KEY_BINDINGS");
  assert.ok(gone, "키바인딩 정본이 사라졌다면 `/keys` 를 웹에 노출하면 안 된다");
});

test("정본의 설명 키는 **전부 사전에 있다** — 화면은 키로만 말한다", () => {
  // `t(c.descriptionKey)` 는 동적 키라 배선 검사(리터럴 스캔)가 못 잡는다.
  // 그래서 여기서 직접 고정한다: 키가 없으면 화면에 키 자체가 나온다.
  const missing = SLASH_COMMANDS.map((c) => c.descriptionKey).filter((k) => !(k in ko));
  assert.deepEqual(missing, [], `사전에 없는 설명 키: ${missing.join(", ")}`);
  for (const k of [
    "slash.help.intro",
    "slash.help.group.dialog",
    "slash.help.group.skills",
    "slash.help.group.models",
    "slash.help.group.cli",
    "slash.help.group.meta",
    "slash.help.other",
    "slash.help.tuiNote",
  ]) {
    assert.ok(k in ko, `도움말 틀 키 누락: ${k}`);
  }
  // `tuiOnly` 는 카운트·라벨 자리표시자를 그대로 둔다 — 순서가 바뀌어도 풀린다.
  assert.match(ko["slash.help.tuiOnly"] ?? "", /\{\{count\}\}.*\{\{labels\}\}/, "tuiOnly 자리표시자가 깨졌다");
});
