param([string]$DestinationRoot, [string]$LauncherPath, [string]$NasOfflineBundle, [string]$NasArm64OfflineBundle)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
if (!$DestinationRoot) { $DestinationRoot = Join-Path $projectRoot 'release' }
if (!$LauncherPath) { $LauncherPath = Join-Path $projectRoot 'release/Yingjian-Server.exe' }
$destination = [IO.Path]::GetFullPath($DestinationRoot)
foreach ($item in @('server','public','config','node_modules','launcher','deployment')) {
  $sourcePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $item)).TrimEnd('\')
  if ($destination.TrimEnd('\') -eq $sourcePath -or $destination.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Output cannot be inside a packaged source directory: $sourcePath" }
}
$bundleName = "Yingjian-Server-$version-Windows"
$bundleRoot = Join-Path $destination $bundleName
$archive = Join-Path $destination "$bundleName.zip"
if ((Test-Path -LiteralPath $bundleRoot) -or (Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath "$archive.partial")) { throw "Output exists. Choose another -DestinationRoot: $bundleRoot" }
if (!(Test-Path -LiteralPath $LauncherPath)) { throw 'Build scripts/build-server-launcher.ps1 first.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $nodePath -p 'process.versions.node').Trim()
if ([int]$nodeVersion.Split('.')[0] -lt 22) { throw 'Node.js 22 or later is required.' }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/express/package.json'))) { throw 'Run npm ci before packaging.' }
$offlineBundles = @()
foreach ($candidate in @(@{Architecture='amd64'; Path=$NasOfflineBundle}, @{Architecture='arm64'; Path=$NasArm64OfflineBundle})) {
  if (!$candidate.Path) { continue }
  $verifiedPath = (Resolve-Path -LiteralPath $candidate.Path).Path
  $checked = & $nodePath (Join-Path $PSScriptRoot 'verify-nas-offline.mjs') $verifiedPath --platform "linux/$($candidate.Architecture)"
  if ($LASTEXITCODE -ne 0) { throw 'NAS offline bundle verification failed.' }
  $offlineReport = $checked | ConvertFrom-Json
  if ($offlineReport.ok -ne $true -or $offlineReport.image.platform -cne "linux/$($candidate.Architecture)") { throw 'NAS offline bundle architecture verification failed.' }
  $offlineBundles += [pscustomobject]@{ Architecture=$candidate.Architecture; Path=$verifiedPath; Report=$offlineReport }
}
New-Item -ItemType Directory -Path $bundleRoot | Out-Null
foreach ($item in @('server','public','config','node_modules','package.json','package-lock.json','start-windows.cmd','AUTHORS.md','THIRD-PARTY.md')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $bundleRoot -Recurse
}
# The repository landing page links to source-only docs. Ship the full user guide instead.
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/usage.md') -Destination (Join-Path $bundleRoot 'README.md')
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/nas-architectures.md') -Destination $bundleRoot
$launcherRoot = Join-Path $bundleRoot 'launcher'
New-Item -ItemType Directory -Path $launcherRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'launcher/host.mjs') -Destination $launcherRoot
Copy-Item -LiteralPath $LauncherPath -Destination (Join-Path $bundleRoot 'Yingjian-Server.exe')
Copy-Item -LiteralPath "$LauncherPath.config" -Destination (Join-Path $bundleRoot 'Yingjian-Server.exe.config')
$templates = Join-Path $bundleRoot 'deployment/nas'
New-Item -ItemType Directory -Path $templates | Out-Null
foreach ($item in @('Dockerfile','docker-compose.yml','.dockerignore','.env.example','deploy.sh','README.md')) {
  $content = [IO.File]::ReadAllText((Join-Path $projectRoot "deployment/nas/$item")).Replace("`r`n","`n")
  [IO.File]::WriteAllText((Join-Path $templates $item), $content, [Text.UTF8Encoding]::new($false))
}
$verifierRoot = Join-Path $bundleRoot 'scripts'
New-Item -ItemType Directory -Path $verifierRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'verify-nas-offline.mjs') -Destination $verifierRoot
foreach ($offline in $offlineBundles) {
  $offlineRoot = Join-Path $bundleRoot "deployment/nas-offline/$($offline.Architecture)"
  New-Item -ItemType Directory -Path $offlineRoot | Out-Null
  foreach ($item in $offline.Report.files) {
    Copy-Item -LiteralPath (Join-Path $offline.Path $item) -Destination $offlineRoot
  }
}
$runtimeRoot = Join-Path $bundleRoot 'runtime'
New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeRoot 'node.exe')
$license = Join-Path (Split-Path $nodePath -Parent) 'LICENSE'
if (!(Test-Path -LiteralPath $license)) { $license = Join-Path $projectRoot 'config/NODE-LICENSE.txt' }
Copy-Item -LiteralPath $license -Destination (Join-Path $runtimeRoot 'LICENSE')
$included = if ($offlineBundles.Count) { ($offlineBundles | ForEach-Object { "linux/$($_.Architecture)" }) -join '、' } else { '无' }
$nasReadme = @"
NAS：切换“NAS 部署”，选择 x86-64 / AMD64 或 ARM64，再填写地址、端口和管理密码。
本包内置的离线镜像：$included。选择已内置镜像的架构时，校验并导出离线包；没有该架构镜像时明确导出源码部署包，需要 NAS 联网构建。
离线包在 NAS 导入 image.tar 后使用 docker-compose.yml 启动；已有安装须保留原项目、配置和实际数据卷。ARM64 不等于 32 位 ARM，不支持 ARMv7。
"@
$readme = @'
映间服务端 · Windows

1. 解压整个目录，双击 Yingjian-Server.exe。
2. 在“本机服务”点击“启动服务”，再点击“打开管理页”。
3. 管理页生成二维码或连接码，供手机、电视或电脑播放器连接。
4. 关闭窗口会收起到系统托盘；在启动器中退出才会停止它启动的服务。

已有旧服务运行：启动器会显示外部服务，请先在旧启动窗口停止服务。
迁移数据：停止旧服务后，在启动器选择原 data 目录，再启动。
不要同时运行两套服务操作同一个 data 目录。

本程序管理服务端；电脑观看请使用单独的“映间播放器.html”或管理页的播放器入口。
'@
[IO.File]::WriteAllText((Join-Path $bundleRoot '先读我.txt'), ($readme + "`r`n`r`n" + $nasReadme + "`r`n"), [Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open("$archive.partial", [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem -LiteralPath $bundleRoot -File -Recurse -Force | Sort-Object FullName) {
    # .NET Framework can use Windows separators in CreateFromDirectory.
    $relative = $file.FullName.Substring($bundleRoot.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "$bundleName/$relative", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
Move-Item -LiteralPath "$archive.partial" -Destination $archive
[pscustomobject]@{ Bundle = $bundleRoot; Archive = $archive; Runtime = $nodeVersion; Bytes = (Get-Item -LiteralPath $archive).Length } | ConvertTo-Json
