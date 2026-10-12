@echo off
REM CI Manager - one-stop install and update.
REM
REM Put this file in the folder you want the CI Manager in (e.g. C:\CIManager) and
REM double-click it. Needs Node.js 22.13+ and Git. It:
REM   1. checks Node.js and Git;
REM   2. first run: downloads the code from GitHub into the "app" folder next to this file;
REM      later runs: stops the app, backs up your data and pulls the latest version;
REM   3. installs the dependencies;
REM   4. refreshes itself and writes "Start CI Manager.bat", "Stop CI Manager.bat"
REM      and "READ ME - where things are.txt" next to this file;
REM   5. starts the app.
REM Run it again any time to update. Your data is kept outside the app folder
REM (%LOCALAPPDATA%\CIManager), so installing or updating never touches it.
REM
REM Run from inside a clone of the repository it updates that clone in place instead.
setlocal EnableExtensions

set "REPO=https://github.com/JacobMurphy-sys/TaskManagement.git"

REM This file can be replaced by the update, and cmd reads batch files as it
REM goes, so run the rest from a temporary copy.
if /i "%~1"=="--run" goto :main
copy /y "%~f0" "%TEMP%\cimanager-setup.bat" >nul
"%TEMP%\cimanager-setup.bat" --run "%~f0"

:main
title CI Manager - setup
set "SELF=%~2"
for %%F in ("%SELF%") do set "BASEDIR=%%~dpF"
set "BASEDIR=%BASEDIR:~0,-1%"
set "INPLACE="
set "FAILED="
set "FRESH="
if exist "%BASEDIR%\package.json" if exist "%BASEDIR%\.git\" set "INPLACE=1"
if defined INPLACE (set "APP=%BASEDIR%") else (set "APP=%BASEDIR%\app")

echo.
echo CI Manager setup
echo   Folder: %BASEDIR%
echo   Code:   %APP%

echo.
echo [1/6] Checking Node.js and Git...
where node >nul 2>&1
if errorlevel 1 goto :no_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto :old_node
where git >nul 2>&1
if errorlevel 1 goto :no_git
for /f "delims=" %%v in ('node -v') do echo       Node.js %%v
for /f "tokens=3" %%v in ('git --version') do echo       Git %%v

echo.
if exist "%APP%\.git\" goto :update

REM ---- first run: download the code ---------------------------------------
echo [2/6] Downloading the CI Manager from GitHub...
if exist "%APP%\" (
  dir /b /a "%APP%" | findstr . >nul && goto :app_not_empty
)
git clone "%REPO%" "%APP%"
if errorlevel 1 goto :clone_failed
set "FRESH=1"
cd /d "%APP%"
goto :install

REM ---- later runs: stop, back up, pull -------------------------------------
:update
echo [2/6] Updating the CI Manager...
cd /d "%APP%"
call :read_env
call :is_listening
if errorlevel 1 (
  echo       Not running.
  goto :backup
)
echo       Stopping the running CI Manager on port %PORT%...
curl -s -m 5 -X POST -H "X-Requested-With: TaskManager" http://127.0.0.1:%PORT%/api/shutdown >nul 2>&1
for /l %%i in (1,1,10) do (
  call :is_listening
  if errorlevel 1 goto :backup
  timeout /t 1 /nobreak >nul
)
call :kill_port
timeout /t 1 /nobreak >nul
call :is_listening
if errorlevel 1 goto :backup
echo       Port %PORT% is still in use by another program. Close it and run this again.
pause
exit /b 1

:backup
echo       Backing up your data...
node scripts\backup.js >nul 2>&1
if errorlevel 1 (echo       WARNING: backup failed - continuing anyway.) else (echo       Backup done.)
echo       Pulling the latest version...
rem package-lock.json is rewritten by npm install on this PC - drop that so the pull isn't blocked
git checkout -- package-lock.json >nul 2>&1
for /f %%r in ('git rev-parse HEAD') do set "OLDREV=%%r"
git pull --ff-only
if errorlevel 1 (
  echo       git pull failed - see the message above. Keeping the current version.
  set "FAILED=1"
  goto :install
)
echo       Changes:
git --no-pager log --oneline %OLDREV%..HEAD

:install
echo.
echo [3/6] Installing dependencies...
call npm install --no-save --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo       WARNING: npm install failed - see the message above.
  set "FAILED=1"
)

echo.
echo [4/6] Setting up the folders...
call :read_env
if not exist "%DATA%\" mkdir "%DATA%"
echo       Data:   %DATA%
if defined INPLACE goto :readme
REM The newest copy of this file comes with the code - keep the one in this folder up to date.
if exist "%APP%\CIManager-Setup.bat" copy /y "%APP%\CIManager-Setup.bat" "%SELF%" >nul
> "%BASEDIR%\Start CI Manager.bat" echo @echo off
>>"%BASEDIR%\Start CI Manager.bat" echo REM Starts the CI Manager in the background and opens it in the browser.
>>"%BASEDIR%\Start CI Manager.bat" echo wscript "%%~dp0app\start-hidden.vbs"
> "%BASEDIR%\Stop CI Manager.bat" echo @echo off
>>"%BASEDIR%\Stop CI Manager.bat" echo REM Stops the CI Manager running in the background.
>>"%BASEDIR%\Stop CI Manager.bat" echo wscript "%%~dp0app\stop-server.vbs"
echo       Launchers: Start CI Manager.bat, Stop CI Manager.bat

:readme
echo.
echo [5/6] Writing READ ME - where things are.txt...
call :write_readme

echo.
echo [6/6] Starting the CI Manager...
if exist "%APP%\start-hidden.vbs" (
  wscript "%APP%\start-hidden.vbs"
) else (
  start "CI Manager" "%APP%\start.bat"
)

echo.
if defined FAILED (
  echo Finished with problems - read the messages above.
  pause
  exit /b 1
)
if defined FRESH (
  echo Installed. Next time, start it with "Start CI Manager.bat" and run this file again to update.
  echo See "READ ME - where things are.txt" for what is kept where.
  pause
) else (
  echo Up to date.
  timeout /t 5
)
exit /b 0

REM ---- problems ------------------------------------------------------------

:no_node
echo Node.js was not found. Install it from https://nodejs.org (the LTS version) and run this again.
pause
exit /b 1
:old_node
for /f "delims=" %%v in ('node -v') do echo Node.js %%v is too old - the CI Manager needs 22.13 or newer.
echo Install the current LTS from https://nodejs.org and run this again.
pause
exit /b 1
:no_git
echo Git was not found. Install it from https://git-scm.com and run this again.
pause
exit /b 1
:app_not_empty
echo "%APP%" already exists but is not a copy of the CI Manager from GitHub.
echo Move or rename it, then run this again.
pause
exit /b 1
:clone_failed
echo Downloading from GitHub failed - see the message above.
echo Check you are signed in to GitHub with access to %REPO%.
pause
exit /b 1

REM ---- helpers -------------------------------------------------------------

:read_env
REM PORT and DATA_DIR from app\.env (optional), else the defaults.
set "PORT=3000"
set "DATA=%LOCALAPPDATA%\CIManager"
if not exist "%APP%\.env" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%APP%\.env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
  if /i "%%a"=="DATA_DIR" set "DATA=%%~fb"
)
exit /b 0

:is_listening
REM errorlevel 0 if something is listening on PORT.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
exit /b %errorlevel%

:kill_port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  tasklist /fi "PID eq %%p" /nh | find /i "node.exe" >nul && taskkill /pid %%p /f >nul && echo       Force-stopped node.exe ^(PID %%p^).
)
exit /b 0

:write_readme
set "RM=%BASEDIR%\READ ME - where things are.txt"
set "VER=unknown"
for /f "delims=" %%v in ('git -C "%APP%" log -1 "--format=%%h %%cs"') do set "VER=%%v"
if defined INPLACE (set "LAUNCH=start-hidden.vbs in this folder") else (set "LAUNCH=Start CI Manager.bat")
if defined INPLACE (set "STOP=stop-server.vbs in this folder") else (set "STOP=Stop CI Manager.bat")
if defined INPLACE (set "PLANNERBAT=planner.bat") else (set "PLANNERBAT=app\planner.bat")
> "%RM%" echo CI MANAGER - WHERE THINGS ARE
>>"%RM%" echo =============================
>>"%RM%" echo Written by CIManager-Setup.bat on %DATE% %TIME:~0,5%. Version installed: %VER%.
>>"%RM%" echo This file is rewritten every time the setup runs - don't keep notes in it.
>>"%RM%" echo.
>>"%RM%" echo.
>>"%RM%" echo DAY TO DAY
>>"%RM%" echo ----------
>>"%RM%" echo Start:   double-click %LAUNCH%. It runs in the background and opens
>>"%RM%" echo          http://localhost:%PORT% in your browser. Double-click it again to just open the browser.
>>"%RM%" echo Stop:    the top bar's ... menu, Stop server - or double-click %STOP%.
>>"%RM%" echo Update:  double-click CIManager-Setup.bat again. It stops the app, backs up your data,
>>"%RM%" echo          downloads the latest version, and starts it again.
>>"%RM%" echo At log-in (optional): press Win+R, type shell:startup, and put a shortcut to
>>"%RM%" echo          %LAUNCH% in the folder that opens.
>>"%RM%" echo.
>>"%RM%" echo.
>>"%RM%" echo WHAT IS KEPT WHERE
>>"%RM%" echo ------------------
>>"%RM%" echo %BASEDIR%
if defined INPLACE goto :readme_inplace
>>"%RM%" echo   CIManager-Setup.bat               install and update (refreshes itself on each run)
>>"%RM%" echo   Start CI Manager.bat              start the app
>>"%RM%" echo   Stop CI Manager.bat               stop the app
>>"%RM%" echo   READ ME - where things are.txt    this file
>>"%RM%" echo   app\                              the program, downloaded from GitHub.
>>"%RM%" echo                                     Replaced on every update - don't put your own files in it.
>>"%RM%" echo                                     The only file of yours in it is app\.env (optional settings, below).
goto :readme_data
:readme_inplace
>>"%RM%" echo   This folder is a copy of the program from GitHub (%REPO%).
>>"%RM%" echo   Updates replace its files - don't put your own files in it.
>>"%RM%" echo   The only file of yours in it is .env (optional settings, below).
:readme_data
>>"%RM%" echo.
>>"%RM%" echo %DATA%
>>"%RM%" echo   Your data. Never touched by installing or updating; nothing else needs backing up.
>>"%RM%" echo   taskmgr.db       the database: projects, tasks, meetings, ideas, contacts, KPIs, planning
>>"%RM%" echo                    setup and every setting (including the file paths below)
>>"%RM%" echo   backups\         automatic backups (daily, the last 30 kept), plus one before every update.
>>"%RM%" echo                    backups\db\ has whole-database copies.
>>"%RM%" echo   attachments\     files attached to tasks and meetings
>>"%RM%" echo   logs\            the app's log files - look at the newest one if something goes wrong
>>"%RM%" echo.
>>"%RM%" echo %LOCALAPPDATA%\CIPlanner
>>"%RM%" echo   Only if Planning is run on its own for several people (%PLANNERBAT%):
>>"%RM%" echo   its own database planner.db, backups and logs.
>>"%RM%" echo.
>>"%RM%" echo Your own files stay where they are. The app only reads them, from the paths set in the app:
>>"%RM%" echo   KPIs, Sources:        the CI workbook, the source exports, the forecasts, and the folder
>>"%RM%" echo                         the A3 is saved to
>>"%RM%" echo   Planning, Setup:      the open work orders export, the Otto export and the card database
>>"%RM%" echo   Settings:             the project charter template and the report options
>>"%RM%" echo.
>>"%RM%" echo.
>>"%RM%" echo OPTIONAL SETTINGS
>>"%RM%" echo -----------------
>>"%RM%" echo To change the port, the data folder or the backup schedule, copy .env.example to .env in
>>"%RM%" echo %APP%
>>"%RM%" echo and edit it (PORT, DATA_DIR, BACKUP_INTERVAL_HOURS, BACKUP_KEEP). Restart the app afterwards.
>>"%RM%" echo Keep the data folder on this computer's own disk, not a network drive or a synced folder.
>>"%RM%" echo.
>>"%RM%" echo.
>>"%RM%" echo MOVING TO ANOTHER COMPUTER
>>"%RM%" echo --------------------------
>>"%RM%" echo 1. Stop the app and copy the whole data folder above.
>>"%RM%" echo 2. On the new computer, put CIManager-Setup.bat in a folder and run it.
>>"%RM%" echo 3. Stop the app, replace the new data folder with your copy, and start it again.
>>"%RM%" echo (Planning's own Setup can also be moved on its own: Planning, Setup, Export setup / Import setup.)
>>"%RM%" echo.
>>"%RM%" echo.
>>"%RM%" echo IF SOMETHING GOES WRONG
>>"%RM%" echo -----------------------
>>"%RM%" echo - Nothing opens: run start.bat in the program folder to see the error in a window.
>>"%RM%" echo - An update failed: the messages say why; the version you had keeps working. If you edited
>>"%RM%" echo   a file in the program folder, undo that and run CIManager-Setup.bat again.
>>"%RM%" echo - Data looks wrong after an update: Backups (top bar, ... menu) restores an earlier copy.
>>"%RM%" echo - Full documentation: README.md in the program folder, or %REPO:.git=%
exit /b 0
