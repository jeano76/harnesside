/**
 * 전역 i18n (M9 · §11.1).
 *
 * "전역 i18n 훅, 기본값 한국어" 라는 요구의 **실질**은 두 가지다:
 *  1. 문자열이 **한 군데**에 있고 화면은 키로 참조한다(빠진 키는 눈에 보인다).
 *  2. 기본값이 한국어여서 **옛 화면이 그대로** 동작한다(한글이 없는 디바이스에서도).
 *
 * 여기서 가장 중요한 설계 하나: **빠진 키를 조용히 빈 문자열로 두지 않는다.**
 * i18n 을 넣을 때 가장 흔한 사고가 "번역 안 한 부분이 빈 칸으로 보인다" 인데, 사용자는
 * 그것을 "번역이 어딘가 어긋났다" 고 읽지 않는다. 그래서 키를 그대로 보여주고
 * **누락 목록에 추가**한다(개발 중에는 화면에서 바로 보이고, 릴리스 전에는 검사가 잡는다).
 *
 * 두 번째 원칙: **기본값이 한국어** 다. 대상 사용자의 언어이며, 이미 모든 UI 문장이
 * 한국어다. `fallback` 을 영어로 두면 "번역 전 화면" 이 영어로 바뀌어 버린다.
 */

/** 지원 언어. 한국어가 기본값 — 새 로케일을 넣으려면 **판단**이 필요하므로 자동으로 늘지 않는다. */
// React 는 **마지막에** import 한다 — 이 모듈의 로직은 React 없이도 쓸 수 있어야
// 하므로(서버 스크립트·테스트), 훅이 유일한 React 의존 지점이 된다.
import { useSyncExternalStore } from "react";

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ko";

export type Catalog = Record<string, string>;

export interface MissingKey {
  locale: Locale;
  key: string;
  at: number;
}

/** `{{name}}` 자리표시자. 없는 변수는 **빈 문자열이 아니라 원래 표기**를 남긴다. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
    const v = vars[name];
    // **없는 변수는 조용히 지우지 않는다.** `{{경로}}` 가 그대로 남으면 사용자는
    // "화면에 중괄호가 왜 뜨지" 를 보고, 개발자는 어느 키가 비었는지 즉시 안다.
    if (v === undefined || v === null) return whole;
    return String(v);
  });
}

export class I18n {
  private locale: Locale = DEFAULT_LOCALE;
  private catalogs = new Map<Locale, Catalog>();
  private listeners = new Set<(locale: Locale) => void>();
  /** 누락 기록 — "아직 안 옮긴 문자열" 의 정본 목록. */
  private missing: MissingKey[] = [];
  private now: () => number;

  constructor(opts: { catalogs?: Partial<Record<Locale, Catalog>>; locale?: Locale; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    for (const l of LOCALES) this.catalogs.set(l, { ...(opts.catalogs?.[l] ?? {}) });
    if (opts.locale && LOCALES.includes(opts.locale)) this.locale = opts.locale;
  }

  /** 번역을 추가/갱신한다. 실행 중에도 되므로 서버가 늦게 온 번역도 반영된다. */
  add(locale: Locale, entries: Catalog): void {
    const cur = this.catalogs.get(locale) ?? {};
    this.catalogs.set(locale, { ...cur, ...entries });
  }

  get current(): Locale {
    return this.locale;
  }

  /** 지원하지 않는 로케일은 **조용히 받지 않는다** — 기본값으로 내려가되 알린다. */
  setLocale(next: string): { ok: boolean; locale: Locale; detail: string } {
    if (!LOCALES.includes(next as Locale)) {
      const detail = `지원하지 않는 언어입니다: ${next} (지원: ${LOCALES.join(", ")}) — ${this.locale} 을 유지합니다`;
      this.noteMissing({ locale: this.locale, key: `@locale/${next}`, at: this.now() });
      return { ok: false, locale: this.locale, detail };
    }
    const prev = this.locale;
    this.locale = next as Locale;
    // **`<html lang>` 은 요청한 언어가 아니라 화면에 그려지는 언어로 맞춘다.**
    // 번역이 없는 언어를 골랐는데 `lang="en"` 을 찍으면, 한국어 문장을 스크린 리더가
    // 영어로 읽는다 — 바로 이걸 막으려고 `lang` 을 쓰는 것인데, 그 사고를 직접 만든다.
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
   * 문자열을 얻는다.
   *
   * 찾지 못하면: 현재 언어 → **기본값(한국어)** → 키 자체. 그리고 누락에 기록한다.
   * **빈 문자열을 돌려주지 않는다.** 빈 화면 조각은 "버그가 없다" 고 읽히기 때문이다.
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
    // 같은 키를 100번 누락으로 세지 않는다 — **개수** 가 아니라 **목록** 이 필요하다.
    if (this.missing.some((x) => x.locale === m.locale && x.key === m.key)) return;
    this.missing.push(m);
  }

  /** 지금까지 누락된 키. 검증 스크립트가 이걸 읽는다. */
  missingKeys(): MissingKey[] {
    return this.missing.slice();
  }

  /** 번역률 — **넣은 키 수** 기준이다(총 몇 개를 넣었는지는 앱이 알아야 한다). */
  coverage(locale: Locale): { keys: number; translated: number; percent: number } {
    const target = this.catalogs.get(locale) ?? {};
    const base = this.catalogs.get(DEFAULT_LOCALE) ?? {};
    const keys = Object.keys(base).length;
    const translated = Object.keys(target).filter((k) => typeof target[k] === "string").length;
    return { keys, translated, percent: keys === 0 ? 100 : Math.round((translated / keys) * 100) };
  }

  /**
   * 화면에 **실제로 그려지는** 언어.
   *
   * `t()` 는 키마다 따로 떨어지므로 부분 번역 화면은 두 언어가 섞인 화면이 된다.
   * 그래도 `lang` 은 하나만 찍을 수 있으므로, **완전히 번역된 경우에만** 그 언어를
   * 주장한다. 아니면 기본값(한국어) — 그게 실제로 화면 대부분에 그려지는 글자다.
   *
   * 100% 인 이유: 절반만 번역된 화면에 `lang="en"` 을 찍으면 절반은 맞고 절반은 틀린다.
   * 틀린 쪽이 조용하므로(읽히기만 한다) 100% 를 요구한다.
   */
  effective(requested: Locale = this.locale): Locale {
    if (requested === DEFAULT_LOCALE) return requested;
    return this.coverage(requested).percent === 100 ? requested : DEFAULT_LOCALE;
  }
}

/** 전역 인스턴스 — 앱은 이것 하나만 쓴다. */
export const i18n = new I18n();

/**
 * 컴포넌트용 훅.
 *
 * 반환값이 **함수** 라는 점이 중요하다: `const t = useI18n(); t("a.b")` 이면 로케일이
 * 바뀌면 다시 그려진다(함수를 그대로 받아쓴다면 stale 이 된다).
 */
export function useI18n(): (key: string, vars?: Record<string, string | number>) => string {
  const locale = useLocale();
  return (key: string, vars?: Record<string, string | number>) => i18n.t(key, vars, locale);
}

/** 현재 로케일 + 구독. React 가 없는 곳(스크립트·테스트)에서도 쓸 수 있다. */
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
