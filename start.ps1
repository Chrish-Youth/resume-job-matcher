$ErrorActionPreference = "Stop"
$url = "http://127.0.0.1:8765/"
$bundledPython = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

try {
    Set-Location -LiteralPath $PSScriptRoot

    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
        if ($health.ok) {
            Write-Host "The service is already running." -ForegroundColor Green
            Start-Process $url
            exit 0
        }
    } catch {
        # The service is not running yet.
    }

    if (Test-Path -LiteralPath $bundledPython) {
        $python = $bundledPython
    } else {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if (-not $pythonCommand) {
            throw "Python 3 was not found. Install Python or launch the project from Codex."
        }
        $python = $pythonCommand.Source
    }

    Write-Host "Starting Resume Job Matcher..." -ForegroundColor Green
    Write-Host "Open: $url" -ForegroundColor DarkGray
    & $python "$PSScriptRoot\app.py"
} catch {
    Write-Host ""
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
