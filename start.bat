@echo off
REM DarkFleet one-click start (Windows).
REM Brings up the API + web stack with Docker Compose and opens the app.
REM Double-click this file, or run it from a terminal.
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo [DarkFleet] Docker was not found. Install Docker Desktop and retry.
  pause
  exit /b 1
)

REM 8080 is the default web port; fall back to 8099 when something owns it.
set "WEB_PORT=8080"
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 set "WEB_PORT=8099"
set "DARKFLEET_WEB_PORT=%WEB_PORT%"

echo [DarkFleet] Starting API + web ^(web on port %WEB_PORT%^)...
docker compose up -d --build
if errorlevel 1 (
  echo [DarkFleet] 'docker compose up' failed. Is Docker Desktop running?
  pause
  exit /b 1
)

echo [DarkFleet] Waiting for the API to report healthy...
powershell -NoProfile -Command "$t=0; while ($t -lt 150) { try { if ((Invoke-RestMethod http://127.0.0.1:8000/health -TimeoutSec 3).status -eq 'ok') { exit 0 } } catch {}; Start-Sleep -Seconds 2; $t+=2 }; exit 1"
if errorlevel 1 (
  echo [DarkFleet] API did not become healthy in time. Run 'docker compose logs api' to inspect.
  pause
  exit /b 1
)

echo [DarkFleet] Up. API docs at http://localhost:8000/docs
start "" "http://localhost:%WEB_PORT%/"
