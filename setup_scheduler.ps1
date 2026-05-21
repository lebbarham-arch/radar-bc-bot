# ============================================================
#  Radar Marches Publics - Planificateur de taches Windows
#  v8.1 : execution locale toutes les 2h avec logs
#
#  USAGE : Executer en tant qu'Administrateur
#  Le bot tourne en tache de fond via Node.js (pas de fenetre)
# ============================================================

$BotDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$BotJs    = Join-Path $BotDir "radar-bc-bot.js"
$LogFile  = Join-Path $BotDir "radar-bc-bot.log"
$NodeExe  = (Get-Command node -ErrorAction SilentlyContinue)?.Source

if (-not $NodeExe) {
    Write-Host "ERREUR: Node.js non trouve. Installer depuis https://nodejs.org" -ForegroundColor Red
    pause; exit 1
}
if (-not (Test-Path $BotJs)) {
    Write-Host "ERREUR: radar-bc-bot.js non trouve dans $BotDir" -ForegroundColor Red
    pause; exit 1
}
if (-not (Test-Path (Join-Path $BotDir ".env"))) {
    Write-Host "ERREUR: .env manquant. Copier .env.example en .env et remplir les variables." -ForegroundColor Red
    pause; exit 1
}

$TaskName   = "RadarMarchesPublics_v81"
$TaskDesc   = "Radar Marches Publics - scan BC et MP toutes les 2h (v8.1 IA)"

# Wrapper PowerShell pour capturer les logs
$WrapperPs1 = Join-Path $BotDir "run_bot_wrapper.ps1"
@"
Set-Location "$BotDir"
`$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path "$LogFile" -Value "`n=== Scan demarre par planificateur: `$timestamp ==="
node "$BotJs" 2>&1 | Tee-Object -FilePath "$LogFile" -Append
"@ | Set-Content -Path $WrapperPs1 -Encoding UTF8

Write-Host "`n=== Configuration tache planifiee ===" -ForegroundColor Cyan
Write-Host "  Bot     : $BotJs"
Write-Host "  Node    : $NodeExe"
Write-Host "  Logs    : $LogFile"
Write-Host "  Tache   : $TaskName"

# Supprimer ancienne tache si elle existe
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "`nSuppression ancienne tache..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Creer la nouvelle tache
$Action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WrapperPs1`"" `
    -WorkingDirectory $BotDir

# Toutes les 2h a partir de minuit
$Trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 2) -Once -At "00:00"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $Action `
    -Trigger    $Trigger `
    -Settings   $Settings `
    -Principal  $Principal `
    -Description $TaskDesc `
    -Force | Out-Null

Write-Host "`nTache creee avec succes!" -ForegroundColor Green
Write-Host "`n=== Commandes utiles ===" -ForegroundColor Cyan
Write-Host "  Lancer maintenant   : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Verifier statut     : Get-ScheduledTask -TaskName '$TaskName' | Select State"
Write-Host "  Voir derniere exec  : Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "  Supprimer tache     : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host "  Voir logs           : Get-Content '$LogFile' -Tail 50"
Write-Host ""
Write-Host "Lancer le premier scan maintenant ? (O/N)" -ForegroundColor Yellow -NoNewline
$rep = Read-Host " "
if ($rep -match "^[oOyY]") {
    Write-Host "Lancement..." -ForegroundColor Green
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Statut: $($info.LastTaskResult) | Derniere exec: $($info.LastRunTime)"
}

Write-Host "`n=== FIN ===" -ForegroundColor Green
pause
