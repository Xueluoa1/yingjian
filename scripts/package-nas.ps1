param([string]$DestinationRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
if (-not $DestinationRoot) { $DestinationRoot = Join-Path $projectRoot 'release' }
$destination = [IO.Path]::GetFullPath($DestinationRoot)
foreach ($item in @('server','public','config','deployment')) {
  $sourcePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $item)).TrimEnd('\')
  if ($destination.TrimEnd('\') -eq $sourcePath -or $destination.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Output cannot be inside a packaged source directory: $sourcePath" }
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$bundleName = "Yingjian-Server-$version-NAS"
$bundleRoot = Join-Path $destination $bundleName
$archive = Join-Path $destination "$bundleName.zip"
if ((Test-Path -LiteralPath $bundleRoot) -or (Test-Path -LiteralPath $archive)) {
  throw "Output already exists. Choose another -DestinationRoot to preserve configured bundles: $bundleRoot"
}
New-Item -ItemType Directory -Path $bundleRoot | Out-Null
foreach ($item in @('server', 'public', 'config', 'package.json', 'package-lock.json', 'THIRD-PARTY.md')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $bundleRoot -Recurse
}
foreach ($item in @('Dockerfile', 'docker-compose.yml', '.dockerignore', '.env.example', 'deploy.sh', 'README.md')) {
  $source = Join-Path $projectRoot "deployment/nas/$item"
  $target = Join-Path $bundleRoot $item
  # Linux shell scripts must remain UTF-8 without BOM and with LF even on Windows.
  $content = [IO.File]::ReadAllText($source).Replace("`r`n", "`n")
  [IO.File]::WriteAllText($target, $content, [Text.UTF8Encoding]::new($false))
}
# Compress-Archive can omit dotfiles on some hosts. .NET includes the whole folder.
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($bundleRoot, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
[pscustomobject]@{ Bundle = $bundleRoot; Archive = $archive; Bytes = (Get-Item -LiteralPath $archive).Length } | ConvertTo-Json
