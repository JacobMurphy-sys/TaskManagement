@echo off
REM CI Manager - one-stop install and update.
REM
REM Put this file in the folder you want the CI Manager in (e.g. C:\CIManager) and
REM double-click it. Needs Node.js 22.13+ and Git. It:
REM   1. checks Node.js and Git;
REM   2. first run: downloads the code from GitHub into the "app" folder next to this file;
REM      later runs: stops the app, backs up your data and pulls the latest version;
REM   3. installs the dependencies;
REM   4. refreshes itself, makes a "CI Manager" shortcut with the CI Manager icon next to this
REM      file (and on the desktop), and writes "READ ME - where things are" (.txt for Notepad,
REM      .md for Obsidian);
REM   5. starts the app (and, on the first install, asks whether to start it at log-in).
REM Updating happens by itself: each time the CI Manager shortcut starts the app, it checks
REM GitHub and, if there's a newer version, runs this file to update first. Run it by hand to
REM update straight away. Your data is kept outside the app folder
REM (%LOCALAPPDATA%\CIManager), so installing or updating never touches it.
REM
REM Shared on the network: double-clicked from a network folder it installs into
REM %USERPROFILE%\CIManager on this computer. A cimanager-defaults.json next to it (exported on
REM KPIs, Sources, Shared paths) gives every install the same network file paths, read again
REM each time the app starts; a planning-setup*.json there (Planning, Setup, Export setup + history)
REM gives a new install the planning setup and everyone the history so far.
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
set "SRCDIR=%BASEDIR%"
set "INPLACE="
set "FAILED="
set "FRESH="
REM Run from a network folder (\\server\share or a mapped drive): install on this computer instead.
set "REMOTE="
if "%BASEDIR:~0,2%"=="\\" set "REMOTE=1"
if not defined REMOTE if "%BASEDIR:~1,1%"==":" (
  net use %BASEDIR:~0,2% >nul 2>&1
  if not errorlevel 1 set "REMOTE=1"
)
if defined REMOTE set "BASEDIR=%USERPROFILE%\CIManager"
if not exist "%BASEDIR%\" mkdir "%BASEDIR%"
set "LOCALSELF=%BASEDIR%\CIManager-Setup.bat"
if not defined REMOTE set "LOCALSELF=%SELF%"
REM The network file paths everyone uses, if they're handed out next to this file.
REM A mapped drive letter can differ between people, so keep its \\server\share name.
set "SHAREDDEF="
set "SRCUNC=%SRCDIR%"
if defined REMOTE if not "%SRCDIR:~0,2%"=="\\" for /f "delims=" %%r in ('powershell -NoProfile -Command "(Get-PSDrive %SRCDIR:~0,1%).DisplayRoot"') do set "SRCUNC=%%r%SRCDIR:~2%"
if exist "%SRCDIR%\cimanager-defaults.json" set "SHAREDDEF=%SRCUNC%\cimanager-defaults.json"
REM A planning setup (and history) exported from Planning, and a team pack (contacts, project
REM categories) from Settings, handed out next to this file too.
set "SHAREDDIR="
if exist "%SRCDIR%\planning-setup*.json" set "SHAREDDIR=%SRCUNC%"
if exist "%SRCDIR%\cimanager-team*.json" set "SHAREDDIR=%SRCUNC%"
if defined SHAREDDEF set "SHAREDDIR=%SRCUNC%"
REM The shared server: a cimanager-server.json next to this file ({"url": "http://server:3000"},
REM written by server-install.bat) means everyone uses the one copy on the server - this then just
REM gives a CI Manager shortcut to it instead of installing a copy here.
if defined REMOTE if exist "%SRCDIR%\cimanager-server.json" goto :client
if not defined REMOTE if exist "%BASEDIR%\package.json" if exist "%BASEDIR%\.git\" set "INPLACE=1"
if defined INPLACE (set "APP=%BASEDIR%") else (set "APP=%BASEDIR%\app")

echo.
echo CI Manager setup
if defined REMOTE echo   Run from the network - installing on this computer.
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
if defined SHAREDDEF call :set_defaults_file
if defined SHAREDDIR call :set_env SHARED_DIR "%SHAREDDIR%"
if defined SHAREDDIR if exist "%SRCDIR%\planning-setup*.json" echo       Planning setup and history: applied by the app from %SHAREDDIR%
if defined SHAREDDIR if exist "%SRCDIR%\cimanager-team*.json" echo       Team pack (contacts, project categories): added by the app from %SHAREDDIR%
REM The newest copy of this file comes with the code - keep the one in this folder up to date
REM (not the one on the network: that stays as it was handed out).
if not defined INPLACE if exist "%APP%\CIManager-Setup.bat" copy /y "%APP%\CIManager-Setup.bat" "%LOCALSELF%" >nul
REM First install: ask whether it should start by itself at log-in (a CI Manager shortcut in
REM the Windows Startup folder; updates keep it up to date, and deleting it turns it off).
set "MKSTART=$false"
if not defined FRESH goto :startup_asked
echo.
choice /c YN /m "      Start the CI Manager automatically when you log in to Windows"
if not errorlevel 2 set "MKSTART=$true"
:startup_asked
call :make_shortcuts

:readme
echo.
echo [5/6] Writing READ ME - where things are (.txt and .md)...
call :write_readme

echo.
echo [6/6] Starting the CI Manager...
REM Tell the launcher not to check for updates again: this run just did.
set "CIM_NOUPDATE=1"
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
  echo Installed in %BASEDIR%.
  echo Next time, start it from the CI Manager shortcut on the desktop.
  echo It updates itself when it starts, whenever there's a newer version. "READ ME - where things are" (.txt or .md) there says what is kept where.
  pause
) else (
  echo Up to date.
  timeout /t 5
)
exit /b 0

REM ---- problems ------------------------------------------------------------

:client
set "SERVERURL="
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "(Get-Content -Raw '%SRCDIR%\cimanager-server.json' | ConvertFrom-Json).url"`) do set "SERVERURL=%%u"
if not defined SERVERURL (
  echo cimanager-server.json next to this file has no "url" in it.
  pause
  exit /b 1
)
echo.
echo CI Manager - the shared copy
echo   Everyone uses the one CI Manager at %SERVERURL%
echo   Nothing is installed on this computer: you get a CI Manager shortcut that opens it.
if exist "%SRCDIR%\cimanager.ico" copy /y "%SRCDIR%\cimanager.ico" "%BASEDIR%\cimanager.ico" >nul
REM Opened in its own window (Edge's app mode) when Edge is there, else in the usual browser.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $u='%SERVERURL%'; $ico='%BASEDIR%\cimanager.ico'; $e=@(${env:ProgramFiles(x86)}+'\Microsoft\Edge\Application\msedge.exe', $env:ProgramFiles+'\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1; function L($p){ $s=$w.CreateShortcut($p); if ($e) { $s.TargetPath=$e; $s.Arguments='--app='+$u } else { $s.TargetPath=$env:SystemRoot+'\explorer.exe'; $s.Arguments=$u }; if (Test-Path $ico) { $s.IconLocation=$ico+',0' }; $s.Description='Open the CI Manager'; $s.Save() }; L ([Environment]::GetFolderPath('Desktop')+'\CI Manager.lnk'); L ('%BASEDIR%'+'\CI Manager.lnk')" >nul 2>&1
if errorlevel 1 (
  echo   Couldn't make the shortcut - open %SERVERURL% in your browser and add it to your favourites.
) else (
  echo   Shortcut: CI Manager, on the desktop. To pin it: right-click it ^> Pin to taskbar.
)
REM A copy of its own from before: no longer started at log-in. Its data stays where it is.
set "OLDSTART=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CI Manager.lnk"
if exist "%OLDSTART%" (
  del "%OLDSTART%" >nul 2>&1
  echo   Your own copy no longer starts when you log in. Its data is kept in %LOCALAPPDATA%\CIManager.
)
if exist "%BASEDIR%\app\" echo   Your own copy is still in %BASEDIR%\app - stop it from its ... menu ^> Stop server; it isn't needed any more.
start "" "%SERVERURL%"
echo.
pause
exit /b 0

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
REM PORT, DATA_DIR and DEFAULTS_FILE from app\.env (optional), else the defaults.
set "PORT=3000"
set "DATA=%LOCALAPPDATA%\CIManager"
set "SHAREDNOW="
if not exist "%APP%\.env" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%APP%\.env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
  if /i "%%a"=="DATA_DIR" set "DATA=%%~fb"
  if /i "%%a"=="DEFAULTS_FILE" set "SHAREDNOW=%%~b"
)
exit /b 0

:set_defaults_file
REM Point the app at the shared paths file (DEFAULTS_FILE in app\.env); it reads it each time it starts.
call :set_env DEFAULTS_FILE "%SHAREDDEF%"
set "SHAREDNOW=%SHAREDDEF%"
echo       Shared paths: %SHAREDDEF%
exit /b 0

:set_env
REM Sets KEY=value in app\.env (replacing a line for it that's there): call :set_env KEY "value"
type nul > "%TEMP%\cimanager-env.tmp"
if exist "%APP%\.env" findstr /v /b /i /c:"%~1=" "%APP%\.env" > "%TEMP%\cimanager-env.tmp"
>>"%TEMP%\cimanager-env.tmp" echo %~1=%~2
copy /y "%TEMP%\cimanager-env.tmp" "%APP%\.env" >nul
exit /b 0

:make_shortcuts
REM A .bat file can't have an icon of its own, so the app is started from a "CI Manager" shortcut
REM with the CI Manager icon (app\assets): in this folder, and on the desktop (on the first
REM install, or refreshed if it's still there). Starting it also updates it when there's a
REM newer version, and it's stopped from inside the app, so that's the only one needed.
REM It runs start-hidden.vbs through wscript.exe so Windows offers "Pin to taskbar" for it
REM (it won't for a shortcut straight to a script).
set "MKDESK=$false"
if defined FRESH set "MKDESK=$true"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $a='%APP%'; $q=[char]34; function L($p){$s=$w.CreateShortcut($p); $s.TargetPath=$env:SystemRoot+'\System32\wscript.exe'; $s.Arguments=$q+$a+'\start-hidden.vbs'+$q; $s.WorkingDirectory=$a; $s.IconLocation=$a+'\assets\cimanager.ico,0'; $s.Description='Start the CI Manager'; $s.Save()}; L ('%BASEDIR%'+'\CI Manager.lnk'); $d=[Environment]::GetFolderPath('Desktop')+'\CI Manager.lnk'; if (%MKDESK% -or (Test-Path $d)) { L $d }; $st=[Environment]::GetFolderPath('Startup')+'\CI Manager.lnk'; if (%MKSTART% -or (Test-Path $st)) { L $st }" >nul 2>&1
if errorlevel 1 goto :bat_launchers
echo       Shortcut: CI Manager
if "%MKDESK%"=="$true" echo       Desktop shortcut: CI Manager
if "%MKSTART%"=="$true" echo       Starts when you log in: yes ^(the CI Manager shortcut in shell:startup^)
REM Shortcuts an earlier version made, no longer needed.
if exist "%BASEDIR%\Update CI Manager.lnk" del "%BASEDIR%\Update CI Manager.lnk"
if exist "%BASEDIR%\Stop CI Manager.lnk" del "%BASEDIR%\Stop CI Manager.lnk"
REM Launchers from before the shortcuts are kept up to date only if they're still there
REM (something, e.g. a start-up shortcut, may point at them).
if exist "%BASEDIR%\Start CI Manager.bat" goto :bat_launchers_write
exit /b 0
:bat_launchers
echo       Couldn't make the shortcuts - writing Start CI Manager.bat and Stop CI Manager.bat instead.
:bat_launchers_write
if defined INPLACE exit /b 0
> "%BASEDIR%\Start CI Manager.bat" echo @echo off
>>"%BASEDIR%\Start CI Manager.bat" echo REM Starts the CI Manager in the background and opens it in the browser.
>>"%BASEDIR%\Start CI Manager.bat" echo wscript "%%~dp0app\start-hidden.vbs"
> "%BASEDIR%\Stop CI Manager.bat" echo @echo off
>>"%BASEDIR%\Stop CI Manager.bat" echo REM Stops the CI Manager running in the background.
>>"%BASEDIR%\Stop CI Manager.bat" echo wscript "%%~dp0app\stop-server.vbs"
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
REM Notepad (.txt) and Obsidian (.md) versions, with this computer's paths.
set "WTA="
if defined INPLACE set "WTA=--inplace"
if not exist "%APP%\scripts\where-things-are.js" exit /b 0
node "%APP%\scripts\where-things-are.js" "%BASEDIR%" %WTA%
if errorlevel 1 echo       WARNING: couldn't write the read-me.
exit /b 0
