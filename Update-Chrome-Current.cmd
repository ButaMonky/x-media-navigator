@echo off
setlocal
cd /d "%~dp0"
echo [XMN] Verify private GitHub CI and update the single Current Chrome folder...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update-current.ps1"
set "code=%ERRORLEVEL%"
if not "%code%"=="0" echo [XMN] Update failed: no alternate QA folder will be installed.
if "%code%"=="0" echo [XMN] Reload the Current extension card in chrome://extensions and refresh X.
pause
exit /b %code%
