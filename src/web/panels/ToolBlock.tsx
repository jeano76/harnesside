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
import { toolCommand, toolPath, type AgentBlock } from "../../session/blocks.js";
import { FilePreview } from "./FilePreview.js";
import { CodeBlock } from "./CodeBlock.js";
import { BlockHeader } from "./BlockHeader.js";
import { languageFor } from "../editor/highlight.js";
import { COLOR, FONT, RADIUS } from "../theme/tokens.js";

const DIM = COLOR.DIM_SUBTLE;
const FG = COLOR.FG;
const BORDER = COLOR.BORDER;

/** 도구 이름 → 사람이 읽는 말. 내부 식별자를 화면에 내놓지 않는다(§5.8). */
const TOOL_LABEL: Record<string, string> = {
  read_file: "파일 읽기",
  write_file: "파일 쓰기",
  edit_file: "파일 수정",
  create_file: "파일 만들기",
  run_shell: "셸 실행",
  list_files: "목록 보기",
  search: "검색",
  apply_patch: "패치 적용",
  git_commit: "커밋",
  finish: "완료",
};

function labelFor(name: string): string {
  return TOOL_LABEL[name] ?? name;
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

export function ToolBlock({
  block,
  client,
  extra,
}: {
  block: AgentBlock;
  client?: ApiClient;
  /** `view` 블록이 그릴 내용. 설정 패널처럼 **무거운 것**은 여기서 주입한다 —
   *  이 컴포넌트가 그 화면을 아는 것이 아니라, **셸이 그릴 대상을 아는** 편이 낫다. */
  /** `view` 블록이 그릴 것들. **셸이 대상을 알고** 있다.
   *
   * **선택 필드가 아니다** — 이 컴포넌트가 클라이언트를 직접 만들어 부르지 않는다.
   * 그렇게 하면 "무엇을 그릴지" 와 "어떻게 부를지" 를 함께 알게 되고, 요구가 바뀔 때
   * 두 곳이 갈라진다(2026-10-01 `ModelPanel` deps 무한요청 사고가 같은 종류였다). */
  extra?: { settings?: React.ReactNode };
}) {
  // ── 사람이 연 블록 (2026-10-01) ────────────────────────────────────────────
  // 설정 · 변경 검토 · 파일 미리보기가 **대화 안에** 열린다. 별도 패널이 없어진
  // 이유가 이것이고, 되돌리려면 이 분기를 없애고 패널을 다시 만들어야 한다.
  if (block.kind === "view") {
    if (block.view?.what === "file" && block.view.path && client) {
      return (
        <div style={{ margin: "2px 0" }}>
          <div style={{ fontSize: 10, color: DIM, marginBottom: 2 }}>열기 · {block.view.path}</div>
          {/* **자동 연다** — 사람이 직접 연 블록이므로 접어 두면 "뭘 열었지" 가 된다. */}
          <FilePreview client={client} path={block.view.path} autoOpen />
        </div>
      );
    }
    // 설정 · 변경 검토 · 디렉터리는 **사람이 연 블록**이다. 이 자리에서 그린다 —
    // 별도 패널로 빼면 "왜 이걸 봤나" 를 스크롤로 되돌아가야 한다(2026-10-01).
    if (block.view?.what === "settings" && client) {
      return (
        <div style={{ margin: "2px 0" }}>
          <div style={{ fontSize: 10, color: DIM, marginBottom: 2 }}>설정</div>
          <div className="elev-1" style={{ border: `1px solid ${BORDER}`, borderRadius: 6, overflow: "hidden" }}>
            {extra?.settings}
          </div>
        </div>
      );
    }
    // ── 디렉터리 · 변경 검토 진입로는 제거됨 (사용자 지정: 설정만 남긴다) ──
    // 저장된 옛 대화에 남은 블록은 정직하게 말한다. "아직 연결하지 않았습니다"는
    // 거짓말이다 — 연결됐었는데 제거된 것이다.
    if (block.view?.what === "dirs" || block.view?.what === "diff") {
      return (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "6px 8px", fontSize: 11, color: DIM }}>
          {block.view.what === "diff" ? "변경 검토" : "디렉터리"} — 이 화면은 제거되었습니다.
        </div>
      );
    }
    return (
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "6px 8px", fontSize: 11, color: DIM }}>
        이 화면을 열 수 없습니다 — {block.view?.what ?? "알 수 없는 보기"}.
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
    return <FilePreview client={client} path={path} />;
  }
  if (isFileTool(name, args) && path) return <FileBlock label={labelFor(name)} path={path} done={done} client={client} />;

  // **판별할 수 없는 도구** — 한 줄로 말한다. 추측해서 에디터를 열지 않는다.
  // 헤더 계약(BlockHeader): 도형+이름+대상+상태+복사. 색만으로 알리지 않는다.
  return (
    <div>
      <BlockHeader
        kind={isShell(name, args) ? "shell" : isFileTool(name, args) ? "file" : /search/i.test(name) ? "search" : "tool"}
        target={labelFor(name)}
        status={done ? "완료" : "실행 중"}
        done={done}
        copyText={block.text || undefined}
      />
      {block.text ? <div style={{ color: DIM, fontSize: FONT.AUX }}>{block.text.slice(0, 120)}</div> : null}
    </div>
  );
}

/** 파일 도구 — **경로와 내용을 그 자리에서** 보여준다. */
function FileBlock({ label, path, done, client }: { label: string; path: string; done: boolean; client?: ApiClient }) {
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
          {error && <div style={{ padding: "6px 8px", color: COLOR.ERROR, fontSize: FONT.AUX }}>읽지 못했습니다: {error}</div>}
          {!error && content === null && <div style={{ padding: "6px 8px", color: DIM, fontSize: 11 }}>읽는 중…</div>}
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
        target={command || "(명령 없음)"}
        status={done ? "완료" : "실행 중…"}
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
          summary={`셸 출력 ${output.split("\n").length}줄`}
        />
      )}
    </div>
  );
}
