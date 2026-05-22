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
Write-Host "   Option B - Ollama local expose sur