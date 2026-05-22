@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Nettoyage token + Push v8.1
echo ========================================
echo.

git add deploy_v76.ps1 deploy_v80.ps1
git commit --amend --no-edit
echo.
echo Commit amende. Push en cours...
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
