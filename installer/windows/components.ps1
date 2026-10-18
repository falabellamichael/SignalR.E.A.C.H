param(
    [Parameter(Mandatory=$true)][ValidateSet('InstallCode','InstallPublic','LaunchCode','LaunchRag','LaunchStudio','LaunchTray')][string]$Action,
    [string]$Payload,
    [string]$ExtensionHome,
    [ValidateSet('VSCode','Antigravity','Cursor')][string]$IDE = 'VSCode'
)
$ErrorActionPreference = 'Stop'
function File-Hash([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLower() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Find-Code {
    $hostInfo = switch ($IDE) {
        VSCode { @{ Folder = 'Microsoft VS Code'; Command = 'code.cmd'; Name = 'VS Code' } }
        Antigravity { @{ Folder = 'Antigravity'; Command = 'antigravity.cmd'; Name = 'Antigravity' } }
        Cursor { @{ Folder = 'cursor'; Command = 'cursor.cmd'; Name = 'Cursor' } }
    }
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\$($hostInfo.Folder)\bin\$($hostInfo.Command)",
        "$env:ProgramFiles\$($hostInfo.Folder)\bin\$($hostInfo.Command)",
        "${env:ProgramFiles(x86)}\$($hostInfo.Folder)\bin\$($hostInfo.Command)"
    )
    $command = Get-Command $hostInfo.Command -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    throw "$($hostInfo.Name) is required. Install it, then run Setup again with IDE > $($hostInfo.Name) selected."
}

function Compare-ExtensionVersion([string]$Left, [string]$Right) {
    $leftRelease = @((($Left -split '\+', 2)[0]) -split '-', 2)
    $rightRelease = @((($Right -split '\+', 2)[0]) -split '-', 2)
    $core = ([version]$leftRelease[0]).CompareTo([version]$rightRelease[0])
    if ($core -ne 0) { return $core }
    if ($leftRelease.Count -eq 1 -and $rightRelease.Count -eq 1) { return 0 }
    if ($leftRelease.Count -eq 1) { return 1 }
    if ($rightRelease.Count -eq 1) { return -1 }
    $leftIds = @($leftRelease[1] -split '\.')
    $rightIds = @($rightRelease[1] -split '\.')
    for ($i = 0; $i -lt [Math]::Min($leftIds.Count, $rightIds.Count); $i++) {
        $a = $leftIds[$i]; $b = $rightIds[$i]
        $aNumeric = $a -match '^\d+$'; $bNumeric = $b -match '^\d+$'
        if ($aNumeric -and $bNumeric) {
            $a = $a.TrimStart('0'); $b = $b.TrimStart('0')
            if ($a.Length -ne $b.Length) { return [Math]::Sign($a.Length - $b.Length) }
        } elseif ($aNumeric -ne $bNumeric) {
            if ($aNumeric) { return -1 } else { return 1 }
        }
        $comparison = [String]::CompareOrdinal($a, $b)
        if ($comparison -ne 0) { return $comparison }
    }
    return [Math]::Sign($leftIds.Count - $rightIds.Count)
}

function Install-Public {
    $manifestPath = Join-Path $Payload 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.id -ne 'signal-reach-public' -or $manifest.edition -ne 'public' -or $manifest.schema_version -ne 1 -or
        $manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$') { throw 'Invalid public extension manifest.' }
    $assets = @($manifest.scripts) + @($manifest.styles)
    if (($assets.path -join ',') -ne 'manifest.js,reach-public.js,reach-public.css') { throw 'Unexpected public extension assets.' }
    foreach ($asset in $assets) {
        $source = Join-Path $Payload $asset.path
        if ((Get-Item -LiteralPath $source).Length -ne $asset.size -or (File-Hash $source) -ne $asset.sha256) { throw "Invalid asset: $($asset.path)" }
    }
    if (!$ExtensionHome) {
        if ($env:PYMU_RAG_EXTENSION_HOME) { $ExtensionHome = $env:PYMU_RAG_EXTENSION_HOME }
        elseif ($env:PYMU_RAG_HOME) { $ExtensionHome = Join-Path (Split-Path $env:PYMU_RAG_HOME -Parent) 'extensions' }
        else { $ExtensionHome = "$env:LOCALAPPDATA\RAGWorkspace\extensions" }
    }
    $extensionRoot = [IO.Path]::GetFullPath($ExtensionHome)
    New-Item -ItemType Directory -Force -Path $extensionRoot | Out-Null
    $lock = [IO.File]::Open((Join-Path $extensionRoot '.reach-editions-install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $stage = $null; $backup = $null; $installed = $false
    $registryPath = Join-Path $extensionRoot 'registry.json'
    $tempRegistry = Join-Path $extensionRoot ('.registry-' + [guid]::NewGuid() + '.tmp')
    try {
        $registry = if (Test-Path -LiteralPath $registryPath) { Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{schema_version=1;extensions=@()} }
        if ($registry.schema_version -ne 1 -or $registry.extensions -isnot [array]) { throw 'Invalid extension registry; existing data preserved.' }
        foreach ($existing in @($registry.extensions | Where-Object { $_.id -eq 'signal-reach-public' })) {
            if ((Compare-ExtensionVersion $manifest.version $existing.version) -lt 0) {
                Write-Output "Kept newer public SimpleRAG extension $($existing.version); this bundle contains $($manifest.version)."
                return
            }
        }
        $parent = Join-Path $extensionRoot 'packages\signal-reach-public'
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $target = Join-Path $parent $manifest.version
        $stage = Join-Path $parent ('.stage-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($name in @('manifest.json') + @($assets.path)) { Copy-Item -LiteralPath (Join-Path $Payload $name) -Destination $stage }
        if (Test-Path -LiteralPath $target) { $backup = $target + '.backup-' + [guid]::NewGuid(); Move-Item -LiteralPath $target -Destination $backup }
        Move-Item -LiteralPath $stage -Destination $target
        $stage = $null; $installed = $true
        $entry = [pscustomobject]@{id=$manifest.id;version=$manifest.version;enabled=$true;manifest_sha256=(File-Hash $manifestPath);schema_version=1;surfaces=@('advanced');scripts=$manifest.scripts;styles=$manifest.styles}
        $registry.extensions = @($registry.extensions | Where-Object { $_.id -ne 'signal-reach-public' }) + @($entry)
        if ($registry.PSObject.Properties['uninstalled_extensions']) { $registry.uninstalled_extensions = @($registry.uninstalled_extensions | Where-Object { $_ -ne 'signal-reach-public' }) }
        [IO.File]::WriteAllText($tempRegistry, ($registry | ConvertTo-Json -Depth 32), (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $registryPath) { [IO.File]::Replace($tempRegistry, $registryPath, [NullString]::Value) }
        else { [IO.File]::Move($tempRegistry, $registryPath) }
    } catch {
        if ($installed) { Remove-Item -LiteralPath $target -Recurse -Force }
        if ($backup -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target; $backup = $null }
        throw
    } finally {
        foreach ($temporary in @($stage,$backup,$tempRegistry)) { if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
        $lock.Dispose()
    }
    Write-Output 'Public SimpleRAG extension installed. Reload the Advanced page in SimpleRAG.'
}

try {
    switch ($Action) {
        InstallCode {
            $code = Find-Code
            & $code --install-extension $Payload --force
            if ($LASTEXITCODE -ne 0) { throw "$IDE extension install failed ($LASTEXITCODE)." }
        }
        InstallPublic { Install-Public }
        LaunchCode { & (Find-Code) --new-window; if ($LASTEXITCODE -ne 0) { throw "Could not launch $IDE." } }
        LaunchRag {
            $links = Get-ChildItem -Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs","$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Filter '*SimpleRAG*.lnk' -Recurse -ErrorAction SilentlyContinue
            $link = $links | Where-Object { $_.Name -notmatch 'uninstall' } | Select-Object -First 1
            if (!$link) { throw 'SimpleRAG was not found in the Start menu. Open your SimpleRAG installation and reload its Advanced page.' }
            Start-Process -FilePath $link.FullName
        }
        { $_ -in 'LaunchStudio','LaunchTray' } {
            $name = if ($Action -eq 'LaunchStudio') { 'Reach Studio' } else { 'SignalREACH' }
            $entries = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
            $entry = $entries | Where-Object { $_.DisplayName -eq $name -and $_.InstallLocation } | Select-Object -First 1
            $folder = if ($entry) { $entry.InstallLocation } elseif ($Action -eq 'LaunchStudio') { "$env:LOCALAPPDATA\Programs\Reach Studio" } else { "$env:LOCALAPPDATA\Programs\signalreach-copilot-tray" }
            Start-Process -FilePath (Join-Path $folder ($name + '.exe'))
        }
    }
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
