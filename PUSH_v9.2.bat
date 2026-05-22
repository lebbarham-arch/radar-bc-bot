@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR BC MAROC v9.2 - BC-only launch
echo ================================================
echo.
echo  CHANGEMENTS v9.2 :
echo  - Radar MP desactive (FEATURES.enableMP = false)
echo  - Pack limits: 5 / 20 / 50 mots-cles
echo  - Validation IA reservee aux packs Pro/Business
echo  - Pricing page: BC-only, nouveaux differenciateurs
echo  - Portail: bouton MP "Bientot" + pack card mise a jour
echo  - migration_packs.sql: max_criteres 5/20/50, has_mp=false
echo.
git add radar-bc-bot.js
git add web\index.html
git add web\pricing.html
git add migration_packs.sql
git add PUSH_v9.2.bat
git commit -m "v9.2: BC-only launch — MP disabled, pack limits 5/20/50, AI validation Pro+"
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK Push reussi ! Deploy en cours...
  echo  https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo.
  echo  ETAPES FINALES :
  echo  1. Executer migration_packs.sql dans Supabase
  echo     (met a jour max_criteres + has_mp=false)
  echo  2. Verifier secrets Fly.io :
  echo     fly secrets set RESEND_API_KEY=re_xxxx
  echo     fly secrets set FROM_EMAIL=radar@radarmarchesmaroc.ma
  echo  3. Ouvrir web/pricing.html pour valider l'affichage
  echo  4. Ouvrir web/index.html -> onglet Profil -> verifier
  echo     carte pack + bouton MP "Bientot"
  echo ================================================
) else (
  echo ERREUR lors du push.
)
echo.
pause
