<#
.SYNOPSIS
  Cycle local complet : Snapshot-Only -> Replay Shadow -> Analyse -> Resume.

.DESCRIPTION
  Orchestre le cycle local de calibration sans aucun impact prod :
    1. Verification git status (propre ou -AllowDirty)
    2. Verification port 3000 libre
    3. Scan snapshot-only (RADAR_BC_SNAPSHOT_ONLY=1, log horodate)
    4. Replay shadow sur le dernier snapshot
    5. Analyse shadow-report (hints actifs via GD-068) + exports
    6. Resume console

  SECURITE :
    - N'appelle jamais fly, git add, git commit, git push
    - Ne definit jamais RADAR_BC_MATCH_SHADOW, RADAR_BC_SHADOW_ACTIVE
    - Refuse de continuer si port 3000 est occupe
    - Refuse si git status non propre (sauf -AllowDirty)
    - Ne touche pas Supabase bcs_vus
    - Ne scrape pas en mode prod
    - Ne notifie aucun client

.PARAMETER AllowDirty
  Si present, ignore le check "git status propre" et continue quand meme.

.PARAMETER SkipScan
  Si present, saute l'etape 3 (scan snapshot) et utilise le dernier snapshot existant.
  Utile quand un snapshot vient d'etre cree manuellement.

.PARAMETER ClientFilter
  Filtre optionnel client pour replay et analyze (ex : "TEST PROD - Nettoyage Hygiene").

.EXAMPLE
  .\scripts\run-local-snapshot-review-cycle.ps1
  .\scripts\run-local-snapshot-review-cycle.ps1 -AllowDirty
  .\scripts\run-local-snapshot-review-cycle.ps1 -SkipScan
  .\scripts\run-local-snapshot-review-cycle.ps1 -ClientFilter "TEST PROD"

.NOTES
  Ce script est local uniquement. Aucun commit, aucun push, aucun deploiement.
  Dossier de travail attendu : racine du repo radar-bc-bot-clean-2.
#>

[CmdletBinding()]
param(
    [switch]$AllowDirty,
    [switch]$SkipScan,
    [string]$ClientFilter = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -- Resolution racine repo
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

# -- Horodatage session
$SessionTs  = (Get-Date -Format "yyyy-MM-ddTHH-mm-ss")
$SessionTag = "[CycleLocal $SessionTs]"

function Write-Step { param([string]$Msg) Write-Host "`n$SessionTag $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "  [OK]   $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "  [WARN] $Msg" -ForegroundColor Yellow }
function Write-Fail {
    param([string]$Msg)
    Write-Host "`n  [FAIL] $Msg" -ForegroundColor Red
    exit 1
}

# ========================================================
# Banniere
# ========================================================
Write-Host ""
Write-Host "========================================================" -ForegroundColor DarkCyan
Write-Host "  CYCLE LOCAL SNAPSHOT -> REPLAY -> ANALYSE" -ForegroundColor Cyan
Write-Host "  $SessionTs" -ForegroundColor DarkGray
Write-Host "  Repo : $RepoRoot" -ForegroundColor DarkGray
Write-Host "========================================================" -ForegroundColor DarkCyan

# ========================================================
# Etape 1 -- Verification git status
# ========================================================
Write-Step "Etape 1/6 -- Verification git status"

$GitStatus = & git status --short 2>&1
# Filtrer les lignes D + ?? (etat index NTFS/Linux connu, non bloquant)
$RealDirty = $GitStatus | Where-Object {
    $_ -notmatch '^D  ' -and $_ -notmatch '^\?\? '
}

if ($RealDirty) {
    if ($AllowDirty) {
        Write-Warn "git status non propre -- continue avec -AllowDirty :"
        $RealDirty | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    } else {
        $DirtyMsg  = "git status non propre. Committer ou stasher avant de lancer le cycle."
        $DirtyMsg += "`nOu relancer avec -AllowDirty pour ignorer."
        $DirtyMsg += "`nLignes detectees :`n" + ($RealDirty -join "`n")
        Write-Fail $DirtyMsg
    }
} else {
    Write-Ok "git status propre (ou seuls D+?? NTFS/Linux -- ignores)"
}

# ========================================================
# Etape 2 -- Verification port 3000
# ========================================================
Write-Step "Etape 2/6 -- Verification port 3000"

$PortOccupe = $false
try {
    $TcpResult = Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue -InformationLevel Quiet 2>$null
    if ($TcpResult -eq $true) { $PortOccupe = $true }
} catch {
    # Test-NetConnection peut ne pas exister sur certains environnements
    try {
        $Listener   = [System.Net.Sockets.TcpClient]::new()
        $ConnResult = $Listener.BeginConnect("127.0.0.1", 3000, $null, $null)
        $Connected  = $ConnResult.AsyncWaitHandle.WaitOne(500, $false)
        if ($Connected -and $Listener.Connected) { $PortOccupe = $true }
        $Listener.Close()
    } catch { $PortOccupe = $false }
}

if ($PortOccupe) {
    $PortMsg  = "Le port 3000 est occupe. Un serveur est peut-etre deja en cours (radar-bc-bot.js prod ?)."
    $PortMsg += "`nArreter le processus concerne avant de lancer le scan snapshot."
    Write-Fail $PortMsg
} else {
    Write-Ok "Port 3000 libre"
}

# ========================================================
# Etape 3 -- Scan Snapshot-Only
# ========================================================
Write-Step "Etape 3/6 -- Scan Snapshot-Only"

$LogDir  = Join-Path $RepoRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir "snapshot-only-full-$SessionTs.log"

if ($SkipScan) {
    Write-Warn "-SkipScan active : scan ignore, utilisation du dernier snapshot existant"
} else {
    Write-Host "  Log : $LogFile" -ForegroundColor DarkGray
    Write-Host "  Lancement node radar-bc-bot.js (RADAR_BC_SNAPSHOT_ONLY=1)..." -ForegroundColor DarkGray

    # Variables d'environnement LOCALES au scan -- scope session uniquement
    $env:RADAR_BC_SNAPSHOT_ONLY = "1"

    # Securite : s'assurer que les flags prod sont NON definis
    Remove-Item Env:\RADAR_BC_SERVER_ONLY   -ErrorAction SilentlyContinue
    Remove-Item Env:\RADAR_BC_MATCH_SHADOW  -ErrorAction SilentlyContinue
    Remove-Item Env:\RADAR_BC_SHADOW_ACTIVE -ErrorAction SilentlyContinue

    try {
        # Tee vers log + console simultanement
        node radar-bc-bot.js 2>&1 | Tee-Object -FilePath $LogFile
        $ScanExit = $LASTEXITCODE
    } finally {
        # Toujours nettoyer apres le scan, meme en cas d'erreur
        Remove-Item Env:\RADAR_BC_SNAPSHOT_ONLY -ErrorAction SilentlyContinue
    }

    if ($ScanExit -ne 0) {
        Write-Fail "Le scan snapshot-only a echoue (exit $ScanExit). Voir : $LogFile"
    }
    Write-Ok "Scan termine (exit 0) -- log : logs\snapshot-only-full-$SessionTs.log"
}

# ========================================================
# Etape 4 -- Identifier le dernier snapshot
# ========================================================
Write-Step "Etape 4/6 -- Identification du dernier snapshot"

$SnapshotDir = Join-Path $RepoRoot "data\input-snapshots"
if (-not (Test-Path $SnapshotDir)) {
    Write-Fail "Dossier data\input-snapshots introuvable. Aucun snapshot disponible."
}

$LatestSnapshot = Get-ChildItem -Path $SnapshotDir -Filter "bc-input-*.jsonl" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $LatestSnapshot) {
    Write-Fail "Aucun fichier bc-input-*.jsonl dans data\input-snapshots."
}

$SnapSize  = [math]::Round($LatestSnapshot.Length / 1KB, 1)
$SnapLines = (Get-Content $LatestSnapshot.FullName | Measure-Object -Line).Lines

Write-Ok "Snapshot : $($LatestSnapshot.Name)"
Write-Host "    Taille : ${SnapSize} KB  |  BC : $SnapLines  |  Date : $($LatestSnapshot.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor DarkGray

# ========================================================
# Etape 5 -- Replay Shadow
# ========================================================
Write-Step "Etape 5/6 -- Replay Shadow"

$ReplayArgs = @("scripts\replay-shadow-from-input-snapshot.js", $LatestSnapshot.FullName)
if ($ClientFilter) {
    $ReplayArgs += "--client"
    $ReplayArgs += $ClientFilter
    Write-Host "  Filtre client : $ClientFilter" -ForegroundColor DarkGray
}

Write-Host "  Commande : node $($ReplayArgs -join ' ')" -ForegroundColor DarkGray

$ReplayOutput = node @ReplayArgs 2>&1
$ReplayOutput | Write-Host
$ReplayExit   = $LASTEXITCODE

if ($ReplayExit -ne 0) {
    Write-Fail "replay-shadow-from-input-snapshot.js a echoue (exit $ReplayExit)."
}

# Extraire le nom du rapport shadow depuis stdout
$ReportMatch = $ReplayOutput | Select-String -Pattern "\[Replay-V2\] Rapport ecrit : (shadow-bc-input-replay-[^\s]+\.json)"
if (-not $ReportMatch) {
    $RepMsg  = "Impossible de detecter le rapport shadow dans la sortie du replay."
    $RepMsg += "`nLigne attendue : [Replay-V2] Rapport ecrit : shadow-bc-input-replay-*.json"
    Write-Fail $RepMsg
}
$ReportFname = $ReportMatch.Matches[0].Groups[1].Value
$ReportPath  = Join-Path $RepoRoot "data\shadow\$ReportFname"
Write-Ok "Rapport shadow : data\shadow\$ReportFname"

# ========================================================
# Etape 6 -- Analyse Shadow Report
# ========================================================
Write-Step "Etape 6/6 -- Analyse Shadow Report"

# GD-068 : analyze-shadow-report.js charge automatiquement
#          data/review-learning/review-reason-hints-active-current.json
#          Aucun flag hints a passer par defaut (chargement auto).
$AnalyzeArgs = @("scripts\analyze-shadow-report.js", $ReportPath,
                 "--export-review", "--export-review-csv")

if ($ClientFilter) {
    $AnalyzeArgs += "--client"
    $AnalyzeArgs += $ClientFilter
}

Write-Host "  Commande : node $($AnalyzeArgs -join ' ')" -ForegroundColor DarkGray

$AnalyzeOutput = node @AnalyzeArgs 2>&1
$AnalyzeOutput | Write-Host
$AnalyzeExit   = $LASTEXITCODE

if ($AnalyzeExit -ne 0) {
    Write-Fail "analyze-shadow-report.js a echoue (exit $AnalyzeExit)."
}
Write-Ok "Analyse terminee"

# ========================================================
# RESUME -- Fichiers generes + metriques
# ========================================================
Write-Host ""
Write-Host "========================================================" -ForegroundColor DarkCyan
Write-Host "  RESUME DU CYCLE" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor DarkCyan

Write-Host "  Snapshot      : $($LatestSnapshot.Name) ($SnapLines BC)" -ForegroundColor White
Write-Host "  Shadow report : data\shadow\$ReportFname" -ForegroundColor White

# Fichiers exports detectes
$ShadowDir = Join-Path $RepoRoot "data\shadow"
$TsPattern = ($ReportFname -replace "shadow-bc-input-replay-","" -replace "\.json","")

$ReviewJson = Get-ChildItem -Path $ShadowDir -Filter "review-candidates-$TsPattern.json"     -ErrorAction SilentlyContinue | Select-Object -First 1
$ReviewCsv  = Get-ChildItem -Path $ShadowDir -Filter "review-candidates-$TsPattern.csv"      -ErrorAction SilentlyContinue | Select-Object -First 1
$AutoCsv    = Get-ChildItem -Path $ShadowDir -Filter "auto-candidates-admin-$TsPattern.csv"  -ErrorAction SilentlyContinue | Select-Object -First 1
$CompJson   = Get-ChildItem -Path $ShadowDir -Filter "legacy-vs-clean-$TsPattern.json"       -ErrorAction SilentlyContinue | Select-Object -First 1

if ($ReviewJson) { Write-Host "  Review JSON   : data\shadow\$($ReviewJson.Name)" -ForegroundColor White }
if ($ReviewCsv)  { Write-Host "  Review CSV    : data\shadow\$($ReviewCsv.Name)"  -ForegroundColor White }
if ($AutoCsv)    { Write-Host "  Auto CSV      : data\shadow\$($AutoCsv.Name)"    -ForegroundColor White }
if ($CompJson)   { Write-Host "  Legacy/Clean  : data\shadow\$($CompJson.Name)"   -ForegroundColor White }

# Metriques extraites directement du rapport shadow JSON (lecture robuste)
$LegacyCount = "n/a"
$CleanCount  = "n/a"
$LegacyOnly  = "n/a"
$CleanOnly   = "n/a"
$FpRate      = "n/a"
$AutoCands   = "n/a"
$ReviewCands = "n/a"

try {
    $ReportRaw  = Get-Content -Path $ReportPath -Raw -Encoding UTF8
    $ReportData = $ReportRaw | ConvertFrom-Json
    $Sum        = $ReportData.summary
    if ($null -ne $Sum) {
        if ($null -ne $Sum.total_legacy_matches) { $LegacyCount = [string]$Sum.total_legacy_matches }
        if ($null -ne $Sum.total_clean_matches)  { $CleanCount  = [string]$Sum.total_clean_matches  }
        if ($null -ne $Sum.total_legacy_only)    { $LegacyOnly  = [string]$Sum.total_legacy_only    }
        if ($null -ne $Sum.total_clean_only)     { $CleanOnly   = [string]$Sum.total_clean_only     }
    }
    $Clients = $ReportData.clients
    if ($null -ne $Clients) {
        $AutoSum = 0
        $RevSum  = 0
        $FpList  = @()
        foreach ($Cl in $Clients) {
            # clean_auto_notify_candidates : nombre direct
            if ($null -ne $Cl.clean_auto_notify_candidates) {
                $AutoSum += [int]$Cl.clean_auto_notify_candidates
            }
            # clean_review_candidates : peut etre un tableau ou un nombre
            $RevVal = $Cl.clean_review_candidates
            if ($RevVal -is [System.Array]) {
                $RevSum += $RevVal.Count
            } elseif ($null -ne $RevVal) {
                $RevSum += [int]$RevVal
            }
            # fp_rate_pct : moyenne si plusieurs clients
            if ($null -ne $Cl.fp_rate_pct) { $FpList += [int]$Cl.fp_rate_pct }
        }
        $AutoCands   = [string]$AutoSum
        $ReviewCands = [string]$RevSum
        if ($FpList.Count -gt 0) {
            $FpAvg = [math]::Round(($FpList | Measure-Object -Average).Average)
            $FpRate = [string]$FpAvg
        }
    }
} catch {
    Write-Warn "Lecture metriques JSON echouee : $_"
}

Write-Host ""
Write-Host "  -- Metriques -------------------------------------------" -ForegroundColor DarkCyan
Write-Host "  BC snapshot       : $SnapLines"    -ForegroundColor White
Write-Host "  Legacy matches    : $LegacyCount"  -ForegroundColor White
Write-Host "  Clean matches     : $CleanCount"   -ForegroundColor White
Write-Host "  Legacy only       : $LegacyOnly  (FP rate legacy ~${FpRate}%)" -ForegroundColor White
Write-Host "  Clean only        : $CleanOnly"    -ForegroundColor White
Write-Host "  Auto candidates   : $AutoCands"    -ForegroundColor White
Write-Host "  Review candidates : $ReviewCands"  -ForegroundColor White
Write-Host ""
Write-Host "========================================================" -ForegroundColor DarkCyan
Write-Host "  git status --short (fin de cycle)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor DarkCyan

& git status --short

Write-Host ""
Write-Host "  Cycle termine -- aucun commit, aucun push." -ForegroundColor Green
Write-Host "  Log scan : logs\snapshot-only-full-$SessionTs.log" -ForegroundColor DarkGray
Write-Host ""
