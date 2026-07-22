#Requires -Version 5.1
<#
.SYNOPSIS
    Gere la tache Windows du cycle feedback -> learning.

.USAGE
    .\ops\feedback-task.ps1 install
    .\ops\feedback-task.ps1 status
    .\ops\feedback-task.ps1 run
    .\ops\feedback-task.ps1 remove
    .\ops\feedback-task.ps1 install -EveryHours 4

.SECURITY
    - Aucun scan.
    - Aucune notification.
    - Aucun appel Fly.
    - Aucun commit ni push Git.
    - Un mutex bloque les executions simultanees.
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "status", "run", "remove")]
    [string]$Action = "status",

    [ValidateRange(1, 24)]
    [int]$EveryHours = 4,

    [string]$TaskName = "RadarBC-FeedbackLearning"
)

$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$cycleScript = Join-Path $PSScriptRoot "feedback-cycle.ps1"
$logDir = Join-Path $repo "data\feedback\task-logs"
$mutexName = "Local\RadarBCFeedbackLearning"

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message"
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Invoke-FeedbackTaskRun {
    if (-not (Test-Path $cycleScript)) {
        throw "Script cycle introuvable : $cycleScript"
    }

    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    $lockTaken = $false

    try {
        $lockTaken = $mutex.WaitOne(0)
        if (-not $lockTaken) {
            Write-Info "Un cycle feedback est deja en cours. Execution ignoree."
            return
        }

        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $logFile = Join-Path $logDir "feedback-task-$timestamp.log"
        $powershellExe = Join-Path $PSHOME "powershell.exe"

        if (-not (Test-Path $powershellExe)) {
            $powershellExe = "powershell.exe"
        }

        Write-Info "Cycle feedback demarre."
        Write-Info "Log : $logFile"

        & $powershellExe `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $cycleScript 2>&1 |
            Tee-Object -FilePath $logFile

        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "Cycle feedback echoue (code $exitCode). Voir $logFile"
        }

        Get-ChildItem -Path $logDir -Filter "feedback-task-*.log" -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip 30 |
            Remove-Item -Force -ErrorAction SilentlyContinue

        Write-Ok "Cycle feedback termine."
    }
    finally {
        if ($lockTaken) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

function Install-FeedbackTask {
    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        throw "Le module ScheduledTasks est indisponible."
    }

    $scriptPath = $MyInvocation.MyCommand.Path
    $powershellExe = Join-Path $PSHOME "powershell.exe"

    if (-not (Test-Path $powershellExe)) {
        $powershellExe = "powershell.exe"
    }

    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '" run'
    $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $arguments -WorkingDirectory $repo

    $startAt = (Get-Date).AddMinutes(2)
    $trigger = New-ScheduledTaskTrigger `
        -Once `
        -At $startAt `
        -RepetitionInterval (New-TimeSpan -Hours $EveryHours) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Radar BC - cycle feedback vers learning, sans scan ni notification" `
        -Force | Out-Null

    Write-Ok "Tache installee : $TaskName"
    Write-Info "Frequence : toutes les $EveryHours heure(s)"
    Write-Info "Premier lancement : $startAt"
}

function Show-FeedbackTaskStatus {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Info "Tache absente : $TaskName"
        return
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName

    Write-Host "TaskName       : $TaskName"
    Write-Host "State          : $($task.State)"
    Write-Host "LastRunTime    : $($info.LastRunTime)"
    Write-Host "LastTaskResult : $($info.LastTaskResult)"
    Write-Host "NextRunTime    : $($info.NextRunTime)"
    Write-Host "Logs           : $logDir"
}

function Remove-FeedbackTask {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Info "Tache deja absente : $TaskName"
        return
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok "Tache supprimee : $TaskName"
}

Set-Location $repo

switch ($Action) {
    "install" { Install-FeedbackTask }
    "status"  { Show-FeedbackTaskStatus }
    "run"     { Invoke-FeedbackTaskRun }
    "remove"  { Remove-FeedbackTask }
}
