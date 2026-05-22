@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR MARCHES PUBLICS v9.1 - Push prod-ready
echo ================================================
echo.
echo  NOUVEAUTES v9.1 :
echo  - Packs starter/pro/business (renommes)
echo  - Limites mots-cles par pack (5/15/40)
echo  - Email alerts via Resend API
echo  - Portail client: abonnement + CTA upgrade
echo  - Page pricing publique (web/pricing.html)
echo  - Fix: cron MP mapping anciens/nouveaux packs
echo  - Fix: queue JS index.html + loadPackCard
echo.
git add radar-bc-bot.js
git add web\index.html
git add web\pricing.html
git add migration_packs.sql
git add PUSH_v9.1.bat
git commit -m "v9.1: packs starter/pro/business, email Resend, limites KW, pricing page, portail upgrade"
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK Push reussi !
  echo  Deploy Fly.io en cours via GitHub Actions...
  echo  Verifie : https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo.
  echo  ETAPES SUIVANTES :
  echo  1. Executer migration_packs.sql dans Supabase
  echo     https://supabase.com/dashboard/project/xuqxoersxhtyvrslbxzl/sql
  echo  2. Ajouter secrets Fly.io si pas encore fait :
  echo     fly secrets set RESEND_API_KEY=re_xxxx
  echo     fly secrets set FROM_EMAIL=radar@radarmarchesmaroc.ma
  echo  3. Tester le portail client : ouvrir web/index.html
  echo  4. Tester la page pricing : ouvrir web/pricing.html
  echo ================================================
) else (
  echo ERREUR lors du push.
)
echo.
pause
