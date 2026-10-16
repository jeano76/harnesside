/**
 * 위임 전 검증 · 로그 마스킹 · 루프 감지. 순수 함수라 테스트가 프로세스를 띄우지 않는다.
 *
 * 이 검사들이 거짓말할 수 있는 경우:
 * - 모호성 검사는 **휴리스틱**이다(길이·토큰 수·구체 대상 유무). 긴 모호한 문장은 통과한다 —
 *   그래서 외부 에이전트에게도 "모호하면 BLOCKED" 규칙을 템플릿으로 한 번 더 건다.
 * - 비밀 마스킹은 알려진 패턴만 잡는다. 모르는 형식의 키는 로그에 남는다 — 로그는 로컬 전용이다.
 */
import { isAbsolute, relative, resolve } from "node:path";

const DESTRUCTIVE = /(정리해|삭제해|지워|청소|전부\s*삭제|\brm\s+-rf\b|\bdelete\s+(all|everything)\b|\bclean\s*up\b|\bwipe\b)/i;

export interface DelegateRequest {
  agent?: string;
  task: string;
  files: string[];
  skills?: string[];
  verify?: string;
}

export type Rejection = { ok: false; reason: string; detail: string };

/** 외부 에이전트는 비대화형이라 되물을 수 없다 — 모호한 지시는 추측으로 이어져 기존 파일을 덮어쓴 사례가 있다. */
export function validateRequest(req: DelegateRequest, root: string): { ok: true; files: string[] } | Rejection {
  const task = (req.task ?? "").trim();
  if (!Array.isArray(req.files) || req.files.length === 0) {
    return { ok: false, reason: "no-files", detail: "files 가 비었다. 수정할 파일을 구체적으로 적어라(외부 에이전트는 되물을 수 없다)." };
  }
  if (task.length < 20 || task.split(/\s+/).filter(Boolean).length < 4) {
    return { ok: false, reason: "vague-task", detail: "task 가 너무 짧다. '무엇을(대상) 어떻게(동작) 바꿔라' 를 4단어·20자 이상으로, 성공 기준과 함께 적어라." };
  }
  if (DESTRUCTIVE.test(task)) {
    return { ok: false, reason: "destructive-task", detail: "삭제·정리류 작업은 위임하지 않는다. 대상 파일을 정해 직접 처리하거나 사용자에게 확인하라." };
  }
  const files: string[] = [];
  for (const f of req.files) {
    const abs = isAbsolute(f) ? f : resolve(root, f);
    const rel = relative(root, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { ok: false, reason: "outside-root", detail: `허용 범위 밖 경로: ${f}. 워크스페이스 루트 안의 파일만 맡길 수 있다.` };
    }
    files.push(rel);
  }
  return { ok: true, files };
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, p1) => (typeof p1 === "string" ? `${p1}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

/**
 * 같은 tool 호출이 짧은 창 안에서 반복되면 루프로 본다.
 * 최근 `window` 개 중 서로 다른 호출이 `maxDistinct` 이하이면(= 소수의 동일 호출이 계속 반복) 참.
 */
export class LoopDetector {
  private recent: string[] = [];
  constructor(private window = 12, private maxDistinct = 2) {}
  push(key: string): boolean {
    this.recent.push(key);
    if (this.recent.length > this.window) this.recent.shift();
    if (this.recent.length < this.window) return false;
    return new Set(this.recent).size <= this.maxDistinct;
  }
}
