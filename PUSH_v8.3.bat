@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Push v8.3: Fix ai_enriched_at + enrich_local
echo ========================================
echo.
git add radar-bc-bot.js enrich_local.js web\enrichissements.html
git commit -m "v8.3: fix ai_enriched_at column + enrich_local.js script + dashboard fix"
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
