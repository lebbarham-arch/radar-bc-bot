Set-Location $PSScriptRoot

$PAT = $env:GITHUB_PAT  # Ne jamais mettre le token en dur ici
$REPO = "github.com/lebbarham-arch/radar-bc-bot.git"

Write-Host "=== Verification syntaxe v7.6 ===" -ForegroundColor Cyan
node --check radar-bc-bot.js
if ($LASTEXITCODE -ne 0) { Write-Host "ERREUR SYNTAXE - deploiement annule" -ForegroundColor Red; pause; exit 1 }
Write-Host "Syntaxe OK" -ForegroundColor Green

Write-Host "`n=== Configuration remote avec PAT ===" -ForegroundColor Cyan
git remote set-url origin "https://$PAT@$REPO"

Write-Host "`n=== Commit + Push GitHub ===" -ForegroundColor Cyan
git add radar-bc-bot.js
git commit -m "v7.6: isEnCours grace 30j + diagnostic logging matchClient"
git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "ERREUR git push" -ForegroundColor Red; pause; exit 1 }
Write-Host "Push OK - GitHub Actions va deployer automatiquement" -ForegroundColor Green

Write-Host "`nSuivi: https://github.com/lebbarham-arch/radar-bc-bot/actions" -ForegroundColor Yellow
Write-Host "Logs:   https://fly.io/apps/radar-bc-bot/monitoring" -ForegroundColor Yellow
Write-Host "`n=== FIN ===" -ForegroundColor Green
pause
