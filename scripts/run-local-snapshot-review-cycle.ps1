<#
.SYNOPSIS
  Cycle local complet : Snapshot-Only → Replay Shadow → Analyse → Résumé.

.DESCRIPTION
  Orchestre le cycle local de calibration sans aucun impact prod :
    1. Vérification git status (propre ou -AllowDirty)
    2. Vérification port 3000 libre
    3. Scan snapshot-only (RADAR_BC_SNAPSHOT_ONLY=1, log horodaté)
    4. Replay shadow sur le dernier snapshot
    5. Analyse shadow-report avec approved hints + exports
    6. Résumé console

  SÉCURITÉ :
    - N'appelle jamais fly, git add, git commit, git push
    - Ne définit jamais RADAR_BC_MATCH_SHADOW, RADAR_BC_SHADOW_ACTIVE
    - Refuse de continuer si port 3000 est occupé
    - Refuse si git status non propre (sauf -AllowDirty)
    - Ne touche pas Supabase bcs_vus
    - Ne scrape pas en mode prod
    - Ne notifie aucun client

.PARAMETER AllowDirty
  Si présent, ignore le check "git status propre" et continue quand même.

.PARAMETER SkipScan
  Si présent, saute l'étape 3 (scan snapshot) et utilise le dernier snapshot existant.
  Utile quand un snapshot vient d'être créé manuellement.

.PARAMETER ClientFilter
  Filtre optionnel client pour replay et analyze (ex : "TEST PROD - Nettoyage Hygiène").

.EXAMPLE
  .\scripts\run-local-snapshot-review-cycle.ps1
  .\scripts\run-local-snapshot-review-cycle.ps1 -AllowDirty
  .\scripts\run-local-snapshot-review-cycle.ps1 -SkipScan
  .\scripts\run-local-snapshot-review-cycle.ps1 -ClientFilter "TEST PROD - Nettoyage Hygiène"

.NOTES
  Ce script est local uniquement. Aucun commit, aucun push, aucun déploiement.
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

# ── Résolution racine repo ─────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

# ── Horodatage session ─────────────────────────────────────────────────────────
$SessionTs  = (Get-Date -Format "yyyy-MM-ddTHH-mm-ss")
$SessionTag = "[CycleLocal $SessionTs]"

function Write-Step { param([string]$Msg) Write-Host "`n$SessionTag $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "  ✓ $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "  ⚠ $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg)
    Write-Host "`n  ✗ $Msg" -ForegroundColor Red
    exit 1
}

# ══════════════════════════════════════════════════════════════════════════════
# ÉTAPE 0 — Bannière
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  CYCLE LOCAL SNAPSHOT → REPLAY → ANALYSE" -ForegroundColor Cyan
Write-Host "  $SessionTs" -ForegroundColor DarkGray
Write-Host "  Repo : $RepoRoot" -ForegroundColor DarkGray
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkCyan

# ══════════════════════════════════════════════════════════════════════════════
# ÉTAPE 1 — Vérification git status
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "Étape 1/6 — Vérification git status"

$GitStatus = & git status --short 2>&1
# Filtrer les lignes D + ?? (état index NTFS/Linux connu, non bloquant)
$RealDirty = $GitStatus | Where-Object {
    $_ -notmatch '^D  ' -and $_ -notmatch '^\?\? '
}

if ($RealDirty) {
    if ($AllowDirty) {
        Write-Warn "git status non propre — continué avec -AllowDirty :"
        $RealDirty | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    } else {
        Write-Fail ("git status non propre. Committer ou stasher avant de lancer le cycle.`n" +
                    "Ou relancer avec -AllowDirty pour ignorer.`n" +
                    "Lignes détectées :`n" + ($RealDirty -join "`n"))
    }
} else {
    Write-Ok "git status propre (ou seuls D+?? NTFS/Linux — ignorés)"
}

# ══════════════════════════════════════════════════════════════════════════════
# ÉTAPE 2 — Vérification port 3000
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "Étape 2/6 — Vérification port 3000"

$PortOccupe = $false
try {
    $TcpResult = Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue -InformationLevel Quiet 2>$null
    if ($TcpResult -eq $true) { $PortOccupe = $true }
} catch {
    # Test-NetConnection peut ne pas exister sur certains environnements
    try {
        $Listener = [System.Net.Sockets.TcpClient]::new()
        $ConnResult = $Listener.BeginConnect("127.0.0.1", 3000, $null, $null)
        $Connected  = $ConnResult.AsyncWaitHandle.WaitOne(500, $false)
        if ($Connected -and $Listener.Connected) { $PortOccupe = $true }
        $Listener.Close()
    } catch { $PortOccupe = $false }
}

if ($PortOccupe) {
    Write-Fail ("Le port 3000 est occupé. Un serveur est peut-être déjà en cours (radar-bc-bot.js prod ?).`n" +
                "Arrêter le processus concerné avant de lancer le scan snapshot.")
} else {
    Write-Ok "Port 3000 libre"
}

# ══════════════════════════════════════════════════════════════════════════════
# ÉTAPE 3 — Scan Snapshot-Only
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "Étape 3/6 — Scan Snapshot-Only"

$LogDir  = Join-Path $RepoRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir "snapshot-only-full-$SessionTs.log"

if ($SkipScan) {
    Write-Warn "-SkipScan activé : scan ignoré, utilisation du dernier snapshot existant"
} else {
    Write-Host "  Log : $LogFile" -ForegroundColor DarkGray
    Write-Host "  Lancement node radar-bc-bot.js (RADAR_BC_SNAPSHOT_ONLY=1)..." -ForegroundColor DarkGray

    # Variables d'environnement LOCALES au scan — scope session uniquement
    $env:RADAR_BC_SNAPSHOT_ONLY = "1"

    # Sécurité : s'assurer que les flags prod sont NON définis
    Remove-Item Env:\RADAR_BC_SERVER_ONLY    -ErrorAction SilentlyContinue
    Remove-Item Env:\RADAR_BC_MATCH_SHADOW   -ErrorAction SilentlyContinue
    Remove-Item Env:\RADAR_BC_SHADOW_ACTIVE  -ErrorAction SilentlyContinue

    try {
        # Tee vers log + console simultanément
        node radar-bc-bot.js 2>&1 | Tee-Object -FilePath $LogFile
        $ScanExit = $LASTEXITCODE
    } finally {
        # Toujours nettoyer après le scan, même en cas d'erreur
        Remove-Item Env:\RADAR_BC_SNAPSHOT_ONLY -ErrorAction SilentlyContinue
    }

    if ($ScanExit -ne 0) {
        Write-Fail "Le scan snapshot-only a échoué (exit $ScanExit). Voir : $LogFile"
    }
    Write-Ok "Scan terminé (exit 0) — log : logs\snapshot-only-full-$SessionTs.log"
}

# ══════════════════════════════════════════════════════════════════════════════
# ÉTAPE 4 — Identifier le dernier snapshot
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "Étape 4/6 — Identification du dernier snapshot"

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

# ══════════════════════════════════════════════════════════════════════════════
# ÉTAPE 5 — Replay Shadow
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "Étape 5/6 — Replay Shadow"

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
    Write-Fail "replay-shadow-from-input-snapshot.js a échoué (exit $ReplayExit)."
}

# Extraire le nom du rapport shadow depuis stdout
$ReportMatch = $ReplayOutput | Select-String -Pattern "\[Replay-V2\] Rapport ecrit : (shadow-bc-input-replay-[^\s]+\.json)"
if (-not $ReportMatch) {
    Write-Fail ("Impossible de détecter le rapport shadow dans la sortie du replay.`n" +
                "Ligne attendue : [Replay-V2] Rapport ecrit : shadow-bc-input-replay-*.json")
}
$ReportFname = $ReportMatch.Matches[0].Groups[1].Value
$ReportPath  = Join-Path $RepoRoot "data\shadow\$ReportFname"
Write-Ok "Rapport shadow : data\shadow\$ReportFname"

# ══════════════════════════════════════════════════════════════════════════════
# ÉTAPE 6 — Analyse Shadow Report
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "Étape 6/6 — Analyse Shadow Report"

# Chercher le dernier fichier approved hints
$HintsDir = Join-Path $RepoRoot "data\review-learning"
$AnalyzeArgs = @("scripts\analyze-shadow-report.js", $ReportPath,
                 "--export-review", "--export-review-csv")

if (Test-Path $HintsDir) {
    $LatestHints = Get-ChildItem -Path $HintsDir -Filter "review-reason-hint-candidates-approved-*.json" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($LatestHints) {
        $AnalyzeArgs += "--review-reason-hints"
        $AnalyzeArgs += $LatestHints.FullName
        Write-Host "  Hints approuvés : $($LatestHints.Name)" -ForegroundColor DarkGray
    } else {
        Write-Warn "Aucun fichier approved hints trouvé dans data\review-learning — analyse sans hints"
    }
} else {
    Write-Warn "Dossier data\review-learning absent — analyse sans hints"
}

if ($ClientFilter) {
    $AnalyzeArgs += "--client"
    $AnalyzeArgs += $ClientFilter
}

Write-Host "  Commande : node $($AnalyzeArgs -join ' ')" -ForegroundColor DarkGray

$AnalyzeOutput = node @AnalyzeArgs 2>&1
$AnalyzeOutput | Write-Host
$AnalyzeExit   = $LASTEXITCODE

if ($AnalyzeExit -ne 0) {
    Write-Fail "analyze-shadow-report.js a échoué (exit $AnalyzeExit)."
}
Write-Ok "Analyse terminée"

# ══════════════════════════════════════════════════════════════════════════════
# RÉSUMÉ — Fichiers générés + métriques
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  RÉSUMÉ DU CYCLE" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkCyan

# Snapshot
Write-Host "  Snapshot      : $($LatestSnapshot.Name) ($SnapLines BC)" -ForegroundColor White

# Rapport shadow
Write-Host "  Shadow report : data\shadow\$ReportFname" -ForegroundColor White

# Fichiers exports détectés (review candidates, auto candidates, legacy-vs-clean)
$ShadowDir = Join-Path $RepoRoot "data\shadow"

$TsPattern  = ($ReportFname -replace "shadow-bc-input-replay-","" -replace "\.json","")

$ReviewJson = Get-ChildItem -Path $ShadowDir -Filter "review-candidates-$TsPattern.json" -ErrorAction SilentlyContinue | Select-Object -First 1
$ReviewCsv  = Get-ChildItem -Path $ShadowDir -Filter "review-candidates-$TsPattern.csv"  -ErrorAction SilentlyContinue | Select-Object -First 1
$AutoCsv    = Get-ChildItem -Path $ShadowDir -Filter "auto-candidates-admin-$TsPattern.csv" -ErrorAction SilentlyContinue | Select-Object -First 1
$CompJson   = Get-ChildItem -Path $ShadowDir -Filter "legacy-vs-clean-$TsPattern.json"    -ErrorAction SilentlyContinue | Select-Object -First 1

if ($ReviewJson) { Write-Host "  Review JSON   : data\shadow\$($ReviewJson.Name)" -ForegroundColor White }
if ($ReviewCsv)  { Write-Host "  Review CSV    : data\shadow\$($ReviewCsv.Name)"  -ForegroundColor White }
if ($AutoCsv)    { Write-Host "  Auto CSV      : data\shadow\$($AutoCsv.Name)"    -ForegroundColor White }
if ($CompJson)   { Write-Host "  Legacy/Clean  : data\shadow\$($CompJson.Name)"   -ForegroundColor White }

# Métriques extraites de la sortie analyze
function Extract-Metric { param([string[]]$Lines, [string]$Pattern)
    $m = $Lines | Select-String -Pattern $Pattern | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value } else { return "?" }
}

$AllOut = $AnalyzeOutput -join "`n"

$LegacyCount    = if ($AllOut -match "total_legacy_matches['""\s:]+(\d+)") { $Matches[1] } else { "?" }
$CleanCount     = if ($AllOut -match "total_clean_matches['""\s:]+(\d+)")  { $Matches[1] } else { "?" }
$LegacyOnly     = if ($AllOut -match "total_legacy_only['""\s:]+(\d+)")    { $Matches[1] } else { "?" }
$CleanOnly      = if ($AllOut -match "total_clean_only['""\s:]+(\d+)")     { $Matches[1] } else { "?" }
$AutoCands      = if ($AllOut -match "clean_auto_notify.*?:\s*(\d+)")      { $Matches[1] } else { "?" }
$ReviewCands    = if ($AllOut -match "clean_review_candidates.*?:\s*(\d+)") { $Matches[1] } else { "?" }
$GuardsBlocked  = if ($AllOut -match "guard_impact_global.*?(\d+) entrée") { $Matches[1] } else { "?" }
$FpRate         = if ($AllOut -match "fp_rate_pct['""\s:]+(\d+)")          { $Matches[1] } else { "?" }

Write-Host ""
Write-Host "  ── Métriques ───────────────────────────────────────" -ForegroundColor DarkCyan
Write-Host "  BC snapshot       : $SnapLines" -ForegroundColor White
Write-Host "  Legacy matches    : $LegacyCount" -ForegroundColor White
Write-Host "  Clean matches     : $CleanCount" -ForegroundColor White
Write-Host "  Legacy only       : $LegacyOnly  (FP taux legacy ≈ ${FpRate}%)" -ForegroundColor White
Write-Host "  Clean only        : $CleanOnly" -ForegroundColor White
Write-Host "  Auto candidates   : $AutoCands" -ForegroundColor White
Write-Host "  Review candidates : $ReviewCands" -ForegroundColor White
if ($LatestHints) {
    Write-Host "  Hints appliqués   : $($LatestHints.Name)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  git status --short (fin de cycle)" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkCyan

& git status --short

Write-Host ""
Write-Host "  Cycle terminé — aucun commit, aucun push." -ForegroundColor Green
Write-Host "  Log scan : logs\snapshot-only-full-$SessionTs.log" -ForegroundColor DarkGray
Write-Host ""
