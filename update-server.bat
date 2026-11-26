@echo off
REM Updates the office server (a bundle install: runtime\node.exe and BUILD.json here, no Git or Node.js
REM installed) by hand, from Gitea - the server's own copy of update.bat. Run it on the server, as
REM administrator. The nightly update and the Server panel's "Restart (and update)" do the same by
REM themselves; this is for doing it now, and seeing each step.
REM   1. asks Gitea (UPDATE_FROM and UPDATE_TOKEN in .env) for the newest bundle - says why if it can't;
REM   2. downloads and unpacks it next to the app (..\SITHUB-update), while SITHUB keeps running;
REM   3. stops the "SITHUB server" task and SITHUB;
REM   4. backs up the data;
REM   5. copies the new version over the app (.env, logs, data and backups kept) and starts the task again.
REM update-server.bat --force installs the newest bundle even if it's the one installed already.
setlocal EnableExtensions
REM This file is replaced by the update, and cmd reads batch files as it goes: run from a copy.
if /i "%~1"=="--run" goto :main
copy /y "%~f0" "%TEMP%\sithub-update-server.bat" >nul
"%TEMP%\sithub-update-server.bat" --run "%~dp0" %1
exit /b %errorlevel%

:main
cd /d "%~2"
set "FORCE="
if /i "%~3"=="--force" set "FORCE=1"
title SITHUB - update the server from Gitea
net session >nul 2>&1
if errorlevel 1 (
  echo Run this as administrator: right-click update-server.bat ^> Run as administrator.
  pause
  exit /b 1
)
if not exist "BUILD.json" goto :not_bundle
if not exist "runtime\node.exe" goto :not_bundle
set "NODE=%CD%\runtime\node.exe"
REM trust the certificates Windows trusts (e.g. the company's own, which Gitea's HTTPS may use)
"%NODE%" --use-system-ca -e "" >nul 2>&1 && set "NODE_OPTIONS=%NODE_OPTIONS% --use-system-ca"
set "PORT=3000"
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set "PORT=%%b"
set "STAGE=%CD%\..\SITHUB-update"
set "LOG=%CD%\logs\server-run.log"
if not exist "logs\" mkdir "logs"

echo.
echo [1/5] What's installed, and what's on Gitea
"%NODE%" scripts\bundle.js status
set "ST=%errorlevel%"
if "%ST%"=="10" goto :fetch
if "%ST%"=="0" if defined FORCE goto :fetch
if "%ST%"=="0" (
  echo.
  echo       Already up to date - nothing to do. ^(update-server.bat --force installs it again.^)
  pause
  exit /b 0
)
echo.
echo       Couldn't tell - see the message above. Nothing was changed.
pause
exit /b 1

:fetch
echo.
echo [2/5] Downloading and unpacking it, while SITHUB keeps running
"%NODE%" scripts\bundle.js fetch --to "%STAGE%"
if errorlevel 1 (
  echo       The download failed - see the message above. Nothing was changed.
  pause
  exit /b 1
)

echo.
echo [3/5] Stopping SITHUB
>>"%LOG%" echo %date% %time% Update by hand ^(update-server.bat^) - stopping
schtasks /End /TN "SITHUB server" >nul 2>&1
REM the runner's loop (a copy of server-run.bat) would start it again: ended first, then SITHUB itself
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*cimanager-server-run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
timeout /t 3 /nobreak >nul
echo       Stopped.

echo.
echo [4/5] Backing up the data
"%NODE%" scripts\backup.js
if errorlevel 1 (echo       WARNING: the backup failed - continuing anyway.) else (echo       Done.)

echo.
echo [5/5] Copying the new version over the app, and starting it
REM (what's local stays - the folders kept are named by their full path, as a bare name would also skip
REM  e.g. node_modules\pdfkit\js\data)
robocopy "%STAGE%" "%CD%" /MIR /R:2 /W:2 /NFL /NDL /NJH /NP /XD "%CD%\logs" "%CD%\data" "%CD%\backups" "%CD%\for-the-share" "%STAGE%\logs" "%STAGE%\data" /XF .env cimanager-defaults.json "READ ME - where things are.txt" "READ ME - where things are.md" *.lnk >nul
if errorlevel 8 (
  echo       Copying the new version failed - check the app folder. Starting what's there.
  set "FAILED=1"
) else (
  rmdir /s /q "%STAGE%" >nul 2>&1
  echo       Copied.
)
>>"%LOG%" echo %date% %time% Update by hand done - starting the task
schtasks /Run /TN "SITHUB server" >nul 2>&1
if errorlevel 1 (echo       Couldn't start the task - start "SITHUB server" in Task Scheduler, or restart the PC.) else (echo       Started - give it a minute.)
echo.
if defined FAILED (echo Finished with problems - read the messages above.) else (echo Update complete.)
"%NODE%" -e "try{const b=require('./BUILD.json');console.log('Now on '+b.short+' ('+String(b.date).slice(0,10)+')')}catch{}"
pause
exit /b 0

:not_bundle
echo This isn't a bundle install (no BUILD.json and runtime\node.exe here). A copy with Git updates with
echo update.bat, from where it was cloned (git remote set-url origin ^<the Gitea address^> to point it at Gitea).
pause
exit /b 1
