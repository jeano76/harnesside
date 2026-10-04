/**
 * 터미널이 **스스로 만든 응답**(장치 속성·커서 위치·색 질의·버전 응답)인가.
 *
 * tmux 는 attach 직후 바깥 터미널에 DA1/XTVERSION/색 질의를 보낸다. xterm.js 는 그 질의에
 * 자동으로 답하는데, 그 답은 키 입력과 같은 `onData` 로 나온다. 답이 tmux 가 기다리는 시간을
 * 넘겨 도착하면 **안쪽 셸이 키 입력으로 받는다** — 화면에 `0c`·`276:` 같은 글자가 찍히고
 * 명령이 깨진다(2026-10-04 실측: 새로고침 후 다시 붙은 셸에서 `명령어 '0cecho'`).
 * 사람이 누른 키(방향키 `ESC [ A` 등)는 이 모양이 아니다.
 */
export function isTerminalReply(d: string): boolean {
  return (
    /^\x1b\[\?[\d;]*c$/.test(d) || // DA1
    /^\x1b\[>[\d;]*c$/.test(d) || // DA2
    /^\x1b\[\d+;\d+R$/.test(d) || // 커서 위치
    /^\x1b\[\??[\d;]*\$y$/.test(d) || // DECRPM
    /^\x1b\](?:10|11|12);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)$/.test(d) || // 색 질의 응답
    /^\x1bP>\|[^\x1b]*\x1b\\$/.test(d) // XTVERSION
  );
}

