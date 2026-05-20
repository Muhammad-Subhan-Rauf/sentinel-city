# dev.ps1 — launch backend (uvicorn --reload) and frontend (vite HMR) together.
# Each runs in its own PowerShell window so logs stay readable; closing either
# window stops just that service. Ctrl+C in a window stops only that service.
#
# Usage (from repo root):
#   .\dev.ps1
#
# Requires: backend\venv to be set up, and `npm install` to have been run
# in frontend\.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$backendCmd = @"
Set-Location '$root\backend'
if (Test-Path '.\venv\Scripts\Activate.ps1') { . '.\venv\Scripts\Activate.ps1' }
Write-Host '── backend: uvicorn --reload on http://localhost:8000 ──' -ForegroundColor Cyan
uvicorn main:app --reload --host 0.0.0.0 --port 8000 ``
  --reload-dir . ``
  --reload-exclude 'venv/*' ``
  --reload-exclude '__pycache__/*' ``
  --reload-exclude '*.pyc' ``
  --reload-exclude 'tests/*'
"@

$frontendCmd = @"
Set-Location '$root\frontend'
Write-Host '── frontend: vite HMR ──' -ForegroundColor Magenta
npm run dev
"@

Start-Process powershell -ArgumentList '-NoExit', '-Command', $backendCmd
Start-Process powershell -ArgumentList '-NoExit', '-Command', $frontendCmd

Write-Host ''
Write-Host 'Launched backend and frontend in separate windows.' -ForegroundColor Green
Write-Host '  Backend:  http://localhost:8000  (auto-reloads on .py changes)'
Write-Host '  Frontend: http://localhost:5173  (HMR on .jsx/.js/.css changes)'
