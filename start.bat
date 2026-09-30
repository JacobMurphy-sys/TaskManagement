@echo off
REM Double-click to start the CI Manager, then open http://localhost:3000
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
start "" http://localhost:3000
node src/server.js
pause
