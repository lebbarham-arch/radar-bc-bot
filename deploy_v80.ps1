Set-Location $PSScriptRoot

$PAT        = $env:GITHUB_PAT  # Ne jamais mettre le token en dur ici
$REPO       = "github.com/lebbarham-arch/radar-bc-bot.git"

Write-Host "=== Verification syntaxe v8.1 ===" -ForegroundColor Cyan
node --check radar-bc-bot.js
if ($LASTEXITCODE -ne 0) { Write-Host "ERREUR SYNTAXE - deploiement annule" -ForegroundColor Red; pause; exit 1 }
Write-Host "Syntaxe OK" -ForegroundColor Green

Write-Host "`n=== Configuration remote avec PAT ===" -ForegroundColor Cyan
git remote set-url origin "https://$PAT@$REPO"

Write-Host "`n=== Commit + Push GitHub ===" -ForegroundColor Cyan
git add radar-bc-bot.js migration_ai.sql
git commit -m "v8.1: couche LLM unifiee Ollama local + Claude Haiku fallback"
git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "ERREUR git push" -ForegroundColor Red; pause; exit 1 }
Write-Host "Push OK - GitHub Actions deploie sur Fly.io" -ForegroundColor Green

Write-Host "`n=== Etapes post-deploy (Fly.io cloud) ===" -ForegroundColor Yellow
Write-Host "1. Supabase SQL Editor: executer migration_ai.sql (si pas deja fait)"
Write-Host ""
Write-Host "2. Secrets Fly.io (choisir une option) :"
Write-Host "   Option A - Claude Haiku uniquement (cloud) :"
Write-Host "   fly secrets set ANTHROPIC_API_KEY=sk-ant-xxxxx -a radar-bc-bot"
Write-Host ""
Write-Host "   Option B - Ollama local expose sur internet :"
Write-Host "   fly secrets set OLLAMA_URL=https://votre-ip:11434 OLLAMA_MODEL=qwen2.5:32b -a radar-bc-bot"
Write-Host "   (+ optionnel) fly secrets set ANTHROPIC_API_KEY=sk-ant-xxxxx -a radar-bc-bot"
Write-Host ""
Write-Host "   Option C - Sans IA (desactiver) :"
Write-Host "   fly secrets unset ANTHROPIC_API_KEY OLLAMA_URL -a radar-bc-bot"
Write-Host ""
Write-Host "3. Logs: https://fly.io/apps/radar-bc-bot/monitoring"
Write-Host "4. Marqueurs a chercher dans les logs :"
Write-Host "   '[IA] Enrichissement'  -> enrichissement criteres"
Write-Host "   '[IA] VALIDE'          -> match valide par IA"
Write-Host "   '[IA] REJETE'          -> faux positif elimine"
Write-Host "   '[IA] Ollama KO'       -> fallback Haiku active"
Write-Host "`n=== FIN ===" -ForegroundColor Green
pause
