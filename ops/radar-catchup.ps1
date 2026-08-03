#Requires -Version 5.1
<#
.SYNOPSIS
    Draine immediatement le backlog BC par scans manuels successifs.

.DESCRIPTION
    - Utilise uniquement l'API locale /api/scan-now.
    - Attend la fin reelle de chaque scan via [SCAN_SUMMARY].
    - S'arrete des que skipped_for_next=0.
    - Nombre de cycles borne par MaxRounds.
    - Ne modifie ni scoring, ni profils, ni configuration.

.USAGE
    .\ops\radar-catchup.ps1
    .\ops\radar-catchup.ps1 -MaxRounds 4
#>

param(
    [ValidateRange(1, 10)]
    [int]$MaxRounds = 4,

    [ValidateRange(2, 30)]
    [int]$PollSeconds = 5,

    [ValidateRange(5, 60)]
    [int]$MaxMinutesPerScan = 30
)

$ErrorActionPreference = "Stop"

$REPO     = "C:\PROJETS_AI\projet_claude\radar-bc-bot-clean-2"
$ENV_FILE = Join-Path $REPO ".env"
$LOG      = Join-Path $REPO "logs\radar-bc-runtime.log"
$BASE_URL = "http://127.0.0.1:3000"

function Assert-Repo {
    $here = (Get-Location).Path.TrimEnd('\')
    if ($here -ne $REPO.TrimEnd('\')) {
        throw "Ce script doit etre lance depuis $REPO (actuel : $here)"
    }
}

function Get-EnvValue {
    param([string]$Name)

    if (-not (Test-Path $ENV_FILE)) { return "" }

    $line = Get-Content $ENV_FILE -Encoding UTF8 -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ("^\s*" + [regex]::Escape($Name) + "\s*=") } |
        Select-Object -Last 1

    if (-not $line) { return "" }

    return (($line -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Get-ApiUrl {
    param([string]$Path)

    $secret = Get-EnvValue "ADMIN_SECRET"
    if (-not $secret) { return $BASE_URL + $Path }

    $encoded = [uri]::EscapeDataString($secret)
    $sep = if ($Path.Contains("?")) { "&" } else { "?" }
    return $BASE_URL + $Path + $sep + "secret=" + $encoded
}

function Get-Status {
    $url = Get-ApiUrl "/api/status"
    return Invoke-RestMethod -Method GET -Uri $url -TimeoutSec 10
}

function Get-LastScanSummary {
    if (-not (Test-Path $LOG)) { return $null }

    return Select-String -Path $LOG -Pattern "\[SCAN_SUMMARY\]" -ErrorAction SilentlyContinue |
        Select-Object -Last 1 |
        ForEach-Object { $_.Line }
}

function Parse-ScanSummary {
    param([string]$Line)

    if (-not $Line) { return $null }

    $pattern = "runId=(?<runId>\S+).*?source=(?<source>\S+).*?duration=(?<duration>\d+)s.*?portal_total=(?<portal>\d+).*?known_count=(?<known>\d+).*?new=(?<new>\d+).*?loaded=(?<loaded>\d+).*?failed=(?<failed>\d+).*?vus_added=(?<vus>\d+).*?no_delivery_retry=(?<retry>\d+).*?skipped_for_next=(?<skipped>\d+).*?status=(?<status>\S+)"
    $m = [regex]::Match($Line, $pattern)
    if (-not $m.Success) {
        throw "SCAN_SUMMARY illisible : $Line"
    }

    return [pscustomobject]@{
        RunId             = $m.Groups["runId"].Value
        Source            = $m.Groups["source"].Value
        DurationSeconds   = [int]$m.Groups["duration"].Value
        PortalTotal       = [int]$m.Groups["portal"].Value
        KnownCount        = [int]$m.Groups["known"].Value
        NewCount          = [int]$m.Groups["new"].Value
        Loaded            = [int]$m.Groups["loaded"].Value
        Failed            = [int]$m.Groups["failed"].Value
        VusAdded          = [int]$m.Groups["vus"].Value
        NoDeliveryRetry   = [int]$m.Groups["retry"].Value
        SkippedForNext    = [int]$m.Groups["skipped"].Value
        Status            = $m.Groups["status"].Value
        Raw               = $Line
    }
}

function Wait-NextScanSummary {
    param(
        [string]$PreviousLine,
        [datetime]$Deadline
    )

    while ((Get-Date) -lt $Deadline) {
        Start-Sleep -Seconds $PollSeconds

        try {
            $status = Get-Status
        }
        catch {
            throw "Radar local indisponible pendant le rattrapage : $($_.Exception.Message)"
        }

        $line = Get-LastScanSummary
        if ($line -and $line -ne $PreviousLine -and -not $status.scanningBC) {
            return Parse-ScanSummary $line
        }
    }

    throw "Aucun nouveau SCAN_SUMMARY avant le delai de $MaxMinutesPerScan minute(s)."
}

function Start-Or-JoinScan {
    param([string]$PreviousLine)

    $status = Get-Status
    if ($status.status -ne "running") {
        throw "Radar local non operationnel."
    }

    if ($status.scanningBC) {
        Write-Host "Un scan est deja en cours : rattachement au scan existant." -ForegroundColor Yellow
    }
    else {
        $url = Get-ApiUrl "/api/scan-now"
        try {
            $response = Invoke-RestMethod -Method POST -Uri $url -TimeoutSec 15
            if (-not $response.accepted) {
                throw "Le scan manuel n'a pas ete accepte."
            }
            Write-Host "Scan manuel accepte a $($response.accepted_at)."
        }
        catch {
            $responseCode = $null
            if ($_.Exception.Response) {
                $responseCode = [int]$_.Exception.Response.StatusCode
            }
            if ($responseCode -eq 409) {
                Write-Host "Un scan vient de demarrer : rattachement au scan existant." -ForegroundColor Yellow
            }
            else {
                throw
            }
        }
    }

    $deadline = (Get-Date).AddMinutes($MaxMinutesPerScan)
    return Wait-NextScanSummary -PreviousLine $PreviousLine -Deadline $deadline
}

Assert-Repo

if (-not (Test-Path $LOG)) {
    throw "Log runtime introuvable : $LOG"
}

Write-Host ""
Write-Host "=== RADAR BC - RATTRAPAGE BACKLOG ===" -ForegroundColor Cyan
Write-Host "Max cycles : $MaxRounds"
Write-Host "Delai max  : $MaxMinutesPerScan minute(s) par scan"
Write-Host ""

$initialStatus = Get-Status
if ($initialStatus.status -ne "running") {
    throw "Radar local hors ligne."
}

$completedRounds = 0
$totalLoaded = 0
$totalFailed = 0
$lastResult = $null

for ($round = 1; $round -le $MaxRounds; $round++) {
    Write-Host "--- Cycle $round/$MaxRounds ---" -ForegroundColor Cyan

    $previousLine = Get-LastScanSummary
    $result = Start-Or-JoinScan -PreviousLine $previousLine

    $completedRounds++
    $totalLoaded += $result.Loaded
    $totalFailed += $result.Failed
    $lastResult = $result

    Write-Host "runId            : $($result.RunId)"
    Write-Host "new              : $($result.NewCount)"
    Write-Host "loaded           : $($result.Loaded)"
    Write-Host "failed           : $($result.Failed)"
    Write-Host "skipped_for_next : $($result.SkippedForNext)"
    Write-Host "status           : $($result.Status)"
    Write-Host ""

    if ($result.Status -ne "ok") {
        throw "Scan termine avec status=$($result.Status)."
    }

    if ($result.Failed -gt 0) {
        throw "Scan termine avec $($result.Failed) fiche(s) en echec."
    }

    if ($result.SkippedForNext -eq 0) {
        Write-Host "Backlog draine : aucun BC laisse pour le scan suivant." -ForegroundColor Green
        break
    }

    if ($round -lt $MaxRounds) {
        Write-Host "$($result.SkippedForNext) BC restent a traiter. Nouveau cycle immediat." -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}

if ($lastResult -and $lastResult.SkippedForNext -gt 0) {
    throw "Limite de $MaxRounds cycles atteinte avec $($lastResult.SkippedForNext) BC encore en attente."
}

Write-Host ""
Write-Host "=== RESULTAT RATTRAPAGE ===" -ForegroundColor Green
Write-Host "Cycles termines : $completedRounds"
Write-Host "BC charges      : $totalLoaded"
Write-Host "Echecs          : $totalFailed"
Write-Host "Backlog restant : $(if ($lastResult) { $lastResult.SkippedForNext } else { 'inconnu' })"
Write-Host "Dernier runId   : $(if ($lastResult) { $lastResult.RunId } else { 'N/A' })"
Write-Host ""
