/**
 * 한국어 카탈로그 — **정본**(M9 기본값).
 *
 * 규칙: 이 파일의 문자열은 **화면에 이미 쓰이고 있던 것** 이다. 새로 번역해서 넣지 않는다.
 * 새로 쓰는 문장은 키를 정하고(영문, 도트 구분) 여기에 추가한다.
 *
 * 화면 문자열을 카탈로그로 "옮기는" 작업은 단계적이다. 전부 옮기기 전까지 화면에
 * 번역 밖 문자열이 남을 수 있는데, 그것을 숨기지 않는 방법이 `I18n.missingKeys()` 다 —
 * 옮기지 않은 키가 목록으로 남는다.
 */

import type { Catalog } from "./index.js";

export const ko: Catalog = {
  // ── 앱 셸 ────────────────────────────────────────────────────────────────
  "app.name": "harnesside",
  "app.workspace": "워크스페이스",
  "app.booting": "부팅 {{stage}}/{{total}}",

  // ── 존 ───────────────────────────────────────────────────────────────────
  "zone.left": "왼쪽 도크",
  "zone.right": "오른쪽 도크",
  "zone.center": "중앙 (플로팅)",
  "zone.top": "상단 도크",
  "zone.bottom": "하단 도크",
  "zone.detached": "분리 창",

  // ── 패널 ─────────────────────────────────────────────────────────────────
  "panel.explorer": "탐색기",
  "panel.editor": "에디터",
  "panel.terminal": "터미널",
  "panel.diff": "변경 검토",
  "panel.monitor": "모니터",
  "panel.log": "서버 로그",
  "panel.settings": "설정",
  "panel.agent": "대화",

  // ── 공통 동작 ────────────────────────────────────────────────────────────
  "action.close": "닫기",
  "action.collapse": "접기",
  "action.expand": "펼치기",
  "action.refresh": "새로고침",
  "action.cancel": "취소",
  "action.retry": "다시 시도",
  "action.continue": "이어서 진행",
  "action.open": "열기",

  // ── 빈 상태(§11.3: 빈 화면 금지) ─────────────────────────────────────────
  "empty.noFile.title": "열린 파일이 없습니다",
  "empty.noFile.hint": "탐색기에서 파일을 여세요. 저장하지 않은 탭은 창을 닫아도 세션에 남습니다.",
  "empty.noFile.example": "예시 프롬프트",
  "empty.treeFailed.title": "탐색기를 읽지 못했습니다",
  "empty.treeFailed.hint": "워크스페이스 경로와 권한을 확인하세요.",
  "empty.folderEmpty.title": "빈 폴더입니다",
  "empty.folderEmpty.hint": "{{root}} 에 파일이 없습니다.",
  "empty.noDiff.title": "변경 사항이 없습니다",
  "empty.noDiff.hint": "에이전트가 파일을 쓰면 여기서 항목별로 승인하거나 되돌릴 수 있습니다.",
  "empty.noTerminal.title": "터미널이 없습니다",
  "empty.noTerminal.hint": "셸을 열면 여기에 나타납니다.",
  "empty.agent.title": "아직 메시지가 없습니다",
  "empty.agent.hint": "입력창에 지시하십시오.",

  // ── 에이전트 ─────────────────────────────────────────────────────────────
  "agent.thinking": "사고 표시",
  "agent.send": "보내기",
  "agent.clear": "지우기",
  "agent.cancelTurn": "취소",
  "agent.resumeTitle": "이어서 할 작업이 남아 있습니다",
  "agent.noTurn": "진행 중인 턴이 없습니다",

  // ── 파일 저장 ────────────────────────────────────────────────────────────
  "file.saved": "저장됨",
  "file.savedVersion": "저장됨 (v{{version}})",
  "file.pending": "바뀜 · 곧 저장",
  "file.saving": "저장 중",
  "file.saveFailed": "저장 실패",
  "file.readOnly": "읽기 전용",
  "file.conflict": "충돌",
  "file.conflictKeepMine": "내 편집 유지",
  "file.conflictTakeTheirs": "서버본문 사용",
  "file.conflictBoth": "둘 다 남기기",

  // ── Git ──────────────────────────────────────────────────────────────────
  "git.commit": "커밋",
  "git.commitMessage": "커밋 메시지",
  "git.commitEmpty": "커밋할 파일을 하나 이상 고르십시오.",
  "git.pullConflict": "충돌이 있어 중단했습니다. 자동 병합하지 않았습니다 — 변경 검토에서 해결하십시오.",
  "git.shallow": "얕은 복사 — 원격과의 차이를 계산할 수 없습니다",

  // ── 오류 ─────────────────────────────────────────────────────────────────
  "error.auth": "인증 실패 — 토큰이 없거나 세션이 만료됐습니다.",
  "error.network": "네트워크에 연결하지 못했습니다.",
  "error.readonly": "읽기 전용 경로입니다",
  "error.generic": "알 수 없는 오류",

  // ── 언어 ─────────────────────────────────────────────────────────────────
  "lang.label": "언어",
  "lang.ko": "한국어",
  "lang.en": "English",
};
