@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows-fast.ps1" %*
exit /b %ERRORLEVEL%
