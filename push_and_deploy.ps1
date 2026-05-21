Set-Location $PSScriptRoot

Write-Host "=== Verification syntaxe ===" -ForegroundColor Cyan
node --check radar-bc-bot.js
if ($LASTEXITCODE -ne 0) { Write-Host "ERREUR SYNTAXE" -ForegroundColor Red; pause; exit 1 }
Write-Host "OK - Syntaxe valide" -ForegroundColor Green

Write-Host "`n=== Commit + Push GitHub ===" -ForegroundColor Cyan
git add radar-bc-bot.js
git commit -m "Fix: réécriture complète sans Unicode problématique"
git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "ERREUR git push" -ForegroundColor Red; pause; exit 1 }
Write-Host "OK - GitHub à jour" -ForegroundColor Green

Write-Host "`n=== Déploiement Fly.io ===" -ForegroundColor Cyan
flyctl deploy --ha=false
if ($LASTEXITCODE -ne 0) { Write-Host "ERREUR flyctl deploy" -ForegroundColor Red; pause; exit 1 }

Write-Host "`n=== DEPLOIEMENT TERMINÉ ===" -ForegroundColor Green
Write-Host "Logs: flyctl logs -a radar-bc-bot" -ForegroundColor Yellow
pause
