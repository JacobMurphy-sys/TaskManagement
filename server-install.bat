@echo off
REM Makes this computer the CI Manager server: one copy everyone on the network opens in their
REM browser. Run it once, as administrator, on the server, after CIManager-Setup.bat has installed
REM the app here. It:
REM   1. sets the app to answer the network (HOST=0.0.0.0 in .env) and where its data lives;
REM   2. opens its port in Windows Firewall (domain and private networks only);
REM   3. makes a scheduled task, "CI Manager server", that runs server-run.bat at start-up under a
REM      Windows account of your choice (it needs access to the network folders the app reads);
REM   4. writes, in a "for-the-share" folder, cimanager-server.json and the icon: put both next to
REM      CIManager-Setup.bat on the share, and running that setup then just gives people a CI Manager
REM      shortcut to the server instead of installing a copy of their own.
REM Running it again changes the settings; nothing is lost.
setlocal EnableExtensions
cd /d "%~dp0"
set "APP=%CD%"
title CI Manager - server setup

net session >nul 2>&1
if errorlevel 1 (
  echo Run this as administrator: right-click server-install.bat ^> Run as administrator.
  pause
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org first.
  pause
  exit /b 1
)
if not exist "%APP%\src\server.js" (
  echo Run this from the CI Manager's app folder ^(the one with src\server.js^).
  pause
  exit /b 1
)

set "PORT=3000"
set "DATA="
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
  if /i "%%a"=="DATA_DIR" set "DATA=%%~fb"
)
if not defined DATA set "DATA=%ProgramData%\CIManager"

echo.
echo CI Manager - server setup
echo   App:  %APP%
echo.
echo [1/5] Port and data folder
set /p "NEWPORT=      Port [%PORT%]: "
if defined NEWPORT set "PORT=%NEWPORT%"
set /p "NEWDATA=      Data folder, on this computer's own disk [%DATA%]: "
if defined NEWDATA set "DATA=%NEWDATA%"
if not exist "%DATA%\" mkdir "%DATA%"
call :set_env HOST "0.0.0.0"
call :set_env PORT "%PORT%"
call :set_env DATA_DIR "%DATA%"
echo       Set in .env: HOST=0.0.0.0, PORT=%PORT%, DATA_DIR=%DATA%

REM The data of a copy that ran here for one person can be the shared copy's starting point.
if exist "%DATA%\taskmgr.db" goto :data_done
if not exist "%LOCALAPPDATA%\CIManager\taskmgr.db" goto :data_done
echo.
echo       There's a CI Manager database for %USERNAME% on this computer:
echo       %LOCALAPPDATA%\CIManager
choice /c YN /m "      Start the shared copy from it (copied, the original is kept)"
if errorlevel 2 goto :data_done
call :stop_local
robocopy "%LOCALAPPDATA%\CIManager" "%DATA%" /E /XF *.lock /NFL /NDL /NJH /NJS >nul
echo       Copied into %DATA%.
:data_done

echo.
echo [2/5] Windows Firewall: port %PORT% for the company network
netsh advfirewall firewall delete rule name="CI Manager" >nul 2>&1
netsh advfirewall firewall add rule name="CI Manager" dir=in action=allow protocol=TCP localport=%PORT% profile=domain,private >nul
if errorlevel 1 (echo       WARNING: couldn't add the firewall rule.) else (echo       Allowed: TCP %PORT% on domain and private networks.)

echo.
echo [3/5] Starting it with Windows
echo       The account needs read access to the network folders the app reads (KPI workbook and
echo       sources, planning exports, card database, timing reports) and write access to the A3 folder.
set "ACCT=%USERDOMAIN%\%USERNAME%"
set /p "NEWACCT=      Windows account to run it as [%ACCT%]: "
if defined NEWACCT set "ACCT=%NEWACCT%"
echo       Windows asks for that account's password, so it can run when nobody is logged on:
schtasks /Create /TN "CI Manager server" /TR "\"%APP%\server-run.bat\"" /SC ONSTART /DELAY 0001:00 /RU "%ACCT%" /RP * /RL HIGHEST /F
if errorlevel 1 (
  echo       WARNING: couldn't make the scheduled task - see the message above.
  set "FAILED=1"
)

echo.
echo [4/5] For the share
set "URL=http://%COMPUTERNAME%:%PORT%"
set /p "NEWURL=      Address people will open [%URL%]: "
if defined NEWURL set "URL=%NEWURL%"
if not exist "%APP%\for-the-share\" mkdir "%APP%\for-the-share"
> "%APP%\for-the-share\cimanager-server.json" echo {"url": "%URL%"}
copy /y "%APP%\assets\cimanager.ico" "%APP%\for-the-share\cimanager.ico" >nul
echo       Wrote %APP%\for-the-share: cimanager-server.json and cimanager.ico.
echo       Copy both next to CIManager-Setup.bat on the share.

echo.
echo [5/5] Starting it now
call :stop_local
schtasks /Run /TN "CI Manager server" >nul 2>&1
if errorlevel 1 (echo       Couldn't start the task - restart the computer, or start "CI Manager server" in Task Scheduler.) else (echo       Started. Give it a few seconds, then open %URL%)

echo.
if defined FAILED (echo Finished with problems - read the messages above.) else (echo Done. Everyone can now open %URL%)
echo Logs: %DATA%\logs (the app) and %APP%\logs\server-run.log (starts, stops and updates).
pause
exit /b 0

:stop_local
REM A copy running here for one person (it holds the database): stopped first.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul || exit /b 0
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
