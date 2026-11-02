$ErrorActionPreference = 'Stop'
$companionRoot = Split-Path -Parent $PSScriptRoot
$previousJavaOptions = $env:JAVA_TOOL_OPTIONS
Push-Location $companionRoot
try {
    & npm.cmd run sync
    if ($LASTEXITCODE -ne 0) { throw 'Android asset synchronization failed.' }
    $socketDirectory = Join-Path $companionRoot '.java-tmp'
    New-Item -ItemType Directory -Path $socketDirectory -Force | Out-Null
    # Keep Windows Unix socket paths on the project's real volume instead of profile junctions.
    $env:JAVA_TOOL_OPTIONS = ($previousJavaOptions + ' -Djdk.net.unixdomain.tmpdir="' + $socketDirectory.Replace('\', '/') + '"').Trim()
    & ./android/gradlew.bat -p android assembleDebug --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'Android APK build failed.' }
    Get-Item -LiteralPath (Join-Path $companionRoot 'android/app/build/outputs/apk/debug/app-debug.apk')
} finally {
    $env:JAVA_TOOL_OPTIONS = $previousJavaOptions
    Pop-Location
}
