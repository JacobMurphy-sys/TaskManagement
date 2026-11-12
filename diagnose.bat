@echo off
REM Double-click when SITHUB seems to have stopped: it checks whether it is still running and answering,
REM where its data and logs are, and whether a proxy or VPN is in the way, then opens what it found.
cd /d "%~dp0"
node scripts\diagnose.js
pause
