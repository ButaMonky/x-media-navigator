# X Media Navigator private QA: on-demand build, verify, backup, sync.
# Never modifies main, Draft PR, production browser profile or stable installation.
[CmdletBinding()]
param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$branch = 'handoff/fxembed-media-continuation-20261029'
$target = Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-FxEmbed-QA-20261029'
$stable = Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-Current'
$backupRoot = Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-Backups'
$files = @('manifest.json','content_script.js','style.css','icon16.png','icon48.png','icon128.png')
$actualBranch = (& git -C $root branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $actualBranch -ne $branch) {
  throw "Refusing to deploy from branch '$actualBranch'. Expected '$branch'."
}
Set-Location $root
$sourceDir = Join-Path $root 'extension'
$stableHashes = @{}
foreach ($name in $files) {
  $sourceFile = Join-Path $sourceDir $name
  if (!(Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Missing source: $name" }
  $stableFile = Join-Path $stable $name
  if (!(Test-Path -LiteralPath $stableFile -PathType Leaf)) { throw "Missing stable file: $name" }
  $stableHashes[$name] = (Get-FileHash -LiteralPath $stableFile -Algorithm SHA256).Hash
}

Write-Host '[XMN] TypeScript check, Node tests, Chromium tests...' -ForegroundColor Cyan
& npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed: stable QA files were not touched' }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed: stable QA files were not touched' }
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (!(Test-Path -LiteralPath $edge)) { throw 'Edge needed for isolated browser QA' }
$env:CHROMIUM_PATH = $edge
$env:XMN_RUN_CHROMIUM = '1'
& npm.cmd run test:browser
if ($LASTEXITCODE -ne 0) { throw 'Chromium tests failed: stable QA files were not touched' }
$sourceManifest = Get-Content -LiteralPath (Join-Path $sourceDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($sourceManifest.version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw 'Invalid numeric Chrome version' }
if (Test-Path -LiteralPath (Join-Path $target 'manifest.json') -PathType Leaf) {
  $oldManifest = Get-Content -LiteralPath (Join-Path $target 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([version]$sourceManifest.version -lt [version]$oldManifest.version) {
    throw 'Refusing to downgrade the installed QA build'
  }
}
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$parent = Split-Path -Parent $target
$stage = Join-Path $parent ('.xmn-qa-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$backup = Join-Path $backupRoot ('fxembed-qa-pre-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$movedPrevious = $false
$movedStage = $false
try {

  foreach ($name in $files) {
    Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination (Join-Path $stage $name) -ErrorAction Stop
  }
  $qaManifestPath = Join-Path $stage 'manifest.json'
  $qaManifest = Get-Content -LiteralPath $qaManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $qaManifest.name = 'X Media Navigator (TypeScript Dev) - FxEmbed QA (UNRELEASED)'
  $qaManifest.description = 'Private FxEmbed test build. Disable other X Media Navigator installations during testing.'
  [IO.File]::WriteAllText($qaManifestPath,($qaManifest | ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
  $commit = (& git rev-parse --short HEAD).Trim()
  $dirty = [bool](@(& git status --porcelain).Count)
  $note = @"
X Media Navigator FxEmbed QA - v$($sourceManifest.version) / source $commit (uncommitted local edits: $dirty)
This is an UNRELEASED test version; official main and stable install are unchanged.
The third-party FxEmbed API receives a public profile handle and normal network metadata after your consent.
HOW TO CHECK IN CHROME:
1. Disable every other X Media Navigator extension (do not remove it).
2. Once: chrome://extensions -> Developer mode -> Load unpacked -> choose THIS folder.
3. Later: run Update-Chrome-QA.cmd in the project root, click Reload on this extension card and refresh the X tab.
4. On X: F12 -> Console -> filter "[XMN"; confirm startup, fxembed.* and preview.* events.
5. A "preview.low_thumbnail_decoded" entry proves preparation; "preview.visible" with quality=low proves actual display.
6. A direct document navigation cannot show the old modal's low-res handoff. It is not proof of an SPA transition.
Do not share private HAR, cookies, tokens, raw network URLs or full browser logs.
"@
  [IO.File]::WriteAllText((Join-Path $stage 'QA_README.txt'),$note,[Text.UTF8Encoding]::new($false))

  foreach ($name in $files | Where-Object { $_ -ne 'manifest.json' }) {
    $expected = (Get-FileHash -LiteralPath (Join-Path $sourceDir $name) -Algorithm SHA256).Hash
    $actual = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash
    if ($expected -ne $actual) { throw "Stage hash mismatch: $name" }
  }
  if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination $backup -ErrorAction Stop
    $movedPrevious = $true
  }
  Move-Item -LiteralPath $stage -Destination $target -ErrorAction Stop
  $movedStage = $true
  foreach ($name in $files | Where-Object { $_ -ne 'manifest.json' }) {
    $expected = (Get-FileHash -LiteralPath (Join-Path $sourceDir $name) -Algorithm SHA256).Hash
    $actual = (Get-FileHash -LiteralPath (Join-Path $target $name) -Algorithm SHA256).Hash
    if ($expected -ne $actual) { throw "Installed QA hash mismatch: $name" }
  }
  foreach ($name in $files) {
    $after = (Get-FileHash -LiteralPath (Join-Path $stable $name) -Algorithm SHA256).Hash
    if ($stableHashes[$name] -ne $after) { throw "Stable installation changed unexpectedly: $name" }
  }
  Write-Host "[XMN] QA $($qaManifest.version) installed and verified: $target" -ForegroundColor Green
  Write-Host '[XMN] Stable installation was NOT changed.' -ForegroundColor Green

} catch {
  $failure = $_
  if ($movedStage -and (Test-Path -LiteralPath $target)) {
    $failedCopy = Join-Path $backupRoot ('fxembed-qa-failed-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    Move-Item -LiteralPath $target -Destination $failedCopy -ErrorAction Stop
  }
  if ($movedPrevious -and (Test-Path -LiteralPath $backup)) {
    Move-Item -LiteralPath $backup -Destination $target -ErrorAction Stop
  }
  throw $failure
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force -Recurse }
}
if (!$NoOpen) {
  $chromeCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
  )
  $chromePath = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if ($chromePath) {
    Start-Process -FilePath $chromePath -ArgumentList 'chrome://extensions'
  } else {
    Write-Host '[XMN] Chrome executable not found. Open chrome://extensions manually.'
  }
}
Write-Host '[XMN] Chrome: click Reload on the FxEmbed QA extension and refresh your X tab.'
