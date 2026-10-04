/**
 * 크래시 안내 배너 — M10 (§5.13 웹 배선).
 *
 * 서버가 비정상 종료하면 `.harnesside/crash.log` 에 동기 기록이 남는다.
 * 다음 실행의 창은 그것을 보여주고, 체크포인트가 있으면 `ResumeBanner` 가
 * 재개를 맡는다 — 여기서 재개 버튼을 중복하지 않는다 (같은 일을 두 곳에 두지 않는다).
 *
 * 닫기 버튼은 화면에서 숨기고, 서버가 기록을 `.harnesside/crash-archive/` 로 **옮긴다**(지우지 않는다 —
 * 증거를 조용히 지우면 "왜 죽었지" 에 답할 수 없게 된다). 옮기지 않으면 같은 배너가 창을 열 때마다 뜬다.
 */
import React from "react";
import type { ApiClient } from "../api.js";
import { COLOR, FONT, RADIUS } from "../theme/tokens.js";

export function CrashBanner({ client }: { client: ApiClient }) {
  const [tail, setTail] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void client
      .get<{ present: boolean; tail: string | null; error: string | null }>("/api/crash")
      .then((r) => {
        if (alive && r.present && r.tail) setTail(r.tail);
      })
      .catch(() => {
        // 조회 실패는 "없음" 이 아니다 — 이전 값을 둔다(처음엔 null=숨김).
      });
    return () => {
      alive = false;
    };
  }, [client]);

  if (hidden || tail === null) return null;
  return (
    <div
      role="alert"
      style={{
        border: `1px solid ${COLOR.YELLOW}`, borderRadius: RADIUS.M, background: COLOR.SURFACE_1,
        padding: "6px 8px", fontSize: FONT.AUX, color: COLOR.FG,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span aria-hidden="true" style={{ color: COLOR.YELLOW }}>⚠️</span>
        <span style={{ fontWeight: 700 }}>이전 실행이 비정상 종료되었습니다</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => {
            // 숨기기만 하면 다음에 열 때 같은 배너가 또 뜬다 — 서버가 기록을 보관 폴더로 옮긴다(지우지 않는다).
            setHidden(true);
            void client.post("/api/crash/ack", {}).catch(() => { /* 못 옮겨도 이번 화면에선 숨겨졌다 */ });
          }}
          aria-label="크래시 안내 닫기"
          style={{ background: "transparent", color: COLOR.DIM, border: 0, cursor: "pointer", font: "inherit", fontSize: FONT.AUX }}
        >
          닫기
        </button>
      </div>
      <div style={{ color: COLOR.DIM, marginTop: 2 }}>
        저장된 작업이 있으면 아래 재개 배너에서 이어집니다. 크래시 기록은 서버 로그에 남아 있습니다.
      </div>
      <details style={{ marginTop: 4 }}>
        <summary style={{ color: COLOR.DIM, cursor: "pointer", fontSize: FONT.META }}>마지막 기록 보기</summary>
        <pre style={{ margin: "4px 0 0", padding: 6, background: COLOR.SURFACE_2, borderRadius: RADIUS.S, overflow: "auto", maxHeight: 160, font: `${FONT.AUX}px/${FONT.LINE_CODE} ${FONT.MONO}`, whiteSpace: "pre-wrap", wordBreak: "break-word", color: COLOR.FG }}>
          {tail}
        </pre>
      </details>
    </div>
  );
}
