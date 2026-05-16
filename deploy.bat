@echo off
echo ================================================
echo   RADAR BC - Deploiement Fly.io
echo ================================================
echo.

cd /d "%~dp0"

echo [1/3] Verification syntax JS...
node --check radar-bc-bot.js
if %errorlevel% neq 0 (
    echo ERREUR: Fichier JS invalide !
    pause
    exit /b 1
)
echo     OK - Fichier valide

echo.
echo [2/3] Commit + push GitHub...
git add -A
git commit -m "Deploy: redeploy clean version" 2>nul || echo     (rien a committer)
git push origin main
if %errorlevel% neq 0 (
    echo ERREUR: git push echoue
    pause
    exit /b 1
)
echo     OK - GitHub a jour

echo.
echo [3/3] Deploiement Fly.io...
flyctl deploy --ha=false
if %errorlevel% neq 0 (
    echo ERREUR: flyctl deploy echoue
    echo Verifiez que flyctl est installe et que vous etes connecte (flyctl auth login)
    pause
    exit /b 1
)

echo.
echo ================================================
echo   DEPLOIEMENT TERMINE !
echo   Surveillez les logs: flyctl logs -a radar-bc-bot
echo ================================================
pause
