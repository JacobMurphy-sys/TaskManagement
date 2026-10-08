@echo off
REM CI Planner: Planning on its own, for a server several people use from their browsers.
REM It keeps its own database (%%LOCALAPPDATA%%\CIPlanner\planner.db, or PLANNER_DATA_DIR) and
REM listens on port 3100 for the whole network (PLANNER_PORT / PLANNER_HOST to change).
REM Everyone then opens http://THIS-COMPUTER-NAME:3100 - nobody else needs to install anything.
REM Keep the database on this computers own disk, not a shared drive: only one copy may run on it,
REM and a second one started on the same database stops and says who has it open.
cd /d "%~dp0"
set "APP=planner"
if not defined PLANNER_HOST set "PLANNER_HOST=0.0.0.0"
if not defined PLANNER_PORT set "PLANNER_PORT=3100"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-save
)
echo CI Planner - others open http://%COMPUTERNAME%:%PLANNER_PORT%
start "" http://localhost:%PLANNER_PORT%
node src/server.js
pause
