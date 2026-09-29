@echo off
REM Development helper: stops the running Task Manager, backs up your data,
REM gets the latest code from GitHub, installs dependencies and restarts it.
REM Uses "git pull" if this folder is a Git clone and Git is installed;
REM otherwise downloads the latest ZIP from GitHub (no Git needed).
REM Your data, logs, backups and .env are never touched by the update.
setlocal EnableExtensions

REM ---- settings ---------------------------------------------------------
set "REPO=JacobMurphy-sys/TaskManagement"
REM Branch for the ZIP download. Blank = the repository's default branch.
set "BRANCH="
REM -----------------------------------------------------------------------

REM This file may itself be replaced by the update, and cmd reads batch files
REM as it goes, so run the rest from a temporary copy.
if /i "%~1"=="--run" goto :main
copy /y "%~f0" "%TEMP%\taskmgr-update.bat" >nul
"%TEMP%\taskmgr-update.bat" --run "%~dp0"

:main
title Task Manager - update
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

echo.
echo [1/5] Stopping any running Task Manager on port %PORT%...
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
echo [3/5] Getting the latest version from GitHub...
if not exist ".git\" goto :zip
where git >nul 2>&1
if errorlevel 1 goto :zip
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
goto :install

:zip
echo       Downloading https://github.com/%REPO% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol = 'Tls12';" ^
  "[Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials;" ^
  "$ref = if ($env:BRANCH) { 'refs/heads/' + $env:BRANCH } else { 'HEAD' };" ^
  "$zip = Join-Path $env:TEMP 'taskmgr-update.zip'; $out = Join-Path $env:TEMP 'taskmgr-update';" ^
  "Invoke-WebRequest -UseBasicParsing ('https://github.com/' + $env:REPO + '/archive/' + $ref + '.zip') -OutFile $zip;" ^
  "if (Test-Path $out) { Remove-Item $out -Recurse -Force };" ^
  "Expand-Archive $zip $out;" ^
  "$src = (Get-ChildItem $out -Directory | Select-Object -First 1).FullName;" ^
  "robocopy $src (Get-Location).Path /E /XD data logs backups node_modules .git /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null;" ^
  "if ($LASTEXITCODE -ge 8) { throw 'Copying the new files failed.' };" ^
  "Remove-Item $zip, $out -Recurse -Force; exit 0"
if errorlevel 1 (
  echo       Download failed - see the message above. Restarting the current version.
  set "FAILED=1"
) else (
  echo       Files updated.
)

:install
echo.
echo [4/5] Installing dependencies...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo       WARNING: npm install failed - see the message above.
  set "FAILED=1"
)

echo.
echo [5/5] Starting the Task Manager...
if exist "start-hidden.vbs" (
  wscript "%CD%\start-hidden.vbs"
) else (
  start "Task Manager" "%CD%\start.bat"
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
