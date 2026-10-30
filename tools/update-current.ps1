# Update the sole Chrome unpacked folder from a verified private GitHub commit.
# Temporary rollback is removed after success; no versioned local QA folders.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$branch='task/xmn-b0-b3-20261029'
$repo='ButaMonky/x-media-navigator'
$target=Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-Current'
$files=@('manifest.json','content_script.js','background.js','style.css','icon16.png','icon48.png','icon128.png')
function Assert-Source {
  $actual=(& git -C $root branch --show-current).Trim()
  if($LASTEXITCODE -ne 0 -or $actual -ne $branch){throw "Incorrect branch: $actual"}
  $head=(& git -C $root rev-parse HEAD).Trim()
  if($LASTEXITCODE -ne 0 -or $head -notmatch '^[a-f0-9]{40}$'){throw 'Invalid commit'}
  $dirty=@(& git -C $root status --porcelain --untracked-files=normal)
  if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){throw 'Dirty source refused'}
  $ref=@(& git -C $root ls-remote origin ('refs/heads/'+$branch))
  if($LASTEXITCODE -ne 0 -or $ref.Count -ne 1 -or
    ($ref[0] -split '\s+')[0] -ne $head){throw 'Source differs from private GitHub'}
  return $head
}
$head=Assert-Source
$gh=Get-Command gh.exe -ErrorAction SilentlyContinue
if(-not $gh){throw 'GitHub CLI unavailable; cannot verify CI'}
$api='repos/'+$repo+'/actions/runs?head_sha='+$head+'&per_page=30'
$raw=& $gh.Source api $api
if($LASTEXITCODE -ne 0){throw 'GitHub CI lookup failed'}
$runs=(($raw -join [Environment]::NewLine)|ConvertFrom-Json).workflow_runs
$passed=@($runs|Where-Object {
  $_.head_sha -eq $head -and $_.name -eq 'TypeScript check' -and
  $_.status -eq 'completed' -and $_.conclusion -eq 'success'
})
if($passed.Count -eq 0){throw 'Exact commit lacks successful GitHub CI'}
& npm.cmd --prefix $root run typecheck
if($LASTEXITCODE -ne 0){throw 'TypeScript typecheck failed'}
foreach($name in @('content_script.js','background.js')){
  & node.exe --check (Join-Path $root ('extension\'+$name))
  if($LASTEXITCODE -ne 0){throw ('JavaScript syntax failed: '+$name)}
}
if((Assert-Source) -ne $head){throw 'Source changed during checks'}
$src=Join-Path $root 'extension'
foreach($name in $files){
  if(-not(Test-Path -LiteralPath (Join-Path $src $name) -PathType Leaf)){
    throw ('Missing release asset: '+$name)
  }
}
$manifest=Get-Content -LiteralPath (Join-Path $src 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.manifest_version -ne 3 -or
  $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or
  $manifest.name -notmatch '^X Media Navigator \(Native QA '){
  throw 'Not a supported native QA manifest'
}
$pkg=Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json
if(-not ([string]$pkg.version).StartsWith(([string]$manifest.version)+'-dev.')){
  throw 'Manifest and development package versions differ'
}
if(-not(Test-Path -LiteralPath (Join-Path $target 'manifest.json') -PathType Leaf)){
  throw 'Current extension folder is missing; do not create a second target'
}
$prior=Get-Content -LiteralPath (Join-Path $target 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if([version]$manifest.version -lt [version]$prior.version){throw 'Version downgrade refused'}
if([version]$manifest.version -eq [version]$prior.version){
  $same=$true
  foreach($name in $files){
    $a=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $src $name)).Hash
    $oldPath=Join-Path $target $name
    if(-not(Test-Path -LiteralPath $oldPath) -or
      $a -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $oldPath).Hash){$same=$false}
  }
  if(-not $same){throw 'Same-version content change refused; bump Chrome version'}
  Write-Output ('ALREADY_CURRENT='+$manifest.version)
  exit 0
}
$parent=Split-Path -Parent $target
$nonce=[guid]::NewGuid().ToString('N')
$stage=Join-Path $parent ('.xmn-current-stage-'+$nonce)
$rollback=Join-Path $parent ('.xmn-current-rollback-'+$nonce)
$failed=Join-Path $parent ('.xmn-current-failed-'+$nonce)
if((Test-Path $stage) -or (Test-Path $rollback) -or (Test-Path $failed)){
  throw 'Temporary path collision'
}
$oldMoved=$false;$newMoved=$false
New-Item -ItemType Directory -Path $stage|Out-Null
try {
  foreach($name in $files){
    $sourcePath=Join-Path $src $name
    $destination=Join-Path $stage $name
    Copy-Item -LiteralPath $sourcePath -Destination $destination -ErrorAction Stop
    if((Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash -ne
      (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash){
      throw ('Stage SHA mismatch: '+$name)
    }
  }
  if((Assert-Source) -ne $head){throw 'Git HEAD changed before staging'}
  Move-Item -LiteralPath $target -Destination $rollback -ErrorAction Stop
  $oldMoved=$true
  Move-Item -LiteralPath $stage -Destination $target -ErrorAction Stop
  $newMoved=$true
  foreach($name in $files){
    if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $src $name)).Hash -ne
      (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target $name)).Hash){
      throw ('Installed SHA mismatch: '+$name)
    }
  }
  Remove-Item -LiteralPath $rollback -Recurse -Force -ErrorAction Stop
  $oldMoved=$false
  Write-Output ('UPDATED_CURRENT='+$target)
  Write-Output ('VERSION='+$manifest.version)
  Write-Output ('COMMIT='+$head)
  Write-Output 'Reload this extension card in chrome://extensions, then refresh X.'
} catch {
  $err=$_.Exception.Message
  if($newMoved -and (Test-Path -LiteralPath $target)){
    Move-Item -LiteralPath $target -Destination $failed -ErrorAction Stop
  }
  if($oldMoved -and (Test-Path -LiteralPath $rollback)){
    Move-Item -LiteralPath $rollback -Destination $target -ErrorAction Stop
  }
  throw ('Update failed; previous Current restored if possible: '+$err)
} finally {
  if(Test-Path $stage){Remove-Item -LiteralPath $stage -Recurse -Force}
}
