@echo off
setlocal
cd /d "%~dp0"
echo [XMN] Building and verifying the private QA extension...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update-chrome-qa.ps1"
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  echo [XMN] Update FAILED. Review the message above; the stable extension was not targeted.
) else (
  echo [XMN] Updated. Reload the FxEmbed QA extension card, then refresh X.
)
pause
exit /b %code%
