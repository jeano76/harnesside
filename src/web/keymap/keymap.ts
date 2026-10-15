/**
 * U-11 키맵 프리셋 — 순수 로직 (React 없음).
 *
 * 프리셋 2종: vscode | intellij. 정본은 여기 하나뿐이다.
 * 사람ショート컷 표시와 "단축키로 찾기"가 같은 표를 읽는다.
 * 브라우저·OS 예약 키와 충돌하면 실측 후 대체 키 + 이유를 적는다 (아래 BROWSER_RESERVED).
 */

export type KeymapPreset = "vscode" | "intellij";

export interface KeymapAction {
  id: string;
  vscode: string[];
  intellij: string[];
  noteKey: string;
}

export const KEYMAP_ACTIONS: KeymapAction[] = [
  { id: "palette.all", vscode: ["Ctrl+K", "Ctrl+Shift+P", "Ctrl+P"], intellij: ["Shift Shift", "Ctrl+K"], noteKey: "keymap.paletteAll" },
  { id: "palette.commands", vscode: ["Ctrl+K"], intellij: ["Ctrl+K"], noteKey: "keymap.paletteCommands" },
  { id: "goto.file", vscode: ["Ctrl+P"], intellij: ["Shift Shift"], noteKey: "keymap.gotoFile" },
  { id: "search.content", vscode: ["Ctrl+Shift+F"], intellij: ["Ctrl+Shift+F"], noteKey: "keymap.searchContent" },
  { id: "goto.definition", vscode: ["F12"], intellij: ["Ctrl+B"], noteKey: "keymap.gotoDefinition" },
  { id: "find.usages", vscode: ["Shift+F12"], intellij: ["Alt+F7"], noteKey: "keymap.findUsages" },
  { id: "rename.symbol", vscode: ["F2"], intellij: ["Shift+F6"], noteKey: "keymap.renameSymbol" },
  { id: "intention.action", vscode: ["Ctrl+.", "Alt+Enter"], intellij: ["Alt+Enter"], noteKey: "keymap.intention" },
  { id: "recent.files", vscode: ["Ctrl+E"], intellij: ["Ctrl+E"], noteKey: "keymap.recentFiles" },
  { id: "recipe.run", vscode: ["Ctrl+Shift+B"], intellij: ["Shift+F10"], noteKey: "keymap.recipeRun" },
  { id: "history.local", vscode: ["Ctrl+K H"], intellij: ["Alt+Shift+C"], noteKey: "keymap.localHistory" },
];

export function keysFor(preset: KeymapPreset, actionId: string): string[] {
  const a = KEYMAP_ACTIONS.find((x) => x.id === actionId);
  if (!a) return [];
  return preset === "vscode" ? a.vscode : a.intellij;
}

/** 같은 팔레트 껍데트를 여는 동작들 — 키가 겹쳐도 충돌이 아니다 (U-1: 같은 함수). */
export const PALETTE_FAMILY = new Set(["palette.all", "palette.commands", "goto.file", "search.content"]);

/** 같은 프리셋 안에서 같은 키가 두 동작에 묶였는가 — 있으면 실패. 단 팔레트 가족 내 겹침은 제외. */
export function findKeymapConflicts(preset: KeymapPreset): { key: string; actions: string[] }[] {
  const byKey = new Map<string, string[]>();
  for (const a of KEYMAP_ACTIONS) {
    const keys = preset === "vscode" ? a.vscode : a.intellij;
    for (const k of keys) {
      const norm = k.toLowerCase();
      const list = byKey.get(norm) ?? [];
      list.push(a.id);
      byKey.set(norm, list);
    }
  }
  const out: { key: string; actions: string[] }[] = [];
  for (const [key, actions] of byKey) {
    if (actions.length <= 1) continue;
    // 팔레트 가족끼리의 겹침은 같은 함수를 부르므로 충돌이 아니다.
    if (actions.every((a) => PALETTE_FAMILY.has(a))) continue;
    out.push({ key, actions });
  }
  return out;
}

/** "단축키로 찾기": 키 조합을 누르면 그 키에 묶인 명령이 뜬다. */
export function findActionByKey(preset: KeymapPreset, keyText: string): string | null {
  const norm = keyText.trim().toLowerCase();
  if (!norm) return null;
  for (const a of KEYMAP_ACTIONS) {
    const keys = preset === "vscode" ? a.vscode : a.intellij;
    if (keys.some((k) => k.toLowerCase() === norm)) return a.id;
  }
  return null;
}

/**
 * 브라우저(`--app` 창)가 가로챌 수 있는 예약 키 — 실측 전 잠정치.
 * 확정은 headed Chrome 에서 직접 눌러 보고 정한다 (부록 A 미측정).
 * 여기서의 역할: "충돌 가능성을 숨기지 않고" UI 에 경고로 보여주는 것.
 */
export const BROWSER_RESERVED: { key: string; reason: string }[] = [
  { key: "ctrl+shift+p", reason: "Chrome command palette may intercept; Ctrl+K fallback exists" },
  { key: "ctrl+e", reason: "may focus address bar outside --app; Ctrl+P fallback exists" },
  { key: "shift+f10", reason: "may open context menu on some platforms; palette ! fallback exists" },
  { key: "ctrl+.", reason: "IME may swallow; Alt+Enter fallback exists" },
];

export function checkBrowserConflicts(preset: KeymapPreset): { key: string; action: string; reason: string }[] {
  const out: { key: string; action: string; reason: string }[] = [];
  for (const a of KEYMAP_ACTIONS) {
    const keys = preset === "vscode" ? a.vscode : a.intellij;
    for (const k of keys) {
      const hit = BROWSER_RESERVED.find((r) => r.key === k.toLowerCase());
      if (hit) out.push({ key: k, action: a.id, reason: hit.reason });
    }
  }
  return out;
}

export const KEYMAP_STORAGE_KEY = "harnesside.keymap";

export function parseKeymapPreset(v: string | null): KeymapPreset | null {
  return v === "vscode" || v === "intellij" ? v : null;
}
