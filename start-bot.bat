@echo off
setlocal

chcp 65001 >nul
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

echo.>> "logs\radar-bc-runtime.log"
echo ==================================================>> "logs\radar-bc-runtime.log"
echo START %date% %time%>> "logs\radar-bc-runtime.log"
echo REPO %CD%>> "logs\radar-bc-runtime.log"
echo ==================================================>> "logs\radar-bc-runtime.log"

"C:\Program Files\nodejs\node.exe" "radar-bc-bot.js" >> "logs\radar-bc-runtime.log" 2>&1

set EXIT_CODE=%ERRORLEVEL%

echo STOP %date% %time% CODE=%EXIT_CODE%>> "logs\radar-bc-runtime.log"

exit /b %EXIT_CODE%
