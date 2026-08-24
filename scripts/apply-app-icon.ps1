#Requires -Version 5.1
<#
.SYNOPSIS
  Apply logo/grok-main-logo.png (via apps/desktop/build/icon.ico) to:
  - Dev host GrokBuild-dev.exe
  - Installed Grok Build.exe (%LOCALAPPDATA%\Programs\Grok Build)
  - dist/desktop/win-unpacked\Grok Build.exe
  - Desktop + Start Menu shortcuts

Close Grok Build first, then run:
  powershell -File scripts\apply-app-icon.ps1
#>
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host "1) Generate icons from logo/grok-main-logo.png..."
& node "$root\apps\desktop\build\generate-icon.mjs"
if ($LASTEXITCODE -ne 0) { throw "generate-icon failed" }

Write-Host "2) Stamp dev electron host..."
& node "$root\apps\desktop\build\stamp-dev-electron-icon.cjs"

$ico = Join-Path $root "apps\desktop\build\icon.ico"
if (-not (Test-Path $ico)) { throw "Missing $ico" }

$rceditCandidates = @(
  "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign",
  "C:\Users\truongit\AppData\Local\electron-builder\Cache\winCodeSign",
  "$env:USERPROFILE\AppData\Local\electron-builder\Cache\winCodeSign"
)
$rcedit = $null
foreach ($c in $rceditCandidates) {
  if (Test-Path $c) {
    $rcedit = Get-ChildItem $c -Recurse -Filter "rcedit-x64.exe" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    if ($rcedit) { break }
  }
}
if (-not $rcedit) {
  $rcedit = Join-Path $root "node_modules\electron-winstaller\vendor\rcedit.exe"
}
if (-not (Test-Path $rcedit)) { throw "rcedit not found" }

$targets = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Grok Build\Grok Build.exe"),
  "C:\Users\truongit\AppData\Local\Programs\Grok Build\Grok Build.exe",
  (Join-Path $root "dist\desktop\win-unpacked\Grok Build.exe")
) | Select-Object -Unique

Write-Host "3) Stamp installed / unpacked app exes..."
foreach ($exe in $targets) {
  if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "  skip (missing): $exe"
    continue
  }
  Write-Host "  stamp: $exe"
  & $rcedit $exe --set-icon $ico
  if ($LASTEXITCODE -ne 0) { Write-Warning "rcedit failed for $exe" }
}

$installDir = Join-Path $env:LOCALAPPDATA "Programs\Grok Build"
if (Test-Path $installDir) {
  Copy-Item -Force $ico (Join-Path $installDir "app-icon.ico")
  $resIco = Join-Path $installDir "resources\icon.ico"
  if (Test-Path (Split-Path $resIco)) {
    Copy-Item -Force $ico $resIco
  }
  Write-Host "4) Copied app-icon.ico → install dir"
}

Write-Host "5) Update Desktop / Start Menu shortcuts..."
$sh = New-Object -ComObject WScript.Shell
$iconLoc = if (Test-Path (Join-Path $installDir "app-icon.ico")) {
  (Join-Path $installDir "app-icon.ico") + ",0"
} else {
  "$ico,0"
}
foreach ($lnkPath in @(
  (Join-Path $env:USERPROFILE "Desktop\Grok Build.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Grok Build.lnk")
)) {
  if (-not (Test-Path $lnkPath)) { continue }
  $l = $sh.CreateShortcut($lnkPath)
  $l.IconLocation = $iconLoc
  $l.Save()
  Write-Host "  updated: $lnkPath"
}

Write-Host ""
Write-Host "Done. Close all Grok windows, then open from Desktop shortcut."
Write-Host "If taskbar still wrong: unpin Grok, run scripts\refresh-win-icon-cache.ps1, re-open and re-pin."
