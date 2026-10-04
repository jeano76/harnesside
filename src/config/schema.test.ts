/**
 * 설정 스키마 테스트 (§5.13 · §6.4 · §10.2).
 *
 * 두 가지를 특히 검증한다:
 *  1. **모든 항목이 rationale 을 가진다** — §5.13 이 요구하는 3요소 중 하나다.
 *  2. **병합이 중첩을 보존**한다 — 얕은 병합은 앞 단계 키를 통째로 날린다(§6.4).
 *     원본 `config.ts` 에서 이미 그 버그가 났고, 프로젝트 설정을 켰더니 전역
 *     설정이 통째로 사라졌다.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SETTINGS,
  SETTINGS_BY_KEY,
  SECTIONS,
  SCHEMA_VERSION,
  resolveSettings,
  coerce,
  describeSetting,
  settingsMissingRationale,
  bySection,
  envNameFor,
  preserveUnknown,
  unknownKeys,
  PROVENANCE_KO,
  type SectionId,
} from "./schema.js";

test("**모든 항목에 rationale(왜 이 값인가)** 이 있다 — §5.13 요구", () => {
  assert.deepEqual(settingsMissingRationale(), [], `근거가 없는 항목: ${settingsMissingRationale().join(", ")}`);
});

test("§5.13 의 **6개 섹션** 이 모두 있다", () => {
  const ids = SECTIONS.map((s) => s.id);
  assert.deepEqual(ids, ["model", "browser", "agent", "log", "update", "advanced"]);
  for (const s of SECTIONS) {
    assert.ok(s.title.length > 0, `${s.id} 에 제목이 없다`);
    assert.ok(s.reason.length > 8, `${s.id} 에 근거가 없다`);
  }
  // 모든 항목이 어느 섹션에든 속해야 한다
  const valid = new Set<SectionId>(ids);
  for (const s of SETTINGS) assert.ok(valid.has(s.section), `${s.key} 의 섹션 ${s.section} 이 정의되지 않았다`);
});

test("기본값이 **요구사항과 일치**한다 — 근거 없는 기본값은 안 된다", () => {
  // §4.7 / 사용자의 원래 요청: 브라우저 GPU 는 꺼짐
  assert.equal(SETTINGS_BY_KEY["browser.gpu"].default, "off");
  // §5.3 + 패널 개선(2026-10-01 Thinking 상시): thinking 기본 ON
  assert.equal(SETTINGS_BY_KEY["agent.enableThinking"].default, true);
  // §5.12: 로그 상한 50만 자
  assert.equal(SETTINGS_BY_KEY["log.maxChars"].default, 500_000);
  // §7.2: Ornith 고정
  assert.equal(SETTINGS_BY_KEY["model.pinnedFamily"].default, "Ornith");
  // §5.13.1: 자동 설치 기본 금지
  assert.equal(SETTINGS_BY_KEY["update.autoInstall"].default, false);
  // M1: 세션 닫힘 무관
  assert.equal(SETTINGS_BY_KEY["log.level"].default, "info");
});

test("GPU 기본값의 rationale 은 **실측 근거**를 말한다", () => {
  const r = SETTINGS_BY_KEY["browser.gpu"].rationale;
  assert.match(r, /기본 꺼짐/);
  assert.match(r, /VRAM/);
  // 사용자가 이 화면만 보고도 "왜 꺼져 있지" 를 이해할 수 있어야 한다
  assert.ok(r.includes("285") || r.includes("7,278"), `실측 수치가 없다: ${r}`);
});

test("범위를 벗어나는 값은 **경계로** 좁힌다 — 버리면 안 된다", () => {
  const big = SETTINGS_BY_KEY["log.maxChars"];
  assert.equal(coerce(big, 999_999_999), big.max, "상한을 넘겨도 그대로 들어간다");
  assert.equal(coerce(big, -5), big.min);
  assert.equal(coerce(big, "abc"), big.default, "쓰레기 값은 기본값으로");
  assert.equal(coerce(big, "300000"), 300_000);
  const port = SETTINGS_BY_KEY["model.port"];
  assert.equal(coerce(port, 80), 1024, "1024 미만 포트를 받아들였다");
});

test("enum 은 **정의된 값만** — 오타가 조용히 기본값이 되면 안 된다", () => {
  const ch = SETTINGS_BY_KEY["update.channel"];
  assert.equal(coerce(ch, "nightly"), "nightly");
  assert.equal(coerce(ch, "nightley"), "stable");
  const gpu = SETTINGS_BY_KEY["browser.gpu"];
  assert.equal(coerce(gpu, "OFF"), "off");
  assert.equal(coerce(gpu, "on"), "on");
});

test("string[] 는 배열·CSV·빈값을 모두 받는다", () => {
  const al = SETTINGS_BY_KEY["agent.approvalAllowlist"];
  assert.deepEqual(coerce(al, ["a", "b"]), ["a", "b"]);
  assert.deepEqual(coerce(al, "a, b , c"), ["a", "b", "c"]);
  assert.deepEqual(coerce(al, ""), [], "빈 문자열이 빈 배열이 아니다");
  assert.deepEqual(coerce(al, 123), al.default);
});

test("boolean 은 '1'/'true' 를 받는다 — 환경변수는 문자열이니까", () => {
  const t = SETTINGS_BY_KEY["update.autoInstall"];
  assert.equal(coerce(t, "true"), true);
  assert.equal(coerce(t, "1"), true);
  assert.equal(coerce(t, "false"), false);
  assert.equal(coerce(t, ""), false);
  assert.equal(coerce(t, true), true);
});

test("병합 우선순위: 전역 ← 프로젝트 ← **환경변수**", () => {
  const r = resolveSettings({
    global: { "log.maxChars": 100_000 },
    project: { "log.maxChars": 200_000 },
    env: { HARNESSIDE_LOG_MAXCHARS: "300000" },
  });
  assert.equal(r["log.maxChars"].value, 300_000);
  assert.equal(r["log.maxChars"].provenance, "env");
  assert.equal(r["log.maxChars"].source, PROVENANCE_KO.env);
  // 환경변수를 빼면 프로젝트
  const r2 = resolveSettings({ global: { "log.maxChars": 100_000 }, project: { "log.maxChars": 200_000 } });
  assert.equal(r2["log.maxChars"].value, 200_000);
  assert.equal(r2["log.maxChars"].provenance, "project");
  // 프로젝트도 없으면 전역
  const r3 = resolveSettings({ global: { "log.maxChars": 100_000 } });
  assert.equal(r3["log.maxChars"].value, 100_000);
  assert.equal(r3["log.maxChars"].provenance, "global");
  // 아무것도 없으면 기본값
  const r4 = resolveSettings();
  assert.equal(r4["log.maxChars"].value, SETTINGS_BY_KEY["log.maxChars"].default);
  assert.equal(r4["log.maxChars"].provenance, "default");
});

test("**부분 병합이 다른 항목을 날리지 않는다** — 원본 config.ts 의 버그", () => {
  // 프로젝트가 딱 한 항목만 재정의하는데, 전역의 다른 항목이 사라지면 안 된다
  const r = resolveSettings({
    global: { "log.maxChars": 100_000, "log.level": "warn", "model.port": 9090 },
    project: { "log.maxChars": 200_000 },
  });
  assert.equal(r["log.maxChars"].value, 200_000);
  assert.equal(r["log.level"].value, "warn", "전역 설정이 날아갔다");
  assert.equal(r["log.level"].provenance, "global");
  assert.equal(r["model.port"].value, 9090);
});

test("`envOverridable: false` 항목은 **환경변수를 무시**한다", () => {
  // log.maxChars 는 envOverridable 이 기본(true)이므로 반영된다
  const r = resolveSettings({ env: { HARNESSIDE_LOG_MAXCHARS: "300000" } });
  assert.equal(r["log.maxChars"].value, 300_000);
  assert.equal(r["log.maxChars"].provenance, "env");
  // **자동 설치는 환경변수로 켤 수 없다** — 스크립트에 남은 값 하나가 IDE 를
  // 자동 재시작시키면, 실패했을 때 돌아갈 곳이 없다.
  const r2 = resolveSettings({ env: { HARNESSIDE_UPDATE_AUTOINSTALL: "true" } });
  assert.equal(r2["update.autoInstall"].value, false, "자동 설치가 환경변수로 켜졌다 — 위험");
  assert.equal(r2["update.autoInstall"].provenance, "default");
  // 다른 항목은 여전히 환경변수로 조정된다
  const r3 = resolveSettings({ env: { HARNESSIDE_MODEL_PORT: "9091" } });
  assert.equal(r3["model.port"].value, 9091);
});

test("위험 항목은 **danger** 로 표시된다 — 확인 없이 실행되면 안 된다", () => {
  const dangers = SETTINGS.filter((s) => s.danger);
  assert.ok(dangers.length > 0, "위험 항목이 표시되지 않는다");
  for (const d of dangers) {
    assert.equal(d.section, "advanced", `${d.key} 인데 위험 항목이 다른 섹션에 있다`);
    assert.ok(d.rationale.includes("되돌릴 수 없") || d.rationale.includes("확인"), `${d.key} 에 위험 설명이 없다`);
  }
});

test("화면 설명은 **값·출처·근거** 를 한 줄에 담는다 (§5.13 3요소)", () => {
  const r = resolveSettings({ project: { "log.maxChars": 200_000 } });
  const line = describeSetting(r["log.maxChars"]);
  assert.match(line, /200,?000|200000/, `값이 없다: ${line}`);
  assert.match(line, /이 프로젝트에서 재정의/);
  assert.match(line, /상한/);
});

test("알 수 없는 키는 **보존**된다 — 앞으로 추가될 키를 사용자가 날리지 않게", () => {
  const known = { "log.level": "info" };
  const incoming = { "log.level": "warn", "future.setting": 42 };
  const merged = preserveUnknown(known, incoming);
  assert.equal(merged["future.setting"], 42, "알 수 없는 키를 버렸다");
  assert.deepEqual(unknownKeys(merged), ["future.setting"], "알 수 없는 키를 찾지 못한다");
  // 알려진 키는 오타로 간주하지 않는다
  assert.deepEqual(unknownKeys({ "log.levl": 1 }), ["log.levl"]);
});

test("환경변수 이름 규칙이 **일관**된다", () => {
  assert.equal(envNameFor("log.maxChars"), "HARNESSIDE_LOG_MAXCHARS");
  assert.equal(envNameFor("update.rollbackOnFailedBoot"), "HARNESSIDE_UPDATE_ROLLBACKONFAILEDBOOT");
  // 항목마다 규칙이 달라지면 사용자가 env 를 못 맞춘다
  for (const s of SETTINGS) assert.match(envNameFor(s.key), /^HARNESSIDE_[A-Z0-9_]+$/, `${s.key} 의 env 이름이 규칙에 맞지 않는다`);
});

test("스키마 버전에 **마이그레이션 자리** 가 있다", () => {
  assert.ok(SCHEMA_VERSION >= 1, "버전 번호가 없다");
  // 구 버전을 읽으면 변환 후 백업을 남긴다(§6.4) — 훅이 준비되어야 한다
  assert.ok(SETTINGS_BY_KEY["update.channel"], "마이그레이션 대상 키가 없다");
});

test("bySection 은 설정 파일 순서와 무관하게 **같은 순서** 를 준다", () => {
  for (const s of SECTIONS) {
    const items = bySection(s.id);
    for (const it of items) assert.equal(it.section, s.id);
  }
  // 중복 키가 있으면 화면이 두 번 보인다
  const keys = SETTINGS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, `중복 키: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(", ")}`);
});

test("숫자 항목은 **범위** 를 갖는다 — 0 이 되는 항목이 있으면 이상하다", () => {
  for (const s of SETTINGS) {
    if (s.type !== "number") continue;
    assert.ok(s.min !== undefined && s.max !== undefined, `${s.key} 에 범위가 없다`);
    assert.ok(s.min! < s.max!, `${s.key} 의 범위가 뒤집혔다`);
    assert.ok((s.default as number) >= s.min! && (s.default as number) <= s.max!, `${s.key} 의 기본값이 범위 밖이다`);
  }
});

test("enum 항목은 기본값이 **옵션 안에** 있어야 한다", () => {
  for (const s of SETTINGS) {
    if (s.type !== "enum") continue;
    assert.ok(s.options && s.options.length > 0, `${s.key} 에 옵션이 없다`);
    assert.ok(s.options!.includes(String(s.default)), `${s.key} 의 기본값(${s.default})이 옵션에 없다`);
  }
});
