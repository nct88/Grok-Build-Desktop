#Requires -Version 5.1
<#
.SYNOPSIS
  Publish Grok Build Desktop release artifact to Cloudflare R2 bucket and update version.json.
  Delegates to E:\projects\AI-Clone\scripts\publish_release.py.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-r2-ai-clone.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-r2-ai-clone.ps1 -Version 0.5.50
#>
param(
  [string]$Version,
  [string]$InstallerPath,
  [string]$Changelog = ""
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

if (-not $Version) {
  $pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
if (-not $Version) {
  throw "Unable to determine version from package.json."
}

if (-not $InstallerPath) {
  $candidates = @(
    (Join-Path $root "dist\$Version\install\Grok-Build-Setup-$Version.exe"),
    (Join-Path $root "dist\install\Grok-Build-Setup-$Version.exe"),
    (Join-Path $root "dist\install\Grok-Build-Setup.exe")
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) {
      $InstallerPath = (Resolve-Path -LiteralPath $c).Path
      break
    }
  }
}

if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) {
  throw "Installer executable not found. Please build release first or pass -InstallerPath."
}

$publisher = "E:\projects\AI-Clone\scripts\publish_release.py"
if (-not (Test-Path -LiteralPath $publisher)) {
  throw "AI-Clone publisher script not found: $publisher"
}

Write-Host "=== Publishing Grok Build Desktop v$Version to R2 (ai-clone) ===" -ForegroundColor Cyan
Write-Host "Installer: $InstallerPath"
Write-Host "Publisher: $publisher"

$argsList = @(
  $publisher,
  "--tool", "grok",
  "--version", $Version,
  "--file", $InstallerPath
)
if ($Changelog) {
  $argsList += @("--changelog", $Changelog)
}

python @argsList
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}