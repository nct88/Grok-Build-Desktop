#Requires -Version 5.1
<#
.SYNOPSIS
  Install/run Grok Build from the portable ZIP in a fixed folder (durable).

.DESCRIPTION
  The single-file *-portable.exe re-extracts on each launch (slow, fragile).
  This script uses the ZIP (or dist/desktop/win-unpacked) once into a stable
  directory, verifies Grok CLI, optionally creates a Desktop shortcut, then
  starts "Grok Build.exe".

.PARAMETER Version
  Release folder under dist\, e.g. 0.5.15. Default: newest dist\<ver>\portable.

.PARAMETER InstallRoot
  Where to keep the unpacked app permanently.
  Default: %LOCALAPPDATA%\Programs\Grok Build

.PARAMETER ZipPath
  Explicit path to Grok-Build-*-win32-x64.zip (overrides Version lookup).

.PARAMETER SourceDir
  Already-unpacked folder containing "Grok Build.exe" (skip zip).

.PARAMETER NoLaunch
  Install/update only; do not start the app.

.PARAMETER Shortcut
  Create/update a Desktop shortcut.

.PARAMETER Force
  Overwrite existing InstallRoot even if already present.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-portable.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-portable.ps1 -Version 0.5.15 -Shortcut

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-portable.ps1 -SourceDir E:\projects\Grok-Build\dist\desktop\win-unpacked
#>
[CmdletBinding()]
param(
  [string] $Version = "",
  [string] $InstallRoot = "",
  [string] $ZipPath = "",
  [string] $SourceDir = "",
  [switch] $NoLaunch,
  [switch] $Shortcut,
  [switch] $Force
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\Grok Build"
}

function Find-GrokExe {
  if ($env:GROK_EXECUTABLE -and (Test-Path -LiteralPath $env:GROK_EXECUTABLE)) {
    return (Resolve-Path -LiteralPath $env:GROK_EXECUTABLE).Path
  }
  $candidates = @(
    (Join-Path $env:USERPROFILE ".grok\bin\grok.exe"),
    (Join-Path $env:USERPROFILE ".local\bin\grok.exe")
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path }
  }
  $cmd = Get-Command grok -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  return $null
}

function Find-LatestPortableZip {
  $dist = Join-Path $repoRoot "dist"
  if (-not (Test-Path $dist)) { return $null }
  $zips = Get-ChildItem -Path $dist -Recurse -Filter "Grok-Build-*-win32-x64.zip" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\portable\\' } |
    Sort-Object LastWriteTime -Descending
  if ($zips) { return $zips[0].FullName }
  return $null
}

function Resolve-ZipForVersion([string] $ver) {
  $p = Join-Path $repoRoot "dist\$ver\portable\Grok-Build-$ver-win32-x64.zip"
  if (Test-Path -LiteralPath $p) { return (Resolve-Path -LiteralPath $p).Path }
  return $null
}

function Get-AppExe([string] $root) {
  $exe = Join-Path $root "Grok Build.exe"
  if (Test-Path -LiteralPath $exe) { return $exe }
  return $null
}

function Copy-AppTree([string] $from, [string] $to) {
  if (Test-Path -LiteralPath $to) {
    if (-not $Force) {
      $existing = Get-AppExe $to
      if ($existing) {
        Write-Host "Already installed: $to"
        Write-Host "  Use -Force to reinstall from source."
        return $false
      }
    }
    Write-Host "Removing old install: $to"
    Remove-Item -LiteralPath $to -Recurse -Force
  }
  New-Item -ItemType Directory -Path $to -Force | Out-Null
  Write-Host "Copying -> $to"
  # robocopy is more reliable than Copy-Item for large electron trees
  $null = & robocopy $from $to /E /NFL /NDL /NJH /NJS /nc /ns /np
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "robocopy failed with exit $code" }
  return $true
}

function Expand-ZipToInstall([string] $zip, [string] $to) {
  $tmp = Join-Path $env:TEMP ("grok-build-portable-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Write-Host "Extracting zip: $zip"
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    # Zip may be flat (Grok Build.exe at root) or nested one folder
    $exe = Get-ChildItem -Path $tmp -Filter "Grok Build.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $exe) { throw "Grok Build.exe not found inside zip" }
    $from = $exe.DirectoryName
    [void](Copy-AppTree -from $from -to $to)
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function New-DesktopShortcut([string] $targetExe, [string] $workDir) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $lnkPath = Join-Path $desktop "Grok Build Desktop.lnk"
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = $targetExe
  $sc.WorkingDirectory = $workDir
  $sc.Description = "Grok Build Desktop (portable install)"
  $sc.IconLocation = "$targetExe,0"
  $sc.Save()
  Write-Host "Shortcut: $lnkPath"
}

# --- resolve source ---
$winUnpacked = Join-Path $repoRoot "dist\desktop\win-unpacked"
$sourceKind = ""
$resolvedZip = $null
$resolvedSrc = $null

if ($SourceDir) {
  if (-not (Get-AppExe $SourceDir)) {
    throw "SourceDir has no 'Grok Build.exe': $SourceDir"
  }
  $resolvedSrc = (Resolve-Path -LiteralPath $SourceDir).Path
  $sourceKind = "dir"
} elseif ($ZipPath) {
  if (-not (Test-Path -LiteralPath $ZipPath)) { throw "Zip not found: $ZipPath" }
  $resolvedZip = (Resolve-Path -LiteralPath $ZipPath).Path
  $sourceKind = "zip"
} elseif ($Version) {
  $resolvedZip = Resolve-ZipForVersion $Version
  if (-not $resolvedZip) { throw "No zip for version $Version under dist\$Version\portable\" }
  $sourceKind = "zip"
} elseif (Test-Path (Join-Path $winUnpacked "Grok Build.exe")) {
  $resolvedSrc = (Resolve-Path -LiteralPath $winUnpacked).Path
  $sourceKind = "dir"
  Write-Host "Using build tree: $resolvedSrc"
} else {
  $resolvedZip = Find-LatestPortableZip
  if (-not $resolvedZip) {
    throw @"
No portable package found.

Build one first:
  cd $repoRoot
  npm run release
  # or: npm run dist:desktop

Then re-run this script.
"@
  }
  $sourceKind = "zip"
  Write-Host "Using latest zip: $resolvedZip"
}

# --- install ---
$appExe = Get-AppExe $InstallRoot
if (-not $appExe -or $Force) {
  if ($sourceKind -eq "zip") {
    Expand-ZipToInstall -zip $resolvedZip -to $InstallRoot
  } else {
    [void](Copy-AppTree -from $resolvedSrc -to $InstallRoot)
  }
  $appExe = Get-AppExe $InstallRoot
  if (-not $appExe) { throw "Install failed — Grok Build.exe missing under $InstallRoot" }
  Write-Host "Installed: $appExe"
} else {
  Write-Host "Using existing install: $appExe"
}

# --- CLI check ---
$grok = Find-GrokExe
if (-not $grok) {
  Write-Warning @"
Grok CLI not found.
Install/login once:
  https://docs.x.ai  (or your grok install)
  grok login
Or set GROK_EXECUTABLE to full path of grok.exe
"@
} else {
  Write-Host "Grok CLI: $grok"
  $env:GROK_EXECUTABLE = $grok
}

if ($Shortcut) {
  New-DesktopShortcut -targetExe $appExe -workDir $InstallRoot
}

Write-Host ""
Write-Host "Portable install (durable):"
Write-Host "  App:   $InstallRoot"
Write-Host "  State: $env:APPDATA\@grok-build\desktop\"
Write-Host "  Tip:   Prefer this folder over double-clicking *-portable.exe"
Write-Host ""

if (-not $NoLaunch) {
  Write-Host "Starting Grok Build..."
  Start-Process -FilePath $appExe -WorkingDirectory $InstallRoot
}
