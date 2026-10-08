# SimpleREACH one-click installer (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
# Pins to a release tag. Override with $env:REACH_REF = 'main' if you accept that risk.
$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/falabellamichael/SignalR.E.A.C.H.git'
$Ref = if ($env:REACH_REF) { $env:REACH_REF } else { 'v26.9.13' }
Write-Host "[SimpleREACH] source: $Repo"
Write-Host "[SimpleREACH] ref: $Ref"

# 0. Use the current folder if it is already a checkout
if (Test-Path (Join-Path (Get-Location) 'tools\reach.py')) {
    $Dir = (Get-Location).Path
    Write-Host "[SimpleREACH] using current checkout: $Dir"
} else {
    $Dir = Join-Path (Get-Location) 'SignalR.E.A.C.H'
    Write-Host "[SimpleREACH] checkout: $Dir"
}

# 1. Python (3.9+)
$py = $null
foreach ($cand in @('python', 'python3')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cand; break }
}
if (-not $py) { throw "Python not found on PATH. Install Python 3.9+ from https://python.org and re-run." }
$ver = (& $py -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null)
if (-not $ver) { $ver = 'unknown' }
Write-Host "[SimpleREACH] using $py ($ver)"

# 2. Clone or refresh the pinned ref (only when not already in a checkout)
if ($Dir -ne (Get-Location).Path) {
    if (Test-Path (Join-Path $Dir '.git')) {
        Write-Host "[SimpleREACH] existing checkout at $Dir - fetching $Ref"
        Push-Location $Dir
        git fetch --depth 1 origin $Ref
        git checkout --detach FETCH_HEAD
        Pop-Location
    } else {
        Write-Host "[SimpleREACH] cloning $Repo at $Ref"
        git clone --depth 1 --branch $Ref $Repo $Dir
    }
}

# 3. Install the public SimpleRAG frontend only.
Push-Location $Dir
try {
    & $py tools\reach.py install
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) { throw "install failed (exit $code). See output above; re-run with 'python tools\reach.py install --help' for options." }

Write-Host ''
Write-Host '[SignalREACH] done. Reload SimpleRAG -> Advanced -> SignalREACH.'
Write-Host '[SignalREACH] add your own provider URL and API key in Settings.'
