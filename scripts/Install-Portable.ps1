# HarnessIDE 포터블 설치 (Windows) — npm 불필요
# 쓰는 법: 이 파일 우클릭 → "PowerShell에서 실행"
# (더블클릭이 막히면: 쉬프트+우클릭 → "PowerShell에서 실행")

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Find-Node {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Host ""
  Write-Host "Node.js 22 이상이 필요합니다 (npm은 필요 없음)." -ForegroundColor Red
  Write-Host "https://nodejs.org 에서 LTS를 받아 설치한 뒤 이 파일을 다시 실행하세요." -ForegroundColor Yellow
  Write-Host ""
  Read-Host "닫으려면 Enter"
  exit 1
}

Write-Host "Node: $node"
& $node install-portable.mjs @args
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
  Write-Host "설치 완료 — 바탕화면의 HarnessIDE 아이콘으로 실행하세요." -ForegroundColor Green
} else {
  Write-Host "설치가 끝나지 않았습니다 (코드 $code). 위 메시지를 확인하세요." -ForegroundColor Yellow
}
Read-Host "닫으려면 Enter"
exit $code
