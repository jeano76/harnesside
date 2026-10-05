/**
 * **편집 화면의 도달 가능성** (2026-10-05).
 *
 * 이 테스트가 없던 이유는 단순하다 — 편집기(`EditorView`)가 **도달 불가능**했다.
 * `import` 만 있고 렌더되는 곳이 없고, 파일을 여는 함수(`openFileByPath`)는
 * 정의만 되어 있었고, `openFile` 상태와 탭 목록(`openTabs`)만 남아 있었다.
 * 즉 **이 프로그램에는 파일을 여는 방법이 없었다.**
 *
 * 왜 이게 유닛으로 잡히는가: 렌더 **결과물**은 브라우저가 있어야 보이지만,
 * "이 컴포넌트가 어디에서 그려지는가" 는 **소스에 있다.** 화면 모양을 보지 않고도
 * "사용자가 도달할 수 있는가" 를 검사할 수 있다 — 그리고 도달 불가능한 것은
 * **브라우저 실측 전에** 잡아야 한다(실측은 그 이후에도 실패한다).
 *
 * 규칙 하나: **컴포넌트를 import 하면 화면에 닿아야 한다.** 닿지 않을 것이라면
 * 이유를 코드에 적는다 — 그래야 "왜 이 파일이 있냐" 를 나중에 답할 수 있다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = here;
const read = (rel: string) => readFileSync(join(webDir, rel), "utf8");

const mainSrc = read("main.tsx");
const agentPanelSrc = read("panels/AgentPanel.tsx");
const toolBlockSrc = read("panels/ToolBlock.tsx");
const previewSrc = read("panels/FilePreview.tsx");

/**
 * **도달 불가능하다고 인정한 컴포넌트** — reasons 는 비우지 않는다.
 *
 * 2026-10-05 실측: `DiffPanel` 은 import 만 있고 렌더되지 않는다. diff 화면이
 * 없다는 뜻이고, 사용자는 "diff 를 볼 방법이 없다" 고 말해야만 알게 된다.
 * 여기 적어 두는 것은 고치지 않겠다는 뜻이 아니라, **모르는 죽은 코드**로 두지
 * 않겠다는 뜻이다. 연결하면 이 목록에서 지운다(누가 연결했든).
 */
const KNOWN_UNREACHABLE: Record<string, string> = {
  CommitBox:
    "커밋 입력 상자(§9.3). import 만 있고 렌더되지 않는다 — 어디에 둘지(설정 블록? 대화 블록?)가 정해지지 않았다. 배치는 별도 요구(미결)",
};

function renderedUsages(symbol: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(p) || /\.test\.tsx?$/.test(p)) continue;
      const src = readFileSync(p, "utf8");
      // **JSX 로 쓰인 곳만** 렌더로 센다 — import 나 mere 참조는 도달이 아니다.
      if (new RegExp(`<${symbol}[\\s/>]`).test(src)) out.push(p);
    }
  };
  walk(webDir);
  return out;
}

// ── 편집기: 도달 가능해야 한다 ──────────────────────────────────────────────

test("**편집기가 화면에 그려진다** — import 만 있어서는 '있는 기능' 이 아니다", () => {
  const users = renderedUsages("EditorView");
  assert.ok(users.length > 0, "EditorView 를 그리는 곳이 없다 — 편집기에 도달할 방법이 없다");
  assert.ok(
    users.some((u) => u.endsWith("main.tsx")),
    `EditorView 가 ${users.join(", ")} 에서만 그려진다 — 최상위에서 열리는 경로가 있어야 한다`,
  );
});

test("편집기는 **열린 파일이 있을 때** 그려진다 — 조건이 거짓이면 코드가 있어도 화면에 없다", () => {
  // `<EditorView` 가 코드에 있다는 것만으로는 부족하다(실측: `{false && (…)}` 로 바꿔도
  // 첫 판은 통과했다). **guard 조건**과 **상태를 채우는 곳**을 함께 본다.
  assert.match(mainSrc, /\{openFile && \(/, "편집기 렌더가 `openFile` 로 열리지 않는다 — 언제 그려지는지 알 수 없다");
  // `openFileByPath` 가 실제로 상태를 채운다 — 읽기 성공 시 파일 정보를 넣어야 한다.
  assert.match(mainSrc, /setOpenFile\(f\)/, "파일을 열어도 상태가 채워지지 않는다 — 화면이 열리지 않는다");
});

test("**파일을 여는 함수가 호출된다** — 정의만 있고 불리지 않는 함수는 없다", () => {
  // 정의(=`const name =` )가 아니라 **호출**(`name(`)을 센다.
  // 정의는 `name =`, 호출은 `name(` — **둘을 다른 정규식으로 센다.** 한 정규식으로
  // 세려 하면 둘이 섞여 "호출이 있다" 고 잘못 통과한다(첫 판이 그랬다).
  const defs = (mainSrc.match(/openFileByPath\s*=/g) ?? []).length;
  const calls = (mainSrc.match(/openFileByPath\(/g) ?? []).length;
  assert.ok(defs >= 1, "openFileByPath 정의가 사라졌다");
  assert.ok(calls >= 1, "openFileByPath 를 **호출하는 곳**이 없다 — 함수가 죽어 있다");
  assert.match(
    mainSrc,
    /onEditFile=\{\(p: string\) => void openFileByPath\(p\)\}/,
    "편집 입구가 `openFileByPath` 로 연결되어 있지 않다",
  );
});

test("**`편집` 버튼은 입구가 있을 때만** 붙는다 — 죽은 버튼을 늘리지 않는다", () => {
  assert.match(previewSrc, /onEdit\?: \(path: string\) => void/, "FilePreview 가 편집 입구를 받지 않는다");
  assert.match(previewSrc, /\{onEdit && \(/, "편집 버튼이 항상 붙는다 — 눌러도 아무 일 없는 버튼");
  assert.match(previewSrc, />\s*편집\s*</, "편집 버튼에 보이는 이름이 없다 — 아이콘만 남으면 무엇인지 모른다");
  // 경로는 `onEdit(path)` 로만 전달한다 — 블록이 열기를 직접 호출하지 않는다.
  assert.match(previewSrc, /onClick=\{\(\) => onEdit\(path\)\}/, "편집 버튼이 경로 없이 호출된다");
  // 배선이 끊기면 FilePreview 는 조용히 읽기 전용으로 돌아간다 — 그게 지금의 결함이다.
  assert.match(toolBlockSrc, /onEdit=\{onEditFile\}/, "ToolBlock 가 편집 입구를 FilePreview 에 넘기지 않는다");
  assert.match(agentPanelSrc, /onEditFile=\{onEditFile\}/, "AgentPanel 이 편집 입구를 ToolBlock 에 넘기지 않는다");
  assert.match(mainSrc, /onEditFile=\{/, "App 이 편집 입구를 AgentPanel 에 넘기지 않는다");
});

test("편집기는 **닫을 수 있다** — 열었는데 못 닫으면 화면이 갇힌다", () => {
  assert.match(mainSrc, /onClick=\{\(\) => setOpenFile\(null\)\}/, "편집기를 닫는 방법이 없다");
  // 열려 있는 동안 탭 목록에 뜨는 상태도 이미 있다(`openTabs`) — 그 계선이 끊기면
  // "어디가 열린 파일이냐" 를 아무도 모른다.
  assert.match(mainSrc, /openTabs = useMemo/, "열린 파일 목록(state)이 사라졌다");
});

// ── 죽은 코드 목록: 모르는 죽은 코드를 두지 않는다 ────────────────────────

test("**import 만 되고 아무 데서도 쓰이지 않는 것**은 사유와 함께 인정되어 있다", () => {
  // **대문자 import 라고 전부 컴포넌트는 아니다** — `WsClient` 같은 클래스는
  // `new WsClient(...)` 로 쓰인다. 그래서 판정 기준은 "JSX 로 그려지는가" 하나가
  // 아니라 **import 줄을 제외하고 이름이 한 번이라도 나오나** 다(첫 판이 이걸 놓쳤고
  // 실제로 렌더되지도 않는 클래스를 "죽은 코드" 라고보고했다)。
  const imported = [...mainSrc.matchAll(/^import \{ ([A-Z][A-Za-z0-9]*) \} from "\.\//gm)].map((m) => m[1]!);
  // ★ import 줄을 **지운 뒤** 센다. 지우지 않으면 `import { X } from "./X.js"` 의
  //   경로 문자열이 두 번째 등장으로 잡혀 **쓰이지 않은 것을 쓴 것으로 센다**(실측).
  const withoutImports = mainSrc.replace(/^import .*$/gm, "");
  const referenced = (sym: string) => (withoutImports.match(new RegExp(`\\b${sym}\\b`, "g")) ?? []).length > 0;
  const dead = imported.filter((sym) => !referenced(sym));
  for (const sym of dead) {
    const reason = KNOWN_UNREACHABLE[sym];
    assert.ok(reason, `${sym} 이(가) import 만 되고 렌더되지 않는다 — 연결하거나 사유를 적어라`);
    assert.ok(reason.length > 20, `${sym} 의 사유가 한 문장보다 짧다 — 아무도 이해하지 못한다`);
  }
  // 목록이 **비어 있지 않은 상태로** 실제 문제를 담고 있는지도 함께 본다 —
  // 목록을 지워 통과시키면 이 검사가 아무것도 하지 않는 것이다.
  // 목록이 **현재 사실과 맞는지**도 본다. 연결해서 지운 컴포넌트가 남아 있으면
  // "거짓 사유" 가 쌓이고, 새로 죽은 컴포넌트가 있으면 목록이 조용히 낡아간다.
  for (const sym of Object.keys(KNOWN_UNREACHABLE)) {
    assert.ok(dead.includes(sym), `${sym} 은 이제 쓰이고 있다 — KNOWN_UNREACHABLE 에서 지워야 한다`);
  }
  for (const sym of dead) {
    assert.ok(Object.keys(KNOWN_UNREACHABLE).includes(sym), `${sym} 이 새로 죽었다 — 사유를 적거나 연결하라`);
  }
});

test("**렌더는 되는데 목록에 남아 있는** 컴포넌트도 없다 — 거짓 사유가 쌓이지 않게", () => {
  for (const [sym, reason] of Object.entries(KNOWN_UNREACHABLE)) {
    if (!renderedUsages(sym).length) continue;
    assert.fail(`${sym} 은 이제 렌더된다 — KNOWN_UNREACHABLE 에서 지워야 한다 (적힌 사유: ${reason})`);
  }
});
