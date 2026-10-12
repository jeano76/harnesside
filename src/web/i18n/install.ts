/**
 * Registers catalogs on the **global instance** (M9 · §11.1 wiring).
 *
 * Without this file, `i18n` is an instance with empty catalogs and `t("panel.terminal")`
 * returns "panel.terminal". That was literally the state until 2026-09-30 — module,
 * dictionary, and tests all existed but **zero importers** ran them (§④ first line:
 * a module that never runs is not a feature).
 *
 * So registration ends with **one import**. Boot calls `installI18n()`, but any place
 * using `i18n.t` directly (outside React — layout engines etc.) importing this file gets
 * the dictionaries **automatically**. Without it, engines leak key strings onto screen.
 *
 * Language choice: the default is English (`DEFAULT_LOCALE`). A saved pick in
 * `localStorage` (`harnesside.locale`) wins over the default when it names a
 * supported locale — that is how `/lang` and the settings picker persist.
 * `navigator.language` is **not** consulted: guessing from the browser would flip
 * the screen language under users who never asked.
 */

import { i18n, DEFAULT_LOCALE, LOCALES, type Locale } from "./index.js";
import { ko } from "./ko.js";
import { en } from "./en.js";

let installed = false;

function savedLocale(): Locale | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem("harnesside.locale");
    if (v && (LOCALES as readonly string[]).includes(v)) return v as Locale;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return null;
}

/** Persist a locale pick. Best-effort: a failed write must not break switching. */
export function persistLocale(locale: Locale): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("harnesside.locale", locale);
  } catch {
    /* ignore — the switch itself already applied */
  }
}

/** Default is English. Registering twice never overwrites dictionaries. */
export function installI18n(): void {
  if (!installed) {
    i18n.add("en", en);
    i18n.add("ko", ko);
    const saved = savedLocale();
    if (saved && saved !== DEFAULT_LOCALE) i18n.setLocale(saved);
    else if (typeof document !== "undefined") document.documentElement.lang = i18n.effective();
    installed = true;
  }
}

/**
 * Translation function for outside React.
 *
 * The one difference from the hook (`useI18n`) matters: the hook **subscribes** so
 * the screen redraws on language change. This function only reads. Labels used for
 * **position math** (like layout engines) must keep their layout when the language
 * changes (a label drifting off its position is wrong — see the docking rules in
 * `main.tsx`), so they must not redraw.
 */
export const t = (key: string, vars?: Record<string, string | number>): string =>
  i18n.t(key, vars, i18n.current);

installI18n();
