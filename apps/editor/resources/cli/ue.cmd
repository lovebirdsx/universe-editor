@echo off
chcp 65001 >nul 2>&1
"%~dp0..\Universe Editor.exe" %*
exit /b %ERRORLEVEL%
