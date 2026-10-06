#!/bin/sh
# HarnessIDE 포터블 설치 (Linux · macOS) — npm 불필요
# 쓰는 법: 압축을 푼 폴더에서  sh install.sh   (옵션은 install-portable.mjs 로 그대로 넘어간다)
#
# POSIX sh 로만 쓴다 — bash 3.2(macOS 기본)·dash(Ubuntu /bin/sh)·zsh 에서 같은 뜻이어야 한다.
# fish 사용자도 `sh install.sh` 로 부르면 된다.
set -eu
cd "$(dirname "$0")"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done
  # nvm 은 셸 함수라 비대화형 sh 에서는 PATH 에 없다 — 설치된 버전 중 가장 새것을 찾는다.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    # `sort -V` 는 GNU 확장이라 macOS 에 없을 수 있다 — POSIX 키 정렬로 버전 순을 맞춘다.
    latest=$(ls "$HOME/.nvm/versions/node" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
    if [ -n "$latest" ] && [ -x "$HOME/.nvm/versions/node/v$latest/bin/node" ]; then
      echo "$HOME/.nvm/versions/node/v$latest/bin/node"; return 0
    fi
  fi
  return 1
}

if ! NODE=$(find_node); then
  echo ""
  echo "Node.js 22 이상이 필요합니다 (npm은 필요 없음)."
  echo "https://nodejs.org 에서 LTS 를 받아 설치한 뒤 다시 실행하세요."
  exit 1
fi

# macOS: 브라우저로 받은 zip 은 quarantine 속성이 붙어 llama-server 등 실행 파일이 막힌다.
if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine . 2>/dev/null || true
fi
chmod +x harnesside.sh 2>/dev/null || true

echo "Node: $NODE"
code=0
"$NODE" install-portable.mjs "$@" || code=$?
echo ""
if [ "$code" -eq 0 ]; then
  echo "설치 완료 — ./harnesside.sh 로 실행하세요."
else
  echo "설치가 끝나지 않았습니다 (코드 $code). 위 메시지를 확인하세요."
fi
exit "$code"
