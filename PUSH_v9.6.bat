@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ================================================
echo  RADAR BC MAROC v9.6 — UX Commercialisation
echo ================================================
echo.
echo  AMELIORATIONS v9.6 :
echo  - Page connexion : texte sous boutons, lien pricing
echo  - Page inscription : message "activation sous 24h"
echo  - Feature pills : alertes temps reel, IA, scan 2h
echo  - BUG FIX : message succes inscription plus efface
echo  - BUG FIX : email non confirme = message explicite
echo  - Dashboard : onboarding guide 2 etapes pour nouveaux clients
echo  - Stats : couleurs neutres, sous-titres explicatifs
echo  - Criteres : quota pack visible, empty state ameliore
echo  - Alertes : CTA vers criteres si vide
echo  - Profil : sous-titres explicatifs, Telegram guide pas-a-pas
echo  - Suppression : message de confirmation explicite
echo.
git push origin main
echo.
if %ERRORLEVEL% EQU 0 (
  echo ================================================
  echo  OK — Deploy en cours sur Fly.io
  echo  https://github.com/lebbarham-arch/radar-bc-bot/actions
  echo.
  echo  Site apres deploy (~2 min) :
  echo  https://radar-bc-bot.fly.dev/
  echo ================================================
) else (
  echo ERREUR push. Verifiez connexion git.
)
echo.
pause
