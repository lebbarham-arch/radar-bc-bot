@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR BC MAROC v9.5
echo ================================================
echo.
echo  CHANGEMENTS v9.5 :
echo  - Enrichissements : inclusions AI-only (pas d'ajout manuel)
echo  - Enrichissements : exclusions manuelles toujours possibles
echo  - Bot : serveur HTTP avec endpoints de test
echo    GET  /health
echo    GET  /api/status?secret=xxx
echo    POST /api/scan-now?secret=xxx
echo    GET  /api/test-notify?secret=xxx[^&client_id=yyy]
echo.
echo  AVANT DE PUSHER - configurer le secret sur Fly.io :
echo  fly secrets set ADMIN_SECRET=votre_secret_ici
echo.
git add -A
git commit -m "v9.5: inclusions AI-only + serveur HTTP test (scan-now, test-notify, status)"
echo.
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK Deploy en cours sur Fly.io...
  echo  https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo.
  echo  ENDPOINTS DE TEST (apres deploy) :
  echo  https://radar-bc-bot.fly.dev/health
  echo  https://radar-bc-bot.fly.dev/api/status?secret=VOTRE_SECRET
  echo  curl -X POST "https://radar-bc-bot.fly.dev/api/scan-now?secret=VOTRE_SECRET"
  echo  https://radar-bc-bot.fly.dev/api/test-notify?secret=VOTRE_SECRET^&client_id=1
  echo ================================================
) else (
  echo ERREUR push. Verifiez connexion git.
)
echo.
pause
