@echo off
REM Development helper: stops the running CI Manager, backs up your data,
REM runs "git pull" in this folder (the same as AutoPull.bat), installs any
REM new dependencies and restarts the app.
REM Your data lives in %LOCALAPPDATA%\CIManager, outside this folder, so the pull never touches it.
setlocal EnableExtensions

REM This file may itself be replaced by the update, and cmd reads batch files
REM as it goes, so run the rest from a temporary copy.
if /i "%~1"=="--run" goto :main
copy /y "%~f0" "%TEMP%\taskmgr-update.bat" >nul
"%TEMP%\taskmgr-update.bat" --run "%~dp0"

:main
title CI Manager - update
cd /d "%~2"
set "FAILED="
set "PORT=3000"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set "PORT=%%b"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
where git >nul 2>&1
if errorlevel 1 (
  echo Git was not found on PATH.
  pause
  exit /b 1
)
if not exist ".git\" (
  echo %CD% is not a Git clone - run update.bat from your TaskManagement repo folder.
  pause
  exit /b 1
)

echo.
echo [1/5] Stopping any running CI Manager on port %PORT%...
call :is_listening
if errorlevel 1 (
  echo       Not running.
  goto :backup
)
curl -s -m 5 -X POST -H "X-Requested-With: TaskManager" http://127.0.0.1:%PORT%/api/shutdown >nul 2>&1
for /l %%i in (1,1,10) do (
  call :is_listening
  if errorlevel 1 goto :stopped
  timeout /t 1 /nobreak >nul
)
REM Didn't shut down politely (e.g. an older version) - end the node.exe on the port.
call :kill_port
timeout /t 1 /nobreak >nul
call :is_listening
if errorlevel 1 goto :stopped
echo       Port %PORT% is still in use by another program. Close it and run this again.
pause
exit /b 1
:stopped
echo       Stopped.

:backup
echo.
echo [2/5] Backing up your data...
node scripts\backup.js >nul 2>&1
if errorlevel 1 (echo       WARNING: backup failed - continuing anyway.) else (echo       Done ^(see the backups folder^).)

echo.
echo [3/5] Pulling the latest version from GitHub...
for /f %%r in ('git rev-parse HEAD') do set "OLDREV=%%r"
git pull --ff-only
if errorlevel 1 (
  echo.
  echo       git pull failed - see the message above. Restarting the current version.
  set "FAILED=1"
  goto :install
)
echo       Changes:
git --no-pager log --oneline %OLDREV%..HEAD

:install
echo.
echo [4/5] Installing dependencies...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo       WARNING: npm install failed - see the message above.
  set "FAILED=1"
)

echo.
echo [5/5] Starting the CI Manager...
if exist "start-hidden.vbs" (
  wscript "%CD%\start-hidden.vbs"
) else (
  start "CI Manager" "%CD%\start.bat"
)

echo.
if defined FAILED (
  echo Finished with problems - read the messages above.
  pause
) else (
  echo Update complete.
  timeout /t 5
)
exit /b 0

REM ---- helpers ----------------------------------------------------------

:is_listening
REM errorlevel 0 if something is listening on PORT.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
exit /b %errorlevel%

:kill_port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  tasklist /fi "PID eq %%p" /nh | find /i "node.exe" >nul && taskkill /pid %%p /f >nul && echo       Force-stopped node.exe ^(PID %%p^).
)
exit /b 0
