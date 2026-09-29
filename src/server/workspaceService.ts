/**
 * **살아 있는** 워크스페이스 상태 (§8.3 · 요구 13).
 *
 * `workspace.ts` 가 "무엇이 바뀌는가" 를 계산한다면, 여기는 "바꾼다" 를 실행한다.
 * 둘을 따로 모듈로 둔 이유가 있다: 계산은 **순수**해야 테스트할 수 있고, 실행은
 * 부수효과가 있어 테스트하기 어렵다. 그래서 `planSwitch` 는 여기서 부수효과 없이 호출만 한다.
 *
 * 이 파일이 지키는 것 — **셋을 한 번에** 바꾼다:
 *   1. 파일 트리 루트 (`root()` — safePath 가 쓰는 값)
 *   2. 도구 호출의 기준 디렉터리 (`baseDir()`)
 *   3. 로드한 규칙 (`rules()`)
 *
 * 셋 중 하나만 바꾸면 **조용히 엉뚱한 곳에 쓰게 된다**(트리는 새 프로젝트인데 도구는 옛
 * 폴더에 파일을 만든다). 그래서 전이를 **한 함수**에서 끝내고, 중간 상태를 노출하지 않는다.
 *
 * 전이 실패는 **반전이 아니라 실패** 다. 새 루트를 지문으로 확인한 **뒤에** 상태를 바꾼다.
 * 그 순서가 반대면, 새 루트가 없는 폴더여도 이전 루트를 잃는다.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  fingerprint,
  planSwitch,
  contextBoundaryNote,
  rebasePath,
  type WorkspaceFingerprint,
  type WorkspaceSwitch,
} from "./workspace.js";

export interface WorkspaceServiceOptions {
  /** 부팅 시의 루트(보통 projectRoot). */
  root: string;
  /** 전이가 일어났을 때 알린다(WS 방송 · 파일 감시 재루팅). */
  onChange?: (e: WorkspaceChange) => void;
}

export interface WorkspaceChange {
  from: WorkspaceFingerprint;
  to: WorkspaceFingerprint;
  switchPlan: WorkspaceSwitch;
  /** 열린 탭을 새 루트 기준으로 다시 잡은 결과. */
  tabs: { path: string; ok: boolean }[];
  /** 이 루트에서 도구 결과를 설명하는 문장(§8.3 연속성 정책). */
  note: string;
}

export type SwitchResult =
  | { ok: true; value: WorkspaceChange }
  | { ok: false; reason: "needs-confirm" | "not-a-directory" | "not-found" | "same-root"; detail: string };

/**
 * 사용자에게 보여줄 **확인 다이얼로그 내용**(§8.3 은 전환 전 확인을 요구한다).
 *
 * 부수효과가 없어야 하므로 상태를 바꾸지 않는다. "미리보기" 와 "실행" 을 같은 함수로
 * 하면, 미리보기를 보기 위해 실제로 루트가 바뀌는 사고가 난다.
 */
export interface SwitchPreview {
  to: WorkspaceFingerprint;
  warnings: string[];
  orphanedTabs: string[];
  tabs: { path: string; ok: boolean }[];
  carriesPriorContext: boolean;
  note: string;
}

export class WorkspaceService {
  private currentFingerprint: WorkspaceFingerprint;
  /** 새 루트에서 온 결과임을 설명하는 문장들. **아직 소비되지 않은 것** 이 쌓인다. */
  private notes: string[] = [];

  constructor(private opts: WorkspaceServiceOptions) {
    // 지문 계산은 비동기라 생성자에 둘 수 없다 — 부팅 시 `init()` 을 부른다.
    this.currentFingerprint = {
      root: resolve(opts.root),
      name: "",
      kind: ["unknown"],
      rules: [],
      git: false,
      packageManager: null,
      buildHint: null,
    };
  }

  /** 부팅 시 한 번. 지문을 **한 번만** 구해 이후 모든 판정이 같은 값을 본다. */
  async init(): Promise<WorkspaceFingerprint> {
    this.currentFingerprint = await fingerprint(resolve(this.opts.root));
    return this.currentFingerprint;
  }

  /** 파일 API 가 쓰는 루트. 전환 직후에도 새 값이어야 한다(캡처한 상수를 쓰면 안 된다). */
  root(): string {
    return this.currentFingerprint.root;
  }

  /** 도구 호출의 기준 디렉터리. §8.3 은 이것도 함께 바꾸라고 요구한다. */
  baseDir(): string {
    return this.currentFingerprint.root;
  }

  rules(): WorkspaceFingerprint["rules"] {
    return this.currentFingerprint.rules;
  }

  get current(): WorkspaceFingerprint {
    return this.currentFingerprint;
  }

  /**
   * 아직 소비되지 않은 컨텍스트 경계 문장.
   *
   * **소비 지점은 아직 없다** — 에이전트 턴 루프가 서버에 배선되지 않았다. 그래서
   * 이 목록은 "만들어진 사실" 까지만 보장하고, "모델에게 전달됐다" 고 말하지 않는다.
   * 배선되면 여기서부터 읽으면 된다(가장 최근 문장만 유효하므로 소비 시 비운다).
   */
  pendingNotes(): string[] {
    return [...this.notes];
  }

  takeNotes(): string[] {
    const out = [...this.notes];
    this.notes = [];
    return out;
  }

  /** 전환 전 미리보기. **아무것도 바꾸지 않는다.** */
  async preview(path: string, openTabs: string[] = []): Promise<{ ok: true; value: SwitchPreview } | { ok: false; reason: string; detail: string }> {
    const check = await this.checkTarget(path);
    if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail };
    const to = await fingerprint(check.root);
    if (to.root === this.currentFingerprint.root) {
      return { ok: false, reason: "same-root", detail: "이미 그 폴더입니다" };
    }
    const sw = planSwitch(this.currentFingerprint, to, openTabs);
    const tabs = await rebaseTabs(openTabs, this.currentFingerprint.root, to.root);
    return {
      ok: true,
      value: {
        to,
        warnings: [...sw.warnings, ...missingTabWarning(tabs)],
        orphanedTabs: sw.orphanedTabs,
        tabs,
        carriesPriorContext: sw.carriesPriorContext,
        note: contextBoundaryNote(this.currentFingerprint, to),
      },
    };
  }

  /**
   * 전환을 **실행**한다. `confirm` 이 없으면 하지 않는다.
   *
   * 확인을 요구하는 이유: 이건 사용자가 **모르는 사이에 도구가 쓰는 곳**이 바뀐다.
   * 서버가 "확인 없이" 루트를 바꾸면, 이후 모든 파일 쓰기가 의도와 다른 곳으로 간다.
   */
  async switchTo(
    path: string,
    opts: { openTabs?: string[]; confirm?: boolean } = {}
  ): Promise<SwitchResult> {
    if (!opts.confirm) {
      return { ok: false, reason: "needs-confirm", detail: "전환 전 확인이 필요합니다(확인 다이얼로그를 먼저 거치십시오)" };
    }
    const check = await this.checkTarget(path);
    if (!check.ok) return check;
    const to = await fingerprint(check.root);
    if (to.root === this.currentFingerprint.root) {
      return { ok: false, reason: "same-root", detail: "이미 그 폴더입니다" };
    }
    const from = this.currentFingerprint;
    const openTabs = opts.openTabs ?? [];
    const sw = planSwitch(from, to, openTabs);
    const change: WorkspaceChange = {
      from,
      to,
      switchPlan: sw,
      tabs: await rebaseTabs(openTabs, from.root, to.root),
      note: contextBoundaryNote(from, to),
    };
    // **여기서** 상태를 바꾼다. 지문을 먼저 구했으므로 실패하면 이전 상태가 그대로다.
    this.currentFingerprint = to;
    this.notes.push(change.note);
    this.opts.onChange?.(change);
    return { ok: true, value: change };
  }

  private async checkTarget(path: string): Promise<{ ok: true; root: string } | { ok: false; reason: "not-a-directory" | "not-found"; detail: string }> {
    if (!path || !path.trim()) return { ok: false, reason: "not-found", detail: "경로가 비어 있습니다" };
    const abs = resolve(path);
    const st = await stat(abs).catch(() => null);
    if (!st) return { ok: false, reason: "not-found", detail: `폴더가 없습니다: ${abs}` };
    if (!st.isDirectory()) return { ok: false, reason: "not-a-directory", detail: `디렉터리가 아닙니다: ${abs}` };
    return { ok: true, root: abs };
  }
}

/** 옮겨졌지만 **새 루트에 없는** 탭. 이걸 말하지 않으면 사용자가 빈 화면을 만난다. */
function missingTabWarning(tabs: { path: string; ok: boolean }[]): string[] {
  const missing = tabs.filter((t) => !t.ok).map((t) => t.path);
  if (!missing.length) return [];
  return [`${missing.length}개 탭은 새 폴더에 없습니다: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " 외" : ""}. 닫힙니다.`];
}

/**
 * 열린 탭 경로를 새 루트 기준으로 옮긴다.
 *
 * **경로 연산만으로는 충분하지 않다** — 옮겨진 경로가 새 루트 안에 있어도 그 파일이
 * **없을** 수 있다. 그래데 `ok: true` 라고 하면 UI 는 "탭이 옮겨졌다" 고 표시하고,
 * 사용자는 눌렀을 때 빈 화면을 본다. 그게 조용히 틀린 것의 정보다(§④ 표 8).
 * 그래서 **존재까지 확인**하고, 없으면 `ok: false` 로 남긴다.
 */
async function rebaseTabs(tabs: string[], fromRoot: string, toRoot: string): Promise<{ path: string; ok: boolean }[]> {
  const out: { path: string; ok: boolean }[] = [];
  for (const p of tabs) {
    const r = rebasePath(p, fromRoot, toRoot);
    if (!r.ok) {
      out.push(r);
      continue;
    }
    const exists = await stat(r.path).then(
      (s) => s.isFile() || s.isDirectory(),
      () => false
    );
    out.push({ path: r.path, ok: exists });
  }
  return out;
}
