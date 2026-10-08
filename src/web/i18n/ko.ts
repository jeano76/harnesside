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
  "agent.thinkStyle.dots": "파동 점",
  "agent.thinkStyle.dotsHint": "기본. 생각 중임을 짧게 알립니다",
  "agent.thinkStyle.pulse": "고동",
  "agent.thinkStyle.pulseHint": "한 점이 밝아졌다 어두워집니다",
  "agent.thinkStyle.orbit": "공전",
  "agent.thinkStyle.orbitHint": "가장 눈에 띕니다",
  "agent.thinkStyle.shimmer": "번짐",
  "agent.thinkStyle.shimmerHint": "글 흐름에 은은한 빛",
  "agent.thinkStyle.bar": "막대",
  "agent.thinkStyle.barHint": "움직임 없음. prefers-reduced-motion 에 적합",

  // ── 빈 상태 예시·힌트 ─────────────────────────────────────────────────────
  "empty.agent.example1": "이 저장소의 구조를 한 문단으로 설명해 주세요",
  "empty.agent.example2": "최근 변경 파일을 찾아 Likely 버그를 하나만 골라 주세요",
  "empty.agent.example3": "테스트를 실행하고 실패한 것만 정리해 주세요",
  "empty.agent.guide1": "여기서 지시를 입력하면 이 저장소에서 에이전트가 직접 일합니다.",
  "empty.agent.guide2": "아래 예시 중 하나를 누르면 입력창에 채워집니다 — 바로 보낼 수도, 고쳐서 보낼 수도 있습니다.",
  "hint.send": "Enter 전송",
  "hint.newline": "Shift+Enter 줄바꿈",
  "hint.command": "Ctrl+K 명령",
  "hint.settings": "설정·변경검토는 위 아이콘",

  // ── 알림 센터 ─────────────────────────────────────────────────────────────
  "notice.view": "알림 {{count}}개 보기",
  "notice.center": "알림 센터 (우하단 알림과 같은 내용)",
  "notice.dismiss": "{{title}} 닫기",

  // ── 압축 배너 ─────────────────────────────────────────────────────────────
  "compaction.running": "압축 중… 대화 기록을 정리합니다 (체크포인트는 저장됨)",
  "compaction.failed": "압축 실패 — 체크포인트는 저장됐고 현재 대화로 계속합니다",
  "compaction.dismiss": "압축 알림 닫기",
  "compaction.done": "압축 완료 — {{dropped}}개 메시지({{droppedTokens}} 토큰)를 요약으로, {{kept}}개 유지",
  "compaction.forgotten": "잊혀진 내용:",

  // ── 실시간 초안 ───────────────────────────────────────────────────────────
  "draft.editing": "수정 중",
  "draft.writing": "작성 중",
  "draft.chars": "{{chars}}자",
  "draft.oldLabel": "기존",
  "draft.newLabel": "작성 중",

  // ── Thinking 표시줄 ───────────────────────────────────────────────────────
  "think.estimateTitle": "토큰 수는 길이 추정치(사고+답변+도구호출 합산). 속도는 델타 사이 대기(슬롯·도구·프리필)를 뺀 순수 출력 구간 기준",
  "think.tokens": "Thinking · {{range}} 토큰{{pace}}{{suffix}}",

  // ── 상태바·묶음 ───────────────────────────────────────────────────────────
  "status.wsOpen": "● 실시간",
  "status.wsConnecting": "○ 연결 중",
  "status.wsClosed": "▲ 끊김",
  "status.wsTitle": "WebSocket 연결 상태",
  "status.context": "컨텍스트 {{range}}",
  "status.contextUnknown": "컨텍스트 —",
  "status.contextUnknownTitle": "작업 중이 아니면 측정되지 않습니다",
  "status.running": "실행 중",
  "status.bundles": "묶음 {{count}}",
  "status.turns": "{{turns}}개 대화 묶음 · {{blocks}}개 항목",
  "turn.previous": "이전 대화",
  "turn.latestTitle": "가장 최근 출력",
  "turn.latestLive": "● 최신",
  "turn.latestIdle": "최신",
  "turn.collapseBundle": "묶음 접기",
  "turn.expandBundle": "묶음 펼치기",
  "turn.collapseAll": "전체 접기",
  "turn.expandAll": "전체 펼치기",
  "turn.newContent": "↓ 아래에 새 내용",
  "block.userLabel": "나",
  "block.thinkingChars": "Thinking {{count}}자",
  "block.errorPrefix": "오류",

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

  // ── 도구 블록 (대화 안) ───────────────────────────────────────────────────
  "tool.read_file": "파일 읽기",
  "tool.write_file": "파일 쓰기",
  "tool.edit_file": "파일 수정",
  "tool.create_file": "파일 만들기",
  "tool.run_shell": "셸 실행",
  "tool.list_files": "목록 보기",
  "tool.search": "검색",
  "tool.apply_patch": "패치 적용",
  "tool.git_commit": "커밋",
  "tool.finish": "완료",
  "block.running": "실행 중",
  "block.runningEllipsis": "실행 중…",
  "block.done": "완료",
  "block.failed": "실패",
  "block.noOutput": "(출력 없음)",
  "block.noCommand": "(명령 없음)",
  "block.loading": "읽는 중…",
  "block.readFailed": "읽지 못했습니다",
  "block.copy": "복사",
  "block.copied": "복사됨",
  "block.copyCall": "호출 내용 복사",
  "block.expandCall": "호출 내용 펼치기",
  "block.collapseCall": "호출 내용 접기",
  "block.openPath": "열기 · {{path}}",
  "block.settingsExpand": "설정 펼치기",
  "block.settingsCollapse": "설정 접기",
  "block.settingsCollapsedHint": "(접힘 — 다시 누르면 펼침)",
  "block.viewRemoved": "이 화면은 제거되었습니다.",
  "block.viewUnknown": "이 화면을 열 수 없습니다 — {{what}}.",
  "block.unknownView": "알 수 없는 보기",
  "block.shellOutputLines": "셸 출력 {{count}}줄",
  "panel.directory": "디렉터리",

  // ── 승인 (S-6 §8.2) ─────────────────────────────────────────────────────────
  "approval.unknownCommand": "무엇을 실행하는지 알 수 없습니다",
  "approval.rejectedTitle": "거절했습니다",
  "approval.rejectedBody": "실행되지 않습니다.",
  "approval.allowOnceTitle": "한 번 허용했습니다",
  "approval.allowAlwaysTitle": "항상 허용했습니다",
  "approval.resultHint": "실행 결과는 대화의 도구 블록에 나옵니다.",
  "approval.checkIrreversible": "되돌릴 수 없는 조작이므로 결과를 꼭 확인하십시오.",
  "approval.decideFailed": "결정을 전달하지 못했습니다",
  "approval.expiredTitle": "응답 없음 — 거절됨",
  "approval.needApproval": "승인 필요",
  "approval.expired": "기한이 지났습니다",
  "approval.autoReject": "{{left}}초 뒤 자동 거절",
  "approval.tool": "도구",
  "approval.reject": "거절",
  "approval.allowOnce": "한 번 허용",
  "approval.allowAlways": "항상 허용",
  "approval.allowAlwaysHint": "이 도구를 앞으로 확인 없이 실행합니다",

  // ── 언어 ─────────────────────────────────────────────────────────────────
  "lang.label": "언어",
  "lang.ko": "한국어",
  "lang.en": "English",
};
