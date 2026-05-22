@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Ajout workflow deploy + Push
echo ========================================
echo.
git add .github\workflows\deploy.yml
git commit -m "ci: add Fly.io deploy workflow"
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo OK Push reussi ! Le deploy va se lancer automatiquement.
  echo Verifie : https://github.com/lebbarham-arch/radar-bc-bot/actions
) else (
  echo ERREUR lors du push.
)
echo.
pause
