@echo off
REM SITHUB - copy the code from GitHub to the office Gitea, for the server to update from.
REM
REM   GitHub (where the code is worked on)  ->  this machine  ->  Gitea  ->  the office server (git pull, nightly)
REM
REM Put this file anywhere on the machine that does the syncing, with Git installed, and once:
REM   1. make the (empty) repository on Gitea, e.g. http://gitea.office:3000/IT/SITHUB.git;
REM   2. write its address in a file "sithub-gitea.txt" next to this one (one line), or set SITHUB_GITEA;
REM   3. run this file by hand once: Git asks to sign in to GitHub and to Gitea (Git Credential Manager
REM      keeps both; a read-only GitHub token and a Gitea account that may push are enough);
REM   4. run it with --install to have Windows run it every 30 minutes (Task Scheduler,
REM      "SITHUB GitHub to Gitea"), or --install 60 for every hour.
REM
REM Each run: fetches GitHub into a local mirror (%LOCALAPPDATA%\SITHUB-sync), then pushes the
REM branches below (and the tags) to Gitea exactly as they are on GitHub - GitHub is the source,
REM so anything pushed to those branches on Gitea directly is overwritten. Logged to sync.log there.
REM
REM An office server WITH Git and Node.js installs from Gitea: put the Gitea address in "sithub-repo.txt"
REM next to CIManager-Setup.bat before the first install (or, installed already, in its app folder:
REM git remote set-url origin <the Gitea address>).
REM
REM An office server with NO internet, Git or Node.js runs a ready-to-run BUNDLE instead: this machine
REM (with Node.js 22.13+ installed) builds one each time the "server" branch changes (live, main, plus what
REM the office server needs: it takes each release from main) - the app, its dependencies for
REM Windows and its own node.exe - and publishes it as a release on Gitea, for the server to update from.
REM For that, next to this file:
REM   sithub-gitea-token.txt   a Gitea access token that may write to the repository (keep it private);
REM   sithub-bundle-share.txt  (or as well) a folder the server can read, to copy the bundles to.
REM Without either, the bundle is still made, in %LOCALAPPDATA%\SITHUB-sync\bundles, to copy by hand.
setlocal EnableExtensions

set "GITHUB=https://github.com/JacobMurphy-sys/TaskManagement.git"
set "BRANCHES=main dev server"
REM the branch the offline server runs (its bundle is built from it)
set "BUNDLE_BRANCH=server"
if defined SITHUB_GITHUB set "GITHUB=%SITHUB_GITHUB%"
set "GITEA=%SITHUB_GITEA%"
if exist "%~dp0sithub-gitea.txt" for /f "usebackq delims=" %%R in ("%~dp0sithub-gitea.txt") do if not "%%R"=="" set "GITEA=%%R"
set "HOME_DIR=%LOCALAPPDATA%\SITHUB-sync"
set "MIRROR=%HOME_DIR%\TaskManagement.git"
set "LOG=%HOME_DIR%\sync.log"
if not exist "%HOME_DIR%\" mkdir "%HOME_DIR%"

if /i "%~1"=="--install" goto :install

where git >nul 2>&1 || (call :log "Git was not found - install it from https://git-scm.com" & exit /b 1)
if "%GITEA%"=="" (call :log "No Gitea address: put it in sithub-gitea.txt next to this file, or set SITHUB_GITEA" & exit /b 1)

REM ---- the local mirror of GitHub --------------------------------------------
if not exist "%MIRROR%\HEAD" (
  call :log "First run: mirroring %GITHUB%"
  git clone --mirror "%GITHUB%" "%MIRROR%" >>"%LOG%" 2>&1 || (call :log "Couldn't reach GitHub - see above" & exit /b 1)
) else (
  git -C "%MIRROR%" remote set-url origin "%GITHUB%"
  git -C "%MIRROR%" fetch --prune origin >>"%LOG%" 2>&1 || (call :log "Couldn't fetch from GitHub - see above; Gitea left as it was" & exit /b 1)
)

REM ---- GitHub's branches and tags to Gitea, as they are -------------------------
set "SPECS="
for %%B in (%BRANCHES%) do (
  git -C "%MIRROR%" rev-parse --verify --quiet "refs/heads/%%B" >nul && call set "SPECS=%%SPECS%% +refs/heads/%%B:refs/heads/%%B"
)
if "%SPECS%"=="" (call :log "None of the branches (%BRANCHES%) is on GitHub - nothing pushed" & exit /b 1)
git -C "%MIRROR%" push "%GITEA%" %SPECS% "+refs/tags/*:refs/tags/*" >>"%LOG%" 2>&1 || (call :log "Couldn't push to Gitea (%GITEA%) - see above" & exit /b 1)
for /f "delims=" %%H in ('git -C "%MIRROR%" log -1 --format^="%%h of %%cs" main 2^>nul') do set "LAST=%%H"
call :log "Synced%SPECS% to %GITEA% - main is %LAST%"

REM ---- the bundle for an offline server, when its branch has changed since the last one --------------
set "LASTB=%HOME_DIR%\last-bundle.txt"
set "MAINC="
for /f %%C in ('git -C "%MIRROR%" rev-parse %BUNDLE_BRANCH% 2^>nul') do set "MAINC=%%C"
if "%MAINC%"=="" exit /b 0
set "PREV="
if exist "%LASTB%" set /p PREV=<"%LASTB%"
if "%MAINC%"=="%PREV%" exit /b 0
where node >nul 2>&1 || (call :log "No Node.js on this machine - no bundle made for an offline server" & exit /b 0)
set "WORK=%HOME_DIR%\work"
if exist "%WORK%\" rmdir /s /q "%WORK%"
mkdir "%WORK%"
git -C "%WORK%" --git-dir="%MIRROR%" --work-tree=. checkout -f %BUNDLE_BRANCH% -- . >>"%LOG%" 2>&1 || (call :log "Couldn't check out %BUNDLE_BRANCH% for the bundle - see above" & exit /b 1)
set BARGS=--mirror "%MIRROR%" --work "%WORK%" --out "%HOME_DIR%\bundles" --branch %BUNDLE_BRANCH%
if exist "%~dp0sithub-gitea-token.txt" set BARGS=%BARGS% --gitea "%GITEA%" --token-file "%~dp0sithub-gitea-token.txt"
set "SHARE="
if exist "%~dp0sithub-bundle-share.txt" for /f "usebackq delims=" %%R in ("%~dp0sithub-bundle-share.txt") do if not "%%R"=="" set "SHARE=%%R"
if defined SHARE set BARGS=%BARGS% --copy-to "%SHARE%"
call :log "Building the bundle for an offline server (%BUNDLE_BRANCH% %MAINC:~0,7%)"
node "%WORK%\scripts\bundle.js" build %BARGS% >>"%LOG%" 2>&1 || (call :log "The bundle failed - see above" & exit /b 1)
>"%LASTB%" echo %MAINC%
call :log "Bundle made for %BUNDLE_BRANCH% %MAINC:~0,7%"
exit /b 0

REM ---- run it every N minutes (Task Scheduler) --------------------------------
:install
set "EVERY=%~2"
if "%EVERY%"=="" set "EVERY=30"
schtasks /Create /F /SC MINUTE /MO %EVERY% /TN "SITHUB GitHub to Gitea" /TR "\"%~f0\"" >nul || (echo Couldn't add the scheduled task - run this as the user who should own it. & pause & exit /b 1)
echo Every %EVERY% minutes from now, Windows runs:
echo   %~f0
echo The log is %LOG%.
echo Run this file by hand once first if Git hasn't been signed in to GitHub and Gitea on this machine.
pause
exit /b 0

:log
>>"%LOG%" echo %DATE% %TIME:~0,8%  %~1
echo %~1
exit /b 0
