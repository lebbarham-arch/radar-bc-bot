@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR MARCHES PUBLICS v9 - Push prod-ready
echo ================================================
echo.
echo  - Serveur HTTP health check
echo  - Cache LLM Supabase (persistant)
echo  - Dashboard admin (web/admin.html)
echo  - Historique alertes client
echo  - Fly.io 1GB RAM + health check
echo  - Tags enrichissement toggleables
echo.
git add radar-bc-bot.js
git add web\index.html
git add web\enrichissements.html
git add web\admin.html
git add fly.toml
git add migration_v9.sql
git add enrich_local.js
git commit -m "v9.0: prod-ready SaaS - HTTP server, Supabase cache, admin dashboard, alertes history, Fly 1GB"
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK Push reussi !
  echo  Deploy Fly.io en cours via GitHub Actions...
  echo  Verifie : https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo.
  echo  ETAPE SUIVANTE : executer migration_v9.sql dans Supabase
  echo  https://supabase.com/dashboard/project/xuqxoersxhtyvrslbxzl/sql
  echo ================================================
) else (
  echo ERREUR lors du push.
)
echo.
pause
