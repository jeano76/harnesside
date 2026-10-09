/**
 * 업데이트 위임 — 감시기가 새 버전 기동을 확인하고, 실패하면 되돌린다 (P13 4단계).
 *
 * 분업: 서버(라우트)는 교체+마커까지만 하고 코드 42 로 끝난다(자기 재시작 불가).
 * 감시기는 다시 띄우고, 마커가 소비됐는지(자식이 확인했는지)로 판정한다.
 * 마커가 남았으면(신원 불일치) 슬롯에서 되돌리고 옛것을 다시 띄운다.
 *
 * 경계 규칙(서버 `rollback()` 과 같은 규칙 — 두 곳에 두면 어긋난다):
 *  - 슬롯 범위 밖의 경로는 거부한다 — 임의 경로 복사는 곧 임의 파일 쓰기다.
 *  - git 체크아웃에는 손대지 않는다 — 개발 트리를 갈아끼우면 작업이 날아간다.
 *  - 마커는 지우지 않고 옆으로 옮긴다 — "무엇이 있었는지" 가 증거다.
 */

import { readFile, rename, stat } from "node:fs/promises";
import { join, relative, isAbsolute, resolve } from "node:path";
import { installTree } from "../updateService.js";

/** 서버가 자발적으로 끝낼 때 감시기에 알리는 코드 — 크래시(1)·정상(0)과 다르다. */
export const UPGRADE_EXIT_CODE = 42;

export interface UpdateMarker {
  swappedAt?: number;
  tree?: string;
  slot?: string | null;
  treeSha256?: string | null;
  target?: { version?: string; date?: string | null; sha?: string | null } | null;
}

export function markerPath(stateDir: string): string {
  return join(stateDir, "update-pending.json");
}

export async function readPendingMarker(stateDir: string): Promise<UpdateMarker | null> {
  try {
    return JSON.parse(await readFile(markerPath(stateDir), "utf8")) as UpdateMarker;
  } catch {
    return null;
  }
}

/**
 * 새 버전 기동이 확인됐는가 — 마커가 소비됐으면(자식이 같은 신원으로 떴으면) 그렇다.
 * 마커가 없는데 확인을 물으면: 쓸 게 없으니 확인으로 본다(자식이 소비한 뒤다).
 * 이유도 함께 말한다 — "됐습니다" 만으로는 부족하다.
 */
export async function checkUpdateConfirmed(stateDir: string): Promise<{ confirmed: boolean; reason: string }> {
  const marker = await readPendingMarker(stateDir);
  if (!marker) return { confirmed: true, reason: "마커 없음 — 자식이 적용을 확인하고 소비했습니다" };
  const target = marker.target?.version ?? marker.target?.sha?.slice(0, 7) ?? "미상";
  return {
    confirmed: false,
    reason: `마커 남음 — 자식이 ${target} 을(를) 확인하지 않았습니다 (신원 불일치)`,
  };
}

/**
 * 슬롯에서 설치 루트로 되돌린다. 성공하면 마커를 `update-rolledback-*` 으로 옮긴다.
 * 실패하면 아무것도 안 건드린다(마커 포함 — 다음 판단의 재료다).
 */
export async function rollbackUpdate(
  stateDir: string,
  slotsDir: string,
  installRoot: string
): Promise<{ ok: boolean; detail: string }> {
  const marker = await readPendingMarker(stateDir);
  const slot = marker?.slot ?? null;
  if (!slot) return { ok: false, detail: "되돌릴 슬롯이 마커에 없습니다 — 수동으로 확인하십시오" };
  const rel = relative(resolve(slotsDir), resolve(slot));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, detail: "슬롯 범위 밖의 경로입니다 — 임의 경로를 복사하지 않습니다" };
  }
  try {
    const git = await stat(join(installRoot, ".git")).catch(() => null);
    if (git) return { ok: false, detail: `설치 루트가 git 체크아웃입니다(${installRoot}) — 개발 트리에는 손대지 않습니다` };
    const r = await installTree(slot, installRoot);
    const aside = join(stateDir, `update-rolledback-${Date.now()}.json`);
    await rename(markerPath(stateDir), aside).catch(() => undefined);
    return { ok: true, detail: `되돌렸습니다: ${slot} (${r.written}개 파일)` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
