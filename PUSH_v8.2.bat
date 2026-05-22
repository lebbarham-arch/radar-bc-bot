@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Push v8.2: Cache LLM + Dashboard IA
echo ========================================
echo.
git add radar-bc-bot.js web\enrichissements.html
git commit -m "v8.2: cache LLM local (ai_cache.json) + dashboard enrichissements"
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo OK Push reussi ! Deploy Fly.io en cours...
  echo Verifie : https://github.com/lebbarham-arch/radar-bc-bot/actions
) else (
  echo ERREUR lors du push.
)
echo.
pause
