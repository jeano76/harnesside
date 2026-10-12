/**
 * Wiring checks (M9) — **only the maximized surface.**
 *
 * Why this exists: `src/web/i18n/` once had hook, dictionary, and tests all green
 * with **zero importers** (measured 2026-09-30). Module tests passing while nothing
 * runs is the exact §④-forbidden state — "keys exist" vs "keys are used" were not
 * distinguished. So this test checks two things only:
 *  1. **Keys are actually used.** A `t("…")` literal in use must exist in the dicts.
 *  2. **Misses stay loud.** A new key trips here.
 *
 * What it doesn't do: push coverage to 100%. Claiming "all 100%" here would be a lie —
 * some panel strings are still hardcoded. That fact belongs **here**, not in a §④ table.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { en } from "./en.js";
import { ko } from "./ko.js";
// This import registers the catalogs (side effect). Without calling it, the test
// would pass "even unwired" (the 2026-09-30 state).
import "./install.js";
import { i18n, I18n, DEFAULT_LOCALE } from "./index.js";

const WEB = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Strip comments. `t("a.b")` in a comment is an **example** — not real use. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Collect **keys actually drawn on screen**.
 *
 * Only two places:
 *  1. `t("key")` literals
 *  2. maps whose **values are keys** (like `TITLE_KEY`)
 *
 * Scanning every `"a.b"` string over-matches. It did: WS event types
 * (`"agent.done"` · `"agent.error"`) are dotted strings too. Stuffing them all in
 * makes the check **always fail, or forces dead keys into the dict** to fix it. Then
 * the check measures "what my regex catches", not "what the screen shows".
 */
function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of walk(WEB)) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(/\bt\(\s*"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) keys.add(m[1]);
    // `…_KEY = { …: "key" }` — only maps holding keys as values.
    for (const block of text.matchAll(/const\s+\w*KEY\w*\s*(?::[^=]+)?=\s*\{([^}]*)\}/g)) {
      for (const m of block[1].matchAll(/"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) keys.add(m[1]);
    }
  }
  return [...keys].sort();
}

test("keys **used on screen exist in both dicts** — a missing key prints as itself", () => {
  const missingEn = usedKeys().filter((k) => !(k in en));
  const missingKo = usedKeys().filter((k) => !(k in ko));
  assert.deepEqual(missingEn, [], `keys missing from en: ${missingEn.join(", ")}`);
  assert.deepEqual(missingKo, [], `keys missing from ko: ${missingKo.join(", ")}`);
});

test("**actually wired** — at least one file uses the hook", () => {
  const users = walk(WEB).filter((f) => /useI18n\(/.test(readFileSync(f, "utf8")));
  assert.ok(users.length > 0, "nothing uses useI18n — i18n is dead code again");
});

test("registering the catalogs leaves **no empty keys** — the i18n instance is not empty", () => {
  // `install.ts` registers on import alone. Without this structure the test would
  // pass "even unwired" (the 2026-09-30 state).
  assert.equal(i18n.t("panel.terminal"), "Terminal", "catalog is empty");
  assert.equal(i18n.t("missing.key"), "missing.key", "a missing key must be the key itself");
});

test("default locale is English", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.equal(i18n.effective("en"), "en");
});

test("`lang` is the **drawn** language — a picked-but-untranslated language must not misread", () => {
  // Both shipped catalogs are full, so each claims itself.
  assert.equal(i18n.effective("en"), "en");
  assert.equal(i18n.effective("ko"), "ko");
});

test("only a **fully translated** language becomes `lang` — half right is half wrong", () => {
  // Stamping `lang="ko"` on a half-moved screen reads the **wrong half silently**
  // (it just reads). So 100% is required.
  const partial = new I18n({ catalogs: { en, ko: { "panel.terminal": "터미널" } } });
  assert.equal(partial.effective("ko"), "en", "half-translated but claimed Korean");
  assert.ok(partial.coverage("ko").percent < 100);

  const full = new I18n({ catalogs: { en, ko: Object.fromEntries(Object.keys(en).map((k) => [k, k])) } });
  assert.equal(full.effective("ko"), "ko", "fully translated but claimed English");
});
