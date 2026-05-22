@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  MIGRATION SUPABASE — Radar BC v9.2
echo ================================================
echo.
node run_migration.js
echo.
pause
