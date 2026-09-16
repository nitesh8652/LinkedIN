@echo off
cd /d C:\Users\Admin\Desktop\linkedInAuto
set HOST=0.0.0.0
set WIFI_HOST=10.0.0.10
set PORT=3001
set ALLOW_LINKEDIN_REMOTE=1
echo Starting AI Company Research Agent on %WIFI_HOST%:%PORT% (binding %HOST%:%PORT%) ...
echo Accessible on same WiFi at http://%WIFI_HOST%:%PORT%
echo Also: http://localhost:%PORT%

echo Starting local SearXNG (Docker) on http://localhost:8080 ...
docker compose up -d searxng
if errorlevel 1 echo   SearXNG did not start (Docker not running?). Serper still works; SearXNG "Test connection" will fail until it is up.

node server.js
