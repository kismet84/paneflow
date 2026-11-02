param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
$planFile = [IO.Path]::GetFullPath($PlanPath)
$plan = Get-Content -LiteralPath $planFile -Raw | ConvertFrom-Json
$install = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($plan.executable))
$data = [IO.Path]::GetFullPath($plan.dataDirectory)
$backup = [IO.Path]::GetFullPath($plan.backupDirectory)
$planDirectory = [IO.Path]::GetDirectoryName($planFile)
$resultFile = Join-Path $planDirectory 'result.json'
$programSaved = $false
$installationStarted = $false
$newProcess = $null
function Within([string]$child,[string]$parent) { return $child.StartsWith($parent.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) }
function Assert-NoReparse([string]$path) {
  $current = [IO.Path]::GetFullPath($path)
  while ($current) {
    if (Test-Path -LiteralPath $current) { if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update path contains a reparse point; original data retained' } }
    $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
    if (!$parent -or $parent -eq $current) { break }; $current = $parent
  }
}
function Result([string]$state,[string]$message) { @{state=$state;message=$message;version=$plan.version;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8 }
try {
  if ([IO.Path]::GetFileName($plan.executable) -ne 'PaneFlow Desktop.exe' -or $install -eq [IO.Path]::GetPathRoot($install)) { throw 'Unexpected installation target' }
  if ($data -eq $install -or (Within $data $install)) { throw 'Portable data must be separated before upgrade' }
  if (Within $install $data) { throw 'Program must not be inside the data directory' }
  if (!(Within $planDirectory (Join-Path $data 'updates')) -or $backup -ne (Join-Path $planDirectory 'backup')) { throw 'Unexpected recovery location' }
  $installer = [IO.Path]::GetFullPath($plan.installer)
  foreach ($path in @($install,$data,$backup,$planFile,$installer)) { Assert-NoReparse $path }
  if (!(Within $installer (Join-Path $data 'updates'))) { throw 'Unexpected installer location' }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.sha256) { throw 'Installer checksum mismatch' }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (Get-Process -Id $plan.processId -ErrorAction SilentlyContinue) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Application did not exit; update cancelled' }; Start-Sleep -Milliseconds 500 }
  if (Test-Path -LiteralPath $backup) { throw 'Recovery destination already exists' }
  New-Item -ItemType Directory -Path $backup | Out-Null
  Copy-Item -LiteralPath $install -Destination (Join-Path $backup 'program') -Recurse
  $programSaved = $true
  $configBackup = Join-Path $backup 'data'
  New-Item -ItemType Directory -Path $configBackup | Out-Null
  Get-ChildItem -LiteralPath $data -Force | Where-Object {$_.Name -notin @('updates','chromium','logs')} | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $configBackup -Recurse }
  Result 'backed-up' 'Program and local configuration saved'
  $installationStarted = $true
  $installerProcess = Start-Process -FilePath $installer -ArgumentList @('/S',"/D=$install") -WindowStyle Hidden -PassThru -Wait
  if ($installerProcess.ExitCode -ne 0) { throw "Installer failed: $($installerProcess.ExitCode)" }
  $installedVersion = (Get-Item -LiteralPath $plan.executable).VersionInfo.ProductVersion
  if ($installedVersion -notmatch ('^'+[regex]::Escape($plan.version)+'(?:\.0)?$')) { throw 'Installed executable version did not match' }
  $env:CODEX_PANE_USER_DATA_DIR = $data
  $env:PANEFLOW_UPGRADE_READY_FILE = Join-Path $planDirectory 'ready.json'
  $env:PANEFLOW_UPGRADE_NONCE = [Guid]::NewGuid().ToString('N')
  $newProcess = Start-Process -FilePath $plan.executable -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (!(Test-Path -LiteralPath $env:PANEFLOW_UPGRADE_READY_FILE)) {
    if ($newProcess.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Updated application did not confirm successful startup' }
    Start-Sleep -Milliseconds 500
  }
  $ready = Get-Content -LiteralPath $env:PANEFLOW_UPGRADE_READY_FILE -Raw | ConvertFrom-Json
  if ($ready.version -ne $plan.version -or $ready.processId -ne $newProcess.Id -or $ready.nonce -ne $env:PANEFLOW_UPGRADE_NONCE -or $ready.codex -ne 'ready') { throw 'Startup confirmation identity or readiness mismatch' }
  Result 'installed' 'Update started successfully; backups retained'
} catch {
  $failure = $_.Exception.Message
  if ($newProcess) {
    if (!$newProcess.HasExited) {
      @{abort=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $planDirectory 'abort.json') -Encoding UTF8
      if (!$newProcess.WaitForExit(60000)) { Result 'recovery-required' ($failure+'; application did not confirm shutdown; files retained in place'); exit 2 }
    }
    $stoppedFile = Join-Path $planDirectory 'stopped.json'
    if (!(Test-Path -LiteralPath $stoppedFile)) { Result 'recovery-required' ($failure+'; owned writers shutdown not proven; files retained in place'); exit 2 }
    $stopped = Get-Content -LiteralPath $stoppedFile -Raw | ConvertFrom-Json
    if ($stopped.processId -ne $newProcess.Id -or $stopped.nonce -ne $env:PANEFLOW_UPGRADE_NONCE) { Result 'recovery-required' 'Shutdown confirmation mismatch'; exit 2 }
  }
  if ($programSaved -and $installationStarted) {
    try {
      # Every move uses the validated exact installation/recovery paths in this shell.
      $failed = Join-Path $backup 'failed-program'
      if (Test-Path -LiteralPath $failed) { throw 'Failed-program recovery path already exists' }
      if (Test-Path -LiteralPath $install) { Move-Item -LiteralPath $install -Destination $failed }
      Move-Item -LiteralPath (Join-Path $backup 'program') -Destination $install
      # Retain potentially changed data separately before restoring the pre-upgrade configuration.
      $failedData = Join-Path $backup 'failed-data'
      New-Item -ItemType Directory -Path $failedData | Out-Null
      Get-ChildItem -LiteralPath $data -Force | Where-Object {$_.Name -notin @('updates','chromium','logs')} | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $failedData }
      if (Test-Path -LiteralPath (Join-Path $backup 'data')) { Get-ChildItem -LiteralPath (Join-Path $backup 'data') -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $data -Recurse } }
      Result 'rolled-back' $failure
      $env:CODEX_PANE_USER_DATA_DIR = $data
      Remove-Item Env:PANEFLOW_UPGRADE_READY_FILE -ErrorAction SilentlyContinue
      Start-Process -FilePath $plan.executable -WindowStyle Hidden | Out-Null
    } catch { Result 'recovery-required' ($failure+'; '+$_.Exception.Message) }
  } else { Result 'cancelled' $failure }
  exit 1
}
