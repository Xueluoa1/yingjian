param(
  [Parameter(Mandatory=$true)][string]$VerifiedBundle,
  [string]$DestinationRoot,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$bundle = (Resolve-Path -LiteralPath $VerifiedBundle).Path
if (!$DestinationRoot) { $DestinationRoot = Join-Path $projectRoot 'release' }
$destination = [IO.Path]::GetFullPath($DestinationRoot)
if ($destination.TrimEnd('\') -eq $bundle.TrimEnd('\') -or $destination.StartsWith($bundle.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be outside the verified bundle.' }
$node = $NodePath
if (!$node) { $node = (Get-Command node -ErrorAction Stop).Source }
$verification = & $node (Join-Path $PSScriptRoot 'verify-nas-offline.mjs') $bundle
if ($LASTEXITCODE -ne 0) { throw 'A complete, runtime-verified offline image bundle is required.' }
$report = $verification | ConvertFrom-Json
if ($report.ok -ne $true) { throw 'Offline bundle verification failed.' }
$architecture = switch -CaseSensitive ($report.image.platform) { 'linux/amd64' { 'amd64' }; 'linux/arm64' { 'arm64' }; default { throw 'Unsupported verified image architecture.' } }
$name = "Yingjian-Server-0.1.4-nas1-linux-$architecture-Offline"
$archive = Join-Path $destination "$name.zip"
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath "$archive.partial")) { throw "Output already exists: $archive" }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
# Windows PowerShell 5.1 does not resolve ZipArchiveMode from FileSystem alone.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open("$archive.partial", [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in $report.files) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $bundle $item), "$name/$item", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
Move-Item -LiteralPath "$archive.partial" -Destination $archive
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$archive.sha256", "$hash  $name.zip`n", [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ Archive=$archive; SHA256=$hash; Image=$report.image; Bytes=(Get-Item -LiteralPath $archive).Length } | ConvertTo-Json -Depth 5
