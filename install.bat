@echo off
rem Echlon customer pack, Windows. Runs install.ps1 for this one run only; it changes no system setting.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "echlon_code=%errorlevel%"
rem Started by double-click, the window would close the moment the installer ends and take its messages with it.
echo %cmdcmdline% | find /i "/c" >nul
if not errorlevel 1 (
  echo.
  if "%echlon_code%"=="0" (echo Finished.) else (echo The installer stopped. Read the message above.)
  pause
)
exit /b %echlon_code%
