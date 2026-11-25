@echo off
rem Echlon customer pack, Windows. Runs install.ps1 for this one run only; it changes no system setting.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
