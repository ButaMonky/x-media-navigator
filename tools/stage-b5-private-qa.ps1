# Stage an immutable, side-by-side unpacked QA candidate. Never install it.
# The ordinary Chrome profile, existing QA folder and stable version are untouched.
[CmdletBinding()]
param([string]$Destination = (Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-v2.4.22-B5-QA-20261030'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$branch = 'task/xmn-b5-28to29-20261030'
$files = @('manifest.json','content_script.js','background.js',
  'style.css','icon16.png','icon48.png','icon128.png')
$source = Join-Path $root 'extension'
function Assert-VerifiedSource {
  $actual = (& git -C $root branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -ne $branch) {
    throw "Unrecognized private QA source branch: $actual"
  }
  $sha = (& git -C $root rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') {
    throw 'Unable to validate source SHA'
  }
  $status = @(& git -C $root status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $status.Count -gt 0) {
    throw 'Refusing QA package from uncommitted or untracked source'
  }
  $remote = @(& git -C $root ls-remote origin ("refs/heads/" + $branch))
  if ($LASTEXITCODE -ne 0 -or $remote.Count -ne 1) {
    throw 'Cannot verify original private GitHub branch'
  }
  if (($remote[0] -split '\s+')[0] -ne $sha) {
    throw 'Refusing QA staging from non-GitHub-matching HEAD'
  }
  return $sha
}
if (Test-Path -LiteralPath $Destination) {
  throw "Destination already exists, no overwrites: $Destination"
}
$sha = Assert-VerifiedSource
$manifest = Get-Content (Join-Path $source 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.version -ne '2.4.22' -or
    $manifest.version_name -notlike '*B5 private QA candidate*') {
  throw 'Unexpected extension version or release channel'
}
if (@($manifest.permissions).Count -ne 1 -or $manifest.permissions[0] -ne 'storage') {
  throw 'QA package requires unexpected extension permissions'
}
foreach ($file in $files) {
  if (!(Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
    throw "Missing committed extension asset: $file"
  }
}
$readOnly = @(
  (Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-Current'),
  (Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-FxEmbed-QA-20261029'),
  (Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-v2.4.21-B4-QA-20261030')
)
$protected = @{}
foreach ($folder in $readOnly) {
  if (!(Test-Path -LiteralPath $folder -PathType Container)) {
    throw "Required existing install folder is missing: $folder"
  }
  foreach ($file in $files) {
    $p = Join-Path $folder $file
    if (!(Test-Path -LiteralPath $p -PathType Leaf)) {
      # Older stable/QA manifests do not include an MV3 background worker.
      if ($file -eq 'background.js') { continue }
      throw "Protected extension asset is missing: $p"
    }
    $protected[$p] = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash
  }
}
$oldPath = (Get-Location).Path
Set-Location $root
try {
  & npm.cmd run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'QA TypeScript check failed' }
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'QA Node suite failed' }
  & npm.cmd run test:mv3:b5
  if ($LASTEXITCODE -ne 0) { throw 'QA real-Chrome MV3 28-to-29 synthetic gate failed' }
  & npm.cmd run test:mv3:reject
  if ($LASTEXITCODE -ne 0) { throw 'QA MV3 unauthorized-origin rejection failed' }
  if ((Assert-VerifiedSource) -ne $sha) {
    throw 'Source changed during QA verification'
  }
  # Source integrity alone is insufficient; GitHub must have passed all
  # required Node, TypeScript, Chromium, and generated JavaScript gates.
  $ciJson = & gh run list --repo ButaMonky/x-media-navigator --branch $branch --limit 10 --json headSha,status,conclusion
  if ($LASTEXITCODE -ne 0 -or !$ciJson) {
    throw 'GitHub Actions verification is unavailable; QA staging refused'
  }
  $runs = @($ciJson | ConvertFrom-Json)
  $approved = @($runs | Where-Object {
    $_.headSha -eq $sha -and $_.status -eq 'completed' -and
    $_.conclusion -eq 'success'
  })
  if ($approved.Count -eq 0) {
    throw 'Required GitHub CI has not succeeded for this exact QA commit'
  }
} finally {
  Set-Location $oldPath
}
$parent = Split-Path -Parent $Destination
if (!(Test-Path -LiteralPath $parent -PathType Container)) {
  throw 'QA destination parent directory is unavailable'
}
$stage = Join-Path $parent ('.xmn-b5-qa-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
try {
  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $stage $file) -ErrorAction Stop
  }
  # This manual diagnostic is not referenced in the extension manifest.
  $manualAudit = Join-Path $root 'tools\b5-readonly-audit.js'
  if (!(Test-Path -LiteralPath $manualAudit -PathType Leaf)) {
    throw 'Missing read-only B5 acceptance snippet'
  }
  Copy-Item -LiteralPath $manualAudit -Destination (Join-Path $stage 'B5_READONLY_AUDIT.js') -ErrorAction Stop
  $digests = @()
  foreach ($file in $files) {
    $sourceDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source $file)).Hash
    $stageDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage $file)).Hash
    if ($sourceDigest -ne $stageDigest) { throw "Asset hash mismatch: $file" }
    $digests += ($stageDigest + '  ' + $file)
  }
  $manualDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $manualAudit).Hash
  $copyDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage 'B5_READONLY_AUDIT.js')).Hash
  if ($manualDigest -ne $copyDigest) {
    throw 'Read-only B5 QA snippet hash mismatch'
  }
  $digests += ($manualDigest + '  B5_READONLY_AUDIT.js')
  [IO.File]::WriteAllLines((Join-Path $stage 'SHA256SUMS.txt'),
    $digests,[Text.UTF8Encoding]::new($false))
  $readme = @"
X Media Navigator v2.4.22 — PRIVATE B5 QA candidate (NOT RELEASED)
Verified private Git source: $sha
This folder is a NEW side-by-side Chrome unpacked extension candidate.
The stable v2.4.18, older QA v2.4.20 and B4 QA v2.4.21 folders have not been changed.

To test manually:
1. Disable ALL older X Media Navigator extensions temporarily.
2. Open chrome://extensions, enable Developer mode, choose Load unpacked,
   and select this new versioned folder.
3. Start with an X account's public Media tab, use left/right arrows,
   and verify multiple-photo posts, GIF/video, and 28 -> 29.
4. Confirm that replies remain correct during native SPA transitions.
   Between separately archived pages, full document navigation is expected.
5. Test disabled network, rapid repeated keys, page refresh and Back/Forward.
6. Check the preview is not painted over X replies or other photos.
7. If any real X behavior differs, do not publish or overwrite stable Chrome.
8. Optional: manually run B5_READONLY_AUDIT.js in Chrome DevTools Snippets
   while the X viewer is open. It reports only aggregate counts/booleans.
   A DOM-visible image is NOT proof of Paint; inspect the screen yourself.

FxEmbed is a third-party service; explicitly approving continuation shares
the public account handle and normal network metadata with that service.
No X cookies or credentials are sent intentionally.
Never share raw HAR, signed-in network logs, cookies or access tokens.
Source evidence: docs/implementation/B4-GRID-VALIDATION-20261030.md
"@
  [IO.File]::WriteAllText((Join-Path $stage 'QA_README.txt'),
    $readme,[Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Destination) {
    throw 'Destination appeared during staging; refusing overwrite'
  }
  if ((Assert-VerifiedSource) -ne $sha) {
    throw 'GitHub source changed during QA staging'
  }
  Move-Item -LiteralPath $stage -Destination $Destination -ErrorAction Stop
  foreach ($p in $protected.Keys) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash -ne $protected[$p]) {
      throw "A protected stable/previous QA extension asset changed: $p"
    }
  }
  Write-Host "PRIVATE_QA_STAGED_SHA=$sha"
  Write-Host "PRIVATE_QA_FOLDER=$Destination"
  Write-Host 'CHROME_INSTALLATION_NOT_MODIFIED=true'
} finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
