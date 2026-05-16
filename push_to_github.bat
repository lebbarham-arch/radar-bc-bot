@echo off
echo =========================================
echo  RADAR BC BOT - Push vers GitHub
echo =========================================
echo.

set /p REPO_URL=Colle l'URL de ton repo GitHub (ex: https://github.com/username/radar-bc-bot.git) :

cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"

echo.
echo Initialisation du repo git...
git init
git add radar-bc-bot.js package.json .env.example .gitignore railway.toml
git commit -m "Initial commit - Radar BC Bot v3"
git branch -M main
git remote add origin %REPO_URL%

echo.
echo Push vers GitHub...
git push -u origin main

echo.
echo =========================================
if %ERRORLEVEL% EQU 0 (
    echo  SUCCES ! Fichiers sur GitHub.
) else (
    echo  ERREUR - Verifie que tu es connecte a GitHub.
    echo  Conseil : installe GitHub Desktop ou configure un token.
)
echo =========================================
pause
