@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR BC MAROC v9.5c — Push portail production
echo ================================================
echo.
echo  CHANGEMENTS v9.5c :
echo  - Portail client production-ready
echo  - BC-only : tout texte "Marches Publics" supprime
echo  - Dashboard : 3 stats (BCs recus, Criteres, Prochain scan)
echo  - WhatsApp/CallMeBot supprime du profil
echo  - Bug JS corriges : btn-add-crit id, loadAlertes double, auth listener tronque
echo.

git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK — Deploy en cours sur Fly.io
  echo  https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo.
  echo  Site (apres deploy ~2min) :
  echo  https://radar-bc-bot.fly.dev/
  echo.
  echo  RAPPEL — Config Supabase dashboard :
  echo  1. Authentication - URL Configuration
  echo     Site URL = https://radar-bc-bot.fly.dev
  echo  2. Authentication - Providers - Email
  echo     Desactiver "Confirm email" (pour test)
  echo ================================================
) else (
  echo ERREUR push. Verifiez connexion git.
)
echo.
pause
