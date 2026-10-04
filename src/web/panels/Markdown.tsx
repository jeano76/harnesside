/**
 * 대화의 **마크다운** — IDE 다크 테마로 (2026-10-01).
 *
 * ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
 *
 * 모델은 마크다운을 보냅니다. 화면은 `pre` 에 그대로 넣었습니다:
 *
 *     <pre style={{ whiteSpace: "pre-wrap", … }}>{b.text}</pre>
 *
 * 그래서 `**굵게**`, `` `코드` ``, `## 제목`, `- 목록` 이 **모두 기호 그대로** 보였다.
 * 사용자는 "이게 강조가 안 된다" 고 느낀다 — 그리고 그건 **맞다**. 강조가 없었다.
 * 파일 미리보기만 색이 있었고, **대화 본문은 플레인 텍스트**였다.
 *
 * ── 무엇을 쓰나 ────────────────────────────────────────────────────────────
 *
 * **`marked` 가 이미 의존성에 있다**(`marked@15`) — 새로 설치하지 않는다. 그리고
 * **스스로 스타일을 붙인다.** `github-markdown-css` 같은 것을 넣으면:
 *  - 네트워크 설치가 필요하고(오프라인에서 실패),
 *  - **두 번째 하이라이터**가 생겨 파일 미리보기와 규칙이 어긋난다.
 *
 * 하이라이트는 **기존 엔진**(`editor/highlight.ts`)을 그대로 쓴다. 규칙이 두 곳에
 * 있으면 반드시 어긋난다 — 실제로 그랬다.
 *
 * ── 하지 않는 것 ────────────────────────────────────────────────────────────
 *
 * **HTML 을 그대로 신뢰하지 않는다.** `marked` 는 원본 HTML 을 통과시킨다. 모델
 * 출력이 사용자 화면에 `<script>` 를 밀어넣을 수 있고, 이전 버그에서
 * `404` 가 올바른 문장으로 보이는 것처럼 **"안전해 보이지만 위험한 것"** 이 가장
 * 위험하다. 그래서 `html` 을 끄고 **Markdown 내부**에서만 허용한다.
 */

import React, { useMemo } from "react";
import { marked } from "marked";
import { colorFor, tokenizeLine, languageFor } from "../editor/highlight.js";
import { COLOR, FONT, RADIUS } from "../theme/tokens.js";

// ── 색 (GitHub Dark 계열 — 파일 미리보기와 **같은 계열**로 맞춘다) ────────────
const FG = COLOR.FG;
const DIM = COLOR.DIM;
const BLUE = COLOR.BLUE;
const GREEN = COLOR.GREEN;
const YELLOW = COLOR.YELLOW;
const PURPLE = COLOR.PURPLE;
const RED = COLOR.RED;
const BORDER = COLOR.BORDER;
const CODE_BG = COLOR.CODE_BG;

/** 인라인 코드 배경 — 파일 미리보기와 같은 값이어야 한 화면처럼 보인다. */
const inlineCodeStyle: React.CSSProperties = {
  background: CODE_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: RADIUS.S,
  padding: "0 4px",
  font: `0.92em ${FONT.MONO}`,
  color: GREEN,
};

/**
 * **코드 펜스** 를 만든다 — 백틱 3개로 감싼 블록.
 *
 * **언어는 펜스 정보로** 정한다. 없으면 **추측하지 않고** `text` 다 — 언어를
 * 잘못 칠하면 지어내게 되고, 그건 색 없는 것보다 나쁘다.
 */
function renderFence(code: string, langHint: string | undefined, key: string): React.ReactNode {
  const lang = langHint && /^[a-z0-9+#-]+$/i.test(langHint) ? languageFor(`x.${langHint === "sh" || langHint === "bash" ? "sh" : langHint}`) : "text";
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div key={key} style={{ margin: "6px 0", border: `1px solid ${BORDER}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 8px", borderBottom: `1px solid ${BORDER}`, color: DIM, fontSize: 10 }}>
        {/* **언어 표기** — 무엇으로 칠해졌는지 말한다. 지어내지 않는다. */}
        <span>{lang === "text" ? "코드" : lang}</span>
        <span style={{ flex: 1 }} />
        <span>{lines.length}줄</span>
      </div>
      <pre style={{ margin: 0, padding: "6px 8px", overflow: "auto", font: `${FONT.AUX}px/${FONT.LINE_CODE} ${FONT.MONO}`, tabSize: FONT.TAB_SIZE }}>
        {lines.map((l, i) => (
          <div key={i}>
            {tokenizeLine(l, lang).map((t, ti) => (
              <span key={ti} style={{ color: colorFor(t.kind) }}>{t.text}</span>
            ))}
            {l === "" ? " " : null}
          </div>
        ))}
      </pre>
    </div>
  );
}

/**
 * **클릭해도 안전한 주소인가** (2026-10-01).
 *
 * 허용은 **화이트리스트**다 — 위험한 것만 거르는 블랙리스트는 새 스킴이 나올 때마다
 * 뚫린다. 그래서 `http` · `https` · `mailto` 만 통과시킨다.
 *
 * `marked` 는 `javascript:` 를 **그대로 통과시킨다**(실측). 그리고 대소문자를
 * 섞어도 막지 않는다(`JaVaScRiPt:`) — 그래서 정규식도 대소문자 무시로 **같이** 봐야 한다.
 *
 * 상대 주소와 해시는 허용한다 — 대화가 `docs/파일.md` 를 참조하는 게 정상이기 때문이다.
 */
export function safeHref(raw: string | undefined): string | null {
  if (!raw) return null;
  const h = raw.trim();
  if (!h) return null;
  // 상대 경로·해시·쿼리 — 위험하지 않다.
  if (h.startsWith("/") || h.startsWith("#") || h.startsWith("?")) return h;
  // **스킴이 없으면 상대 주소**로 본다 (`docs/a.md`).
  if (!/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  // 스킴이 있으면 **화이트리스트**로.
  const scheme = h.slice(0, h.indexOf(":")).toLowerCase();
  return ["http", "https", "mailto"].includes(scheme) ? h : null;
}

/** 인라인 요소 — `code` / `strong` / `em` / `a` / `del` . */
function styleNode(node: React.ReactNode, key: number): React.ReactNode {
  const el = node as React.ReactElement<{ children?: React.ReactNode; className?: string; href?: string }>;
  if (!el || typeof el !== "object" || !("type" in el)) return node;
  const kids = el.props.children;
  const cls = el.props.className ?? "";

  if (cls.includes("language-")) {
    // 펜스는 **태그가 아니라** React 요소로 대체한다 — `pre > code` 로 두면
    // 줄번호·접기 같은 것을 붙일 자리가 없다.
    const raw = textOf(kids);
    return renderFence(raw.replace(/\n$/, ""), cls.replace("language-", "") || undefined, String(key));
  }
  if (cls === "code") {
    return (
      <code key={key} style={inlineCodeStyle}>
        {kids}
      </code>
    );
  }
  if (el.type === "strong") return <strong key={key} style={{ color: FG, fontWeight: 700 }}>{kids}</strong>;
  if (el.type === "em") return <em key={key} style={{ color: FG, fontStyle: "italic" }}>{kids}</em>;
  if (el.type === "del") return <del key={key} style={{ color: DIM }}>{kids}</del>;
  if (el.type === "a") {
    const href = safeHref(el.props.href);
    // **위험한 스킴이면 링크가 아니다** (2026-10-01 실측).
    //
    // `marked` 의 기본 출력에 **`javascript:` 링크가 그대로 살아남는다** —
    // 실측: `[클릭](javascript:alert(1))` → `<a href="javascript:alert(1)">`.
    // 대소문자도 섞인다(`JaVaScRiPt:`). `href` 는 클릭하면 실행되므로
    // **"보이지 않는 위험"** 이 아니라 **한 번의 클릭으로 발동하는 위험**이다.
    //
    // 그래서 **스킴을 여기서 판정한다.** `rel="noopener noreferrer"` 는 탭 탈취만
    // 막고 `javascript:` 는 막지 **못한다** — 이건 자주 오해하는 부분이다.
    if (!href) {
      // **삭제하지 않고 글자로 보여준다** — 링크가 왜 눌리지 않는지 알 수 있어야 한다.
      return (
        <span key={key} style={{ color: YELLOW, borderBottom: `1px dotted ${COLOR.DIM_SUBTLE}`, cursor: "not-allowed" }} title={`허용되지 않는 주소입니다: ${el.props.href ?? ""}`}>
          {kids}
        </span>
      );
    }
    return (
      <a key={key} href={href} target="_blank" rel="noreferrer noopener" style={{ color: BLUE, textDecoration: "underline" }}>
        {kids}
      </a>
    );
  }
  if (el.type === "hr") return <hr key={key} style={{ border: 0, borderTop: `1px solid ${BORDER}`, margin: "8px 0" }} />;
  if (el.type === "blockquote") {
    return (
      <blockquote key={key} style={{ margin: "6px 0", padding: "2px 0 2px 10px", borderLeft: `3px solid ${BORDER}`, color: DIM }}>
        {kids}
      </blockquote>
    );
  }
  if (el.type === "ul" || el.type === "ol") {
    return (
      <ul key={key} style={{ margin: "4px 0", paddingLeft: 20, color: FG }}>
        {kids}
      </ul>
    );
  }
  if (el.type === "li") {
    return (
      <li key={key} style={{ margin: "1px 0", color: FG }}>
        {/* **마커** — 브라우저 기본 글머리 기호 대신. 브라우저마다 모양이 달라
            "같은 화면처럼 보인다" 가 거짓이 된다. */}
        <span style={{ color: DIM, marginRight: 6 }}>•</span>
        {kids}
      </li>
    );
  }
  if (el.type === "h1" || el.type === "h2" || el.type === "h3" || el.type === "h4" || el.type === "h5" || el.type === "h6") {
    const level = Number(String(el.type).slice(1));
    // **크기는 단계에 따라** — 같은 크기 머리는 단계가 없다는 뜻이다.
    const size = [20, 17, 15, 13, 12, 12][level - 1] ?? 12;
    return (
      <div key={key} style={{ margin: "10px 0 4px", fontSize: size, fontWeight: 700, color: FG, borderBottom: level <= 2 ? `1px solid ${BORDER}` : "none", paddingBottom: level <= 2 ? 3 : 0 }}>
        {kids}
      </div>
    );
  }
  if (el.type === "p") return <div key={key} style={{ margin: "4px 0", color: FG, lineHeight: 1.6 }}>{kids}</div>;
  if (el.type === "pre") {
    // **`pre` 밖의 코드** — 펜스 처리 후 남은 것. 여기도 코드로 보인다.
    return (
      <pre key={key} style={{ margin: "4px 0", padding: "6px 8px", background: "#0d1117", border: `1px solid ${BORDER}`, borderRadius: 6, overflow: "auto", font: "11px/1.5 ui-monospace, monospace" }}>
        {kids}
      </pre>
    );
  }
  if (el.type === "table") {
    return (
      <div key={key} style={{ overflow: "auto", margin: "6px 0", border: `1px solid ${BORDER}`, borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, color: FG, width: "100%" }}>{kids}</table>
      </div>
    );
  }
  if (el.type === "thead") {
    return <thead key={key} style={{ background: CODE_BG }}>{kids}</thead>;
  }
  if (el.type === "tbody") {
    return <tbody key={key}>{kids}</tbody>;
  }
  if (el.type === "tr") {
    return (
      <tr key={key} style={{ borderBottom: `1px solid ${BORDER}` }}>{kids}</tr>
    );
  }
  if (el.type === "th") {
    return (
      <th key={key} style={{ border: `1px solid ${BORDER}`, padding: "4px 8px", color: FG, fontWeight: 700, textAlign: "left", background: CODE_BG }}>
        {kids}
      </th>
    );
  }
  if (el.type === "td") {
    return (
      <td key={key} style={{ border: `1px solid ${BORDER}`, padding: "3px 8px", color: FG }}>
        {kids}
      </td>
    );
  }
  // **모르는 태그** — 원본 HTML 이 아니라 **텍스트로만** 내린다. 미끼를 넣지 않는다.
  return <span key={key}>{kids}</span>;
}

/** React 노드 트리에서 문자열만 모은다(코드 펜스용). */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as React.ReactElement<{ children?: React.ReactNode }>;
  if (el?.props?.children !== undefined) return textOf(el.props.children);
  return "";
}

/** 원본 HTML 을 **비활성화** 한다. 모델 출력을 신뢰하지 않는다. */
marked.setOptions({ gfm: true, breaks: false, async: false });
marked.use({
  renderer: {
    /** HTML 블록은 **버린다** — 그대로 내보내지 않는다. */
    html() {
      return "";
    },
  },
});

/** 문자열 → 스타일링된 React 노드. */
function toReact(html: string): React.ReactNode {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return null;
  const convert = (parent: Element, out: React.ReactNode[]): void => {
    let k = 0;
    for (const node of Array.from(parent.childNodes)) {
      const key = `${parent.tagName}-${k++}`;
      if (node.nodeType === 3) {
        const t = node.textContent ?? "";
        if (t.trim()) out.push(t);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const clone = el.cloneNode(true) as HTMLElement;
      // **원본 속성을 신뢰하지 않는다** — `style` 로 무엇이든 주입될 수 있다.
      for (const attr of Array.from(clone.attributes)) clone.removeAttribute(attr.name);
      const kids: React.ReactNode[] = [];
      convert(clone, kids);
      out.push(styleNode({ ...clone, props: { children: kids, className: clone.className, href: clone.getAttribute("href") }, type: clone.tagName.toLowerCase() } as unknown as React.ReactNode, k));
    }
  };
  const out: React.ReactNode[] = [];
  convert(root, out);
  return out;
}

export interface MarkdownProps {
  text: string;
}

/** 대화 본문 — 마크다운을 IDE 다크 테마로. */
export function Markdown({ text }: MarkdownProps) {
  const html = useMemo(() => {
    try {
      return marked.parse(text, { async: false }) as string;
    } catch {
      // **파싱이 실패하면 원문을 그대로 둔다** — 빈 화면은 결함이고,
      // 여기서 지어내면 안 된다.
      return "";
    }
  }, [text]);
  const nodes = useMemo(() => (html ? toReact(html) : text), [html, text]);
  return <div style={{ font: "12px/1.6 system-ui, sans-serif" }}>{nodes}</div>;
}

/** 마크다운 밖에서 쓰는 색 — 파일 미리보기와 맞춰야 하는 값들. */
export const MD_COLOR = { FG, DIM, BLUE, GREEN, YELLOW, PURPLE, RED };
