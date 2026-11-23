param([string]$VerifiedBundle, [switch]$NoOpenFolder)
$ErrorActionPreference = 'Stop'
$kitRoot = Split-Path $PSScriptRoot -Parent
$nodePath = Join-Path $kitRoot 'runtime/node.exe'
$packageScript = Join-Path $PSScriptRoot 'package-nas-offline.ps1'
$bundleName = 'Yingjian-Server-0.1.4-nas1-linux-amd64-Offline'
foreach ($file in @($nodePath, $packageScript, (Join-Path $PSScriptRoot 'verify-nas-offline.mjs'))) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw '工具文件不完整。请将修复补丁解压到原来的镜像制作工具目录，保留原 runtime、scripts 和 output。' }
}
if (!$VerifiedBundle) {
  $output = Join-Path $kitRoot 'output'
  $candidates = @()
  if (Test-Path -LiteralPath $output -PathType Container) {
    $candidates = @(
      Get-ChildItem -LiteralPath $output -Directory |
        Where-Object { !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
        Sort-Object Name -Descending |
        ForEach-Object {
          $candidate = Join-Path $_.FullName $bundleName
          if ((Test-Path -LiteralPath (Join-Path $candidate 'image.tar') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $candidate 'verification.json') -PathType Leaf)) {
            $candidate
          }
        }
    )
  }
  if ($candidates.Count -eq 0) { throw '没有找到已下载的镜像。请将补丁解压到原制作工具目录，里面应有 output\yingjian-image-日期-编号\Yingjian-Server-0.1.4-nas1-linux-amd64-Offline\image.tar。' }
  if ($candidates.Count -eq 1) {
    $VerifiedBundle = $candidates[0]
  } else {
    Write-Host '发现多次制作的镜像，请选择本次需要打包的一份：'
    for ($index = 0; $index -lt $candidates.Count; $index++) {
      $runName = Split-Path (Split-Path $candidates[$index] -Parent) -Leaf
      Write-Host ("  {0}. {1}" -f ($index + 1), $runName)
    }
    $answer = Read-Host '输入编号（直接回车取消）'
    $selected = 0
    if (![int]::TryParse($answer, [ref]$selected) -or $selected -lt 1 -or $selected -gt $candidates.Count) { throw '未选择镜像，已停止；文件保持原样。' }
    $VerifiedBundle = $candidates[$selected - 1]
  }
}
$bundle = (Resolve-Path -LiteralPath $VerifiedBundle).Path
$outputRoot = Split-Path $bundle -Parent
$archive = Join-Path $outputRoot "$bundleName.zip"
# Preserve any previous completed ZIP or interrupted output.
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath "$archive.partial")) {
  $outputRoot = Join-Path $outputRoot ('repacked-' + (Get-Date -Format yyyyMMdd-HHmmss) + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
}
Write-Host "使用已下载的镜像：$bundle"
Write-Host '正在校验镜像并生成 ZIP；这一步只在本机处理文件……'
$result = & $packageScript -VerifiedBundle $bundle -DestinationRoot $outputRoot -NodePath $nodePath
$package = $result | ConvertFrom-Json
if (!$package.Archive -or !(Test-Path -LiteralPath $package.Archive -PathType Leaf)) { throw '未找到生成的 ZIP，请保留镜像目录并查看错误信息。' }
Write-Host ''
Write-Host "离线包已完成：$($package.Archive)"
Write-Host 'NAS 上已经保留本次制作的应用镜像。此 ZIP 可用来备份或在其他 NAS 导入部署。'
$package | ConvertTo-Json -Depth 5
if (!$NoOpenFolder) { Start-Process explorer.exe -ArgumentList ('"{0}"' -f $outputRoot) }
