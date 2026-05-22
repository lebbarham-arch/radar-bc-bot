@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Push radar-bc-bot v8.1 vers GitHub
echo ========================================
echo.
git status
echo.
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ✅ Push reussi ! GitHub Actions va deployer sur Fly.io automatiquement.
  echo    Verifie : https://github.com/lebbarham-arch/radar-bc-bot/actions
) else (
  echo ❌ Erreur lors du push. Voir message ci-dessus.
)
echo.
pause
