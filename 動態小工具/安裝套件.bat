@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 安裝動態小工具需要的 Python 套件...
python -m pip install -r requirements.txt
echo.
echo 裝好了。之後雙擊「啟動.bat」就能開動態小工具。
pause
