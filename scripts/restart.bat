@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-windows.ps1" %*
exit /b %ERRORLEVEL%
