param([string]$DestinationRoot, [ValidateSet('amd64','arm64')][string]$Architecture)
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
if ($Architecture) { $bundleName += "-$Architecture-Source" }
$bundleRoot = Join-Path $destination $bundleName
$archive = Join-Path $destination "$bundleName.zip"
if ((Test-Path -LiteralPath $bundleRoot) -or (Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath "$archive.partial")) {
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
  if ($Architecture -and $item -eq 'docker-compose.yml') {
    $content = $content.Replace("  yingjian:`n", "  yingjian:`n    platform: linux/$Architecture`n")
  }
  if ($Architecture -and $item -eq 'README.md') {
    $content = "# 映间 NAS $Architecture 源码部署包`n`n本包指定 linux/$Architecture，不包含 image.tar。首次启动需在对应架构的 Docker 上联网下载基础镜像、安装依赖并构建。不是离线成品镜像。`n`n" + $content
  }
  [IO.File]::WriteAllText($target, $content, [Text.UTF8Encoding]::new($false))
}
if ($Architecture) {
  [IO.File]::WriteAllText((Join-Path $bundleRoot 'target-platform.txt'), "linux/$Architecture`n", [Text.UTF8Encoding]::new($false))
}
# Include dotfiles and use portable ZIP separators on Windows PowerShell too.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open("$archive.partial", [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem -LiteralPath $bundleRoot -File -Recurse -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring($bundleRoot.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "$bundleName/$relative", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
Move-Item -LiteralPath "$archive.partial" -Destination $archive
[pscustomobject]@{ Bundle = $bundleRoot; Archive = $archive; Bytes = (Get-Item -LiteralPath $archive).Length } | ConvertTo-Json
