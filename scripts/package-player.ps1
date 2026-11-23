param([string]$DestinationRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
if (!$DestinationRoot) { $DestinationRoot = Join-Path $projectRoot 'release' }
$destination = [IO.Path]::GetFullPath($DestinationRoot)
$sourcePath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'player')).TrimEnd('\')
if ($destination.TrimEnd('\') -eq $sourcePath -or $destination.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Output cannot be inside player source directory.' }
$bundleName = "Yingjian-Player-$version-Windows"
$bundleRoot = Join-Path $destination $bundleName
$archive = "$bundleRoot.zip"
if ((Test-Path -LiteralPath $bundleRoot) -or (Test-Path -LiteralPath $archive)) { throw "Output exists. Choose another -DestinationRoot: $bundleRoot" }
New-Item -ItemType Directory -Path $bundleRoot | Out-Null
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'player') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $bundleRoot }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($bundleRoot, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
[pscustomobject]@{ Bundle = $bundleRoot; Archive = $archive; Bytes = (Get-Item -LiteralPath $archive).Length } | ConvertTo-Json
