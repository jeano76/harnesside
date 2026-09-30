/**
 * 카탈로그를 **전역 인스턴스에 넣는다** (M9 · §11.1 배선).
 *
 * 이 파일이 없으면 `i18n` 은 카탈로그가 비어 있는 인스턴스이고, `t("panel.terminal")` 은
 * "panel.terminal" 을 돌려준다. 2026-09-30 까지 실제로 그랬다 — 모듈·사전·테스트가
 * 전부 있었는데 **import 하는 곳이 0건**이어서 아무도 실행되지 않았다(§④ 첫 문장:
 * 모듈만 있고 실행되지 않는 것은 있는 기능이 아니다).
 *
 * 그래서 등록은 **import 한 번**으로 끝낸다. 부팅 시 `installI18n()` 을 부르지만,
 * `i18n.t` 를 직접 쓰는 곳(React 밖 — 레이아웃 엔진 등)이 이 파일을 import 하면
 * 사전이 **자동으로** 들어 있다. 그게 없다면 엔진이 키 문자열을 화면에 그대로 흘린다.
 *
 * 한 가지 **의도적으로 하지 않는 것**: `navigator.language` 로 언어를 고르지 않는다.
 * 영어 카탈로그가 비어 있으므로 "영어로 시작" 은 한국어 화면을 영어로 선언하는 것뿐이다
 * (`<html lang="en">` + 한국어 문장). 언어 전환 UI 도 만들지 않는다 — "English" 를
 * 골랐는데 한국어가 나오면 그 라벨이 거짓말을 한다(§5.8).
 */

import { i18n, DEFAULT_LOCALE } from "./index.js";
import { ko } from "./ko.js";

let installed = false;

/** 기본값은 한국어. 여러 번 불러도 등록은 한 번만 한다(사전 덮어쓰기 방지). */
export function installI18n(): void {
  if (!installed) {
    i18n.add(DEFAULT_LOCALE, ko);
    installed = true;
  }
}

/**
 * React 밖에서 쓰는 번역 함수.
 *
 * 훅(`useI18n`)과 다른 점이 하나 있고, 그게 중요하다: 훅은 **구독**하므로 언어가
 * 바뀌면 다시 그려진다. 이 함수는 읽기만 한다. 레이아웃 엔진처럼 **위치 계산**에
 * 쓰는 라벨은 언어가 바뀌어도 배치가 같아야 하므로(라벨이 위치와 어긋나면 안 된다 —
 * `main.tsx` 의 도킹 규칙), 다시 그릴 필요가 없다.
 */
export const t = (key: string, vars?: Record<string, string | number>): string =>
  i18n.t(key, vars, i18n.current);

installI18n();
