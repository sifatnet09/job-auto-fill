@echo off
title GovJob AutoFill Server
echo ========================================================
echo    Starting GovJob AutoFill Cloud Server & Dashboard...
echo ========================================================
echo.
cd /d "%~dp0server"
node server.js
pause
