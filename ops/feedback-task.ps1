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
    - Le fichier de hints versionne est toujours restaure apres execution.
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
$pendingHintsDir = Join-Path $repo "data\feedback\pending-learning"
$runtimeHintsDir = Join-Path $repo "data\feedback\runtime-learning"
$runtimeHintsFile = Join-Path $runtimeHintsDir "client-learning-hints.json"
$trackedHints = Join-Path $repo "data\client-learning\client-learning-hints.json"
$mutexName = "Local\RadarBCFeedbackLearning"

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message"
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Remove-Utf8Bom {
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    if ([int]$Text[0] -eq 0xFEFF) { return $Text.Substring(1) }
    return $Text
}

function Test-RuntimeArtifactValid {
    param([string]$Path)

    if (-not (Test-Path $Path)) { return $false }

    try {
        $raw = Remove-Utf8Bom ([System.IO.File]::ReadAllText($Path))
        if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
        $raw | ConvertFrom-Json | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Publish-RuntimeLearningArtifact {
    param([string]$SourcePath)

    # Contrat : ne remplace l'artifact runtime qu'apres avoir lu, nettoye et
    # valide integralement la source. Toute anomalie laisse le dernier artifact
    # valide intact et retourne $false sans lever d'exception.
    try {
        if (-not (Test-Path $SourcePath)) { return $false }

        $raw = Remove-Utf8Bom ([System.IO.File]::ReadAllText($SourcePath))
        if ([string]::IsNullOrWhiteSpace($raw)) { return $false }

        # Validation avant toute ecriture.
        $raw | ConvertFrom-Json | Out-Null

        New-Item -ItemType Directory -Path $runtimeHintsDir -Force | Out-Null
        $runtimeTemp = $runtimeHintsFile + ".tmp"

        # UTF-8 strict sans BOM : JSON.parse(readFileSync(f, "utf8")) doit
        # reussir directement cote Node.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($runtimeTemp, $raw, $utf8NoBom)

        Move-Item -Path $runtimeTemp -Destination $runtimeHintsFile -Force
        return $true
    }
    catch {
        return $false
    }
}

function Invoke-FeedbackTaskRun {
    if (-not (Test-Path $cycleScript)) {
        throw "Script cycle introuvable : $cycleScript"
    }

    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    $lockTaken = $false
    $hintsExisted = Test-Path $trackedHints
    $hintsBackup = $null
    $hintsBeforeHash = ""

    if ($hintsExisted) {
        $hintsBackup = [System.IO.File]::ReadAllBytes($trackedHints)
        $hintsBeforeHash = (Get-FileHash -Path $trackedHints -Algorithm SHA256).Hash
    }

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

        if (Test-Path $trackedHints) {
            $hintsAfterHash = (Get-FileHash -Path $trackedHints -Algorithm SHA256).Hash
            $hintsChanged = (-not $hintsExisted) -or ($hintsAfterHash -ne $hintsBeforeHash)

            if ($hintsChanged) {
                Get-Content $trackedHints -Raw -Encoding UTF8 |
                    ConvertFrom-Json | Out-Null

                New-Item -ItemType Directory -Path $pendingHintsDir -Force | Out-Null
                $pendingFile = Join-Path $pendingHintsDir "client-learning-hints-$timestamp.json"
                $pendingLatest = Join-Path $pendingHintsDir "client-learning-hints-latest.json"

                Copy-Item $trackedHints $pendingFile -Force
                Copy-Item $trackedHints $pendingLatest -Force

                $pendingMessage = "Hints learning sauvegardes localement : $pendingFile"
                Write-Info $pendingMessage
                Add-Content -Path $logFile -Value "[INFO] $pendingMessage" -Encoding UTF8

                Get-ChildItem -Path $pendingHintsDir -Filter "client-learning-hints-*.json" -File |
                    Where-Object { $_.Name -ne "client-learning-hints-latest.json" } |
                    Sort-Object LastWriteTime -Descending |
                    Select-Object -Skip 30 |
                    Remove-Item -Force -ErrorAction SilentlyContinue

                # De nouveaux hints ont ete generes : on publie ces hints.
                if (Publish-RuntimeLearningArtifact $trackedHints) {
                    $runtimeMessage = "Artifact runtime learning publie : $runtimeHintsFile"
                    Write-Info $runtimeMessage
                    Add-Content -Path $logFile -Value "[INFO] $runtimeMessage" -Encoding UTF8
                }
                else {
                    $runtimeMessage = "Artifact runtime learning inchange : source invalide"
                    Write-Info $runtimeMessage
                    Add-Content -Path $logFile -Value "[INFO] $runtimeMessage" -Encoding UTF8
                }
            }
            elseif (-not (Test-RuntimeArtifactValid $runtimeHintsFile)) {
                # Aucun nouveau feedback et aucun artifact runtime exploitable :
                # on initialise depuis le fichier stable actuel.
                if (Publish-RuntimeLearningArtifact $trackedHints) {
                    $runtimeMessage = "Artifact runtime learning initialise : $runtimeHintsFile"
                    Write-Info $runtimeMessage
                    Add-Content -Path $logFile -Value "[INFO] $runtimeMessage" -Encoding UTF8
                }
            }
            # Sinon : aucun nouveau feedback et artifact runtime deja valide,
            # on ne le reecrit pas.
        }

        Get-ChildItem -Path $logDir -Filter "feedback-task-*.log" -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip 30 |
            Remove-Item -Force -ErrorAction SilentlyContinue

        Write-Ok "Cycle feedback termine."
    }
    finally {
        # Un temporaire residuel signifie un cycle interrompu : on le supprime
        # sans toucher au dernier artifact runtime valide.
        $residualTemp = $runtimeHintsFile + ".tmp"
        if (Test-Path $residualTemp) {
            Remove-Item $residualTemp -Force -ErrorAction SilentlyContinue
        }

        if ($hintsExisted -and $null -ne $hintsBackup) {
            [System.IO.File]::WriteAllBytes($trackedHints, $hintsBackup)
        }
        elseif (-not $hintsExisted -and (Test-Path $trackedHints)) {
            Remove-Item $trackedHints -Force
        }

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

    $scriptPath = $PSCommandPath
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
    Write-Host "Pending hints  : $pendingHintsDir"
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
