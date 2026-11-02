$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'data/public-companion/persistent.json') -Raw | ConvertFrom-Json
# Keep the login task alive through a supervisor crash. Zero means explicit tray Quit.
while ($true) {
    $process = Start-Process -FilePath $config.node -ArgumentList @('"' + (Join-Path $PSScriptRoot 'public-companion-supervisor.mjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'data/public-companion/logs/supervisor.log') -RedirectStandardError (Join-Path $projectRoot 'data/public-companion/logs/supervisor-error.log')
    $processHandle = $process.Handle
    $process.WaitForExit()
    $result = $process.ExitCode
    if ($null -ne $result -and $result -eq 0) { exit 0 }
    Start-Sleep -Seconds 5
}
