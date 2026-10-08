/**
 * 에이전트 출력 **안쪽**에서 도구를 그린다 (2026-10-01).
 *
 * 왜 이것이 별도 파일인가: 도구 블록은 이제 한 줄짜리 라벨이 아니다. 파일을 봤다면
 * **그 파일을** 보여주고, 셸을 돌렸다면 **그 실행을** 보여준다. 즉 도구 블록은
 * IDE 의 "결과" 영역이다 — 그리고 그건 **에이전트 출력의 흐름 안** 에 있어야 한다.
 *
 * 화면 밖(별도 패널)으로 빼면 두 가지를 잃는다:
 *  1. **맥락** — "왜 이 파일이 열렸나" 를 위아래 스크롤로 따라가야 한다.
 *  2. **순서** — 여러 도구를 썼을 때 어떤 것이 먼저였나가 스크롤 위치가 된다.
 *
 * 비동기 셸은 **블록 안에서** 돈다. 완료되면 **결과가 그 자리에서** 나온다 — 사용자가
 * 다른 화면으로 가서 "됐나" 확인하러 돌아다니게 하지 않는다.
 *
 * ── 하지 않는 것 ────────────────────────────────────────────────────────────
 * **아직 실행 중이면 결과를 지어내지 않는다.** "성공" 을 미리 쓰면 사용자는 확인을
 * 안 하고 넘어간다. 상태는 `실행 중` 이고, 서버가 끝났을 때만 결과를 쓴다.
 */

import React, { useEffect, useState } from "react";
import type { ApiClient } from "../api.js";
import { useI18n } from "../i18n/index.js";
import { toolCommand, toolPath, type AgentBlock } from "../../session/blocks.js";
import { FilePreview } from "./FilePreview.js";
import { CodeBlock } from "./CodeBlock.js";
import { BlockHeader } from "./BlockHeader.js";
import { languageFor } from "../editor/highlight.js";
import { COLOR, FONT, RADIUS } from "../theme/tokens.js";

const DIM = COLOR.DIM_SUBTLE;
const FG = COLOR.FG;
const BORDER = COLOR.BORDER;

/** 도구 이름 → 사람이 읽는 말. 내부 식별자를 화면에 내놓지 않는다(§5.8).
 *  카탈로그에 있는 이름만 번역한다 — 모르는 이름은 t()를 부르지 않는다.
 *  t()는 모르는 키를 누락으로 기록하므로, 식별자 폴백까지 누락에 쌓이면
 *  진짜 빠진 키가 묻힌다. */
const TOOL_KEYS = [
  "read_file",
  "write_file",
  "edit_file",
  "create_file",
  "run_shell",
  "list_files",
  "search",
  "apply_patch",
  "git_commit",
  "finish",
] as const;

function labelFor(name: string, t: (key: string) => string): string {
  return (TOOL_KEYS as readonly string[]).includes(name) ? t(`tool.${name}`) : name;
}

/** 이 도구가 **셸** 이나 — 이름만 믿지 않고 인자까지 본다. */
function isShell(name: string, args: Record<string, unknown> | undefined): boolean {
  if (/shell|bash|exec|terminal|command/i.test(name)) return true;
  return toolCommand(args) !== null;
}

/** 이 도구가 **파일을 본다** 나 — 읽기·쓰기·수정·목록. */
function isFileTool(name: string, args: Record<string, unknown> | undefined): boolean {
  if (isShell(name, args)) return false;
  return /file|read|write|edit|patch|grep|search|list|glob/i.test(name) || toolPath(args) !== null;
}

/** 슬래시 명령 결과 — 대화 안의 **접고 펼 수 있는** 블록. 실행 중이면 그렇다고 말한다. */
function SlashBlock({ block, onToggle }: { block: AgentBlock; onToggle?: () => void }) {
  const t = useI18n();
  const open = block.view?.viewCollapsed !== true;
  const state = block.view?.slashState ?? "ok";
  const color = state === "error" ? "#f85149" : state === "running" ? "#d29922" : DIM;
  const body = state === "running" ? t("block.runningEllipsis") : block.text || t("block.noOutput");
  return (
    <div style={{ margin: "2px 0" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? t("action.collapse") : t("action.expand")}
        style={{ background: "none", border: 0, color, cursor: "pointer", font: "inherit", fontSize: 11, padding: 0 }}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> /{block.view?.path}
        {state === "running" && <span style={{ marginLeft: 6 }}>{t("block.running")}</span>}
        {state === "error" && <span style={{ marginLeft: 6 }}>{t("block.failed")}</span>}
      </button>
      {open && (
        <pre style={{ margin: "2px 0 0", padding: "6px 8px", border: `1px solid ${BORDER}`, borderRadius: 6, background: "#0d1117", color: FG, fontFamily: FONT.MONO ?? "monospace", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 360, overflow: "auto" }}>
          {body}
        </pre>
      )}
    </div>
  );
}

export function ToolBlock({
  block,
  client,
  extra,
  onToggleView,
  onCloseView,
  onToggleBlock,
  onEditFile,
}: {
  block: AgentBlock;
  /** 슬래시 블록 하나를 접고 편다(블록 id 로 찾는다 — 설정용 전역 토글과 별개). */
  onToggleBlock?: () => void;
  client?: ApiClient;
  /** 뷰를 접었다/펼쳤다 — 헤더 ⚙ 아이콘과 **같은 규칙**(`toggleView`)을 탄다.
   *  경로마다 따로 만들면 "아이콘에서는 닫히는데 블록에서는 쌓인다" 가 된다. */
  onToggleView?: () => void;
  /** 편집기로 파일을 연다 — `main.tsx` 의 `openFileByPath` 까지만 전달한다(경로 하나). */
  onEditFile?: (path: string) => void;
  /** 이 블록만 접는다(블록 안의 ✕). */
  onCloseView?: () => void;
  /** `view` 블록이 그릴 내용. 설정 패널처럼 **무거운 것**은 여기서 주입한다 —
   *  이 컴포넌트가 그 화면을 아는 것이 아니라, **셸이 그릴 대상을 아는** 편이 낫다. */
  /** `view` 블록이 그릴 것들. **셸이 대상을 알고** 있다.
   *
   * **선택 필드가 아니다** — 이 컴포넌트가 클라이언트를 직접 만들어 부르지 않는다.
   * 그렇게 하면 "무엇을 그릴지" 와 "어떻게 부를지" 를 함께 알게 되고, 요구가 바뀔 때
   * 두 곳이 갈라진다(2026-10-01 `ModelPanel` deps 무한요청 사고가 같은 종류였다). */
  extra?: { settings?: React.ReactNode };
}) {
  const t = useI18n();
  // ── 사람이 연 블록 (2026-10-01) ────────────────────────────────────────────
  // 설정 · 변경 검토 · 파일 미리보기가 **대화 안에** 열린다. 별도 패널이 없어진
  // 이유가 이것이고, 되돌리려면 이 분기를 없애고 패널을 다시 만들어야 한다.
  if (block.kind === "view") {
    if (block.view?.what === "slash") return <SlashBlock block={block} onToggle={onToggleBlock} />;
    if (block.view?.what === "file" && block.view.path && client) {
      return (
        <div style={{ margin: "2px 0" }}>
          <div style={{ fontSize: 10, color: DIM, marginBottom: 2 }}>{t("block.openPath", { path: block.view.path })}</div>
          {/* **자동 연다** — 사람이 직접 연 블록이므로 접어 두면 "뭘 열었지" 가 된다. */}
          <FilePreview client={client} path={block.view.path} autoOpen onEdit={onEditFile} />
        </div>
      );
    }
    // 설정 · 변경 검토 · 디렉터리는 **사람이 연 블록**이다. 이 자리에서 그린다 —
    // 별도 패널로 빼면 "왜 이걸 봤나" 를 스크롤로 되돌아가야 한다(2026-10-01).
    if (block.view?.what === "settings" && client) {
      // **접힌 상태는 한 줄로 남는다**(사용자 요구: "설정 버튼을 다시 누르면 닫힘").
      // 지우지 않는 이유: 닫았다 다시 열었을 때 **같은 자리**로 돌아와야 하고,
      // 스크롤로 되돌아가 볼 수도 있어야 한다(삭제는 되돌릴 수 없다).
      const collapsed = block.view.viewCollapsed === true;
      return (
        <div style={{ margin: "2px 0" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 10, color: DIM, marginBottom: collapsed ? 0 : 2 }}>
            <button
              type="button"
              onClick={onToggleView}
              aria-expanded={!collapsed}
              title={collapsed ? t("block.settingsExpand") : t("block.settingsCollapse")}
              style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", fontSize: 10, padding: 0 }}
            >
              <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> {t("panel.settings")}
              {collapsed && <span style={{ marginLeft: 6 }}>{t("block.settingsCollapsedHint")}</span>}
            </button>
            {!collapsed && onCloseView && (
              <button
                type="button"
                onClick={onCloseView}
                aria-label={t("block.settingsCollapse")}
                title={t("block.settingsCollapse")}
                style={{ background: "none", border: 0, color: DIM, cursor: "pointer", font: "inherit", fontSize: 10, padding: "0 2px", marginLeft: "auto" }}
              >
                ✕
              </button>
            )}
          </div>
          {!collapsed && (
            <div className="elev-1" style={{ border: `1px solid ${BORDER}`, borderRadius: 6, overflow: "hidden" }}>
              {extra?.settings}
            </div>
          )}
        </div>
      );
    }
    // ── 디렉터리 · 변경 검토 진입로는 제거됨 (사용자 지정: 설정만 남긴다) ──
    // 저장된 옛 대화에 남은 블록은 정직하게 말한다. "아직 연결하지 않았습니다"는
    // 거짓말이다 — 연결됐었는데 제거된 것이다.
    if (block.view?.what === "dirs" || block.view?.what === "diff") {
      return (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "6px 8px", fontSize: 11, color: DIM }}>
          {block.view.what === "diff" ? t("panel.diff") : t("panel.directory")} — {t("block.viewRemoved")}
        </div>
      );
    }
    return (
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "6px 8px", fontSize: 11, color: DIM }}>
        {t("block.viewUnknown", { what: block.view?.what ?? t("block.unknownView") })}
      </div>
    );
  }

  const name = block.tool?.name ?? "";
  const args = block.tool?.args;
  const done = !!block.tool?.done;
  const path = toolPath(args);
  const command = toolCommand(args);

  if (isShell(name, args)) return <ShellBlock command={command ?? ""} done={done} text={block.text} client={client} />;
  // 파일 도구 블록도 **미리보기**로 그린다 — 같은 파일을 두 모양으로 보여주면
  // 사용자는 "이거 편집기인가 미리보기인가" 를 헷갈린다.
  if (isFileTool(name, args) && path && client) {
    return <FilePreview client={client} path={path} onEdit={onEditFile} />;
  }
  if (isFileTool(name, args) && path) return <FileBlock label={labelFor(name, t)} path={path} done={done} client={client} />;

  // **판별할 수 없는 도구** — 한 줄로 말하고 펼치면 호출 내용을 보여준다.
  // 예전엔 헤더 줄 + 결과 미리보기 줄의 두 줄이었고, 정작 "어떻게 호출됐는지"
  // (인자)는 어디에도 없었다. 헤더 계약(도형+이름+상태)은 접힌 한 줄에 두고,
  // 호출 인자와 결과는 펼쳤을 때만 보여준다.
  return <GenericToolBlock name={name} argsText={typeof args === "string" ? args : undefined} done={done} text={block.text} />;
}

/** 인자를 사람이 읽는 모양으로 — 못 읽으면 원문 그대로(지어내지 않는다). */
export function formatToolCall(name: string, argsText?: string): string {
  if (!argsText) return `${name}()`;
  try {
    return `${name}(${JSON.stringify(JSON.parse(argsText), null, 2)})`;
  } catch {
    return `${name}(${argsText})`;
  }
}

/** 판별 불가 도구 한 줄 — 펼치면 호출(인자)과 결과를 보여준다. */
function GenericToolBlock({ name, argsText, done, text }: { name: string; argsText?: string; done: boolean; text: string }) {
  const t = useI18n();
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const callText = formatToolCall(name, argsText);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: FONT.META, color: COLOR.DIM, marginBottom: open ? 2 : 0, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? t("block.collapseCall") : t("block.expandCall")}
          style={{ background: "none", border: 0, color: done ? COLOR.GOOD : COLOR.DIM, cursor: "pointer", font: "inherit", fontSize: FONT.META, padding: 0, display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: "1 1 auto" }}
        >
          <span aria-hidden="true">🔧</span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span style={{ color: COLOR.DIM, flexShrink: 0 }}>{labelFor(name, t)}</span>
          <span style={{ flexShrink: 0 }}>{done ? t("block.done") : t("block.running")}</span>
        </button>
        <button
          type="button"
          aria-label={t("block.copyCall")}
          title={copied ? t("block.copied") : t("block.copy")}
          onClick={() => {
            try {
              void navigator.clipboard?.writeText(callText);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              /* 클립보드 실패는 조용히 둔다 */
            }
          }}
          style={{ flexShrink: 0, background: "transparent", color: copied ? COLOR.GOOD : COLOR.DIM, border: 0, cursor: "pointer", font: "inherit", fontSize: FONT.META, padding: "0 2px" }}
        >
          {copied ? "✓" : "⧉"}
        </button>
      </div>
      {open && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1, overflow: "hidden" }}>
          <pre style={{ margin: 0, padding: "6px 8px", maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "11px/1.5 ui-monospace, monospace", color: FG }}>
            {callText}
          </pre>
          {text ? (
            <div style={{ borderTop: `1px solid ${BORDER}`, padding: "6px 8px", color: DIM, fontSize: FONT.AUX, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {text.slice(0, 2000)}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 파일 도구 — **경로와 내용을 그 자리에서** 보여준다. */
function FileBlock({ label, path, done, client }: { label: string; path: string; done: boolean; client?: ApiClient }) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // **자동으로는 열지 않는다.** 에이전트가 파일을 50번 읽으면 에이전트 출력이
  // 50개의 코드 블록으로 뒤덮여 **대화가 안 읽힌다.** 사용자가 펼칠 때 읽는다.
  useEffect(() => {
    if (!open || content !== null || !client) return;
    let alive = true;
    void client
      .get<{ content: string }>(`/api/fs/file?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (alive) setContent(r.content);
      })
      .catch((e) => {
        // **열지 못했다는 사실을 말한다.** 조용히 빈 화면이면 "파일이 비었다" 고 읽힌다.
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [open, content, client, path]);

  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex", gap: 6, width: "100%", alignItems: "center",
          background: "none", border: 0, color: done ? COLOR.GOOD : DIM,
          cursor: "pointer", font: "inherit", fontSize: 11, padding: "3px 8px", textAlign: "left",
        }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        <code style={{ color: FG, fontSize: 10 }}>{path}</code>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${BORDER}` }}>
          {error && <div style={{ padding: "6px 8px", color: COLOR.ERROR, fontSize: FONT.AUX }}>{t("block.readFailed")}: {error}</div>}
          {!error && content === null && <div style={{ padding: "6px 8px", color: DIM, fontSize: 11 }}>{t("block.loading")}</div>}
          {content !== null && (
            <pre
              style={{
                margin: 0, padding: "6px 8px", maxHeight: 320, overflow: "auto",
                whiteSpace: "pre", font: "11px/1.5 ui-monospace, monospace", color: FG,
              }}
            >
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 비동기 셸 — **블록 안에서** 돈다.
 *
 * 실행 중에는 `실행 중` 이라고만 말한다. 완료되면 그 자리에 결과를 쓴다.
 * "성공" 을 미리 쓰지 않는 이유는 §5.10: 실측되지 않은 것을 실측처럼 말하면
 * 사용자는 확인을 건너뛴다.
 */
function ShellBlock({ command, done, text, client }: { command: string; done: boolean; text: string; client?: ApiClient }) {
  const t = useI18n();
  const [output, setOutput] = useState<string>("");

  useEffect(() => {
    if (!done || !client) return;
    // **실행 ID** 를 알 수 없으므로, 명령 문자열로 최근 로그를 거른다. 이건 부정확하다
    // — 그래서 결과가 없으면 없다고 말하고, 지어내지 않는다.
    void client
      .get<{ entries: { line: string }[] }>(`/api/logs?limit=200`)
      .then((r) => {
        const hit = r.entries.filter((e) => e.line.includes(command.slice(0, 40)));
        if (hit.length) setOutput(hit.map((e) => e.line).join("\n"));
      })
      .catch(() => {
        /* 못 읽으면 비워 둔다 — 없는 결과를 지어내지 않는다 */
      });
  }, [done, client, command]);

  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1, padding: "4px 8px" }}>
      <BlockHeader
        kind="shell"
        target={command || t("block.noCommand")}
        status={done ? t("block.done") : t("block.runningEllipsis")}
        done={done}
        copyText={output || command || undefined}
      />
      {text && <div style={{ color: DIM, fontSize: 10, marginTop: "2px" }}>{text.slice(0, 200)}</div>}
      {output && (
        // 명령줄은 헤더(BlockHeader)에 한 번만 나온다 — CodeBlock 에 또 넣으면
        // 같은 명령이 두 번 보인다(실측). **출력은 하이라이트하지 않는다** —
        // `ls` 의 결과는 셸 문법이 아니다. 색을 칠하면 지어내는 것이 된다.
        <CodeBlock
          lang={null}
          text={output}
          collapsible
          summary={t("block.shellOutputLines", { count: output.split("\n").length })}
        />
      )}
    </div>
  );
}
