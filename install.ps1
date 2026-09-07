# SimpleREACH one-click installer (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
# Clones (or reuses) the repo, then runs: python tools\reach.py install
$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/falabellamichael/SimpleREACH.git'
$Dir = Join-Path (Get-Location) 'SimpleREACH'

# 1. Python (3.9+)
$py = $null
foreach ($cand in @('python', 'python3')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cand; break }
}
if (-not $py) { throw "Python not found on PATH. Install Python 3.9+ from https://python.org and re-run." }
$ver = & $py -c 'import sys; print("%d.%d" % sys.version_info[:2])'
Write-Host "[SimpleREACH] using $py ($ver)"

# 2. Clone or refresh
if (Test-Path (Join-Path $Dir '.git')) {
    Write-Host "[SimpleREACH] existing checkout at $Dir — pulling latest"
    Push-Location $Dir
    git pull --ff-only
    Pop-Location
} else {
    Write-Host "[SimpleREACH] cloning $Repo"
    git clone --depth 1 $Repo $Dir
}

# 3. Install panel + relay + tunnel
Push-Location $Dir
try {
    & $py tools\reach.py install
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) { throw "install failed (exit $code). See output above; re-run with 'python tools\reach.py install --help' for options." }

Write-Host ''
Write-Host '[SimpleREACH] done. Open SimpleRAG -> Advanced -> REACH for the control panel.'
Write-Host '[SimpleREACH] pointer URL: https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt'
