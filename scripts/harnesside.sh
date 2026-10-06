#!/bin/sh
# HarnessIDE launcher (POSIX) — npm 없이 동작한다.
# 이 파일이 있는 디렉터리가 설치 루트다.
exec node "$(dirname "$0")/dist/server/index.js" "$@"
