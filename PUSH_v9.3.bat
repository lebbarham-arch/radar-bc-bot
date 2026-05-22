@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR BC MAROC v9.3 - Securite + Enrichissements
echo ================================================
echo.
echo  CHANGEMENTS v9.3 :
echo  - Securite: clé anon (plus service_role) dans index.html
echo  - RLS Supabase: chaque client ne voit que ses données
echo  - Limites enrichissements: 10 inclusions + 5 exclusions max
echo  - Admin.html: protégé par mot de passe (RadarAdmin2026)
echo  - Bot: cap AI enrichissements à 10/5 termes
echo.
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK Push reussi ! Deploy en cours...
  echo  https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo.
  echo  MOT DE PASSE ADMIN : RadarAdmin2026
  echo  (changeable dans web/admin.html, constante ADMIN_HASH)
  echo ================================================
) else (
  echo ERREUR lors du push. Verifiez votre connexion git.
)
echo.
pause
