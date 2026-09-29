/**
 * 창을 **실제로 띄워야 하는지** 결정한다.
 *
 * 이게 별도 파일인 이유: `--no-browser` 와 `--daemon` 은 "창 없음" 을 뜻하는데,
 * 실제로는 Chrome 을 **항상** 띄우고 있었다. 규칙이 `index.ts` 한 줄짜리
 * 플래그 검사(`NO_BROWSER`)에 흩어져 있었고, **그 플래그를 아예 안 쓰는 곳**이 생겼다
 * (단계 11). 그래서 주입한 규칙을 아무도 지키지 않게 됐다.
 *
 * 실제로 겪은 결과 두 가지:
 *  - 창 없는 데몬이 GPU 를 먹었다.
 *  - X 서버가 없는 CI 러너에서 "Missing X server or $DISPLAY" 로 죽었다.
 *
 * 그래서 "띄울까 말까" 를 **한 곳**에 모으고, 여기서 테스트한다.
 */

/**
 * 창을 띄우지 않으려는 플래그.
 *
 * `--dry` 도 **여기** 다. 그 정의가 "12단계 이름/순서만, 부수효과 0" 이므로 창을 띄우면
 * 거짓말이다. 실제로 부팅 스모크가 X 서버 없는 러너에서 여기서 죽었다.
 */
export const NO_BROWSER_FLAGS = ["--no-browser", "--daemon", "--dry"] as const;

export interface BrowserIntent {
  /** Chrome 을 띄워야 하는가. */
  launch: boolean;
  /** `launch: false` 면 왜 안 띄우는지 — 로그에 그대로 실으려고. */
  reason: string;
}

/**
 * @param argv 명령행 인자 전체 (`process.argv`). 테스트에서 직접 넘길 수 있어야 한다.
 */
export function resolveBrowserIntent(argv: readonly string[]): BrowserIntent {
  if (argv.includes("--dry")) return { launch: false, reason: "dry-run — 부수효과 0 (§3.2)" };
  for (const f of NO_BROWSER_FLAGS) {
    if (argv.includes(f)) {
      return {
        launch: false,
        reason:
          f === "--daemon"
            ? "데몬 모드 — 창 없이 서버만 (§3.7.2)"
            : "창 없음 모드 — llama 만 기동",
      };
    }
  }
  return { launch: true, reason: "기본값: 창 모드" };
}

/**
 * "창이 있어야 수명 규칙(창이 닫히면 종료)이 성립한다" 를 판정한다.
 *
 * 워치독이 "창이 닫혔다" 를 **들을 수 있는지** 의 정본이다. 부재(없음)와 종료(죽음)는
 * 다른 신호인데, 구분하지 않으면 `--no-browser` 데몬이 첫 tick 에 스스로 죽는다
 * (실제로 그랬다 — llama 는 `/v1/models 200` 응답 중이었다).
 */
export function windowLifecycleApplies(argv: readonly string[]): boolean {
  return resolveBrowserIntent(argv).launch;
}
