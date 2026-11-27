param([string]$DestinationRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (!$DestinationRoot) { $DestinationRoot = Join-Path $projectRoot 'release' }
$name = 'Yingjian-NAS-Image-Builder-0.1.4-nas1'
$destination = [IO.Path]::GetFullPath($DestinationRoot)
$bundle = Join-Path $destination $name
if ((Test-Path -LiteralPath $bundle) -or (Test-Path -LiteralPath "$bundle.zip") -or (Test-Path -LiteralPath "$bundle.zip.partial")) { throw 'Output already exists. Choose another destination.' }
New-Item -ItemType Directory -Path (Join-Path $bundle 'scripts') -Force | Out-Null
$tar = (Get-Command tar.exe -ErrorAction Stop).Source
& $tar -czf (Join-Path $bundle 'build-input.tgz') --exclude=deployment/nas-offline/tests -C $projectRoot `
  package.json package-lock.json .dockerignore THIRD-PARTY.md server public config `
  deployment/nas/Dockerfile deployment/nas-offline `
  scripts/build-nas-image.sh scripts/nas-image-smoke.mjs scripts/verify-nas-offline.mjs
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare build input.' }
foreach ($file in @('make-nas-offline.ps1', 'package-nas-offline.ps1', 'verify-nas-offline.mjs', 'repack-nas-offline.ps1')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $bundle 'scripts')
}
$runtime = Join-Path $bundle 'runtime'
New-Item -ItemType Directory -Path $runtime | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $node -Destination (Join-Path $runtime 'node.exe')
$license = Join-Path (Split-Path $node -Parent) 'LICENSE'
if (!(Test-Path -LiteralPath $license)) { $license = Join-Path $projectRoot 'config/NODE-LICENSE.txt' }
Copy-Item -LiteralPath $license -Destination (Join-Path $runtime 'LICENSE')
$launcher = @'
@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-nas-offline.ps1"
if errorlevel 1 echo Operation stopped. If image files are already in output, run Repack-Downloaded-Image.cmd.
pause
'@
[IO.File]::WriteAllText((Join-Path $bundle 'Make-NAS-Image.cmd'), $launcher.Replace("`r`n", "`n").Replace("`n", "`r`n"), [Text.ASCIIEncoding]::new())
$repackLauncher = @'
@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repack-nas-offline.ps1"
if errorlevel 1 echo Local ZIP packaging stopped. Downloaded image files were kept.
pause
'@
[IO.File]::WriteAllText((Join-Path $bundle 'Repack-Downloaded-Image.cmd'), $repackLauncher.Replace("`r`n", "`n").Replace("`n", "`r`n"), [Text.ASCIIEncoding]::new())
$readme = @'
映间 NAS 离线镜像制作工具

这是一次性制作工具。工具包本身不包含成品镜像；成功制作后，镜像和验收记录保存在 output 中。
启动时选择目标镜像架构，并输入可用的 Docker 制作机器地址和 SSH 用户名；不会自动连接预设地址。

请在能访问 NAS 的家里 Windows 电脑运行。
如果你人在外面、通过远程软件控制家里电脑：先将完整 ZIP 传到家里电脑，在家里电脑解压并运行。
不用让你当前所在的电脑直接访问 NAS，也不用配置外网端口。

1. 解压完整工具包，双击 Make-NAS-Image.cmd，选择 1（x86-64 / AMD64）或 2（ARM64）。
2. 按系统 SSH 提示输入 NAS 登录密码。三次连接可能分别要求密码，输入时不回显。
3. 等待自动构建、启动检查、登录、电视配对、重建容器后的数据保留测试。
4. 全部通过后，会自动取回镜像、核验摘要，并打开存放离线 ZIP 的 output 文件夹。

如果镜像已经下载，只是在最后 ZIP 打包时报错：双击 Repack-Downloaded-Image.cmd。
该入口只校验、打包已下载的文件，不连接 NAS、不重复制作镜像。

制作过程使用独立临时容器和测试数据卷，不替换原 yingjian-lan，不操作原家庭数据。
首次制作需要 NAS 联网下载缺失的基础镜像/npm 依赖；制作好的离线包安装时无需这些下载。
要求制作机器运行 Linux Docker，已开启 SSH，登录账户可直接使用 Docker。
优先在相同架构的机器制作；跨架构构建必须由管理员预先配置 Docker 模拟运行支持，本工具不安装模拟器或更改系统。
ARM64 对应 64 位 ARM，不支持 ARMv7 等 32 位 ARM。
只有目标架构的实际容器运行验收通过后才输出成品；源码包或只有构建成功的镜像不会被标记为已验收离线包。
没有 Docker 权限时会明确报错停止，不自动修改账户权限或安装软件。
NAS 的 /tmp 和电脑需有足够的制作及镜像导出空间。

成品安装：导入 image.tar，按 README 更新原 Compose 项目，沿用原 .env 和原数据卷。
不需要继续在 NAS 上改 Node 版本、安装 npm 或反复重建。

若 NAS 地址或用户名不同，可在 PowerShell 运行：
powershell -File .\scripts\make-nas-offline.ps1 -NasAddress 192.168.1.8 -NasUser 你的用户名 -Architecture arm64

失败时窗口会保留错误文字；工具不会把失败结果命名为正式成品。
NAS 上的 /tmp/yingjian-image-日期-随机编号 目录保留制作材料，拿到成品后可自行清理。
'@
[IO.File]::WriteAllText((Join-Path $bundle '先读我.txt'), $readme, [Text.UTF8Encoding]::new($true))
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open("$bundle.zip.partial", [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem -LiteralPath $bundle -File -Recurse -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring($bundle.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, "$name/$relative", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
Move-Item -LiteralPath "$bundle.zip.partial" -Destination "$bundle.zip"
$hash = (Get-FileHash -LiteralPath "$bundle.zip" -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$bundle.zip.sha256", "$hash  $name.zip`n", [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ Bundle=$bundle; Archive="$bundle.zip"; SHA256=$hash; IsFinishedImage=$false } | ConvertTo-Json
