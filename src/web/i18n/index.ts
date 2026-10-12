/**
 * Global i18n (M9 · §11.1).
 *
 * The "global i18n hook, English default" requirement has two parts:
 *  1. Strings live in **one place** and screens reference them by key (a missing
 *     key is visible).
 *  2. The default is English so the **shipped screen reads English**; Korean is a
 *     first-class secondary locale switched via `/lang` or the settings picker.
 *
 * The core design point: **never render a missing key as a silent empty string.**
 * The most common i18n accident is "an untranslated part shows as blank", and users
 * read that as "the original sentence", not as "a translation slipped". So the key
 * itself is shown and added to a **missing list** (visible on screen during
 * development, caught by checks before release).
 *
 * Second principle: **the default is English**. `fallback` into Korean would turn
 * the "pre-translation screen" into Korean.
 */

/** Supported locales. English is the default — adding a new locale is a **decision**, so it never grows automatically. */
// React is imported **last** — this module's logic must work without React
// (server scripts/tests); the hook is the only React dependency.
import { useSyncExternalStore } from "react";

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export type Catalog = Record<string, string>;

export interface MissingKey {
  locale: Locale;
  key: string;
  at: number;
}

/** `{{name}}` placeholders. A missing variable keeps its **original spelling**, not an empty string. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
    const v = vars[name];
    // **A missing variable is never wiped silently.** A leftover `{{path}}` tells
    // the user "why are there braces on screen" and the developer which key is empty.
    if (v === undefined || v === null) return whole;
    return String(v);
  });
}

export class I18n {
  private locale: Locale = DEFAULT_LOCALE;
  private catalogs = new Map<Locale, Catalog>();
  private listeners = new Set<(locale: Locale) => void>();
  /** Miss log — the canonical list of "strings not moved yet". */
  private missing: MissingKey[] = [];
  private now: () => number;

  constructor(opts: { catalogs?: Partial<Record<Locale, Catalog>>; locale?: Locale; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    for (const l of LOCALES) this.catalogs.set(l, { ...(opts.catalogs?.[l] ?? {}) });
    if (opts.locale && LOCALES.includes(opts.locale)) this.locale = opts.locale;
  }

  /** Extra translations. Applies at runtime, so late server translations still land. */
  add(locale: Locale, entries: Catalog): void {
    const cur = this.catalogs.get(locale) ?? {};
    this.catalogs.set(locale, { ...cur, ...entries });
  }

  get current(): Locale {
    return this.locale;
  }

  /** An unsupported locale is **not silently accepted** — keep the current one and say so. */
  setLocale(next: string): { ok: boolean; locale: Locale; detail: string } {
    if (!LOCALES.includes(next as Locale)) {
      const detail = `Unsupported language: ${next} (supported: ${LOCALES.join(", ")}) — keeping ${this.locale}`;
      this.noteMissing({ locale: this.locale, key: `@locale/${next}`, at: this.now() });
      return { ok: false, locale: this.locale, detail };
    }
    const prev = this.locale;
    this.locale = next as Locale;
    // **`<html lang>` follows the drawn language, not the requested one.**
    // Claiming `lang="ko"` over mostly-English text makes a screen reader read
    // English as Korean — the very accident `lang` exists to prevent.
    if (typeof document !== "undefined") document.documentElement.lang = this.effective();
    if (prev !== this.locale) for (const fn of this.listeners) fn(this.locale);
    return { ok: true, locale: this.locale, detail: "" };
  }

  subscribe(fn: (locale: Locale) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Look up a string.
   *
   * On a miss: current language → **default (English)** → the key itself. Misses
   * are recorded. **Never returns an empty string** — a blank screen fragment
   * reads as "no bug".
   */
  t(key: string, vars?: Record<string, string | number>, locale: Locale = this.locale): string {
    const hit = this.catalogs.get(locale)?.[key];
    if (typeof hit === "string") return interpolate(hit, vars);
    if (locale !== DEFAULT_LOCALE) {
      const fb = this.catalogs.get(DEFAULT_LOCALE)?.[key];
      if (typeof fb === "string") {
        this.noteMissing({ locale, key, at: this.now() });
        return interpolate(fb, vars);
      }
    }
    this.noteMissing({ locale, key, at: this.now() });
    return interpolate(key, vars);
  }

  private noteMissing(m: MissingKey): void {
    // One miss per key — the **list** matters, not the count.
    if (this.missing.some((x) => x.locale === m.locale && x.key === m.key)) return;
    this.missing.push(m);
  }

  /** Misses so far. Verification scripts read this. */
  missingKeys(): MissingKey[] {
    return this.missing.slice();
  }

  /** Coverage — counted by **keys added** (the app must know the total). */
  coverage(locale: Locale): { keys: number; translated: number; percent: number } {
    const target = this.catalogs.get(locale) ?? {};
    const base = this.catalogs.get(DEFAULT_LOCALE) ?? {};
    const keys = Object.keys(base).length;
    const translated = Object.keys(target).filter((k) => typeof target[k] === "string").length;
    return { keys, translated, percent: keys === 0 ? 100 : Math.round((translated / keys) * 100) };
  }

  /**
   * The language **actually drawn** on screen.
   *
   * `t()` falls back per key, so a partially translated screen mixes two
   * languages. But `lang` can only claim one, so it claims a language **only when
   * fully translated** — otherwise the default (English), which is what most of
   * the screen really draws.
   *
   * Why 100%: stamping `lang="ko"` on a half-translated screen gets half right
   * and half wrong. The wrong half is silent (it just reads), so 100% is required.
   */
  effective(requested: Locale = this.locale): Locale {
    if (requested === DEFAULT_LOCALE) return requested;
    return this.coverage(requested).percent === 100 ? requested : DEFAULT_LOCALE;
  }
}

/** The global instance — the app uses only this one. */
export const i18n = new I18n();

/**
 * Hook for components.
 *
 * The return value being a **function** matters: `const t = useI18n(); t("a.b")`
 * re-renders on locale change (holding the function itself would go stale).
 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const translators = new Map<Locale, Translate>();

/**
 * Returns the **same function** per locale. If `useI18n` built a new closure per
 * render, every place putting `t` in effect deps (main.tsx's WS/polling effects)
 * would rerun each render — closing sockets and re-calling /api hundreds of
 * times per second (measured: 13k requests in 8s, screen WS "flapping").
 * Function identity must change only when the locale changes.
 */
export function translatorFor(locale: Locale): Translate {
  let fn = translators.get(locale);
  if (!fn) {
    fn = (key, vars) => i18n.t(key, vars, locale);
    translators.set(locale, fn);
  }
  return fn;
}

export function useI18n(): Translate {
  return translatorFor(useLocale());
}

/** Current locale + subscription. Also usable where React is absent (scripts/tests). */
export function useLocale(): Locale {
  return useSyncExternalStoreShim(
    (fn: () => void) => i18n.subscribe(() => fn()),
    () => i18n.current,
  );
}

function useSyncExternalStoreShim(subscribe: (fn: () => void) => () => void, getSnapshot: () => Locale): Locale {
  try {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  } catch {
    return getSnapshot();
  }
}
