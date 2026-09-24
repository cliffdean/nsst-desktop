@echo off
rem Use this script's own folder as project root, so it works wherever the repo is cloned
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\start-out.log' -RedirectStandardError '%ROOT%\start-err.log'"
