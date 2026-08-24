#Requires -Version 5.1
<#
.SYNOPSIS
  Publish an already-built Grok Build Desktop candidate as an immutable GitHub tag and release.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-github-release.ps1 -Version 0.5.30 -AllowUnsigned

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-github-release.ps1 -Version 0.5.30 -AllowUnsigned -DryRun
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$')]
  [string]$Version,
  [switch]$AllowUnsigned,
  [switch]$Prerelease,
  [switch]$DryRun
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

function Invoke-Native([string]$Command, [string[]]$Arguments) {
  $output = & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
  return $output
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required JSON file is missing: $Path"
  }
  return Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
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

function Assert-Hash([string]$Path, [string]$ExpectedHash) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Release artifact is missing: $Path"
  }
  $actual = Get-Sha256 $Path
  if ($actual -ne $ExpectedHash) {
    throw "SHA-256 mismatch for $Path. Expected $ExpectedHash, got $actual."
  }
}

$tag = "v$Version"
$releaseRoot = Join-Path $root "dist\$Version"
$manifestPath = Join-Path $releaseRoot "MANIFEST.json"
$notesPath = Join-Path $root "docs\releases\$Version.md"
$manifest = Read-Json $manifestPath
$rootPackage = Read-Json (Join-Path $root "package.json")
$desktopPackage = Read-Json (Join-Path $root "apps\desktop\package.json")
$lockVersion = (Invoke-Native "node" @("-p", "require('./package-lock.json').version") | Out-String).Trim()
$productVersion = (Get-Content -Raw -LiteralPath (Join-Path $root "product\VERSION")).Trim()

$versions = [ordered]@{
  manifest = [string]$manifest.version
  package = [string]$rootPackage.version
  desktop = [string]$desktopPackage.version
  lock = $lockVersion
  product = $productVersion
}
foreach ($entry in $versions.GetEnumerator()) {
  if ($entry.Value -ne $Version) {
    throw "Version mismatch: $($entry.Key) is $($entry.Value), expected $Version."
  }
}
if (-not (Test-Path -LiteralPath $notesPath -PathType Leaf)) {
  throw "Release notes are missing: $notesPath"
}
$notesContent = Get-Content -Raw -LiteralPath $notesPath -Encoding UTF8
if ($notesContent -notmatch '<!--\s*release:vi\s*-->') {
  throw "Release notes must include the Vietnamese marker: <!-- release:vi -->"
}
if ($notesContent -notmatch '<!--\s*release:en\s*-->') {
  throw "Release notes must include the English marker: <!-- release:en -->"
}
if ($notesContent -notmatch '(?im)^\|\s*Tiếng Việt\s*\|\s*English\s*\|\s*$') {
  throw "Release notes must present Vietnamese and English side by side in a '| Tiếng Việt | English |' table."
}
Invoke-Native "node" @("scripts/check-release-contract.mjs") | Out-Null

$artifacts = @(
  [pscustomobject]@{
    Path = Join-Path $releaseRoot $manifest.channels.install.setup.relativePath
    Hash = [string]$manifest.channels.install.setup.sha256
    Bytes = [int64]$manifest.channels.install.setup.bytes
  },
  [pscustomobject]@{
    Path = Join-Path $releaseRoot $manifest.channels.portable.exe.relativePath
    Hash = [string]$manifest.channels.portable.exe.sha256
    Bytes = [int64]$manifest.channels.portable.exe.bytes
  },
  [pscustomobject]@{
    Path = Join-Path $releaseRoot $manifest.channels.portable.zip.relativePath
    Hash = [string]$manifest.channels.portable.zip.sha256
    Bytes = [int64]$manifest.channels.portable.zip.bytes
  },
  [pscustomobject]@{
    Path = $manifestPath
    Hash = Get-Sha256 $manifestPath
    Bytes = (Get-Item -LiteralPath $manifestPath).Length
  }
)
foreach ($artifact in $artifacts[0..2]) {
  Assert-Hash $artifact.Path $artifact.Hash
  $actualBytes = (Get-Item -LiteralPath $artifact.Path).Length
  if ($actualBytes -ne $artifact.Bytes) {
    throw "Size mismatch for $($artifact.Path). Expected $($artifact.Bytes), got $actualBytes."
  }
}

$unsigned = @()
foreach ($artifact in $artifacts | Where-Object { $_.Path -like '*.exe' }) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.Path
  if ($signature.Status -ne 'Valid') {
    $unsigned += "$($artifact.Path) ($($signature.Status))"
  }
}
if ($unsigned.Count -gt 0 -and -not $AllowUnsigned) {
  throw "Unsigned release artifacts detected. Sign them, or use -AllowUnsigned only with explicit maintainer authorization: $($unsigned -join '; ')"
}

Invoke-Native "gh" @("auth", "status") | Out-Null
$repo = Invoke-Native "gh" @("repo", "view", "--json", "nameWithOwner,visibility,url,defaultBranchRef") |
  Out-String | ConvertFrom-Json
$branch = (Invoke-Native "git" @("branch", "--show-current") | Out-String).Trim()
if ($branch -ne $repo.defaultBranchRef.name) {
  throw "Release must be created from the default branch '$($repo.defaultBranchRef.name)', current branch is '$branch'."
}
$dirty = (Invoke-Native "git" @("status", "--porcelain") | Out-String).Trim()
if ($dirty) {
  throw "Worktree must be clean before tagging. Commit and push all release changes first."
}

Invoke-Native "git" @("fetch", "origin", $branch, "--tags") | Out-Null
$head = (Invoke-Native "git" @("rev-parse", "HEAD") | Out-String).Trim()
$remoteHead = (Invoke-Native "git" @("rev-parse", "origin/$branch") | Out-String).Trim()
if ($head -ne $remoteHead) {
  throw "HEAD $head does not match origin/$branch $remoteHead. Push the release commit first."
}

$probeErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $existingRelease = & gh release view $tag --json url 2>$null
  $existingReleaseExitCode = $LASTEXITCODE
  $localTagCommit = & git rev-list -n 1 $tag 2>$null
  $localTagExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $probeErrorActionPreference
}
if ($existingReleaseExitCode -eq 0) {
  $releaseUrl = ($existingRelease | Out-String | ConvertFrom-Json).url
  throw "GitHub Release $tag already exists: $releaseUrl"
}

if ($localTagExitCode -eq 0) {
  $localTagCommit = ($localTagCommit | Out-String).Trim()
  if ($localTagCommit -ne $head) {
    throw "Local tag $tag points to $localTagCommit instead of HEAD $head."
  }
} else {
  $localTagCommit = $null
}
$remoteTagCommit = (& git ls-remote origin "refs/tags/$tag^{}" | Out-String).Trim()
if (-not $remoteTagCommit) {
  $remoteTagCommit = (& git ls-remote origin "refs/tags/$tag" | Out-String).Trim()
}
if ($remoteTagCommit) {
  $remoteTagCommit = ($remoteTagCommit -split '\s+')[0]
  if ($remoteTagCommit -ne $head) {
    throw "Remote tag $tag points to $remoteTagCommit instead of HEAD $head."
  }
}

Write-Host "=== GitHub release preflight passed ==="
Write-Host "Repository : $($repo.nameWithOwner) ($($repo.visibility))"
Write-Host "Commit     : $head"
Write-Host "Tag        : $tag"
Write-Host "Artifacts  : $($artifacts.Count)"
Write-Host "Languages  : Vietnamese + English"
Write-Host "README     : README.md <-> README.en.md"
if ($unsigned.Count -gt 0) {
  Write-Warning "Publishing explicitly authorized unsigned Windows artifacts. SmartScreen warnings are expected."
}
if ($DryRun) {
  Write-Host "Dry run complete; no tag or release was created."
  return
}

if (-not $localTagCommit) {
  Invoke-Native "git" @("tag", "-a", $tag, "-m", "Grok Build Desktop $Version") | Out-Null
}
if (-not $remoteTagCommit) {
  Invoke-Native "git" @("push", "origin", $tag) | Out-Null
}

$releaseArgs = @(
  "release", "create", $tag,
  $artifacts[0].Path,
  $artifacts[1].Path,
  $artifacts[2].Path,
  $manifestPath,
  "--verify-tag",
  "--target", $head,
  "--title", "Grok Build Desktop $Version",
  "--notes-file", $notesPath,
  "--fail-on-no-commits"
)
if ($Prerelease) {
  $releaseArgs += @("--prerelease", "--latest=false")
} else {
  $releaseArgs += "--latest"
}
Invoke-Native "gh" $releaseArgs | Out-Null

$published = Invoke-Native "gh" @("release", "view", $tag, "--json", "url,assets,isDraft,isPrerelease,tagName") |
  Out-String | ConvertFrom-Json
if ($published.isDraft) {
  throw "Release $tag was created as a draft unexpectedly."
}
$publishedNames = @($published.assets | ForEach-Object { $_.name })
foreach ($artifact in $artifacts) {
  $name = Split-Path $artifact.Path -Leaf
  if ($publishedNames -notcontains $name) {
    throw "Published release is missing asset: $name"
  }
}

Write-Host "Published: $($published.url)"
Write-Host "Assets: $($publishedNames -join ', ')"
