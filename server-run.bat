@echo off
REM Runs SITHUB as the shared server - started by the "SITHUB server" scheduled task
REM that server-install.bat makes (at start-up, whether anyone is logged on or not).
REM - Before starting, and whenever the app asks (it checks each night, at UPDATE_HOUR, default 3,
REM   when nobody has it open), it updates to the newest version: data backed up first, then
REM   git pull and npm install - or, installed from a bundle (an offline server: BUILD.json and
REM   runtime\node.exe here, no Git or Node.js installed), the newest bundle from UPDATE_FROM (the
REM   Gitea repository, or a folder) unpacked and copied over the app (.env, logs and data kept).
REM   AUTO_UPDATE=0 in .env turns that off.
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
REM the bundle's own Node.js, when there is one (an offline server); else the one installed
set "NODE=node"
if exist "runtime\node.exe" set "NODE=%CD%\runtime\node.exe"
REM trust the certificates Windows trusts, for the update check (Gitea's HTTPS may use the company's own)
"%NODE%" --use-system-ca -e "" >nul 2>&1 && set "NODE_OPTIONS=%NODE_OPTIONS% --use-system-ca"
call :log "Server runner started"

:loop
"%NODE%" scripts\check-update.js
if errorlevel 10 call :update
call :log "Starting SITHUB"
"%NODE%" src\server.js
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
"%NODE%" scripts\backup.js >>"%LOG%" 2>&1
if exist "BUILD.json" goto :update_bundle
git checkout -- package-lock.json >nul 2>&1
git pull --ff-only >>"%LOG%" 2>&1
if errorlevel 1 (
  call :log "git pull failed - keeping the current version"
  exit /b 0
)
call npm install --no-save --no-audit --no-fund --loglevel=error >>"%LOG%" 2>&1
call :log "Updated"
exit /b 0

REM ---- a bundle install: the newest bundle, unpacked next to the app, then copied over it ----------
:update_bundle
set "STAGE=%CD%\..\SITHUB-update"
"%NODE%" scripts\bundle.js fetch --to "%STAGE%" >>"%LOG%" 2>&1
if errorlevel 1 (
  call :log "Couldn't get the new bundle - keeping the current version"
  exit /b 0
)
REM (the app is stopped and node.exe isn't running: everything can be replaced; what's local stays - the folders
REM  kept are named by their full path, as a bare name would also skip e.g. node_modules\pdfkit\js\data)
robocopy "%STAGE%" "%CD%" /MIR /R:2 /W:2 /NFL /NDL /NJH /NP /XD "%CD%\logs" "%CD%\data" "%CD%\backups" "%CD%\for-the-share" "%STAGE%\logs" "%STAGE%\data" /XF .env cimanager-defaults.json "READ ME - where things are.txt" "READ ME - where things are.md" *.lnk >>"%LOG%" 2>&1
if errorlevel 8 (
  call :log "Copying the new version failed - see above; check the app folder"
  exit /b 0
)
rmdir /s /q "%STAGE%" >nul 2>&1
call :log "Updated (bundle)"
if exist "runtime\node.exe" set "NODE=%CD%\runtime\node.exe"
exit /b 0

:log
>>"%LOG%" echo %DATE% %TIME% %~1
exit /b 0
