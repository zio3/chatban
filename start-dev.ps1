# ChatBan dev environment launcher
# - Backs up backend/data (dogfooding data = article source material)
# - Starts backend (8787) / frontend (5173) in separate windows if not running
# Usage: .\start-dev.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# --- 1. DB backup (keep latest 20 sets) ---
# #86: プロジェクトごとにDBが分かれたので data/ 配下をまとめて世代バックアップする
# (管理DB chatban-admin.db + projects/*.db。突き合わせは管理DBのprojects表でできる)
$dataDir = Join-Path $root "backend\data"
if (Test-Path $dataDir) {
    # WALモードではファイルコピーだと直近の書き込みが落ちるので、
    # SQLiteのオンラインバックアップAPI経由で取る (稼働中でも整合が取れる)
    Push-Location (Join-Path $root "backend")
    node scripts/backup-data.mjs 20
    Pop-Location
}
# #179: 旧構成 (backend\chatban.db 単一ファイル) を退避する分岐は外した。
# 取り込む処理そのものが無くなったので、バックアップを取っても行き先が無い

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
