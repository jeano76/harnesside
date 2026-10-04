/**
 * **되돌릴 수 없는 조작** 을 알아본다 (S-6 §8.2).
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────────
 *
 * 요구: *"되돌릴 수 없는 조작은 확인을 받는다. 확인 없이 실행된 `rm -rf` 는 되돌릴 수
 * 없다."* 그리고 더 중요한 다음 문장:
 *
 * > **명령 실행 직후 되돌릴 방법을 함께 말한다. 되돌릴 수 없으면 그 말부터 한다.**
 *
 * 즉 이 프로그램이 답해야 할 것은 "물어느냐" 가 아니라 **"되돌릴 수 있는가"** 다.
 * 그래서 판정 결과는 이항이 아니라 **세 가지**로 갈린다:
 *
 *   - `safe`          — 되돌릴 필요 없다(읽기, 검색, 테스트 실행).
 *   - `undoable`      — 돌릴 **길이 있다**(git checkout, trash 이동). 그 길을 **말한다**.
 *   - `irreversible`  — **돌릴 길이 없다.** 확인 전에 **그 사실부터** 말한다.
 *
 * ── 왜 추측하지 않는가 ────────────────────────────────────────────────────────
 *
 * **모르는 명령은 `unknown` 이다.** `unknown` 을 `safe` 로 두면 게이트가 뚫린다.
 * `unknown` 을 `irreversible` 로 두면 매번 묻는다 — **이쪽이 낫다.** 승인보다 안전이
 * 기본이라는 `ApprovalGate` 의 원칙(무응답 = 거절)과 같은 방향이다.
 *
 * **부족한 것은 "없다" 가 아니라 "모른다" 다**(§5.4: 계측 불가를 0 으로 채우지 않는다).
 */

/** 판정 결과. **세 가지**다 — 이항이면 "되돌릴 길이 있는 경우" 를 말할 자리가 없다. */
export type Reversibility = "safe" | "undoable" | "irreversible" | "unknown";

export interface Verdict {
  how: Reversibility;
  /** 사람이 읽는 이유. **빈 문자열이 아니다** — 판정만 하고 이유는 말하지 않으면
   *  사용자가 "왜 물었지" 를 알 수 없다(§8.2: 되돌릴 방법을 함께 말한다). */
  because: string;
  /** `undoable` 일 때 **되돌리는 방법**. 그대로 화면에 보여준다. */
  undo?: string;
}

/**
 * 되돌릴 수 없는 명령 — **정확히 아는 것만** 적는다.
 *
 * **왜 목록인가, 왜 추론이 아니냐**: 추론("`rm` 이 있으면 파괴적")은 오탐을 만든다.
 * `rm` 은 파일을 지우고 `~/.bashrc` 를 백업해 두면 복구된다. 목록은 **사람이 이미
 * 위험하다고 합의한 것**이고, 여기에 없으면 `unknown` 이 되어 물어본다 — 그게
 * 안전한 방향이다.
 */
const IRREVERSIBLE: { re: RegExp; because: string }[] = [
  { re: /\brm\b[^|;&]*\s-[a-zA-Z]*[rR][a-zA-Z]*[fF]|\brm\b[^|;&]*\s-[a-zA-Z]*[fF][a-zA-Z]*[rR]/, because: "파일·폴더를 복구 없이 지웁니다" },
  { re: /\bgit\s+reset\s+--hard\b/, because: "커밋하지 않은 변경이 복구 없이 사라집니다" },
  { re: /\bgit\s+clean\b[^|;&]*-[a-zA-Z]*[fdxX]/, because: "추적되지 않은 파일이 복구 없이 지워집니다" },
  { re: /\bgit\s+push\b[^|;&]*--force(?!-with-lease)|\bgit\s+push\b[^|;&]*\s-f\b/, because: "원격의 커밋이 복구 없이 덮어써집니다" },
  { re: /\bgit\s+branch\b[^|;&]*\s-D\b/, because: "브랜치와 그 위의 커밋이 복구 없이 사라집니다" },
  { re: /\bdd\b[^|;&]*\bof=/, because: "블록 장치를 덮어씁니다" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, because: "파일시스템을 다시 만듭니다" },
  { re: />\s*\/(etc|usr|bin|sbin|boot|dev)\//, because: "시스템 파일을 덮어씁니다" },
  { re: /\bchmod\b[^|;&]*\s-[a-zA-Z]*R/, because: "권한을 넓게 바꾸며 되돌릴 정보가 남지 않습니다" },
  { re: /\bchown\b[^|;&]*\s-R\b/, because: "소유자를 넓게 바꾸며 되돌릴 정보가 남지 않습니다" },
  { re: /\btruncate\b[^|;&]*\s-s\s*0\b/, because: "파일 내용을 복구 없이 비웁니다" },
  { re: /\bshred\b/, because: "내용을 복구 불가능하게 지웁니다" },
  { re: /\bhistory\s+-c\b/, because: "되돌릴 수 없는 기록을 지웁니다" },
  { re: /\bsudo\b[^|;&]*\brm\b/, because: "관리자 권한으로 삭제합니다" },
  { re: /\bnpm\s+(publish|unpublish)\b|\bgit\s+push\b[^|;&]*--tags\b/, because: "공개된 곳에서 되돌리기 어렵습니다" },
];

/**
 * 되돌릴 **길이 있는** 명령.
 *
 * 여기서도 **경로를 만들어내지 않는다.** 되돌리는 방법을 문장으로 **알려 줄 뿐**
 * 실제로 복구하지는 않는다 — 화면이 "되돌렸습니다" 라고 말하면서 아무것도 하지 않는
 * 것이 가장 나쁜 거짓말이기 때문이다(부록 B 1).
 */
const UNDOABLE: { re: RegExp; undo: string }[] = [
  // **확실히 되돌릴 수 있는 git 명령만** 여기에 둔다.
  //
  // `git checkout <branch>` 는 **가지 전환**이라 되돌릴 수 있지만(앞의 `git` 이
  // workspace 를 바꾸기도 하고), 판정 규칙을 정교하게 만들기 시작하면 **틀리기 시작한다**.
  // 여기 없는 것은 `unknown` 이 되어 **물어본다** — 그게 안전한 방향이다.
  { re: /\bgit\s+checkout\s+--\s/, undo: "git reflog 로 이전 상태의 커밋을 찾을 수 있습니다" },
  { re: /\bgit\s+restore\b/, undo: "git reflog 로 이전 상태의 커밋을 찾을 수 있습니다" },
  { re: /\bgit\s+revert\b/, undo: "새 커밋으로 되돌렸습니다 — commit 으로 되돌릴 수 있습니다" },
  { re: /\bgit\s+stash\b/, undo: "git stash list · git stash pop 으로 되돌릴 수 있습니다" },
  { re: /\bgit\s+commit\b/, undo: "git reset --soft HEAD~1 로 되돌릴 수 있습니다(주의 필요)" },
  { re: /\bmv\b/, undo: "이동한 경로가 곧 원래 위치입니다" },
  { re: /\bcp\b/, undo: "원본 파일이 그대로 남아 있습니다" },
  { re: /\btouch\b/, undo: "빈 파일만 생겼습니다 — 지우면 됩니다" },
];

/** 위험이 없어 보이는 명령 — **물어보지 않기 위한 목록**. 여기에 없으면 `unknown` 다. */
const SAFE: RegExp[] = [
  /^(ls|pwd|cd|echo|cat|head|tail|wc|grep|rg|find|file|stat|du|df|which|type|whoami|date|uname|env|printenv)\b/,
  /^(git\s+(status|log|diff|show|branch\s*$|remote\s+-v))\b/,
  /^(npm|node|pnpm|yarn)\s+(test|run\s+(test|lint|build|typecheck|check))\b/,
  /^(tsc|eslint|prettier|vite|tsx)\b/,
  /\b(--help|-h|--version|-v)\s*$/,
  /^\s*$/,
];

/** 위험 문구를 **먼저** 본다 — 안전한 명령 안에 위험 인자가 섞여 있을 수 있다. */
const DANGER_HINT = /\b(rm|rmdir|unlink|dd|mkfs|shutdown|reboot|killall|kill\s+-9|kill\s+9)\b|--force\b|--hard\b/;

/**
 * 셸 명령 한 줄이 **되돌릴 수 있는지** 판정한다.
 *
 * @param command 사용자가(또는 모델이) 실행하려던 원본. **그대로** 판정한다 —
 *   여기서 "정리"한 문자열로 판정하면 화면이 보여준 것과 실제 실행이 달라진다.
 */
export function judgeCommand(command: string): Verdict {
  const cmd = command.trim();
  if (!cmd) return { how: "unknown", because: "명령이 비어 있습니다" };

  // **여러 명령이 이어져 있으면 하나라도 위험하면 전체가 위험하다.**
  // `&&` · `;` · `|` 로 나눠 각각을 본다 — 앞이 `safe` 여도 뒤에서 `rm -rf` 가 나올 수 있다.
  const parts = cmd
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const hit = IRREVERSIBLE.find((r) => r.re.test(part));
    if (hit) {
      // **여러 개 걸리면 전부 말한다** — 하나만 말하면 사용자는 나머지를 모른다.
      const more = IRREVERSIBLE.filter((r) => r !== hit && r.re.test(part)).map((r) => r.because);
      return {
        how: "irreversible",
        because: more.length ? `${hit.because} · ${more.join(" · ")}` : hit.because,
      };
    }
  }

  const undo = UNDOABLE.find((u) => u.re.test(cmd));
  if (undo) return { how: "undoable", because: "되돌릴 길이 있습니다", undo: undo.undo };

  if (SAFE.some((s) => s.test(cmd))) return { how: "safe", because: "무엇을 바꾸지 않습니다" };

  // **안전 목록에 없다** — 그런데 위험 문구가 보인다. 그건 물어야 한다.
  if (DANGER_HINT.test(cmd)) return { how: "irreversible", because: "파괴적인 인자가 보입니다" };

  // **모른다.** 추측해서 통과시키지 않는다 — 이게 이 모듈의 존재 이유다.
  return { how: "unknown", because: "무엇을 하는지 판정하지 못했습니다" };
}

/** 되돌릴 수 없는 조작인가 — **게이트를 통과시키는가**. */
export function needsConfirmation(command: string): boolean {
  return judgeCommand(command).how !== "safe";
}

/**
 * 승인 화면에 **처음으로** 보여줄 한 줄.
 *
 * 요구: "되돌릴 수 없으면 **그 말부터** 한다." 그래서 판정을 뒤에 붙이지 않는다 —
 * `git checkout -- .` 과 `rm -rf /` 를 같은 자리에 놓으면 사용자는 무엇이 중요한지
 * 한 박자 늦게 읽는다.
 */
export function headline(v: Verdict): string {
  switch (v.how) {
    case "irreversible":
      return `되돌릴 수 없습니다 — ${v.because}`;
    case "undoable":
      return `되돌릴 수 있습니다 — ${v.undo ?? "되돌리는 방법이 있습니다"}`;
    case "safe":
      return "되돌릴 필요 없습니다 — 무엇을 바꾸지 않습니다";
    case "unknown":
      return `확인이 필요합니다 — ${v.because}`;
  }
}
