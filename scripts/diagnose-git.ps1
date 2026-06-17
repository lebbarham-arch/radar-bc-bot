<#
.SYNOPSIS
  Diagnostique les incohérences Git/NTFS dans le repo Radar BC.
  Détecte les patterns D + ?? (index corrompu) et propose les corrections.

.DESCRIPTION
  Ce script est READ-ONLY : il n'exécute jamais git add, git commit,
  git restore, git reset, git checkout ni git clean.
  Il affiche uniquement des diagnostics et des commandes à copier-coller.

  Patterns détectés :
    D  <fichier>   = fichier supprimé de l'index (faux positif NTFS)
    ?? <fichier>   = même fichier apparu comme non-traqué
    MM <fichier>   = fichier stagé + modifié dans le working tree (double état)

  Cause connue :
    L'index .git/index contient des métadonnées stat() (mtime, inode)
    écrites par git Windows/NTFS. Quand Linux les relit via le mount,
    les valeurs ne correspondent pas → git marque D + ??.
    Les fins de ligne CRLF (Windows) vs LF (Linux) aggravent le problème.

  Correction standard :
    git restore --staged <fichier>   ← supprime la marque D de l'index
    Puis relancer ce script pour vérifier.

.USAGE
  Depuis le dossier du repo :
    powershell -ExecutionPolicy Bypass -File scripts\diagnose-git.ps1

  Ou depuis n'importe quel dossier :
    powershell -ExecutionPolicy Bypass -File C:\...\scripts\diagnose-git.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

# ── Résolution du répertoire racine du repo ───────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Split-Path -Parent $ScriptDir

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Radar BC — Diagnostic Git / NTFS" -ForegroundColor Cyan
Write-Host "  Repo : $RepoRoot" -ForegroundColor DarkGray
Write-Host "  Date : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

Push-Location $RepoRoot

# ── 1. git status --short ─────────────────────────────────────────────────────
Write-Host "[ 1/4 ]  git status --short" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────"
$StatusRaw = git status --short 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR : git status a échoué (code $LASTEXITCODE)" -ForegroundColor Red
    Write-Host "Vérifiez que vous êtes bien dans un dépôt git." -ForegroundColor Red
    Pop-Location
    exit 1
}
if ($StatusRaw) {
    $StatusRaw | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  (aucune modification)" -ForegroundColor Green
}
Write-Host ""

# ── 2. git diff --name-status (non stagé) ─────────────────────────────────────
Write-Host "[ 2/4 ]  git diff --name-status  (modifications non stagées)" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────"
$DiffRaw = git diff --name-status 2>&1
if ($DiffRaw) {
    $DiffRaw | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  (aucune modification non stagée)" -ForegroundColor Green
}
Write-Host ""

# ── 3. git diff --cached --name-status (stagé) ────────────────────────────────
Write-Host "[ 3/4 ]  git diff --cached --name-status  (modifications stagées)" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────"
$CachedRaw = git diff --cached --name-status 2>&1
if ($CachedRaw) {
    $CachedRaw | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  (aucun fichier stagé)" -ForegroundColor Green
}
Write-Host ""

# ── 4. Détection patterns D + ?? et MM ───────────────────────────────────────
Write-Host "[ 4/4 ]  Détection patterns D + ?? et MM (index NTFS corrompu)" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────"

# Collecter les lignes du porcelain (format stable)
$PorcelainLines = git status --porcelain 2>&1

# Chemins marqués D (supprimés dans l'index)
$DeletedInIndex = @{}
foreach ($line in $PorcelainLines) {
    # Format porcelain : "XY path" où X = index, Y = working tree
    # D en position X (index) : " D path" ou "D  path" ou "MD path"
    if ($line -match '^.D\s+(.+)$' -or $line -match '^D.\s+(.+)$') {
        $path = $matches[1].Trim()
        $DeletedInIndex[$path] = $true
    }
}

# Chemins non-traqués (??)
$Untracked = @{}
foreach ($line in $PorcelainLines) {
    if ($line -match '^\?\?\s+(.+)$') {
        $path = $matches[1].Trim()
        $Untracked[$path] = $true
    }
}

# Chemins en double état MM (stagé modifié + working tree modifié)
$DoubleModified = @{}
foreach ($line in $PorcelainLines) {
    if ($line -match '^MM\s+(.+)$') {
        $path = $matches[1].Trim()
        $DoubleModified[$path] = $true
    }
}

# Intersection D + ?? = faux positif NTFS confirmé
$DPlusQQ = @()
foreach ($path in $DeletedInIndex.Keys) {
    if ($Untracked.ContainsKey($path)) {
        $DPlusQQ += $path
    }
}

$TotalProblems = $DPlusQQ.Count + $DoubleModified.Count

if ($TotalProblems -eq 0) {
    Write-Host "  Aucun pattern D + ?? ni MM détecté." -ForegroundColor Green
    Write-Host "  Index propre du point de vue de ces patterns." -ForegroundColor Green
} else {
    Write-Host "  ATTENTION : $TotalProblems problème(s) détecté(s)" -ForegroundColor Red
    Write-Host ""

    # ── Pattern D + ?? ──────────────────────────────────────────────────────
    if ($DPlusQQ.Count -gt 0) {
        Write-Host "  Pattern D + ?? ($($DPlusQQ.Count) fichier(s)) :" -ForegroundColor Red
        Write-Host "  Cause : index .git/index corrompu par les métadonnées NTFS/Linux." -ForegroundColor DarkGray
        Write-Host "  Le fichier existe bien sur le disque mais l'index le marque supprimé." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Commandes de correction (copier-coller, une par une) :" -ForegroundColor Cyan
        foreach ($path in $DPlusQQ) {
            Write-Host ""
            Write-Host "    git restore --staged `"$path`"" -ForegroundColor White -BackgroundColor DarkBlue
        }
        Write-Host ""
        Write-Host "  Effet : supprime la marque D de l'index sans toucher au fichier." -ForegroundColor DarkGray
    }

    # ── Pattern MM ──────────────────────────────────────────────────────────
    if ($DoubleModified.Count -gt 0) {
        Write-Host ""
        Write-Host "  Pattern MM ($($DoubleModified.Count) fichier(s)) :" -ForegroundColor Magenta
        Write-Host "  Cause : fichier stagé (index) ET modifié dans le working tree." -ForegroundColor DarkGray
        Write-Host "  Sur NTFS, peut apparaître après un commit si le mount Linux a modifié" -ForegroundColor DarkGray
        Write-Host "  les métadonnées (mtime) sans changer le contenu." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Diagnostic supplémentaire recommandé :" -ForegroundColor Cyan
        foreach ($path in $DoubleModified.Keys) {
            Write-Host ""
            Write-Host "    git diff `"$path`"          # voir les modifications non stagées" -ForegroundColor White
            Write-Host "    git diff --cached `"$path`" # voir ce qui est stagé" -ForegroundColor White
        }
        Write-Host ""
        Write-Host "  Si le contenu est identique (diff vide) → faux positif NTFS." -ForegroundColor DarkGray
        Write-Host "  Correction si faux positif :" -ForegroundColor Cyan
        foreach ($path in $DoubleModified.Keys) {
            Write-Host ""
            Write-Host "    git restore --staged `"$path`"" -ForegroundColor White -BackgroundColor DarkBlue
        }
    }
}

# ── Rappel des règles Radar BC ────────────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  Règles Git obligatoires — Radar BC" -ForegroundColor DarkCyan
Write-Host "══════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  ❌  Ne jamais utiliser  git add ." -ForegroundColor Red
Write-Host "      Toujours stager explicitement :" -ForegroundColor DarkGray
Write-Host "        git add docs/PROD_RUNBOOK.md" -ForegroundColor White
Write-Host ""
Write-Host "  ✅  Sur Linux/bash, utiliser l'index temporaire :" -ForegroundColor Green
Write-Host "        GIT_INDEX_FILE=/tmp/git-index-radar git status --short" -ForegroundColor White
Write-Host "        GIT_INDEX_FILE=/tmp/git-index-radar git add <fichier>" -ForegroundColor White
Write-Host ""
Write-Host "  ✅  Après toute correction, relancer ce script pour vérifier :" -ForegroundColor Green
Write-Host "        powershell -ExecutionPolicy Bypass -File scripts\diagnose-git.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  📖  Règles complètes : docs\REGRESSION_RULES.md" -ForegroundColor DarkGray
Write-Host ""

Pop-Location
