#Requires -Version 5.1
<#
.SYNOPSIS
    Lance le pilote feedback -> learning pour les clients actifs.

.USAGE
    .\ops\feedback-cycle.ps1
    .\ops\feedback-cycle.ps1 -DryRun
    .\ops\feedback-cycle.ps1 -ClientId <uuid>
    .\ops\feedback-cycle.ps1 -Since 2026-07-01T00:00:00Z
#>

param(
    [switch]$DryRun,
    [string]$ClientId = "",
    [string]$Since = "",
    [ValidateSet("bc", "mp")]
    [string]$RadarType = "bc"
)

$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$argsList = @(
    "scripts/run-feedback-learning-cycle.js",
    "--radar-type",
    $RadarType
)

if ($DryRun) {
    $argsList += "--dry-run"
}

if ($ClientId) {
    $argsList += "--client-id"
    $argsList += $ClientId
}

if ($Since) {
    $argsList += "--since"
    $argsList += $Since
}

Write-Host ""
Write-Host "=== RADAR BC - FEEDBACK LEARNING AUTOPILOT ===" -ForegroundColor Cyan
Write-Host ""

& node @argsList
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Error "Cycle feedback echoue (code $exitCode)."
    exit $exitCode
}

Write-Host ""
Write-Host "OK : cycle feedback termine." -ForegroundColor Green
Write-Host ""
