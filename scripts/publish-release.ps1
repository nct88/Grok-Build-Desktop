#Requires -Version 5.1
<#
.SYNOPSIS
  Build Grok Build desktop and publish portable + install + update channels.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-release.ps1 -Version 0.5.2
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$')]
  [string]$Version,
  [string]$ReleaseBaseUrl = "",
  [switch]$PublicRelease,
  [switch]$SkipBuilder
)

$ErrorActionPreference = "Stop"
$myDocs = [Environment]::GetFolderPath("MyDocuments")
$windowsPowerShellModuleRoots = @(
  $(if ($myDocs) { Join-Path $myDocs "WindowsPowerShell\Modules" }),
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "WindowsPowerShell\Modules" }),
  $(if ($PSHOME) { Join-Path $PSHOME "Modules" })
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$env:PSModulePath = $windowsPowerShellModuleRoots -join ";"
Import-Module (Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root
$publishRoot = Join-Path $root "dist\$Version"
if (Test-Path -LiteralPath $publishRoot) {
  throw "Release $Version already exists at $publishRoot. Choose a new version; published releases are immutable."
}
if ($ReleaseBaseUrl -and $ReleaseBaseUrl -notmatch '^https?://') {
  throw "ReleaseBaseUrl must be an HTTP(S) URL."
}
if ($PublicRelease -and $ReleaseBaseUrl -notmatch '^https://') {
  throw "PublicRelease requires an HTTPS ReleaseBaseUrl."
}

function Find-NodeBin {
  $dirs = @(
    "$env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node\fb8898c05a62885e\bin",
    "$env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node",
    "C:\Program Files\nodejs",
    "C:\Program Files (x86)\nodejs"
  )
  foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { continue }
    $direct = Join-Path $d "node.exe"
    if (Test-Path $direct) { return (Split-Path $direct -Parent) }
    $found = Get-ChildItem -Path $d -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.DirectoryName }
  }
  return $null
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("X2") }) -join "")
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

$bin = Find-NodeBin
if (-not $bin) { throw "Node.js not found. Install Node or set PATH." }
$env:PATH = "$bin;$env:PATH"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$npmCmd = Join-Path $bin "npm.cmd"
if (-not (Test-Path $npmCmd)) { $npmCmd = "npm" }

Write-Host "=== Grok Build release $Version ==="
Write-Host "Root: $root"
Write-Host "Node: $(Join-Path $bin 'node.exe')"

# Sync package versions
$pkgPaths = @(
  (Join-Path $root "package.json"),
  (Join-Path $root "apps\desktop\package.json")
)
foreach ($p in $pkgPaths) {
  $raw = Get-Content $p -Raw -Encoding UTF8
  $obj = $raw | ConvertFrom-Json
  $obj.version = $Version
  $json = $obj | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($p, $json + "`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host "Version set: $p -> $Version"
}
[System.IO.File]::WriteAllText(
  (Join-Path $root "product\VERSION"),
  $Version + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

# Icon
$iconGen = Join-Path $root "apps\desktop\build\generate-icon.mjs"
if (Test-Path $iconGen) {
  & (Join-Path $bin "node.exe") $iconGen
}

# Build TS packages
& $npmCmd run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

$builderOut = Join-Path $root "dist\desktop"
$portableDir = Join-Path $publishRoot "portable"
$installDir = Join-Path $publishRoot "install"
$updateDir = Join-Path $publishRoot "update"

if (-not $SkipBuilder) {
  Write-Host "Running electron-builder (portable + nsis)..."
  # Ensure desktop package targets portable + nsis
  Push-Location (Join-Path $root "apps\desktop")
  try {
    & npx electron-builder --win portable nsis --x64
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed: $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

# Locate builder artifacts
$portableExe = Get-ChildItem $builderOut -Filter "Grok-Build-*-portable.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$setupExe = Get-ChildItem $builderOut -Filter "*Setup*.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setupExe) {
  $setupExe = Get-ChildItem $builderOut -Filter "Grok Build Setup*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (-not $setupExe) {
  # nsis default names
  $setupExe = Get-ChildItem $builderOut -Filter "*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'Setup|Install' -and $_.Name -notmatch 'portable' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

$unpacked = Join-Path $builderOut "win-unpacked"
if (-not (Test-Path $unpacked)) {
  throw "Missing win-unpacked at $unpacked — builder did not produce app layout"
}
if (-not $portableExe) { throw "Portable executable was not produced in $builderOut" }
if (-not $setupExe) { throw "NSIS installer was not produced in $builderOut" }
if ($PublicRelease) {
  foreach ($signedArtifact in @($portableExe.FullName, $setupExe.FullName)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $signedArtifact
    if ($signature.Status -ne 'Valid') {
      throw "Public release artifact is not signed: $signedArtifact ($($signature.Status))"
    }
  }
}

# Create an immutable version tree. The version root was checked before the build.
foreach ($d in @($portableDir, $installDir, $updateDir)) {
  New-Item -ItemType Directory -Path $d | Out-Null
}

# --- portable ---
$destPortable = Join-Path $portableDir "Grok-Build-$Version-win32-x64-portable.exe"
Copy-Item $portableExe.FullName $destPortable
Write-Host "portable: $destPortable"
$zipPath = Join-Path $portableDir "Grok-Build-$Version-win32-x64.zip"
Compress-Archive -Path (Join-Path $unpacked "*") -DestinationPath $zipPath
Write-Host "portable zip: $zipPath"

# --- install ---
$destSetup = Join-Path $installDir "Grok-Build-Setup-$Version.exe"
Copy-Item $setupExe.FullName $destSetup
Write-Host "install: $destSetup"

# --- update (hot: app.asar + packages + renderer is inside asar) ---
$asar = Join-Path $unpacked "resources\app.asar"
$pkgs = Join-Path $unpacked "resources\packages"
if (-not (Test-Path $asar)) { throw "app.asar missing: $asar" }
Copy-Item -Force $asar (Join-Path $updateDir "app.asar")
if (Test-Path $pkgs) {
  Copy-Item -Recurse -Force $pkgs (Join-Path $updateDir "packages")
}
# Also copy package.json version stamp
Copy-Item -Force (Join-Path $root "apps\desktop\package.json") (Join-Path $updateDir "package.json")

$applyUpdate = @'
# Apply Grok Build desktop hot update (app.asar + packages).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-update.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-update.ps1 -InstallRoot "C:\Path\To\Grok Build"
param(
  [string]$InstallRoot = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

function Resolve-InstallRoot([string]$hint) {
  if ($hint -and (Test-Path (Join-Path $hint "resources\app.asar"))) { return (Resolve-Path $hint).Path }
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Grok Build",
    "$env:LOCALAPPDATA\GrokBuild",
    (Join-Path $env:LOCALAPPDATA "Programs\Grok Build")
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c "resources\app.asar"))) { return (Resolve-Path $c).Path }
    if ($c -and (Test-Path (Join-Path $c "Grok Build.exe"))) { return (Resolve-Path $c).Path }
  }
  # portable single-exe cache under LocalAppData
  $portableCaches = Get-ChildItem "$env:LOCALAPPDATA" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'Grok|grok' }
  foreach ($dir in $portableCaches) {
    $exe = Get-ChildItem $dir.FullName -Filter "Grok Build.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) { return $exe.DirectoryName }
  }
  throw "Could not find Grok Build install. Pass -InstallRoot to the folder containing 'Grok Build.exe'."
}

$root = Resolve-InstallRoot $InstallRoot
Write-Host "Install root: $root"
$resources = Join-Path $root "resources"
if (-not (Test-Path $resources)) { throw "resources/ missing under $root" }

$asarSrc = Join-Path $here "app.asar"
if (-not (Test-Path $asarSrc)) { throw "app.asar missing in update pack" }

$bak = Join-Path $resources ("app.asar.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$asarDst = Join-Path $resources "app.asar"
if (Test-Path $asarDst) {
  Copy-Item -Force $asarDst $bak
  Write-Host "Backup: $bak"
}
Copy-Item -Force $asarSrc $asarDst
Write-Host "Updated app.asar"

$pkgSrc = Join-Path $here "packages"
if (Test-Path $pkgSrc) {
  $pkgDst = Join-Path $resources "packages"
  if (Test-Path $pkgDst) { Remove-Item -Recurse -Force $pkgDst }
  Copy-Item -Recurse -Force $pkgSrc $pkgDst
  Write-Host "Updated resources/packages"
}

$verFile = Join-Path $here "package.json"
if (Test-Path $verFile) {
  $v = (Get-Content $verFile -Raw | ConvertFrom-Json).version
  Write-Host "Update applied (pack version $v). Restart Grok Build."
} else {
  Write-Host "Update applied. Restart Grok Build."
}
'@
Set-Content -Path (Join-Path $updateDir "apply-update.ps1") -Value $applyUpdate -Encoding UTF8

# Public changelog into update
$changeLog = Join-Path $root "CHANGELOG.md"
if (Test-Path $changeLog) {
  Copy-Item -Force $changeLog (Join-Path $updateDir "CHANGELOG.md")
}

# README per channel
@"
# Grok Build $Version — portable

- ``Grok-Build-$Version-win32-x64-portable.exe`` — single-file self-extract (slow each launch)
- ``Grok-Build-$Version-win32-x64.zip`` — **recommended** fixed-folder install

## Durable run (recommended)

Prefer zip → fixed folder, not daily double-click of ``*-portable.exe``.

``````powershell
# From monorepo (install under %LOCALAPPDATA%\Programs\Grok Build + start)
npm run portable
npm run portable:shortcut   # also Desktop shortcut

# Or:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-portable.ps1 -Version $Version -Shortcut
``````

Manual: extract zip once, run ``Grok Build.exe`` from that folder forever.
Requires **Grok CLI** on PATH or ``%USERPROFILE%\.grok\bin\grok.exe`` (then ``grok login``).
"@ | Set-Content (Join-Path $portableDir "README.md") -Encoding UTF8

@"
# Grok Build $Version — install

- ``Grok-Build-Setup-$Version.exe`` — NSIS installer (if present)

Installs under Local AppData / Programs. Uninstall via Windows Apps.
"@ | Set-Content (Join-Path $installDir "README.md") -Encoding UTF8

@"
# Grok Build $Version — hot update

Applies ``app.asar`` + ``packages`` onto an existing install/portable unpack.

``````powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-update.ps1
# or
powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-update.ps1 -InstallRoot "C:\path\to\Grok Build"
``````

Close Grok Build before applying. Restart after.
"@ | Set-Content (Join-Path $updateDir "README.md") -Encoding UTF8

# Manifest + latest.json
function FileInfo([string]$path, [string]$relativePath) {
  if (-not (Test-Path $path)) { return $null }
  $i = Get-Item $path
  return [ordered]@{
    file = $i.Name
    relativePath = $relativePath.Replace('\', '/')
    bytes = $i.Length
    sha256 = Get-Sha256 $i.FullName
  }
}

$manifest = [ordered]@{
  version = $Version
  product = "Grok Build"
  publishedAt = (Get-Date).ToString("o")
  releaseStatus = if ($PublicRelease) { "public-signed" } else { "local-unsigned-candidate" }
  channels = [ordered]@{
    portable = @{}
    install = @{}
    update = [ordered]@{
      apply = "apply-update.ps1"
      files = @("app.asar", "packages", "apply-update.ps1")
    }
  }
}

$pe = Join-Path $portableDir "Grok-Build-$Version-win32-x64-portable.exe"
$pz = Join-Path $portableDir "Grok-Build-$Version-win32-x64.zip"
$ie = Join-Path $installDir "Grok-Build-Setup-$Version.exe"
$manifest.channels.portable.exe = FileInfo $pe "portable/$(Split-Path $pe -Leaf)"
$manifest.channels.portable.zip = FileInfo $pz "portable/$(Split-Path $pz -Leaf)"
$manifest.channels.install.setup = FileInfo $ie "install/$(Split-Path $ie -Leaf)"
$manifest.channels.update.asar = FileInfo (Join-Path $updateDir "app.asar") "update/app.asar"

# Windows PowerShell 5 Set-Content -Encoding UTF8 writes BOM → breaks JSON.parse.
# Always write JSON as UTF-8 without BOM.
function Write-JsonNoBom([string]$Path, $Object, [int]$Depth = 8) {
  $json = ($Object | ConvertTo-Json -Depth $Depth) + "`n"
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

$manifestPath = Join-Path $publishRoot "MANIFEST.json"
Write-JsonNoBom $manifestPath $manifest 8

function Join-ReleaseUrl([string]$relativePath) {
  $normalized = $relativePath.Replace('\', '/')
  if ([string]::IsNullOrWhiteSpace($ReleaseBaseUrl)) { return $normalized }
  return $ReleaseBaseUrl.TrimEnd('/') + '/' + $normalized.TrimStart('/')
}

$primaryRelativePath = "$Version/portable/$(Split-Path $pe -Leaf)"
$latest = [ordered]@{
  version = $Version
  url = Join-ReleaseUrl $primaryRelativePath
  notes = "Grok Build desktop $Version — portable / install / update channels."
  manifest = "$Version/MANIFEST.json"
  publishedAt = $manifest.publishedAt
  releaseStatus = $manifest.releaseStatus
  channels = @("portable", "install", "update")
}
Write-JsonNoBom (Join-Path $root "dist\latest.json") $latest 6
# also example feed for in-app checker (relative-friendly)
Write-JsonNoBom (Join-Path $publishRoot "latest.json") $latest 6

Write-Host ""
Write-Host "=== DONE $Version ==="
Write-Host "portable : $portableDir"
Write-Host "install  : $installDir"
Write-Host "update   : $updateDir"
Write-Host "manifest : $manifestPath"
Write-Host "latest   : $(Join-Path $root 'dist\latest.json')"
Get-ChildItem $publishRoot -Recurse -File | Select-Object FullName, Length | Format-Table -AutoSize
