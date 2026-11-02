$ErrorActionPreference = 'Stop'
$taskName = 'PaneFlow-Companion-AtLogon'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw '已存在同名计划任务；请先检查其路径与归属，未覆盖。' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$script = Join-Path $PSScriptRoot 'start-paneflow-hidden.ps1'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'PaneFlow 固定公网服务；当前用户登录后自动启动。托盘退出停止本次服务。' | Select-Object TaskName,State
