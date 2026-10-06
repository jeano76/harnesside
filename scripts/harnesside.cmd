@echo off
REM HarnessIDE launcher (Windows) — npm 없이 동작한다.
REM 이 파일이 있는 디렉터리가 설치 루트다.
node "%~dp0dist\server\index.js" %*
