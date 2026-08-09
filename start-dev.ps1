# ChatBan dev environment launcher
# - Backs up chatban.db (dogfooding data = article source material)
# - Starts backend (8787) / frontend (5173) in separate windows if not running
# Usage: .\start-dev.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# --- 1. DB backup (keep latest 20) ---
$db = Join-Path $root "backend\chatban.db"
if (Test-Path $db) {
    $backupDir = Join-Path $root "backend\backup"
    New-Item -ItemType Directory -Force $backupDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item $db (Join-Path $backupDir "chatban-$stamp.db")
    Get-ChildItem $backupDir -Filter "chatban-*.db" | Sort-Object Name -Descending | Select-Object -Skip 20 | Remove-Item -Force
    Write-Host "[backup] chatban.db -> backup/chatban-$stamp.db" -ForegroundColor Green
}

function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# --- 2. backend ---
if (Test-Port 8787) {
    Write-Host "[backend] already running on 8787" -ForegroundColor Yellow
} else {
    Start-Process pwsh -WorkingDirectory (Join-Path $root "backend") -ArgumentList "-NoLogo", "-Command", "npm run dev"
    Write-Host "[backend] starting..." -ForegroundColor Cyan
}

# --- 3. frontend ---
if (Test-Port 5173) {
    Write-Host "[frontend] already running on 5173" -ForegroundColor Yellow
} else {
    Start-Process pwsh -WorkingDirectory (Join-Path $root "frontend") -ArgumentList "-NoLogo", "-Command", "npm run dev"
    Write-Host "[frontend] starting..." -ForegroundColor Cyan
}

# --- 4. health check ---
$deadline = (Get-Date).AddSeconds(30)
$backendOk = $false
$frontendOk = $false
while ((Get-Date) -lt $deadline -and -not ($backendOk -and $frontendOk)) {
    Start-Sleep -Milliseconds 500
    if (-not $backendOk) {
        try { Invoke-RestMethod http://localhost:8787/api/board -TimeoutSec 2 | Out-Null; $backendOk = $true } catch {}
    }
    if (-not $frontendOk) {
        try { Invoke-WebRequest http://localhost:5173 -UseBasicParsing -TimeoutSec 2 | Out-Null; $frontendOk = $true } catch {}
    }
}
Write-Host ""
Write-Host ("[health] backend:  " + $(if ($backendOk) { "OK  http://localhost:8787" } else { "NG (check the backend window)" })) -ForegroundColor $(if ($backendOk) { "Green" } else { "Red" })
Write-Host ("[health] frontend: " + $(if ($frontendOk) { "OK  http://localhost:5173" } else { "NG (check the frontend window)" })) -ForegroundColor $(if ($frontendOk) { "Green" } else { "Red" })
