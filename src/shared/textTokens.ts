/**
 * 텍스트의 토큰 무게를 추정한다 — **정본은 여기 하나**다.
 *
 * ── 왜 이 파일이 있나 ────────────────────────────────────────────────────────
 *
 * 처음엔 `src/compaction/compactor.ts` 에 있었다. 추론 예산(`web/agent/think.ts`)이
 * 그 추정을 쓰려고 가져오면서 **브라우저 번들이 깨졌다**(실측):
 *
 *     error during build:
 *     src/compaction/checkpoint.ts (2:18): "join" is not exported by "__vite-browser-external"
 *
 * 이유: `compactor.ts` 가 `node:fs` 를 쓰는 서버 전용 모듈이라, 웹이 이를 import 하면
 * **Node API 가 브라우저 번들에 딸려 들어온다.** 서버 전용 모듈에 웹이 의존하면
 * **경계가 뒤집힌다** — 그리고 번들이 깨진다.
 *
 * 순수 계산(문자 클래스별 밀도)이므로 `shared/` 가 원래 자리가었고, 서버는
 * `compactor.ts` 를 통해 **같은 함수**를 그대로 쓴다(re-export).
 *
 * ── 왜 언어별로 세는가 (이 계산이 틀리면 뭐가 틀리는가) ──────────────────────
 *
 * `글자수 / 4` 는 **영문 기준**이다. 한글·한자·가나는 BPE 에서 **글자당 1.5 토큰**을
 * 먹는다. 그러므로 한글에 영문 비율을 적용하면 **절반밖에 못 센다.**
 *
 * 이것은 단순한 inexactness 가 아니다. 추론 예산은 **이 숫자를 보고 상한을 넘겼는지
 * 판단한다.** 절반으로 세면 **실제 상한의 두 배까지 통과**해 버린다. 화면에 표시되는
 * 숫자도 그만큼 거짓말이 된다.
 *
 * 실측 근거(사용자 사례): 사고가 "1,027 토큰" 을 넘겨 thinking 표시가 꺼졌는데,
 * 그때 세고 있던 계산은 `글자수 / 3.4` — **영문 기준**이었다.
 */

/**
 * 문자 클래스별 **글자당 토큰 수**.
 *
 * 값이 클수록 토큰을 적게 센다. 여기서는 **과소 계정을 피하는 쪽**을 택한다 —
 * 절반씩 세는 것은 "상한을 두 배로 느슨하게" 만드는 것이어서, 방어 기능으로는
 * 실패다. 과대 계정이 나쁜 순간(조금 빨리 끊김)보다 **과소 계정이 나쁜 순간**
 * (방어가 통째로 무력화)이 크다.
 */
const DENSITY = {
  /** 한글 음절·자모, 한자, 히라가나·가타카나. BPE 기준 약 1.5 토큰/글자. */
  cjk: 1.5,
  /** 그 외(라틴 문자·숫자·ASCII 문장부호·공백). 약 4 글자/토큰. */
  other: 0.25,
} as const;

/** 코드포인트가 CJK 계열인가. 범위 판정은 **표**로 한다 — 주석으로 알지 않는다. */
function isCjk(code: number): boolean {
  return (
    (code >= 0xac00 && code <= 0xd7af) || // 한글 음절 AC00–D7AF
    (code >= 0x1100 && code <= 0x11ff) || // 한글 자모 1100–11FF
    (code >= 0x3130 && code <= 0x318f) || // 호환 자모 3130–318F
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 통합 한자 4E00–9FFF
    (code >= 0x3040 && code <= 0x30ff) // 히라가나 3040–309F · 가타카나 30A0–30FF
  );
}

/**
 * 텍스트의 토큰 무게를 **휴리스틱으로** 추정한다.
 *
 * 빈 문자열은 0. 이 값은 **실제 토크나이저의 출력이 아니다** — llama-server 의
 * `/tokenize` 같은 진짜 카운터가 없을 때 쓰는 근사치다. 그래서 이름이 `estimate`
 * 이고, 호출하는 곳도 "추정치" 라고 말해야 한다.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjk(text.charCodeAt(i))) cjk++;
  }
  const nonCjk = text.length - cjk;
  return Math.ceil(cjk * DENSITY.cjk + nonCjk * DENSITY.other);
}