param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$PythonExecutable
)
$ErrorActionPreference = 'Stop'
$runtimeFolder = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$pythonFile = (Resolve-Path -LiteralPath $PythonExecutable).Path
$scriptFile = Join-Path $runtimeFolder 'tools\reach.py'
if (-not (Test-Path -LiteralPath $scriptFile)) { throw 'Installed REACH runtime was not found' }
$taskName = 'SignalREACH Supervisor'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Principal.UserId -notin @($identity.Name, $identity.User.Value)) {
        throw 'An existing supervisor task belongs to another Windows account'
    }
    $backupFolder = Join-Path $runtimeFolder ('backups\host-watchdog-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupFolder | Out-Null
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $backupFolder 'task.xml') -Encoding UTF8
}
$action = New-ScheduledTaskAction -Execute $pythonFile -Argument ('"' + $scriptFile + '" supervise') -WorkingDirectory $runtimeFolder
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $identity.Name),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Keep the installed REACH relay and provisioned private model connections available; recover a stopped supervisor.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Installed the current-user SignalREACH Supervisor recovery task.'
