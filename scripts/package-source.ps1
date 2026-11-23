param([string]$DestinationRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
if (!$DestinationRoot) { $DestinationRoot = Join-Path $projectRoot 'release' }
$destination = [IO.Path]::GetFullPath($DestinationRoot)
foreach ($item in @('server','public','config','tests','scripts','launcher','player','deployment','android','ui','docs','.github')) {
  $sourcePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $item)).TrimEnd('\')
  if ($destination.TrimEnd('\') -eq $sourcePath -or $destination.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Output cannot be inside a packaged source directory: $sourcePath" }
}
$bundleName = "Yingjian-LAN-$version-Source"
$bundleRoot = Join-Path $destination $bundleName
$archive = "$bundleRoot.zip"
if ((Test-Path -LiteralPath $bundleRoot) -or (Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath "$archive.partial")) { throw "Output exists. Choose another -DestinationRoot: $bundleRoot" }
New-Item -ItemType Directory -Path $bundleRoot | Out-Null
foreach ($item in @('server','public','config','tests','scripts','launcher','player','deployment','ui','docs','.github','package.json','package-lock.json','Dockerfile','docker-compose.yml','.dockerignore','.env.example','.gitignore','.gitattributes','.editorconfig','start-windows.cmd','README.md','AUTHORS.md','THIRD-PARTY.md','API-CONTRACT.md')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $bundleRoot -Recurse -Force
}
foreach ($optional in @('LICENSE','LICENSE.md','CONTRIBUTING.md','SECURITY.md')) {
  $optionalPath = Join-Path $projectRoot $optional
  if (Test-Path -LiteralPath $optionalPath) { Copy-Item -LiteralPath $optionalPath -Destination $bundleRoot }
}
$androidTarget = Join-Path $bundleRoot 'android'
New-Item -ItemType Directory -Path (Join-Path $androidTarget 'app') -Force | Out-Null
foreach ($item in @('build.gradle','settings.gradle','gradle.properties','gradlew','gradlew.bat','build-local.ps1','.gitignore','README.md','THIRD-PARTY.md','gradle')) {
  $sourceItem = Join-Path $projectRoot "android/$item"
  if (Test-Path -LiteralPath $sourceItem) { Copy-Item -LiteralPath $sourceItem -Destination $androidTarget -Recurse -Force }
}
$androidTests = Join-Path $androidTarget 'tests'
New-Item -ItemType Directory -Path $androidTests -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'android/tests') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $androidTests -Force }
foreach ($item in @('src','libs','build.gradle')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "android/app/$item") -Destination (Join-Path $androidTarget 'app') -Recurse -Force
}
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
Get-Item -LiteralPath $archive | Select-Object FullName,Length
