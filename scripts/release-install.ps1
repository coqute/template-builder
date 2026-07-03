# 코드 수정 후 원클릭 재배포: 빌드 → NSIS 무음 재설치 (바탕화면/시작메뉴 아이콘 유지)
# 사용: npm run release:win
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

npm run build:electron
if ($LASTEXITCODE -ne 0) { throw "빌드 실패 (exit $LASTEXITCODE)" }

$setup = Get-ChildItem release -Filter '*Setup*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'release/ 에 Setup exe가 없습니다.' }

Write-Host "무음 재설치: $($setup.Name)"
Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait
Write-Host '완료 — 바탕화면 "Template Builder" 아이콘으로 실행하세요.'
