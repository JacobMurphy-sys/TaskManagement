@echo off
REM Makes this computer SITHUB server WITHOUT an administrator account (server-install.bat is
REM the full version and needs one). Run it once, as yourself, after CIManager-Setup.bat has
REM installed the app here. The difference: the server runs as YOU, while you're logged on.
REM   1. sets the app to answer the network (HOST=0.0.0.0 in .env) and where its data lives;
REM   2. checks Windows Firewall: opening a port needs an administrator, so if it isn't open it
REM      writes what to ask IT for (for-the-share\ask IT to open the port.txt);
REM   3. starts it when you log in (a "SITHUB server" shortcut in your Startup folder, to
REM      server-start.vbs), in place of your own copy's start-up shortcut;
REM   4. writes, in a "for-the-share" folder, cimanager-server.json and the icon: put both next to
REM      CIManager-Setup.bat on the share, as with server-install.bat;
REM   5. starts it now.
REM Keep this PC logged on (lock it with Win+L, never log off) and set it never to sleep. After a
REM restart (e.g. Windows Update) the server starts again when you log back in.
REM Running it again changes the settings; nothing is lost.
setlocal EnableExtensions
cd /d "%~dp0"
set "APP=%CD%"
title SITHUB - server setup (no administrator)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org first.
  pause
  exit /b 1
)
if not exist "%APP%\src\server.js" (
  echo Run this from SITHUB's app folder ^(the one with src\server.js^).
  pause
  exit /b 1
)

set "PORT=3000"
set "DATA="
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
  if /i "%%a"=="DATA_DIR" set "DATA=%%~fb"
)
if not defined DATA set "DATA=%LOCALAPPDATA%\CIManager"

echo.
echo SITHUB - server setup, no administrator needed
echo   App:  %APP%
echo   Runs as: %USERDOMAIN%\%USERNAME%, while logged on
echo.
echo [1/5] Port and data folder
set /p "NEWPORT=      Port [%PORT%]: "
if defined NEWPORT set "PORT=%NEWPORT%"
set /p "NEWDATA=      Data folder, on this computer's own disk [%DATA%]: "
if defined NEWDATA set "DATA=%NEWDATA%"
if not exist "%DATA%\" mkdir "%DATA%"
if not exist "%DATA%\" (
  echo       Couldn't make %DATA% - pick a folder you can write to.
  pause
  exit /b 1
)
call :set_env HOST "0.0.0.0"
call :set_env PORT "%PORT%"
call :set_env DATA_DIR "%DATA%"
echo       Set in .env: HOST=0.0.0.0, PORT=%PORT%, DATA_DIR=%DATA%
REM Backups on the server: every 2 hours, compressed, kept 30 days (only when .env doesn't say already)
findstr /b /i /c:"BACKUP_KEEP_DAYS=" ".env" >nul 2>&1
if errorlevel 1 (
  call :set_env BACKUP_INTERVAL_HOURS "2"
  call :set_env BACKUP_KEEP_DAYS "30"
  echo       Backups: every 2 hours, compressed, kept 30 days ^(BACKUP_ settings in .env^)
)

REM Your own copy's data can be the shared copy's starting point (if the data folder is elsewhere).
if exist "%DATA%\taskmgr.db" goto :data_done
if not exist "%LOCALAPPDATA%\CIManager\taskmgr.db" goto :data_done
echo.
echo       There's a SITHUB database for %USERNAME% on this computer:
echo       %LOCALAPPDATA%\CIManager
choice /c YN /m "      Start the shared copy from it (copied, the original is kept)"
if errorlevel 2 goto :data_done
call :stop_local
robocopy "%LOCALAPPDATA%\CIManager" "%DATA%" /E /XF *.lock /NFL /NDL /NJH /NJS >nul
echo       Copied into %DATA%.
:data_done

echo.
echo [2/5] Windows Firewall: port %PORT%
if not exist "%APP%\for-the-share\" mkdir "%APP%\for-the-share"
set "ASKIT=%APP%\for-the-share\ask IT to open the port.txt"
netsh advfirewall firewall show rule name="SITHUB" >nul 2>&1
if not errorlevel 1 (
  echo       A "SITHUB" firewall rule is there already.
  if exist "%ASKIT%" del "%ASKIT%" >nul 2>&1
  goto :fw_done
)
> "%ASKIT%" echo Please allow incoming connections to SITHUB on %COMPUTERNAME%, for the company network only.
>>"%ASKIT%" echo It's an internal web page that colleagues open in their browser at http://%COMPUTERNAME%:%PORT%
>>"%ASKIT%" echo.
>>"%ASKIT%" echo In an administrator command prompt on %COMPUTERNAME%:
>>"%ASKIT%" echo   netsh advfirewall firewall add rule name="SITHUB" dir=in action=allow protocol=TCP localport=%PORT% profile=domain,private
>>"%ASKIT%" echo.
>>"%ASKIT%" echo Or the same through group policy: inbound, TCP %PORT%, allow, domain and private profiles.
>>"%ASKIT%" echo Also check there is no inbound Block rule for node.exe (Windows can make one when its
>>"%ASKIT%" echo "allow access" prompt is cancelled): a Block rule wins over the allow rule.
echo       Not open yet: opening a port needs an administrator. Until it is, SITHUB works on this
echo       PC but other PCs can't reach it. Send IT the request written in:
echo       %ASKIT%
echo       If Windows asks whether Node.js may use the network and you can't allow it, close
echo       the message; the rule IT adds is what counts.
:fw_done

echo.
echo [3/5] Starting it when you log in
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%STARTUP%\SITHUB server.lnk'); $s.TargetPath=$env:SystemRoot+'\System32\wscript.exe'; $s.Arguments=[char]34+'%APP%\server-start.vbs'+[char]34; $s.WorkingDirectory='%APP%'; $s.IconLocation='%APP%\assets\cimanager.ico,0'; $s.Description='Start the SITHUB server'; $s.Save()" >nul 2>&1
if errorlevel 1 (
  echo       WARNING: couldn't make the start-up shortcut. Put a shortcut to server-start.vbs in shell:startup.
  set "FAILED=1"
) else (
  echo       "SITHUB server" in your Startup folder: it starts when you log in.
)
REM Your own copy's start-up shortcut would race the server for the port: removed.
for %%n in ("SITHUB.lnk" "CI Manager.lnk") do if exist "%STARTUP%\%%~n" (
  del "%STARTUP%\%%~n" >nul 2>&1
  echo       Removed your own copy's start-up shortcut ^(%%~n^): the server replaces it.
)
echo       Keep this PC logged on ^(lock it with Win+L^) and set it never to sleep.

echo.
echo [4/5] For the share
set "URL=http://%COMPUTERNAME%:%PORT%"
set /p "NEWURL=      Address people will open [%URL%]: "
if defined NEWURL set "URL=%NEWURL%"
> "%APP%\for-the-share\cimanager-server.json" echo {"url": "%URL%"}
copy /y "%APP%\assets\cimanager.ico" "%APP%\for-the-share\cimanager.ico" >nul
echo       Wrote %APP%\for-the-share: cimanager-server.json and cimanager.ico.
echo       Copy both next to CIManager-Setup.bat on the share.

echo.
echo [5/5] Starting it now
call :stop_local
wscript "%APP%\server-start.vbs"
timeout /t 5 /nobreak >nul
curl -s -m 5 http://127.0.0.1:%PORT%/api/health | findstr /c:"taskmanager" >nul 2>&1
if errorlevel 1 (echo       Still starting - give it a few seconds, then open %URL%) else (echo       Running. Open %URL%)

echo.
if defined FAILED (echo Finished with problems - read the messages above.) else (echo Done. Everyone can open %URL% once the port is open.)
echo Logs: %DATA%\logs (the app) and %APP%\logs\server-run.log (starts, stops and updates).
pause
exit /b 0

:stop_local
REM Your own copy of SITHUB running on this port (it holds the database): stopped first.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul || exit /b 0
curl -s -m 5 -X POST -H "X-Requested-With: TaskManager" http://127.0.0.1:%PORT%/api/shutdown >nul 2>&1
for /l %%i in (1,1,10) do (
  netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul || exit /b 0
  timeout /t 1 /nobreak >nul
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
timeout /t 2 /nobreak >nul
exit /b 0

:set_env
REM Sets KEY=value in .env (replacing a line for it that's there): call :set_env KEY "value"
type nul > "%TEMP%\cimanager-env.tmp"
if exist ".env" findstr /v /b /i /c:"%~1=" ".env" > "%TEMP%\cimanager-env.tmp"
>>"%TEMP%\cimanager-env.tmp" echo %~1=%~2
copy /y "%TEMP%\cimanager-env.tmp" ".env" >nul
exit /b 0
