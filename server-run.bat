@echo off
REM Runs the CI Manager as the shared server - started by the "CI Manager server" scheduled task
REM that server-install.bat makes (at start-up, whether anyone is logged on or not).
REM - Before starting, and whenever the app asks (it checks each night, at UPDATE_HOUR, default 3,
REM   when nobody has it open), it updates to the newest version: data backed up first, then
REM   git pull and npm install. AUTO_UPDATE=0 in .env turns that off.
REM - If the app stops unexpectedly it's started again after 15 seconds; stopped on purpose
REM   (Stop server, on the server itself) it stays stopped.
REM What happens is written to logs\server-run.log in this folder.
setlocal EnableExtensions
REM An update can replace this file, and cmd reads batch files as it goes: run from a copy.
if /i "%~1"=="--run" goto :main
copy /y "%~f0" "%TEMP%\cimanager-server-run.bat" >nul
"%TEMP%\cimanager-server-run.bat" --run "%~dp0"
exit /b %errorlevel%

:main
cd /d "%~2"
if not exist "logs\" mkdir "logs"
set "LOG=%CD%\logs\server-run.log"
set "CIM_SERVER=1"
call :log "Server runner started"

:loop
node scripts\check-update.js
if errorlevel 10 call :update
call :log "Starting the CI Manager"
node src\server.js
set "CODE=%errorlevel%"
if "%CODE%"=="0" (
  call :log "Stopped on purpose - not restarting"
  exit /b 0
)
if "%CODE%"=="75" (
  call :log "Stopped to install an update"
  goto :loop
)
call :log "Stopped unexpectedly (exit code %CODE%) - starting again in 15 seconds"
timeout /t 15 /nobreak >nul
goto :loop

:update
call :log "A newer version is available - updating"
node scripts\backup.js >>"%LOG%" 2>&1
git checkout -- package-lock.json >nul 2>&1
git pull --ff-only >>"%LOG%" 2>&1
if errorlevel 1 (
  call :log "git pull failed - keeping the current version"
  exit /b 0
)
call npm install --no-save --no-audit --no-fund --loglevel=error >>"%LOG%" 2>&1
call :log "Updated"
exit /b 0

:log
>>"%LOG%" echo %DATE% %TIME% %~1
exit /b 0
