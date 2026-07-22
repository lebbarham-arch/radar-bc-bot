#Requires -Version 5.1
<#
.SYNOPSIS
    Controle unifie Radar BC
    Commandes : status / test / logs / restart / deploy / rollback

.USAGE
    .\ops\radar.ps1 status
    .\ops\radar.ps1 test
    .\ops\radar.ps1 logs [-Filter SCAN|SEND|Telegram|ERROR|heartbeat] [-Follow]
    .\ops\radar.ps1 restart
    .\ops\radar.ps1 deploy
    .\ops\radar.ps1 rollback
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("status", "test", "logs", "restart", "deploy", "rollback")]
    [string]$Command,

    [Parameter(Position = 1)]
    [ValidateSet("", "SCAN", "SEND", "Telegram", "ERROR", "heartbeat")]
    [string]$Filter = "",

    [switch]$Follow
)

$ErrorActionPreference = "Stop"

# --- Configuration -----------------------------------------------------------

$REPO     = "C:\PROJETS_AI\projet_claude\radar-bc-bot-clean-2"
$LOG      = Join-Path $REPO "logs\radar-bc-runtime.log"
$ENV_FILE = Join-Path $REPO ".env"
$TASK     = "RadarBC"
$PORT     = 3000
$HEALTH   = "http://127.0.0.1:3000/health"
$BACKUP   = "C:\PROJETS_AI\backups\RadarBC\last-good-commit.txt"

# --- Garde-fou depot ---------------------------------------------------------

function Assert-Repo {
    $here = (Get-Location).Path.TrimEnd('\')
    if ($here -ne $REPO.TrimEnd('\')) {
        Write-Error "Ce script doit etre lance depuis $REPO (actuel : $here)"
        exit 1
    }
}

# --- Helpers .env ------------------------------------------------------------

function Get-EnvStatus {
    param([string]$Name)
    if (-not (Test-Path $ENV_FILE)) { return "empty" }
    $line = Get-Content $ENV_FILE -Encoding UTF8 -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ("^\s*" + [regex]::Escape($Name) + "\s*=") } |
        Select-Object -Last 1
    if (-not $line) { return "empty" }
    $val = (($line -split "=", 2)[1]).Trim().Trim('"').Trim("'")
    if ($val) { return "set" } else { return "empty" }
}

# --- Helpers process / port --------------------------------------------------

function Get-PortListener {
    return Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Get-BotProcess {
    param([int]$BotPid)
    try {
        return Get-WmiObject Win32_Process -Filter "ProcessId=$BotPid" -ErrorAction SilentlyContinue
    }
    catch { return $null }
}

function Test-IsBotProcess {
    param([int]$BotPid)
    $proc = Get-BotProcess $BotPid
    if (-not $proc) { return $false }
    return ($proc.CommandLine -match "radar-bc-bot" -or $proc.Name -match "^node")
}

function Get-HealthCheck {
    try {
        $r = Invoke-RestMethod -Uri $HEALTH -TimeoutSec 3 -ErrorAction Stop
        return $r
    }
    catch { return $null }
}

function Wait-PortFree {
    param([int]$MaxSeconds = 20)
    for ($i = 1; $i -le $MaxSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-PortListener)) { return $true }
    }
    return $false
}

function Wait-Health {
    param([int]$MaxSeconds = 30)
    for ($i = 1; $i -le $MaxSeconds; $i++) {
        Start-Sleep -Seconds 1
        $h = Get-HealthCheck
        if ($h -and $h.status -eq "ok") { return $h }
    }
    return $null
}

# --- Helpers log -------------------------------------------------------------

function Get-LastLogMatch {
    param([string]$Pattern)
    if (-not (Test-Path $LOG)) { return $null }
    return Select-String -Path $LOG -Pattern $Pattern -ErrorAction SilentlyContinue |
        Select-Object -Last 1 |
        ForEach-Object { $_.Line }
}

# --- Helpers git -------------------------------------------------------------

function Test-RepoClean {
    $dirty = git status --porcelain 2>&1
    return (-not $dirty)
}

function Get-GitHead {
    return git rev-parse --short HEAD 2>&1
}

function Get-GitBranch {
    return git rev-parse --abbrev-ref HEAD 2>&1
}

# --- CMD : status ------------------------------------------------------------

function Invoke-Status {
    Assert-Repo

    $branch   = Get-GitBranch
    $head     = Get-GitHead
    $dirty    = git status --porcelain 2>&1
    $gitState = if ($dirty) { "MODIFIE ($(@($dirty).Count) fichier(s))" } else { "propre" }

    $taskState = "introuvable"
    try {
        $t = Get-ScheduledTask -TaskName $TASK -ErrorAction Stop
        $taskState = $t.State
    }
    catch {}

    $conn   = Get-PortListener
    $botPid = if ($conn) { $conn.OwningProcess } else { $null }
    $cmd    = "N/A"
    $uptime = "N/A"

    if ($botPid) {
        $wmi = Get-BotProcess $botPid
        if ($wmi) {
            $cmd = $wmi.CommandLine
            if ($cmd.Length -gt 120) { $cmd = $cmd.Substring(0, 117) + "..." }
        }
        try {
            $proc = Get-Process -Id $botPid -ErrorAction SilentlyContinue
            if ($proc) {
                $span   = (Get-Date) - $proc.StartTime
                $uptime = "$([int]$span.TotalHours)h $($span.Minutes)m"
            }
        }
        catch {}
    }

    $health    = Get-HealthCheck
    $healthStr = if ($health -and $health.status -eq "ok") { "OK" } else { "HORS LIGNE" }

    $cfgLine   = Get-LastLogMatch "\[CFG\]"
    $schedLine = Get-LastLogMatch "\[SCHED\] heartbeat"
    $scanLine  = Get-LastLogMatch "\[SCAN_SUMMARY\]"
    $sendLine  = Get-LastLogMatch "\[SEND\]|\[Telegram\]"

    Write-Host ""
    Write-Host "=== RADAR BC - STATUS ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Depot        : $REPO"
    Write-Host "Branche      : $branch  HEAD $head"
    Write-Host "Git          : $gitState"
    Write-Host ""
    Write-Host "Tache        : $TASK - $taskState"
    Write-Host "Port $PORT   : $(if ($botPid) { "PID $botPid" } else { "N/A" })"
    Write-Host "Process      : $cmd"
    Write-Host "Health       : $healthStr"
    Write-Host "Uptime       : $uptime"
    Write-Host ""
    Write-Host "Secrets (.env) :"
    Write-Host "  SUPABASE_URL        : $(Get-EnvStatus 'SUPABASE_URL')"
    Write-Host "  SUPABASE_KEY        : $(Get-EnvStatus 'SUPABASE_KEY')"
    Write-Host "  TELEGRAM_BOT_TOKEN  : $(Get-EnvStatus 'TELEGRAM_BOT_TOKEN')"
    Write-Host ""
    Write-Host "Dernier [CFG]          : $(if ($cfgLine) { $cfgLine } else { 'N/A' })"
    Write-Host "Dernier [SCHED]        : $(if ($schedLine) { $schedLine } else { 'N/A' })"
    Write-Host "Dernier [SCAN_SUMMARY] : $(if ($scanLine) { $scanLine } else { 'N/A' })"
    Write-Host "Dernier [SEND]         : $(if ($sendLine) { $sendLine } else { 'N/A' })"
    Write-Host ""
}

# --- CMD : test --------------------------------------------------------------

function Invoke-Test {
    Assert-Repo

    Write-Host ""
    Write-Host "=== TESTS ===" -ForegroundColor Cyan
    Write-Host ""

    Write-Host "[1/2] npm test (jest)..." -ForegroundColor Yellow
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ECHEC : npm test" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "[2/2] npm run typecheck..." -ForegroundColor Yellow
    npm run typecheck
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ECHEC : typecheck" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "OK : tests et typecheck passes." -ForegroundColor Green
    Write-Host ""
}

# --- CMD : logs --------------------------------------------------------------

function Invoke-Logs {
    if (-not (Test-Path $LOG)) {
        Write-Host "Log introuvable : $LOG" -ForegroundColor Red
        exit 1
    }

    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

    $pattern = switch ($Filter) {
        "SCAN"      { "\[SCAN" }
        "SEND"      { "\[SEND\]" }
        "Telegram"  { "\[Telegram\]" }
        "ERROR"     { "(?i)error|ERREUR|ECHEC|FAILED" }
        "heartbeat" { "\[SCHED\] heartbeat" }
        default     { $null }
    }

    if ($Follow) {
        Write-Host "=== LOGS (live) - Ctrl+C pour quitter ===" -ForegroundColor Cyan
        if ($pattern) {
            Get-Content $LOG -Wait -Tail 20 -Encoding UTF8 |
                Where-Object { $_ -match $pattern }
        }
        else {
            Get-Content $LOG -Wait -Tail 20 -Encoding UTF8
        }
        return
    }

    Write-Host "=== LOGS (100 dernieres lignes) ===" -ForegroundColor Cyan
    if ($pattern) {
        Write-Host "Filtre : $Filter" -ForegroundColor DarkGray
    }
    Write-Host ""

    $lines = Get-Content $LOG -Tail 500 -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($pattern) {
        $lines = $lines | Where-Object { $_ -match $pattern }
    }
    $lines | Select-Object -Last 100 | ForEach-Object { Write-Host $_ }
    Write-Host ""
}

# --- CMD : restart -----------------------------------------------------------

function Invoke-Restart {
    Assert-Repo

    Write-Host ""
    Write-Host "=== RESTART ===" -ForegroundColor Cyan
    Write-Host ""

    $conn = Get-PortListener
    if ($conn) {
        Write-Host "Port $PORT actif - PID $($conn.OwningProcess)"
    }
    else {
        Write-Host "Port $PORT libre (bot arrete ou non demarre)"
    }

    Write-Host "Arret de la tache $TASK..."
    Stop-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue

    $freed = Wait-PortFree -MaxSeconds 20
    if (-not $freed) {
        $conn2 = Get-PortListener
        if ($conn2) {
            $pid2 = $conn2.OwningProcess
            if (Test-IsBotProcess $pid2) {
                Write-Host "Forcage arret PID $pid2 (radar-bc-bot confirme)..."
                Stop-Process -Id $pid2 -Force -ErrorAction Stop
                Start-Sleep -Seconds 2
            }
            else {
                Write-Error "Port $PORT occupe par un processus non identifie (PID $pid2) - arret refuse."
            }
        }
    }

    if (Get-PortListener) {
        Write-Error "Port $PORT toujours occupe apres 22s - restart abandonne."
    }

    Write-Host "Demarrage de la tache $TASK..."
    Start-ScheduledTask -TaskName $TASK

    Write-Host "Attente health check (max 30s)..."
    $health = Wait-Health -MaxSeconds 30

    if (-not $health -or $health.status -ne "ok") {
        Write-Error "Bot non disponible apres 30s. Consultez : .\ops\radar.ps1 logs -Filter ERROR"
    }

    $conn3  = Get-PortListener
    $newPid = if ($conn3) { $conn3.OwningProcess } else { "?" }
    $cfgLine = Get-LastLogMatch "\[CFG\]"

    Write-Host ""
    Write-Host "OK : bot demarre." -ForegroundColor Green
    Write-Host "PID           : $newPid"
    Write-Host "Health        : OK"
    Write-Host "Dernier [CFG] : $cfgLine"
    Write-Host ""
}

# --- CMD : deploy ------------------------------------------------------------

function Invoke-Deploy {
    Assert-Repo

    Write-Host ""
    Write-Host "=== DEPLOY ===" -ForegroundColor Cyan
    Write-Host ""

    if (-not (Test-RepoClean)) {
        $dirty = git status --porcelain 2>&1
        Write-Host "Modifications non validees :" -ForegroundColor Red
        $dirty | ForEach-Object { Write-Host "  $_" }
        Write-Error "Deploy refuse : commitez ou stashez d'abord."
    }

    $branch = Get-GitBranch
    $remote = git config "branch.$branch.remote" 2>&1
    if (-not $remote -or $remote -match "^fatal") {
        Write-Error "La branche '$branch' n'a pas de remote configure."
    }

    Write-Host "Branche : $branch  Remote : $remote"

    $headBefore = git rev-parse HEAD 2>&1
    $backupDir  = Split-Path $BACKUP -Parent
    if (-not (Test-Path $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    Set-Content -Path $BACKUP -Value $headBefore -Encoding UTF8
    Write-Host "HEAD sauvegarde : $headBefore -> $BACKUP"

    Write-Host "git pull --ff-only..."
    git pull --ff-only $remote $branch 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "git pull --ff-only a echoue."
    }

    $headAfter = git rev-parse HEAD 2>&1
    if ($headAfter -eq $headBefore) {
        Write-Host "Deja a jour. Aucun redemarrage necessaire."
        return
    }

    Write-Host "Mise a jour : $headBefore -> $headAfter"

    Write-Host ""
    Write-Host "Tests pre-deploiement..."
    npm test 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ECHEC tests. Pas de redemarrage." -ForegroundColor Red
        Write-Host "Pour revenir en arriere : .\ops\radar.ps1 rollback"
        exit 1
    }

    npm run typecheck 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ECHEC typecheck. Pas de redemarrage." -ForegroundColor Red
        exit 1
    }

    Write-Host "Tests OK - redemarrage..." -ForegroundColor Green
    Invoke-Restart

    $health = Get-HealthCheck
    if (-not $health -or $health.status -ne "ok") {
        Write-Host "Health KO apres deploy - rollback automatique..." -ForegroundColor Red
        Invoke-RollbackInternal $headBefore
        exit 1
    }

    Write-Host ""
    Write-Host "=== DEPLOY OK ===" -ForegroundColor Green
    Write-Host "Commit : $headAfter"
    Write-Host ""
}

# --- CMD : rollback (interne - appel depuis deploy) --------------------------

function Invoke-RollbackInternal {
    param([string]$Target)

    Write-Host ""
    Write-Host "=== ROLLBACK AUTOMATIQUE ===" -ForegroundColor Yellow
    Write-Host ""

    if (-not $Target) {
        Write-Error "Rollback automatique : commit cible vide."
    }

    git cat-file -e "$Target^{commit}" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Commit '$Target' introuvable dans le depot."
    }

    Write-Host "git reset --hard $Target..."
    git reset --hard $Target 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "git reset --hard a echoue."
    }

    npm test 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ECHEC tests apres rollback. Verifiez manuellement." -ForegroundColor Red
        exit 1
    }

    npm run typecheck 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ECHEC typecheck apres rollback." -ForegroundColor Red
        exit 1
    }

    Invoke-Restart

    $health = Get-HealthCheck
    if (-not $health -or $health.status -ne "ok") {
        Write-Error "Bot non disponible apres rollback. Intervention manuelle requise."
    }

    Write-Host ""
    Write-Host "=== ROLLBACK OK ===" -ForegroundColor Green
    Write-Host "Commit restaure : $Target"
    Write-Host ""
}

# --- CMD : rollback (interactif) ---------------------------------------------

function Invoke-Rollback {
    Assert-Repo

    Write-Host ""
    Write-Host "=== ROLLBACK ===" -ForegroundColor Cyan
    Write-Host ""

    if (-not (Test-RepoClean)) {
        Write-Error "Rollback refuse : repo sale. Commitez ou stashez d'abord."
    }

    if (-not (Test-Path $BACKUP)) {
        Write-Error "Fichier de sauvegarde introuvable : $BACKUP"
    }

    $target = (Get-Content $BACKUP -Encoding UTF8).Trim()
    if (-not $target) {
        Write-Error "Commit cible vide dans $BACKUP"
    }

    git cat-file -e "$target^{commit}" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Commit '$target' introuvable dans le depot."
    }

    $currentHead = git rev-parse HEAD 2>&1
    Write-Host "HEAD actuel : $currentHead"
    Write-Host "Retour vers : $target"
    Write-Host ""

    $confirm = Read-Host "Confirmer le rollback ? (oui/non)"
    if ($confirm -ne "oui") {
        Write-Host "Rollback annule."
        return
    }

    Invoke-RollbackInternal $target
}

# --- Dispatch ----------------------------------------------------------------

if (-not $Command) {
    Write-Host "Usage : .\ops\radar.ps1 <commande> [options]"
    Write-Host ""
    Write-Host "Commandes :"
    Write-Host "  status                    Etat complet du bot"
    Write-Host "  test                      Tests + typecheck"
    Write-Host "  logs [-Filter X]          100 dernieres lignes (SCAN|SEND|Telegram|ERROR|heartbeat)"
    Write-Host "       [-Follow]            Mode live (Ctrl+C pour quitter)"
    Write-Host "  restart                   Arrete et redemarre le bot"
    Write-Host "  deploy                    Pull, tests, redemarrage (rollback auto si echec)"
    Write-Host "  rollback                  Revient au dernier commit sauvegarde"
    Write-Host ""
    exit 0
}

switch ($Command) {
    "status"   { Invoke-Status }
    "test"     { Invoke-Test }
    "logs"     { Invoke-Logs }
    "restart"  { Invoke-Restart }
    "deploy"   { Invoke-Deploy }
    "rollback" { Invoke-Rollback }
}
