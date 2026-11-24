@echo off
cd /d "%~dp0"
chcp 65001 >nul
rem Stops only on error so you can read the message; normally this window is the tool itself.
python server.py || pause
