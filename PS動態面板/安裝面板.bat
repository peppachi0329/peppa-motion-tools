@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.peppa.motiontools"
echo 安裝 PS 動態面板到 %DEST%
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "com.peppa.motiontools" "%DEST%\" /e /i /y >nul
for %%v in (9 10 11 12) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
echo.
echo 裝好了。請把 Photoshop 完全關掉再打開，
echo 到「視窗 > 擴充功能」就會看到「佩佩動態前綴」和「佩佩PS動畫」。
pause
