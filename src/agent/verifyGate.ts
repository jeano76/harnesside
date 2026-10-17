/** X-4: 코드를 고친 턴이 검증 없이 끝나려 하면 한 번 되돌려 보낸다. 막는 것이 아니라 "검증하거나 미검증이라 쓰라"는 강제다. */

const DOC_EXT = /\.(md|txt|rst|ya?ml|json|csv|lock)$/i;

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
