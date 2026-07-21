@echo off
title DNX3 Wave Tracker — Server
color 0A
echo.
echo  ================================================
echo    DNX3 Wave Tracker - Starting Server...
echo  ================================================
echo.
cd /d "%~dp0"
python server.py
echo.
echo  Server stopped.
pause
