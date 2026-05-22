@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Force Push radar-bc-bot v8.1
echo ========================================
echo.
git push origin main --force
echo.
if %ERRORLEVEL% EQU 0 (
  echo OK Push reussi !
  echo Verifie : https://github.com/lebbarham-arch/radar-bc-bot/actions
) else (
  echo ERREUR lors du push.
)
echo.
pause
