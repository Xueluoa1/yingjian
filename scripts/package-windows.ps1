param([switch]$IncludeRuntime, [string]$DestinationRoot)
$ErrorActionPreference = 'Stop'
# Kept for existing build commands; the server distribution always includes Node.
& (Join-Path $PSScriptRoot 'build-server-launcher.ps1')
& (Join-Path $PSScriptRoot 'package-server.ps1') -DestinationRoot $DestinationRoot
