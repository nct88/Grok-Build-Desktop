#Requires -Version 5.1
<#
.SYNOPSIS
  Deploy Grok Build Desktop release artifacts to Cloudflare R2 bucket.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-r2.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-r2.ps1 -Version 0.5.47 -DryRun
#>
param(
  [string]$Version,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

$argsList = @("scripts/deploy_r2.py")
if ($Version) {
  $argsList += @("--version", $Version)
}
if ($DryRun) {
  $argsList += "--dry-run"
}

python @argsList
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
