# 코드 수정 후 원클릭 재배포: 빌드 → 설치된 앱을 그 자리에서 업데이트 (작업표시줄 고정·바탕화면/시작메뉴 아이콘 유지)
# 사용: npm run release:win
#
# 왜 `--updated`인가 (2026-11-10):
#   `/S`만 주면 설치 프로그램이 새 설치로 동작한다. allowToChangeInstallationDirectory가 켜져 있으면
#   electron-builder는 업데이트가 아닐 때 바로가기를 지키지 않기 때문에, 먼저 옛 버전 제거 프로그램을 돌려
#   바로가기를 지우고(WinShell::UninstShortcut — 작업표시줄 고정도 풀린다) 새로 만든다.
#   `--updated`는 electron-updater가 쓰는 업데이트 모드다. 옛 제거 프로그램에 --keep-shortcuts를 넘겨
#   바로가기·고정·앱 ID를 그대로 두고 프로그램 파일만 바꾼다. 사용자 데이터(%APPDATA%\template-builder)는 어느 쪽이든 건드리지 않는다.
#   --force-run을 주지 않으므로 설치 뒤 앱이 저절로 뜨지 않는다. 앱이 켜져 있으면 설치 프로그램이 닫는다(작성 중 초안은 앱이 자동 보존).
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

npm run build:electron
if ($LASTEXITCODE -ne 0) { throw "빌드 실패 (exit $LASTEXITCODE)" }

$setup = Get-ChildItem release -Filter '*Setup*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'release/ 에 Setup exe가 없습니다.' }

$exe = Join-Path $env:LOCALAPPDATA 'Programs\TemplateBuilder\TemplateBuilder.exe'
$installed = Test-Path $exe
# 설치본이 있으면 업데이트 모드, 처음 설치면 일반 무음 설치
$installArgs = if ($installed) { @('/S', '--updated') } else { @('/S') }
Write-Host "무음 $(if ($installed) { '업데이트' } else { '설치' }): $($setup.Name) $($installArgs -join ' ')"
$p = Start-Process -FilePath $setup.FullName -ArgumentList $installArgs -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "설치 실패 (exit $($p.ExitCode))" }

$v = (Get-Item $exe).VersionInfo.ProductVersion
Write-Host "완료 — v$v. 작업표시줄·바탕화면 아이콘은 그대로입니다."
