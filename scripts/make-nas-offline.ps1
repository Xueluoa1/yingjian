param([string]$NasAddress = '192.168.1.8', [string]$NasUser = '2402108902')
$ErrorActionPreference = 'Stop'
$kitRoot = Split-Path $PSScriptRoot -Parent
$inputArchive = Join-Path $kitRoot 'build-input.tgz'
$nodePath = Join-Path $kitRoot 'runtime/node.exe'
if (!(Test-Path -LiteralPath $inputArchive) -or !(Test-Path -LiteralPath $nodePath)) {
  throw '请从完整的 NAS 镜像制作工具包中启动。'
}
$address = $null
if (![Net.IPAddress]::TryParse($NasAddress, [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $address.ToString() -ne $NasAddress) {
  throw 'NAS 地址必须是局域网 IPv4。'
}
$octets = $address.GetAddressBytes()
if (!($octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168))) {
  throw 'NAS 地址必须是局域网 IPv4。'
}
if ($NasUser -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$') { throw 'SSH 用户名格式不正确。' }
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$scp = (Get-Command scp.exe -ErrorAction Stop).Source
$connection = "$NasUser@$NasAddress"
Write-Host "检查当前电脑能否连接 NAS：$NasAddress`:22"
$probe = [Net.Sockets.TcpClient]::new()
try {
  $connectionTask = $probe.ConnectAsync($NasAddress, 22)
  if (!$connectionTask.Wait(5000) -or !$probe.Connected) { throw 'NAS SSH is unreachable.' }
} catch {
  throw '当前电脑无法连接 NAS 的 SSH 端口。请把完整工具包传到家里能访问 NAS 的电脑，在那台电脑解压运行，并确认 NAS 已开启 SSH。'
} finally { $probe.Dispose() }
$runId = 'yingjian-image-' + (Get-Date -Format yyyyMMdd-HHmmss) + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$remoteRoot = "/tmp/$runId"
$remoteArchive = "/tmp/$runId.tgz"
$bundleName = 'Yingjian-Server-0.1.4-nas1-linux-amd64-Offline'
$outputRoot = Join-Path $kitRoot "output/$runId"
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Write-Host "目标 NAS：$connection"
Write-Host '这次只制作并测试镜像，不替换正在运行的映间服务，也不读取家庭数据。'
Write-Host 'SSH 可能多次要求输入 NAS 登录密码；密码由系统 SSH 接收，不保存在工具包。'
Write-Host '[1/3] 上传制作材料……'
& $scp -o StrictHostKeyChecking=ask -o ConnectTimeout=10 $inputArchive "${connection}:$remoteArchive"
if ($LASTEXITCODE -ne 0) { throw '上传失败。请确认 NAS 已开启 SSH，且使用的是 NAS 登录账户。' }
Write-Host '[2/3] 构建、启动验收并导出完整镜像……'
# Every interpolated remote path is derived only from this fixed prefix and GUID.
# Existing NAS application paths, configuration and volumes never enter this command.
$remoteCommand = "set -eu; umask 077; mkdir '$remoteRoot'; tar -xzf '$remoteArchive' -C '$remoteRoot'; cd '$remoteRoot'; sh scripts/build-nas-image.sh '$remoteRoot/output'"
& $ssh -o StrictHostKeyChecking=ask -o ConnectTimeout=10 $connection $remoteCommand
if ($LASTEXITCODE -ne 0) { throw "镜像制作或真实容器验收失败，没有生成安装成品。诊断材料保留在 NAS 的 $remoteRoot。" }
Write-Host '[3/3] 取回已验证镜像并生成离线 ZIP……'
& $scp -o StrictHostKeyChecking=ask -o ConnectTimeout=10 -r "${connection}:$remoteRoot/output/$bundleName" $outputRoot
if ($LASTEXITCODE -ne 0) { throw "镜像取回失败。已制作的文件仍保留在 NAS 的 $remoteRoot/output，可稍后重新下载。" }
$bundle = Join-Path $outputRoot $bundleName
$validation = & $nodePath (Join-Path $PSScriptRoot 'verify-nas-offline.mjs') $bundle
if ($LASTEXITCODE -ne 0) { throw '下载后的镜像校验失败，停止发布。NAS 原服务未修改。' }
$report = $validation | ConvertFrom-Json
if ($report.ok -ne $true) { throw '离线镜像校验未返回成功结果。' }
try {
  & (Join-Path $PSScriptRoot 'package-nas-offline.ps1') -VerifiedBundle $bundle -DestinationRoot $outputRoot -NodePath $nodePath
} catch {
  throw "镜像已构建并下载，本地 ZIP 打包失败。请在本目录运行 Repack-Downloaded-Image.cmd，仅重新打包已有镜像。错误：$($_.Exception.Message)"
}
Write-Host ''
Write-Host "离线包已生成：$outputRoot\$bundleName.zip"
Write-Host '安装：NAS 本地导入 image.tar，保留原配置与数据卷，再使用包内 Compose 启动。'
Write-Host "NAS 制作材料暂存于 $remoteRoot；确认拿到成品后可由你自行清理。"
Start-Process explorer.exe -ArgumentList ('"{0}"' -f $outputRoot)
