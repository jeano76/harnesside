/**
 * i18n tests (M9 · §11.1).
 *
 * The single most important check here: **a missing key must not become an empty
 * string.** The most common and quietest i18n failure is exactly that. Users don't
 * read the blank as "a translation slipped" — they trust the blank as **the
 * original sentence**.
 *
 * The other three:
 *  - The default is **English**. Falling back to Korean would turn the
 *    "pre-translation screen" into Korean.
 *  - `html[lang]` changes with it (M8: screen readers must read the language).
 *  - Misses stay as a **list** — keys are needed, not counts.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_LOCALE, I18n, LOCALES, translatorFor, i18n } from "./index.js";
import { en } from "./en.js";
import { ko } from "./ko.js";

const catalog = { en, ko };

test("default is **English** — the shipped screen reads English", () => {
  const i = new I18n({ catalogs: catalog });
  assert.equal(i.current, "en");
  assert.equal(DEFAULT_LOCALE, "en");
  assert.equal(i.t("panel.terminal"), "Terminal");
});

test("**a missing key is the key itself, not an empty string** — no blank fragments", () => {
  const i = new I18n({ catalogs: catalog });
  const v = i.t("missing.key.name");
  assert.notEqual(v, "", "returning empty hides the gap as a blank");
  assert.equal(v, "missing.key.name", "did not show the key — the gap is invisible");
  // **misses are recorded** — that is the list of unmoved keys.
  assert.ok(i.missingKeys().some((m) => m.key === "missing.key.name"), "miss not recorded");
});

test("repeat calls record **one** miss — the list matters, not the count", () => {
  const i = new I18n({ catalogs: catalog });
  for (let n = 0; n < 5; n++) i.t("panel.log");
  assert.equal(i.missingKeys().length, 0);
  i.t("x.y");
  i.t("x.y");
  i.t("x.y");
  assert.equal(i.missingKeys().filter((m) => m.key === "x.y").length, 1, "counted the same miss repeatedly");
});

test("a language **without a translation falls back to English** — original sentence, not blank", () => {
  const i = new I18n({ catalogs: { en, ko: {} } });
  i.setLocale("ko");
  // The Korean catalog is empty, so it must fall back to **English**.
  assert.equal(i.t("panel.terminal"), "Terminal", "pre-translation screen went blank");
  assert.ok(i.missingKeys().some((m) => m.locale === "ko"), "Korean miss not recorded");
});

test("**missing variables** stay braced — wiping them only erases the braces", () => {
  const i = new I18n({ catalogs: { en: { "a.x": "Saved ({{version}})" } } });
  assert.equal(i.t("a.x", { version: 7 }), "Saved (7)");
  // **Never fill with empty.** The original spelling must stay so the gap is visible.
  assert.equal(i.t("a.x"), "Saved ({{version}})");
  assert.equal(i.t("a.x", { version: 0 }), "Saved (0)", "0 is a value — not empty");
});

test("an **unsupported language** is not silently taken — keep and tell", () => {
  const i = new I18n({ catalogs: catalog });
  const r = i.setLocale("fr");
  assert.equal(r.ok, false);
  assert.equal(i.current, "en", "switched to an unknown language");
  assert.match(r.detail, /fr/, "does not say which value was wrong");
  assert.ok(LOCALES.includes("ko") && LOCALES.includes("en"), "supported locale list changed");
});

test("subscribers are notified **only on change**", () => {
  const i = new I18n({ catalogs: catalog });
  const seen: string[] = [];
  const off = i.subscribe((l) => seen.push(l));
  i.setLocale("ko");
  i.setLocale("ko"); // same language → no notify (avoids useless rerenders)
  off();
  i.setLocale("en");
  assert.deepEqual(seen, ["ko"], `odd subscribe traffic: ${seen.join(",")}`);
});

test("coverage — by **keys added**. Missing keys never count as 100%", () => {
  const i = new I18n({ catalogs: { en, ko: { "panel.terminal": "터미널", "panel.log": "서버 로그" } } });
  const enCov = i.coverage("en");
  const koCov = i.coverage("ko");
  assert.equal(enCov.percent, 100);
  assert.equal(koCov.percent < 100, true, "2 translations came out as 100%");
  assert.ok(koCov.translated <= koCov.keys, "counted more than the keys");
});

test("translations can be **added at runtime** — late server arrivals still land", () => {
  const i = new I18n({ catalogs: { en: {}, ko } });
  assert.equal(i.t("panel.terminal"), "panel.terminal", "before adding, the key itself");
  i.add("en", { "panel.terminal": "Terminal" });
  assert.equal(i.t("panel.terminal"), "Terminal", "late translation not applied");
});

test("safe in **DOM-less environments** (scripts/tests)", () => {
  // Without `document`, `html lang` sync is skipped — server scripts importing
  // this module must not die (boot would die with them).
  const i = new I18n({ catalogs: catalog });
  assert.doesNotThrow(() => i.setLocale("ko"));
  assert.equal(i.current, "ko");
});

test("catalog keys are **all filled** — no empty entries", () => {
  for (const [name, cat] of [["en", en], ["ko", ko]] as const) {
    const empty = Object.entries(cat).filter(([, v]) => typeof v !== "string" || v.trim() === "");
    assert.deepEqual(empty.map(([k]) => k), [], `${name}: empty entries — blank on screen`);
  }
});

test("both catalogs carry **the same keys** — a key in one but not the other mixes languages", () => {
  const enKeys = new Set(Object.keys(en));
  const koKeys = new Set(Object.keys(ko));
  assert.deepEqual([...enKeys].filter((k) => !koKeys.has(k)), [], "keys in en missing from ko");
  assert.deepEqual([...koKeys].filter((k) => !enKeys.has(k)), [], "keys in ko missing from en");
});

test("translatorFor returns the same function per locale — safe in effect deps", () => {
  // Measured accident: useI18n built a new function per render, and WS/polling
  // effects with `t` in deps reran forever (repeated socket closes + hundreds of /api calls/sec).
  for (const l of LOCALES) {
    assert.equal(translatorFor(l), translatorFor(l), `${l}: a different function per call`);
  }
});

test("translatorFor translates per locale", () => {
  const l = LOCALES[0];
  assert.equal(translatorFor(l)("status.wsClosed"), i18n.t("status.wsClosed", undefined, l));
});
