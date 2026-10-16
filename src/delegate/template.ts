/**
 * X-6 외부 에이전트 작업 명세 템플릿과 결과 파서.
 *
 * 로컬 모델은 <…> 부분(목표·성공 기준·허용 파일·스킬 체크리스트)만 채우고, 나머지 규칙은 **고정**이다.
 * 파서가 거짓말할 수 있는 경우: 에이전트가 "STATUS: DONE" 을 쓰고도 실제로는 아무것도 안 했을 수 있다 —
 * 그래서 파서는 형식만 판정하고, 완료 여부는 하네스가 직접 돌리는 검증(P4)이 판정한다.
 */

export interface TaskSpec {
  goal: string;
  criteria: string[];
  files: string[];
  skillChecklists: { name: string; text: string }[];
}

export function buildTaskMd(spec: TaskSpec): string {
  const criteria = spec.criteria.length > 0 ? spec.criteria.map((c) => `- ${c}`).join("\n") : "- (명시된 기준 없음 — 위 목표를 만족하는 최소 변경)";
  const skills =
    spec.skillChecklists.length > 0
      ? spec.skillChecklists.map((s) => `### ${s.name}\n${s.text}`).join("\n\n")
      : "(적용할 스킬 없음)";
  return `# 작업 명세 (비대화형 — 되물을 수 없다. 모호하면 추측하지 말고 "BLOCKED: <이유>"만 출력하고 종료)

## 목표 (1문장)
${spec.goal}

## 성공 기준 (검증 가능해야 함)
${criteria}

## 허용 범위
- 수정 가능: ${spec.files.join(", ")}
- 그 밖의 파일은 읽기만. 새 파일·새 의존성 금지(필요하면 "NEEDS: <이유>"로 보고)

## 규칙
1. 가정은 명시한다. 해석이 둘 이상이면 선택하지 말고 BLOCKED로 보고한다.
2. 요청된 것만 만든다. 단일 사용 추상화·설정 옵션·불가능한 경우의 에러 처리를 추가하지 않는다.
3. 인접 코드·주석·포맷을 건드리지 않는다. 기존 스타일을 따른다.
4. 내 변경으로 안 쓰게 된 import·변수만 제거한다. 기존 데드 코드는 언급만 한다.
5. 버그는 재현 테스트를 먼저 쓰고 실패를 확인한 뒤 고친다.
6. 위 성공 기준을 스스로 실행해 확인한 출력만 "통과"라고 쓴다. 실행하지 않은 것은 "미검증".
7. 삭제·덮어쓰기·\`git push\`·네트워크 설치는 하지 않는다.

## 적용 스킬 체크리스트
${skills}

## 최종 출력 형식 (이것만 stdout 마지막에, ≤ 20줄)
STATUS: DONE | BLOCKED | NEEDS
CHANGED: <파일 목록>
VERIFIED: <실행한 명령 → 결과> (없으면 "미검증")
RISKS: <남은 불확실성 한 줄씩>
`;
}

export type AgentStatus = "done" | "blocked" | "needs";

export interface StatusBlock {
  status: AgentStatus;
  /** STATUS 줄 뒤의 본문(≤ 20줄). BLOCKED/NEEDS 이유도 여기에 들어간다. */
  body: string;
}

const STATUS_RE = /^\s*STATUS:\s*(DONE|BLOCKED|NEEDS)\b(.*)$/;

/**
 * 출력 **마지막** `STATUS:` 블록만 파싱한다. 앞의 대화는 로그로만 간다.
 * 블록이 없으면 null — 호출자는 이를 `malformed` 로 처리하고 성공으로 치지 않는다.
 */
export function parseStatusBlock(output: string): StatusBlock | null {
  const lines = output.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (STATUS_RE.test(lines[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const m = STATUS_RE.exec(lines[at]!)!;
  const rest = [m[2]!.replace(/^[\s:-]+/, "").trim(), ...lines.slice(at + 1)].filter((l) => l.length > 0);
  return { status: m[1]!.toLowerCase() as AgentStatus, body: rest.slice(0, 20).join("\n") };
}
