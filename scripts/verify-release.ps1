param([string]$ReleaseRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if (!$ReleaseRoot) { $ReleaseRoot = Join-Path $projectRoot 'release' }
# Windows PowerShell 5.1 does not resolve all ZIP types from FileSystem alone.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$offlineName = 'Yingjian-Server-0.1.4-nas1-linux-amd64-Offline'
$offlineFiles = @('image.tar','image-metadata.txt','image.tar.sha256','verification.json','docker-compose.yml','.env.example','deploy.sh','README.md','THIRD-PARTY.md','manifest.json')

function Read-ZipText($Entry) {
  if (!$Entry -or $Entry.Length -gt 2MB) { throw 'Missing or oversized ZIP metadata.' }
  $stream = $Entry.Open()
  $buffer = [IO.MemoryStream]::new()
  try {
    $stream.CopyTo($buffer)
    return [Text.UTF8Encoding]::new($false, $true).GetString($buffer.ToArray())
  } finally { $buffer.Dispose(); $stream.Dispose() }
}

function Get-ZipEntryHash($Entry) {
  $stream = $Entry.Open()
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Test-OfflineBundle($Entries, [string]$Prefix, [string]$Label) {
  $bundleEntries = @{}
  foreach ($path in $Entries.Keys) {
    if ($path.StartsWith($Prefix, [StringComparison]::Ordinal)) {
      $relative = $path.Substring($Prefix.Length)
      if ($offlineFiles -cnotcontains $relative) { throw "$Label has an unexpected offline bundle file: $relative" }
      $bundleEntries[$relative] = $Entries[$path]
    }
  }
  if ($bundleEntries.Count -ne $offlineFiles.Count) { throw "$Label must contain exactly the 10 offline bundle files." }
  foreach ($name in $offlineFiles) {
    if (!$bundleEntries.ContainsKey($name) -or $bundleEntries[$name].Length -le 0) { throw "$Label missing or empty: $name" }
  }

  $manifest = Read-ZipText $bundleEntries['manifest.json'] | ConvertFrom-Json
  $verification = Read-ZipText $bundleEntries['verification.json'] | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.appVersion -cne '0.1.4' -or
      $verification.schemaVersion -ne 1 -or $verification.appVersion -cne '0.1.4') {
    throw "$Label has an unsupported offline manifest or verification report."
  }
  if ($verification.verificationMode -cne 'docker-runtime' -or
      $verification.passed -isnot [bool] -or !$verification.passed) {
    throw "$Label requires successful Docker runtime verification."
  }
  $verifiedAt = [DateTimeOffset]::MinValue
  if (![DateTimeOffset]::TryParse([string]$verification.verifiedAt, [ref]$verifiedAt) -or
      $manifest.verifiedAt -cne $verification.verifiedAt) {
    throw "$Label has an invalid or inconsistent verification timestamp."
  }
  foreach ($image in @($manifest.image, $verification.image)) {
    if (!$image -or $image.tag -cne 'yingjian-server:0.1.4-nas1' -or
        $image.platform -cne 'linux/amd64' -or $image.id -cnotmatch '^sha256:[a-f0-9]{64}$') {
      throw "$Label has an invalid verified image identity."
    }
  }
  if ($manifest.image.id -cne $verification.image.id) { throw "$Label manifest and report refer to different images." }
  foreach ($check in @('nonRoot','health','adminLogin','staticAssets','persistenceRecreate')) {
    if ($verification.checks.$check -isnot [bool] -or !$verification.checks.$check) {
      throw "$Label container verification did not pass: $check"
    }
  }
  $manifestFiles = @($manifest.files.PSObject.Properties.Name)
  $hashedFiles = @($offlineFiles | Where-Object { $_ -cne 'manifest.json' })
  if ($manifestFiles.Count -ne $hashedFiles.Count) { throw "$Label manifest file list differs from the offline bundle." }
  $hashes = @{}
  foreach ($name in $hashedFiles) {
    if ($manifestFiles -cnotcontains $name) { throw "$Label manifest missing $name" }
    $entry = $bundleEntries[$name]
    $hash = Get-ZipEntryHash $entry
    $hashes[$name] = $hash
    if ($manifest.files.$name.bytes -ne $entry.Length -or $manifest.files.$name.sha256 -cne $hash) {
      throw "$Label manifest checksum or size mismatch: $name"
    }
  }
  if ($verification.archive.file -cne 'image.tar' -or
      $verification.archive.bytes -ne $bundleEntries['image.tar'].Length -or
      $verification.archive.sha256 -cne $hashes['image.tar']) {
    throw "$Label image archive differs from the verified export."
  }
  $metadata = Read-ZipText $bundleEntries['image-metadata.txt']
  if ($metadata -cne "IMAGE_ID=$($verification.image.id)`nIMAGE_PLATFORM=linux/amd64`n") {
    throw "$Label image metadata differs from the verified image."
  }
  $checksum = Read-ZipText $bundleEntries['image.tar.sha256']
  if ($checksum -cne "$($hashes['image.tar'])  image.tar`n") { throw "$Label image checksum file mismatch." }
  foreach ($name in @('docker-compose.yml','deploy.sh','.env.example')) {
    $text = Read-ZipText $bundleEntries[$name]
    if ($text.Contains("`r") -or $text.StartsWith([string][char]0xFEFF, [StringComparison]::Ordinal)) { throw "$Label $name must use UTF-8 without BOM and LF." }
  }
  $compose = Read-ZipText $bundleEntries['docker-compose.yml']
  if ($compose -cnotmatch '(?m)^\s+image: yingjian-server:0\.1\.4-nas1\s*$' -or
      $compose -cnotmatch '(?m)^\s+pull_policy: never\s*$' -or $compose -match '(?m)^\s+build:') {
    throw "$Label Compose must run only the included image without build or pull."
  }
  $environment = Read-ZipText $bundleEntries['.env.example']
  $passwordLines = @($environment -split "`n" | Where-Object { $_ -match '^\s*ADMIN_PASSWORD\s*=' })
  if ($passwordLines.Count -ne 1 -or $passwordLines[0] -cne "ADMIN_PASSWORD='replace-with-your-own-password'") {
    throw "$Label must contain only the generic administrator password placeholder."
  }
  # The full TAR identity check is performed by verify-nas-offline.mjs before
  # packaging. Here we stream ZIP entry bytes and bind them to that exact report.
  return [pscustomobject]@{ Image=$verification.image; VerifiedAt=$verification.verifiedAt; ImageSHA256=$hashes['image.tar']; Checked=$true }
}

$specs = @(
  @{ Name="Yingjian-Server-$version-Windows"; Required=@('Yingjian-Server.exe','Yingjian-Server.exe.config','runtime/node.exe','runtime/LICENSE','launcher/host.mjs','server/runtime.js','server/index.js','public/index.html','node_modules/express/package.json','deployment/nas/.env.example','deployment/nas/deploy.sh') },
  @{ Name="Yingjian-Server-$version-NAS"; Source=$true; Required=@('Dockerfile','docker-compose.yml','.dockerignore','.env.example','deploy.sh','server/runtime.js','server/index.js','package-lock.json','README.md','THIRD-PARTY.md') },
  @{ Name="Yingjian-Player-$version-Windows"; Required=@('映间播放器.html','README.md') },
  @{ Name="Yingjian-LAN-$version-Source"; Source=$true; Required=@('launcher/host.mjs','launcher/windows/Launcher.cs','launcher/windows/Launcher.xaml','launcher/windows/app.manifest','deployment/nas/.env.example','scripts/package-server.ps1','server/runtime.js','tests/runtime.test.js','android/app/build.gradle','.gitignore') }
)
if (Test-Path -LiteralPath (Join-Path $ReleaseRoot "$offlineName.zip")) {
  $specs += @{ Name=$offlineName; Offline=$true; Required=$offlineFiles }
}
$reports = @()
foreach ($spec in $specs) {
  $archive = Join-Path $ReleaseRoot ($spec.Name + '.zip')
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $entryMap = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $prefix = $spec.Name + '/'
    foreach ($entry in $zip.Entries) {
      $path = $entry.FullName
      if (!$path.StartsWith($prefix, [StringComparison]::Ordinal) -or $path.Contains('\') -or
          $path.Contains(':') -or @($path.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -gt 0 -or
          !$seen.Add($path) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
        throw "$($spec.Name) contains an unsafe or duplicate ZIP path: $path"
      }
      $relative = $path.Substring($prefix.Length)
      if ($path.EndsWith('/')) { continue }
      if (!$relative -or $relative.Contains('//')) { throw "$($spec.Name) contains an invalid ZIP path: $path" }
      $entryMap.Add($relative, $entry)
    }
    $entries = @($entryMap.Keys)
    foreach ($required in $spec.Required) { if ($entries -cnotcontains $required) { throw "$($spec.Name) missing $required" } }
    $unexpected = @($entries | Where-Object { $_ -match '(^|/)(household\.json|\.env|launcher-settings\.json|launcher-self-test\.json|launcher-smoke-test\.json|\.yingjian-server\.lock)(/|$)' -or $_ -match '^(data|test-results|launcher-logs|\.git)/' -or $_ -match '\.(log|jks)$' })
    if ($unexpected.Count) { throw "$($spec.Name) includes runtime data: $($unexpected -join ', ')" }
    if ($spec.Source -and @($entries | Where-Object { $_ -match '(^|/)image\.tar$' }).Count) {
      throw "$($spec.Name) source bundle must not include an image TAR."
    }
    $offlineReport = $null
    if ($spec.Offline) { $offlineReport = Test-OfflineBundle $entryMap '' $spec.Name }
    elseif ($entryMap.ContainsKey('deployment/nas-offline/image.tar')) {
      if (!$entryMap.ContainsKey('scripts/verify-nas-offline.mjs')) { throw "$($spec.Name) missing scripts/verify-nas-offline.mjs" }
      $offlineReport = Test-OfflineBundle $entryMap 'deployment/nas-offline/' $spec.Name
    }
    $packageEntry = $entryMap['package.json']
    if ($packageEntry) {
      $packagedVersion = (Read-ZipText $packageEntry | ConvertFrom-Json).version
      if ($packagedVersion -ne $version) { throw "$($spec.Name) has wrong version." }
    }
    $shellEntry = $entryMap['deploy.sh']
    if ($shellEntry) {
      $shell = Read-ZipText $shellEntry
      if ($shell.Contains("`r")) { throw "$($spec.Name) deploy.sh must use LF." }
    }
    $report = [ordered]@{ Name=$spec.Name; Entries=$entries.Count; Bytes=(Get-Item -LiteralPath $archive).Length; SHA256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant(); Checked=$true }
    if ($offlineReport) { $report.OfflineBundle = $offlineReport }
    $reports += [pscustomobject]$report
  } finally { $zip.Dispose() }
}
$standaloneOffline = $reports | Where-Object { $_.Name -ceq $offlineName }
$windowsServer = $reports | Where-Object { $_.Name -ceq "Yingjian-Server-$version-Windows" }
if ($standaloneOffline -and $windowsServer.OfflineBundle -and
    ($standaloneOffline.OfflineBundle.ImageSHA256 -cne $windowsServer.OfflineBundle.ImageSHA256 -or
     $standaloneOffline.OfflineBundle.Image.id -cne $windowsServer.OfflineBundle.Image.id)) {
  throw 'The Windows server and standalone offline release include different NAS images.'
}
$reportPath = Join-Path $ReleaseRoot "package-validation-$version.json"
[IO.File]::WriteAllText($reportPath, ($reports | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$hashLines = $reports | ForEach-Object { "$($_.SHA256)  $($_.Name).zip" }
[IO.File]::WriteAllLines((Join-Path $ReleaseRoot "SHA256SUMS-$version.txt"), $hashLines, [Text.UTF8Encoding]::new($false))
$reports | ConvertTo-Json -Depth 6
