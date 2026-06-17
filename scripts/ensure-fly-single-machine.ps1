param(
    [string]$AppName = "radar-bc-bot",
    [string]$FraId = "d8d054dc2e6648",
    [string]$CdgId = "48e7364b99d778"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Radar BC - Fly single-machine guard" -ForegroundColor Cyan
Write-Host "App: $AppName"
Write-Host ""

function Assert-CommandExists {
    param([string]$CommandName)

    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: command '$CommandName' not found." -ForegroundColor Red
        Write-Host "Install Fly CLI or open a terminal where flyctl is available." -ForegroundColor Red
        exit 1
    }
}

function Get-MachineState {
    param(
        [string[]]$Lines,
        [string]$MachineId
    )

    foreach ($line in $Lines) {
        if ($line -match [regex]::Escape($MachineId)) {
            if ($line -match '\b(started|stopped|suspended|destroyed|created)\b') {
                return $Matches[1]
            }
        }
    }

    return "unknown"
}

Assert-CommandExists "fly"

Write-Host "[1/4] Checking Fly authentication..." -ForegroundColor Yellow
$authOutput = fly auth whoami 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Fly authentication failed." -ForegroundColor Red
    Write-Host $authOutput
    exit 1
}
Write-Host "Fly auth OK: $authOutput" -ForegroundColor Green
Write-Host ""

Write-Host "[2/4] Listing machines..." -ForegroundColor Yellow
$listRaw = fly machines list --app $AppName 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: cannot list Fly machines for app '$AppName'." -ForegroundColor Red
    Write-Host $listRaw
    exit 1
}

$listRaw | ForEach-Object { Write-Host $_ }
Write-Host ""

$fraState = Get-MachineState -Lines $listRaw -MachineId $FraId
$cdgState = Get-MachineState -Lines $listRaw -MachineId $CdgId

Write-Host "[3/4] Checking FRA production machine ($FraId)..." -ForegroundColor Yellow

if ($fraState -eq "started") {
    Write-Host "FRA: started - OK" -ForegroundColor Green
} elseif ($fraState -eq "unknown") {
    Write-Host "WARNING: FRA machine not found." -ForegroundColor Magenta
    Write-Host "Expected ID: $FraId"
} else {
    Write-Host "ERROR: FRA state is '$fraState' but expected 'started'." -ForegroundColor Red
    Write-Host "To start it:"
    Write-Host "fly machine start $FraId --app $AppName" -ForegroundColor White
}
Write-Host ""

Write-Host "[4/4] Checking CDG secondary machine ($CdgId)..." -ForegroundColor Yellow

if ($cdgState -eq "stopped") {
    Write-Host "CDG: stopped - OK, no double scan." -ForegroundColor Green
} elseif ($cdgState -eq "unknown") {
    Write-Host "WARNING: CDG machine not found. If it was deleted, this is OK." -ForegroundColor Magenta
} elseif ($cdgState -eq "started") {
    Write-Host "PROBLEM: CDG is STARTED. This can cause double scans and duplicate notifications." -ForegroundColor Red
    Write-Host ""
    Write-Host "Command to run:"
    Write-Host "fly machine stop $CdgId --app $AppName" -ForegroundColor White
    Write-Host ""

    $confirm = Read-Host "Stop CDG now? [O/n]"
    if ($confirm -eq "" -or $confirm -match "^[OoYy]") {
        Write-Host "Stopping CDG..." -ForegroundColor Yellow
        fly machine stop $CdgId --app $AppName
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: failed to stop CDG." -ForegroundColor Red
            exit 1
        }

        Write-Host ""
        Write-Host "Final machine state:" -ForegroundColor Cyan
        fly machines list --app $AppName
    } else {
        Write-Host "CDG was not stopped by this script." -ForegroundColor Magenta
        exit 2
    }
} else {
    Write-Host "CDG state is '$cdgState'. Expected 'stopped'." -ForegroundColor Magenta
}

Write-Host ""
Write-Host "Guard completed." -ForegroundColor Cyan

