@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  SECRETS FLY.IO — Radar BC v9.2
echo ================================================
echo.
echo  Tu as besoin de ta cle Resend.
echo  Si tu n'en as pas : https://resend.com/api-keys
echo  (gratuit, 3000 emails/mois)
echo.
set /p RESEND_KEY="  Colle ta cle Resend (re_xxxx) : "
echo.

if "%RESEND_KEY%"=="" (
  echo ERREUR: cle vide. Relance le script.
  pause
  exit /b 1
)

echo  Configuration des secrets...
fly secrets set RESEND_API_KEY=%RESEND_KEY% FROM_EMAIL=radar@radarmarchesmaroc.ma --app radar-bc-bot

echo.
if %ERRORLEVEL% EQU 0 (
  echo  OK Secrets configures. Le bot redémarre automatiquement.
  echo.
  echo  Verification des logs dans 15s...
  timeout /t 15 /nobreak >nul
  fly logs --app radar-bc-bot
) else (
  echo  ERREUR. Verifie que fly CLI est installe et que tu es connecte :
  echo    fly auth login
)
echo.
pause
