@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Push v8.2 Dashboard fix
echo ========================================
echo.
git add web\enrichissements.html
git commit -m "fix: dashboard - remove non-existent columns (clients.email, criteres.actif)"
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo OK Push reussi !
  echo Deploy Fly.io en cours via GitHub Actions...
  echo Verifie : https://github.com/lebbarham-arch/radar-bc-bot/actions
) else (
  echo ERREUR lors du push.
)
echo.
pause
