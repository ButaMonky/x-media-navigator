[CmdletBinding()]
param([switch]$CheckOnly)

# Private, verified GitHub beta artifacts only. Never edit Chrome profiles.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = 'ButaMonky/x-media-navigator'
$branch = 'beta'
$installDir = Join-Path $env:USERPROFILE 'Downloads\X-Media-Navigator-Current'
$dataDir = Join-Path $env:LOCALAPPDATA 'XMediaNavigatorUpdater'
$backupsDir = Join-Path $dataDir 'backups'
$stateFile = Join-Path $dataDir 'state.json'
$logFile = Join-Path $dataDir 'updater.log'
$allowed = @('content_script.js', 'icon128.png', 'icon16.png', 'icon48.png', 'manifest.json', 'style.css')
$mutex = New-Object System.Threading.Mutex($false, 'Local\XMediaNavigatorPrivateBetaSync')
$locked = $false

function Write-Status([string]$message) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $message)
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value $line
    Write-Output $line
}
function Invoke-GhJson([string]$apiPath, [string]$binary) {
    $output = & $binary api $apiPath
    if ($LASTEXITCODE -ne 0) { throw "GitHub request failed: $apiPath" }
    return (($output | Out-String) | ConvertFrom-Json)
}
function Assert-Extension([string]$dir, [string]$expectedVersion) {
    $files = @(Get-ChildItem -LiteralPath $dir -Force -File)
    $dirs = @(Get-ChildItem -LiteralPath $dir -Force -Directory)
    if ($files.Count -ne $allowed.Count -or $dirs.Count -ne 0) { throw 'Artifact has unexpected files or folders' }
    foreach ($file in $files) {
        if ($file.Name -notin $allowed -or $file.Length -le 0 -or
            ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw ('Unsafe artifact file: ' + $file.Name)
        }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $dir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.manifest_version -ne 3 -or $manifest.version -ne $expectedVersion -or
        $manifest.name -ne 'X Media Navigator (TypeScript Dev)') { throw 'Unexpected manifest identity or version' }
    foreach ($key in @('key','update_url','host_permissions','permissions','background','web_accessible_resources')) {
        if ($manifest.PSObject.Properties.Name -contains $key) { throw ('Unexpected permission or identity field: ' + $key) }
    }
    $items = @($manifest.content_scripts)
    if ($items.Count -ne 1 -or
        (@($items[0].js) -join ',') -ne 'content_script.js' -or
        (@($items[0].css) -join ',') -ne 'style.css' -or
        (@($items[0].matches) -join ',') -ne 'https://x.com/*,https://twitter.com/*') {
        throw 'Unexpected content-script targets'
    }
    return $manifest
}

function Save-UpdateState([string]$version, $run, $artifact, $backupPath) {
    $newState = [ordered]@{
        version = $version
        head_sha = [string]$run.head_sha
        run_id = [string]$run.id
        artifact_id = [string]$artifact.id
        installed_at = (Get-Date).ToString('o')
        install_dir = $installDir
        previous_backup = $backupPath
    }
    $tempState = Join-Path $dataDir ('state-' + [guid]::NewGuid().ToString('N') + '.json')
    $newState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempState -Encoding UTF8
    Move-Item -LiteralPath $tempState -Destination $stateFile -Force
}

try {
    if (-not $mutex.WaitOne(0)) { Write-Output 'Updater already running; skipping'; return }
    $locked = $true
    New-Item -ItemType Directory -Force -Path $dataDir, $backupsDir | Out-Null
    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    $gh = if ($ghCommand) { $ghCommand.Source } else { $null }
    if (-not $gh) {
        $candidate = 'C:\Program Files\GitHub CLI\gh.exe'
        if (Test-Path -LiteralPath $candidate) { $gh = $candidate }
    }
    if (-not $gh) { throw 'GitHub CLI (gh) is required' }

    $runsApi = "repos/$repo/actions/workflows/check.yml/runs?branch=$branch&event=push&status=success&per_page=12"
    $runs = Invoke-GhJson $runsApi $gh
    $selected = $null
    $selectedArtifact = $null
    $targetVersion = $null
    foreach ($run in @($runs.workflow_runs)) {
        if ($run.head_branch -ne $branch -or $run.event -ne 'push' -or
            $run.conclusion -ne 'success' -or $run.status -ne 'completed') { continue }
        $artifacts = Invoke-GhJson "repos/$repo/actions/runs/$($run.id)/artifacts" $gh
        foreach ($artifact in @($artifacts.artifacts)) {
            if ($artifact.expired -or $artifact.workflow_run.head_sha -ne $run.head_sha) { continue }
            if ($artifact.name -match '^X-Media-Navigator-v(\d+\.\d+\.\d+)-beta(?:\d+)?$') {
                $selected = $run
                $selectedArtifact = $artifact
                $targetVersion = $Matches[1]
                break
            }
        }
        if ($selected) { break }
    }
    if (-not $selected) { Write-Status 'No validated beta artifact available; keeping installed version'; return }

    $state = $null
    if (Test-Path -LiteralPath $stateFile) {
        $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    $installedManifest = Join-Path $installDir 'manifest.json'
    if ($state -and $state.head_sha -eq $selected.head_sha -and
        (Test-Path -LiteralPath $installedManifest -PathType Leaf)) {
        Write-Status "Already current: version=$targetVersion commit=$($selected.head_sha)"
        return
    }
    if (Test-Path -LiteralPath $installedManifest) {
        $current = Get-Content -LiteralPath $installedManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([version]$targetVersion -lt [version]$current.version) {
            Write-Status "Refusing downgrade from $($current.version) to $targetVersion"
            return
        }
    }
    if ($CheckOnly) {
        Write-Status "Update available: version=$targetVersion commit=$($selected.head_sha) run=$($selected.id)"
        return
    }

    $stage = Join-Path $dataDir ('stage-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        & $gh run download ([string]$selected.id) -R $repo -n ([string]$selectedArtifact.name) -D $stage
        if ($LASTEXITCODE -ne 0) { throw 'Artifact download failed' }
        $null = Assert-Extension $stage $targetVersion

        # A documentation-only commit must not replace identical installed files.
        if (Test-Path -LiteralPath $installedManifest -PathType Leaf) {
            $same = $true
            foreach ($name in $allowed) {
                $oldFile = Join-Path $installDir $name
                $newFile = Join-Path $stage $name
                if (!(Test-Path -LiteralPath $oldFile -PathType Leaf) -or
                    (Get-FileHash -LiteralPath $oldFile -Algorithm SHA256).Hash -ne
                    (Get-FileHash -LiteralPath $newFile -Algorithm SHA256).Hash) {
                    $same = $false
                    break
                }
            }
            if ($same) {
                $oldBackup = if ($state) { $state.previous_backup } else { $null }
                Save-UpdateState $targetVersion $selected $selectedArtifact $oldBackup
                Write-Status "UNCHANGED FILES version=$targetVersion commit=$($selected.head_sha); folder left untouched"
                return
            }
        }

        $backupPath = $null
        $oldMoved = $false
        if (Test-Path -LiteralPath $installDir) {
            $backupPath = Join-Path $backupsDir ('previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $installDir -Destination $backupPath
            $oldMoved = $true
        }
        try {
            Move-Item -LiteralPath $stage -Destination $installDir
        } catch {
            if ($oldMoved -and -not (Test-Path -LiteralPath $installDir)) {
                Move-Item -LiteralPath $backupPath -Destination $installDir
            }
            throw
        }

        Save-UpdateState $targetVersion $selected $selectedArtifact $backupPath
        Write-Status "INSTALLED version=$targetVersion commit=$($selected.head_sha) path=$installDir"
        Write-Status 'Reload the unpacked Chrome extension card; the global Update button does not fetch GitHub files'
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
} catch {
    if (Test-Path -LiteralPath $dataDir) { Write-Status ('ERROR: ' + $_.Exception.Message) }
    throw
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
