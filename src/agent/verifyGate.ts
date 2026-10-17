/** X-4: 코드를 고친 턴이 검증 없이 끝나려 하면 한 번 되돌려 보낸다. 막는 것이 아니라 "검증하거나 미검증이라 쓰라"는 강제다. */

const DOC_EXT = /\.(md|txt|rst|ya?ml|json|csv|lock)$/i;

/** 검증처럼 보이는 셸 명령인가. `ls`·`cat` 같은 탐색은 검증이 아니다(실측: 안내 직후 탐색 명령으로 게이트가 풀렸다). */
export const looksLikeVerification = (cmd: string): boolean =>
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(test|check|build|lint|typecheck|tsc)\b|\b(pytest|jest|vitest|mocha|tsc|eslint|ruff|mypy|cargo\s+(test|check|build)|go\s+(test|build|vet)|make|ctest|gradle|mvn)\b|\bnode\s+(--test|-e|\S+\.(c|m)?js)\b|\bpython3?\s+(-m\s+(pytest|unittest)|\S+\.py)\b/.test(cmd);

export class VerifyGate {
  private unverified = new Set<string>();
  private nudges = 0;

  constructor(private readonly maxNudges = 1) {}

  noteEdit(path: string): void {
    if (!DOC_EXT.test(path)) this.unverified.add(path);
  }

  /** run_recipe / run_shell 이 성공적으로 돌았다. */
  noteVerify(): void {
    this.unverified.clear();
  }

  /** 턴이 도구 호출 없이 끝나려 할 때 호출. 보낼 안내문이 있으면 반환. */
  nudge(): string | null {
    if (this.unverified.size === 0 || this.nudges >= this.maxNudges) return null;
    this.nudges++;
    const files = [...this.unverified].slice(0, 5).join(", ");
    return (
      `[verify gate] 이 턴에서 코드를 고쳤지만(${files}) 그 뒤로 검증을 실행하지 않았습니다. ` +
      `run_recipe 로 검증하고 결과를 보고하세요. 검증할 수 없으면 "미검증"이라고 분명히 쓰세요. "고쳤다/통과했다"라고만 말하지 마세요.`
    );
  }
}
