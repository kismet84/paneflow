$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot "release"
$outputRoot = Join-Path $releaseRoot "relay-deploy"
$relaySource = Join-Path $projectRoot "remote\relay"
$protocolSource = Join-Path $projectRoot "packages\remote-protocol"

$resolvedReleaseRoot = [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$resolvedOutputRoot = [System.IO.Path]::GetFullPath($outputRoot)
$expectedPrefix = "$resolvedReleaseRoot$([System.IO.Path]::DirectorySeparatorChar)"
if (-not $resolvedOutputRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Relay deployment output must stay inside the release directory."
}

if (Test-Path -LiteralPath $resolvedOutputRoot) {
    Remove-Item -LiteralPath $resolvedOutputRoot -Recurse -Force
}

$relayOutput = Join-Path $resolvedOutputRoot "remote\relay"
$protocolOutput = Join-Path $resolvedOutputRoot "packages\remote-protocol"
New-Item -ItemType Directory -Path $relayOutput, $protocolOutput -Force | Out-Null

foreach ($name in @("package.json", "package-lock.json", "tsconfig.json")) {
    Copy-Item -LiteralPath (Join-Path $relaySource $name) -Destination $relayOutput
}
Copy-Item -LiteralPath (Join-Path $relaySource "src") -Destination $relayOutput -Recurse
Copy-Item -LiteralPath (Join-Path $relaySource "public") -Destination $relayOutput -Recurse

Copy-Item -LiteralPath (Join-Path $protocolSource "package.json") -Destination $protocolOutput
Copy-Item -LiteralPath (Join-Path $protocolSource "src") -Destination $protocolOutput -Recurse

foreach ($name in @(".dockerignore", ".env.example", "Caddyfile", "Dockerfile")) {
    Copy-Item -LiteralPath (Join-Path $relaySource $name) -Destination $resolvedOutputRoot
}
foreach ($name in @("README.md", "README.zh-CN.md")) {
    Copy-Item -LiteralPath (Join-Path $relaySource "deploy\$name") -Destination $resolvedOutputRoot
}

$sourceContext = "context: ../.."
$sourceDockerfile = "dockerfile: remote/relay/Dockerfile"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
foreach ($name in @("docker-compose.yml", "docker-compose.proxy.yml")) {
    $composeSource = Get-Content -LiteralPath (Join-Path $relaySource $name) -Raw
    if (-not $composeSource.Contains($sourceContext) -or -not $composeSource.Contains($sourceDockerfile)) {
        throw "The Relay Compose build paths changed in $name. Update the deployment packager before packaging."
    }
    $deployCompose = $composeSource.Replace($sourceContext, "context: .").Replace($sourceDockerfile, "dockerfile: Dockerfile")
    [System.IO.File]::WriteAllText((Join-Path $resolvedOutputRoot $name), $deployCompose, $utf8NoBom)
}

$fileCount = (Get-ChildItem -LiteralPath $resolvedOutputRoot -Recurse -File).Count
Write-Host "Relay deployment package created: $resolvedOutputRoot"
Write-Host "Files: $fileCount"
