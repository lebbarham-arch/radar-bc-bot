@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR BC MAROC v9.4
echo ================================================
echo.
echo  CHANGEMENTS v9.4 :
echo  - Notifications : critere detecte + variante IA
echo  - Notifications : organisme, deadline, lien direct
echo  - Telegram : format HTML avec liens cliquables
echo  - Admin : onglet Inscriptions avec badge compteur
echo  - Admin : activation client (pack, nom, essai)
echo.
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK Deploy en cours sur Fly.io...
  echo  https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo ================================================
) else (
  echo ERREUR push. Verifiez connexion git.
)
echo.
pause
